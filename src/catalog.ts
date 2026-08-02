/**
 * Catalog introspection: turns a live Postgres schema + its statistics into the
 * `Catalog` the analyzer reasons over. Also loads/saves the frozen JSON fixture
 * so the analyzer and its tests run with no database at all.
 */
import { readFile, writeFile } from 'node:fs/promises';
import type pg from 'pg';
import type { Catalog, Column, IndexDef, Table } from './types.ts';

const COLUMN_SQL = `
SELECT c.relname AS table_name,
       a.attname AS column_name,
       format_type(a.atttypid, a.atttypmod) AS data_type,
       NOT a.attnotnull AS nullable,
       s.null_frac, s.n_distinct, s.correlation, s.avg_width,
       s.most_common_vals::text AS mcv,
       s.most_common_freqs
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_stats s ON s.schemaname = n.nspname AND s.tablename = c.relname AND s.attname = a.attname
WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm')
ORDER BY c.relname, a.attnum;`;

/*
 * relkind: r ordinary table, p partitioned table, v view, m materialized view.
 * Ordinary and partitioned tables report no `kind`, so an existing catalog stays
 * byte-identical and `kind === undefined` keeps meaning "an ordinary table".
 *
 * reltuples is -1 for a relation that has never been analyzed, and a partitioned
 * parent stores no rows of its own, so both would report a large table as empty.
 * Each is resolved to SQL NULL -- unknown -- rather than to a misleading zero.
 */
const TABLE_SQL = `
SELECT c.relname AS table_name,
       CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized-view' END AS kind,
       CASE
         WHEN c.relkind = 'v' THEN NULL
         WHEN c.relkind = 'p' THEN (
           SELECT CASE WHEN bool_and(p.reltuples >= 0) THEN sum(p.reltuples)::bigint END
             FROM pg_partition_tree(c.oid) t
             JOIN pg_class p ON p.oid = t.relid
            WHERE p.relkind = 'r')
         ELSE NULLIF(c.reltuples::bigint, -1)
       END AS row_count,
       CASE
         WHEN c.relkind = 'v' THEN NULL
         WHEN c.relkind = 'p' THEN (
           SELECT sum(pg_total_relation_size(t.relid))::bigint FROM pg_partition_tree(c.oid) t)
         ELSE pg_total_relation_size(c.oid)
       END AS size_bytes
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm');`;

const INDEX_SQL = `
SELECT t.relname AS table_name, i.relname AS index_name,
       ix.indisunique AS is_unique, ix.indnkeyatts AS n_key_atts,
       am.amname AS method,
       pg_get_indexdef(ix.indexrelid) AS indexdef,
       pg_relation_size(i.oid) AS size_bytes,
       pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
       (SELECT array_agg(pg_get_indexdef(ix.indexrelid, k, true) ORDER BY k)
          FROM generate_series(1, ix.indnatts) k) AS key_defs
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_am am ON am.oid = i.relam
WHERE n.nspname = $1;`;

const CONSTRAINT_SQL = `
SELECT con.contype, t.relname AS table_name, con.conname,
       (SELECT array_agg(att.attname::text ORDER BY k.ord)
          FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum) AS columns,
       ft.relname AS ref_table,
       (SELECT array_agg(att.attname::text ORDER BY k.ord)
          FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = k.attnum) AS ref_columns
FROM pg_constraint con
JOIN pg_class t ON t.oid = con.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
LEFT JOIN pg_class ft ON ft.oid = con.confrelid
WHERE n.nspname = $1 AND con.contype IN ('p', 'f');`;

const SETTINGS = [
  'work_mem', 'shared_buffers', 'effective_cache_size', 'random_page_cost',
  'seq_page_cost', 'max_parallel_workers_per_gather', 'default_statistics_target',
  'enable_seqscan', 'jit',
];

