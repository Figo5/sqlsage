/**
 * Catalog-derived facts the binder needs: key uniqueness proofs and the
 * multiplicity arithmetic behind `JoinIR.fanOut`.
 *
 * Everything here goes through the shared helpers in `../catalog.ts`
 * (`findTable`, `findColumn`, `distinctCount`, `equalitySelectivity`) so that
 * seven modules do not each grow a subtly different lookup.
 */
import { distinctCount, findColumn, findTable, parsePgArrayLiteral } from '../catalog.ts';
import type { Catalog, IndexDef, Table } from '../types.ts';

/**
 * Current catalog fixtures and live introspection expose real `string[]`
 * values. Accept legacy Postgres array literals (`"{order_id}"`) as well so a
 * previously frozen catalog cannot silently erase every uniqueness proof.
 */
export function asColumnList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  // Shares the array-literal parser rather than splitting on `,`: a quoted
  // identifier may contain a comma, and splitting one apart silently destroys
  // the key it names — along with every uniqueness proof that key supports.
  if (typeof v === 'string') return parsePgArrayLiteral(v).map((s) => s.trim());
  return [];
}

export function primaryKeyOf(table: Table | undefined): string[] {
  return asColumnList(table?.primaryKey);
}

export interface UniquenessProof {
  unique: boolean;
  /** Human-readable justification, always populated. */
  reason: string;
  /** Name of the constraint/index that proved it, when one did. */
  via?: string;
}

// Catalog identifiers and successfully resolved refs both carry PostgreSQL's
// exact stored spelling. Re-folding here would make quoted mixed-case names
// collide with ordinary lower-case identifiers.
const eq = (a: string, b: string) => a === b;
const has = (set: string[], c: string) => set.some((s) => eq(s, c));

/** An index usable as a uniqueness proof: unique, total, and on bare columns. */
function provingIndexes(table: Table): IndexDef[] {
  return (table.indexes ?? []).filter(
    (i) =>
      i.unique &&
      !i.where && // a partial unique index only constrains the rows it covers
      i.columns.length > 0 &&
      i.columns.every((c) => !/[()]/.test(c)), // expression keys are not bare columns
  );
}

/**
 * Is `table` at most one row per distinct value of `cols`?
 *
 * True when some declared key (primary key or total unique index) is a subset
 * of `cols` — a superset of a key is still unique. A plain (non-unique) index
 * on the column proves nothing, and neither does a foreign key: an FK
 * constrains the *referencing* side to point at something that exists, not to
 * point at it only once.
 */
export function uniqueOnColumns(
  catalog: Catalog,
  tableName: string,
  cols: string[],
): UniquenessProof {
  const table = findTable(catalog, tableName);
  if (!table) {
    return { unique: false, reason: `table ${tableName} is not in the catalog, so uniqueness cannot be proven` };
  }
  if (cols.length === 0) {
    return { unique: false, reason: `no key columns on ${tableName} to check uniqueness against` };
  }

  const pk = primaryKeyOf(table);
  if (pk.length > 0 && pk.every((c) => has(cols, c))) {
    return {
      unique: true,
      via: `${table.name} primary key (${pk.join(', ')})`,
      reason: `${table.name}.(${pk.join(', ')}) is the primary key and is covered by the join key, so at most one row matches per key value`,
    };
  }
  for (const idx of provingIndexes(table)) {
    if (idx.columns.every((c) => has(cols, c))) {
      return {
        unique: true,
        via: idx.name,
        reason: `unique index ${idx.name} on ${table.name}(${idx.columns.join(', ')}) is covered by the join key, so at most one row matches per key value`,
      };
    }
  }

  const detail = multiplicityNote(catalog, table, cols);
  return {
    unique: false,
    reason:
      `no primary key or unique index on ${table.name} is covered by (${cols.join(', ')})` +
      (detail ? `; ${detail}` : '') +
      '. A plain or foreign-key index does not prove uniqueness',
  };
}

/**
 * Average rows per distinct key value, from pg_stats. Only meaningful for a
 * single column — combining n_distinct across columns without extended
 * statistics is guesswork, so we decline rather than invent a number.
 */
export function rowsPerKey(
  catalog: Catalog,
  tableName: string,
  cols: string[],
): number | undefined {
  if (cols.length !== 1) return undefined;
  const table = findTable(catalog, tableName);
  const nd = distinctCount(catalog, tableName, cols[0]!);
  if (!table?.rowCount || !nd) return undefined;
  return table.rowCount / nd;
}

function multiplicityNote(catalog: Catalog, table: Table, cols: string[]): string | undefined {
  const ratio = rowsPerKey(catalog, table.name, cols);
  if (ratio === undefined) return undefined;
  const nd = distinctCount(catalog, table.name, cols[0]!)!;
  return `pg_stats puts ${table.name} at ${fmt(table.rowCount!)} rows over ${fmt(nd)} distinct ${cols[0]} values, about ${ratio.toFixed(1)} rows per value`;
}

export function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Column type as declared, or undefined when the column is not in the catalog. */
export function columnType(
  catalog: Catalog,
  tableName: string,
  column: string,
): string | undefined {
  return findColumn(catalog, tableName, column)?.dataType;
}

/** Indexes whose *leading* key is this column — what "sargable" can actually use. */
export function indexesLeadingWith(
  catalog: Catalog,
  tableName: string,
  column: string,
): IndexDef[] {
  const table = findTable(catalog, tableName);
  if (!table) return [];
  return (table.indexes ?? []).filter((i) => i.columns.length > 0 && eq(i.columns[0]!, column));
}