export async function introspect(client: pg.Client, schema = 'shop'): Promise<Catalog> {
  // A pg.Client is a single connection and executes one query at a time. Issuing
  // concurrent client.query() calls is deprecated in pg 8 and will fail in pg 9,
  // so keep introspection explicitly sequential. These catalog queries are tiny.
  const cols = await client.query(COLUMN_SQL, [schema]);
  const tbls = await client.query(TABLE_SQL, [schema]);
  const idxs = await client.query(INDEX_SQL, [schema]);
  const cons = await client.query(CONSTRAINT_SQL, [schema]);
  const ver = await client.query('SHOW server_version');
  const settings = await client.query(
    `SELECT name, setting, unit FROM pg_settings WHERE name = ANY($1)`,
    [SETTINGS],
  );

  const tables = new Map<string, Table>();
  for (const r of tbls.rows) {
    // Number(null) is 0, so an unknown count must be checked before converting.
    tables.set(r.table_name, {
      schema, name: r.table_name, columns: [], indexes: [],
      ...(r.kind ? { kind: r.kind as Table['kind'] } : {}),
      rowCount: r.row_count === null ? undefined : Number(r.row_count),
      sizeBytes: r.size_bytes === null ? undefined : Number(r.size_bytes),
    });
  }

  for (const r of cols.rows) {
    const t = tables.get(r.table_name);
    if (!t) continue;
    const col: Column = {
      name: r.column_name,
      dataType: r.data_type,
      nullable: r.nullable,
    };
    if (r.null_frac !== null) {
      const mcvRaw: string | null = r.mcv;
      const freqs: number[] | null = r.most_common_freqs;
      let mostCommonValues;
      if (mcvRaw && freqs) {
        const vals = mcvRaw.replace(/^\{|\}$/g, '').split(',').map((v) => v.replace(/^"|"$/g, ''));
        mostCommonValues = vals
          .map((value, i) => ({ value, frequency: freqs[i] }))
          .filter((m) => m.frequency !== undefined)
          .slice(0, 10);
      }
      col.stats = {
        nullFrac: r.null_frac,
        nDistinct: r.n_distinct,
        correlation: r.correlation ?? undefined,
        avgWidth: r.avg_width ?? undefined,
        mostCommonValues,
      };
    }
    t.columns.push(col);
  }

  for (const r of idxs.rows) {
    const t = tables.get(r.table_name);
    if (!t) continue;
    // pg_get_indexdef(oid, k, true) gives each key's expression text.
    const keyDefs: string[] = r.key_defs ?? [];
    const nKey: number = r.n_key_atts;
    const keys = keyDefs.slice(0, nKey);
    const includes = keyDefs.slice(nKey);
    const idx: IndexDef = {
      name: r.index_name,
      table: r.table_name,
      columns: keys,
      includeColumns: includes.length ? includes : undefined,
      unique: r.is_unique,
      method: r.method,
      where: r.predicate ?? undefined,
      expressions: keys.filter((k) => /[()]/.test(k)),
      sizeBytes: Number(r.size_bytes),
    };
    t.indexes.push(idx);
  }

  for (const r of cons.rows) {
    const t = tables.get(r.table_name);
    if (!t) continue;
    if (r.contype === 'p') t.primaryKey = r.columns;
    else if (r.contype === 'f') {
      t.foreignKeys ??= [];
      t.foreignKeys.push({
        columns: r.columns,
        referencesTable: r.ref_table,
        referencesColumns: r.ref_columns,
      });
    }
  }

  return {
    dialect: 'postgres',
    serverVersion: ver.rows[0].server_version,
    tables: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)),
    settings: Object.fromEntries(
      settings.rows.map((r) => [r.name, r.unit ? `${r.setting}${r.unit}` : r.setting]),
    ),
  };
}

export async function saveCatalog(cat: Catalog, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(cat, null, 2) + '\n');
}

export class CatalogInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogInputError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonblank);
}

function optionalNonnegative(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function fail(path: string, expectation: string): never {
  throw new CatalogInputError(`${path} ${expectation}`);
}

/** Runtime validation for user-supplied catalog JSON. The TypeScript type is not an input boundary. */
export function validateCatalog(value: unknown): Catalog {
  if (!record(value)) fail('catalog', 'must be a JSON object.');
  if (value.dialect !== 'postgres') fail('catalog.dialect', 'must be "postgres".');
  if (!Array.isArray(value.tables)) fail('catalog.tables', 'must be an array.');
  if (value.serverVersion !== undefined && !nonblank(value.serverVersion)) {
    fail('catalog.serverVersion', 'must be a nonblank string when supplied.');
  }
  if (value.settings !== undefined) {
    if (!record(value.settings) || Object.values(value.settings).some((setting) => typeof setting !== 'string')) {
      fail('catalog.settings', 'must map setting names to string values.');
    }
  }

  const tableNames = new Set<string>();
  value.tables.forEach((table, tableIndex) => {
    const path = `catalog.tables[${tableIndex}]`;
    if (!record(table)) fail(path, 'must be an object.');
    if (!nonblank(table.schema)) fail(`${path}.schema`, 'must be a nonblank string.');
    if (!nonblank(table.name)) fail(`${path}.name`, 'must be a nonblank string.');
    const identity = `${table.schema.toLowerCase()}.${table.name.toLowerCase()}`;
    if (tableNames.has(identity)) fail(path, `duplicates table ${identity}.`);
    tableNames.add(identity);
    if (!Array.isArray(table.columns)) fail(`${path}.columns`, 'must be an array.');
    if (!Array.isArray(table.indexes)) fail(`${path}.indexes`, 'must be an array.');
    if (table.kind !== undefined && !['table', 'view', 'materialized-view'].includes(table.kind as string)) {
      fail(`${path}.kind`, 'must be table, view, or materialized-view.');
    }
    if (!optionalNonnegative(table.rowCount)) fail(`${path}.rowCount`, 'must be a non-negative finite number.');
    if (!optionalNonnegative(table.sizeBytes)) fail(`${path}.sizeBytes`, 'must be a non-negative finite number.');
    if (table.primaryKey !== undefined && !stringList(table.primaryKey)) {
      fail(`${path}.primaryKey`, 'must be an array of nonblank column names.');
    }

    const columnNames = new Set<string>();
    table.columns.forEach((column, columnIndex) => {
      const columnPath = `${path}.columns[${columnIndex}]`;
      if (!record(column)) fail(columnPath, 'must be an object.');
      if (!nonblank(column.name)) fail(`${columnPath}.name`, 'must be a nonblank string.');
      if (!nonblank(column.dataType)) fail(`${columnPath}.dataType`, 'must be a nonblank string.');
      if (typeof column.nullable !== 'boolean') fail(`${columnPath}.nullable`, 'must be boolean.');
      const normalized = column.name.toLowerCase();
      if (columnNames.has(normalized)) fail(columnPath, `duplicates column ${column.name}.`);
      columnNames.add(normalized);
      if (column.stats !== undefined) {
        if (!record(column.stats)) fail(`${columnPath}.stats`, 'must be an object.');
        for (const required of ['nullFrac', 'nDistinct'] as const) {
          if (typeof column.stats[required] !== 'number' || !Number.isFinite(column.stats[required])) {
            fail(`${columnPath}.stats.${required}`, 'must be a finite number.');
          }
        }
        const nullFrac = column.stats.nullFrac as number;
        if (nullFrac < 0 || nullFrac > 1) fail(`${columnPath}.stats.nullFrac`, 'must be between 0 and 1.');
      }
    });

    const methods = new Set(['btree', 'hash', 'gin', 'gist', 'brin', 'spgist']);
    table.indexes.forEach((index, indexNumber) => {
      const indexPath = `${path}.indexes[${indexNumber}]`;
      if (!record(index)) fail(indexPath, 'must be an object.');
      if (!nonblank(index.name)) fail(`${indexPath}.name`, 'must be a nonblank string.');
      if (!nonblank(index.table)) fail(`${indexPath}.table`, 'must be a nonblank string.');
      if (!stringList(index.columns)) fail(`${indexPath}.columns`, 'must be an array of nonblank key expressions.');
      if (typeof index.unique !== 'boolean') fail(`${indexPath}.unique`, 'must be boolean.');
      if (!methods.has(String(index.method))) fail(`${indexPath}.method`, 'must be a supported PostgreSQL index method.');
      if (index.includeColumns !== undefined && !stringList(index.includeColumns)) {
        fail(`${indexPath}.includeColumns`, 'must be an array of nonblank column names.');
      }
      if (index.expressions !== undefined && !stringList(index.expressions)) {
        fail(`${indexPath}.expressions`, 'must be an array of nonblank expressions.');
      }
      if (!optionalNonnegative(index.sizeBytes)) fail(`${indexPath}.sizeBytes`, 'must be a non-negative finite number.');
    });

    if (table.foreignKeys !== undefined) {
      if (!Array.isArray(table.foreignKeys)) fail(`${path}.foreignKeys`, 'must be an array.');
      table.foreignKeys.forEach((foreignKey, fkIndex) => {
        const fkPath = `${path}.foreignKeys[${fkIndex}]`;
        if (!record(foreignKey)) fail(fkPath, 'must be an object.');
        if (!stringList(foreignKey.columns)) fail(`${fkPath}.columns`, 'must be nonblank column names.');
        if (!nonblank(foreignKey.referencesTable)) fail(`${fkPath}.referencesTable`, 'must be a nonblank string.');
        if (!stringList(foreignKey.referencesColumns)) {
          fail(`${fkPath}.referencesColumns`, 'must be nonblank column names.');
        }
        if (foreignKey.columns.length !== foreignKey.referencesColumns.length) {
          fail(fkPath, 'must have the same number of local and referenced columns.');
        }
      });
    }
  });

  return value as unknown as Catalog;
}

export async function loadCatalog(path: string): Promise<Catalog> {
  const text = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CatalogInputError(`catalog ${path} is not valid JSON: ${detail}`);
  }
  return validateCatalog(parsed);
}

// ---------------------------------------------------------------------------
// Convenience lookups every module needs. Keep these here so seven modules do
// not each grow their own subtly different version.
// ---------------------------------------------------------------------------

/** Case-insensitive table lookup, tolerating a schema prefix. */
export function findTable(cat: Catalog, name: string): Table | undefined {
  const bare = name.includes('.') ? name.split('.').pop()! : name;
  return cat.tables.find((t) => t.name.toLowerCase() === bare.toLowerCase());
}

export function findColumn(cat: Catalog, table: string, column: string): Column | undefined {
  return findTable(cat, table)?.columns.find(
    (c) => c.name.toLowerCase() === column.toLowerCase(),
  );
}

/**
 * Distinct-value count for a column, resolving pg_stats' negative-fraction
 * encoding against the table's row count.
 */
export function distinctCount(cat: Catalog, table: string, column: string): number | undefined {
  const t = findTable(cat, table);
  const c = findColumn(cat, table, column);
  if (!t?.rowCount || c?.stats?.nDistinct === undefined) return undefined;
  const nd = c.stats.nDistinct;
  return nd < 0 ? Math.round(-nd * t.rowCount) : nd;
}

/**
 * Selectivity of `column = <value>`. Uses the MCV list when the value is known
 * to be common, otherwise falls back to the uniform 1/n_distinct assumption.
 */
export function equalitySelectivity(
  cat: Catalog, table: string, column: string, value?: string,
): number | undefined {
  const c = findColumn(cat, table, column);
  if (!c?.stats) return undefined;
  if (value !== undefined && c.stats.mostCommonValues) {
    const hit = c.stats.mostCommonValues.find((m) => m.value === value.replace(/^'|'$/g, ''));
    if (hit) return hit.frequency;
  }
  const nd = distinctCount(cat, table, column);
  if (!nd) return undefined;
  return (1 - c.stats.nullFrac) / nd;
}
