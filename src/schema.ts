/**
 * Offline PostgreSQL DDL importer.
 *
 * This intentionally covers the schema objects SQLSage can reason about:
 * tables, columns, primary/foreign keys, and indexes. It is not a general DDL
 * executor. Unknown statements and constraints fail closed so a report never
 * rests on a schema we only partially understood.
 */
import { readFile } from 'node:fs/promises';
import type { Catalog, ForeignKey, IndexDef, Table } from './types.ts';

export class SchemaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaInputError';
  }
}

type TokenKind = 'word' | 'quoted-identifier' | 'string' | 'symbol';

interface Token {
  kind: TokenKind;
  raw: string;
  value: string;
  start: number;
  end: number;
}

interface QualifiedName {
  parts: string[];
  next: number;
}

interface ForeignKeyDraft extends ForeignKey {
  referencesColumns: string[];
}

interface MutableTable extends Table {
  foreignKeys?: ForeignKeyDraft[];
}

interface PartitionKey {
  columns: string[];
  /** True when any key element is an expression rather than a bare column. */
  hasExpression: boolean;
}

interface ParseState {
  currentSchema: string;
  tables: Map<string, MutableTable>;
  indexes: Map<string, string>;
  /** Partition key per table identity, for the uniqueness rule above. */
  partitionKeys: Map<string, PartitionKey>;
}

const INDEX_METHODS = new Set<IndexDef['method']>([
  'btree', 'hash', 'gin', 'gist', 'brin', 'spgist',
]);

function fail(message: string): never {
  throw new SchemaInputError(message.endsWith('.') ? message : `${message}.`);
}

function statementFail(number: number, message: string): never {
  fail(`schema statement ${number}: ${message}`);
}

/** Split DDL without treating semicolons inside strings/identifiers as terminators. */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let blockCommentDepth = 0;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!;
    const next = sql[i + 1];

    if (blockCommentDepth > 0) {
      if (char === '/' && next === '*') {
        blockCommentDepth += 1;
        i += 1;
      } else if (char === '*' && next === '/') {
        blockCommentDepth -= 1;
        i += 1;
        current += ' ';
      }
      continue;
    }

    if (quote === 'single') {
      current += char;
      if (char === "'" && next === "'") {
        current += next;
        i += 1;
      } else if (char === "'") {
        quote = null;
      }
      continue;
    }

    if (quote === 'double') {
      current += char;
      if (char === '"' && next === '"') {
        current += next;
        i += 1;
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }

    if (char === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      current += ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      blockCommentDepth = 1;
      i += 1;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      current += char;
      continue;
    }
    if (char === '"') {
      quote = 'double';
      current += char;
      continue;
    }
    if (char === '$') {
      // Dollar-quoted bodies (function and procedure sources) contain semicolons.
      // Consume to the matching tag so statement splitting stays correct; the
      // statement itself is then ignored as carrying no schema information.
      const tag = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) fail(`schema contains an unterminated dollar-quoted string opened with ${tag}`);
        current += ' ';
        i = close + tag.length - 1;
        continue;
      }
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (blockCommentDepth > 0) fail('schema contains an unterminated block comment');
  if (quote === 'single') fail('schema contains an unterminated string literal');
  if (quote === 'double') fail('schema contains an unterminated quoted identifier');
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function tokenize(statement: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < statement.length;) {
    if (/\s/.test(statement[i]!)) {
      i += 1;
      continue;
    }
    const start = i;
    const char = statement[i]!;
    if (char === "'") {
      i += 1;
      while (i < statement.length) {
        if (statement[i] === "'" && statement[i + 1] === "'") i += 2;
        else if (statement[i] === "'") {
          i += 1;
          break;
        } else i += 1;
      }
      tokens.push({ kind: 'string', raw: statement.slice(start, i), value: statement.slice(start, i), start, end: i });
      continue;
    }
    if (char === '"') {
      i += 1;
      let value = '';
      while (i < statement.length) {
        if (statement[i] === '"' && statement[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (statement[i] === '"') {
          i += 1;
          break;
        } else {
          value += statement[i];
          i += 1;
        }
      }
      tokens.push({ kind: 'quoted-identifier', raw: statement.slice(start, i), value, start, end: i });
      continue;
    }
    if ('(),.;[]'.includes(char)) {
      i += 1;
      tokens.push({ kind: 'symbol', raw: char, value: char, start, end: i });
      continue;
    }
    while (i < statement.length && !/\s/.test(statement[i]!) && !'(),.;[]\'"'.includes(statement[i]!)) i += 1;
    const raw = statement.slice(start, i);
    tokens.push({ kind: 'word', raw, value: raw.toLowerCase(), start, end: i });
  }
  return tokens;
}

function keyword(token: Token | undefined, expected: string): boolean {
  return token?.kind === 'word' && token.value === expected;
}

function identifier(token: Token | undefined): string | undefined {
  if (!token || (token.kind !== 'word' && token.kind !== 'quoted-identifier')) return undefined;
  return token.value;
}

function parseQualifiedName(tokens: Token[], at: number): QualifiedName | undefined {
  const first = identifier(tokens[at]);
  if (first === undefined) return undefined;
  const parts = [first];
  let next = at + 1;
  while (tokens[next]?.value === '.') {
    const part = identifier(tokens[next + 1]);
    if (part === undefined) return undefined;
    parts.push(part);
    next += 2;
  }
  return { parts, next };
}

function tableIdentity(schema: string, name: string): string {
  return `${schema.toLowerCase()}\u0000${name.toLowerCase()}`;
}

function resolveTableName(name: QualifiedName, currentSchema: string): { schema: string; name: string } {
  if (name.parts.length > 2) fail(`three-part table name ${name.parts.join('.')} is not supported`);
  return name.parts.length === 2
    ? { schema: name.parts[0]!, name: name.parts[1]! }
    : { schema: currentSchema, name: name.parts[0]! };
}

function splitTopLevel(tokens: Token[], start: number, end: number): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let depth = 0;
  let partStart = start;
  for (let i = start; i < end; i += 1) {
    if (tokens[i]!.value === '(' || tokens[i]!.value === '[') depth += 1;
    else if (tokens[i]!.value === ')' || tokens[i]!.value === ']') depth -= 1;
    else if (tokens[i]!.value === ',' && depth === 0) {
      if (partStart === i) fail('schema contains an empty comma-separated definition');
      parts.push([partStart, i]);
      partStart = i + 1;
    }
    if (depth < 0) fail('schema contains unmatched parentheses');
  }
  if (depth !== 0) fail('schema contains unmatched parentheses');
  if (partStart < end) parts.push([partStart, end]);
  return parts;
}

function matchingParen(tokens: Token[], open: number, limit = tokens.length): number {
  if (tokens[open]?.value !== '(') fail('expected an opening parenthesis');
  let depth = 0;
  for (let i = open; i < limit; i += 1) {
    if (tokens[i]!.value === '(') depth += 1;
    else if (tokens[i]!.value === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  fail('schema contains an unmatched opening parenthesis');
}

function parseIdentifierList(tokens: Token[], open: number, close: number, label: string): string[] {
  const columns = splitTopLevel(tokens, open + 1, close).map(([start, end]) => {
    if (end !== start + 1) fail(`${label} must contain bare column names`);
    const name = identifier(tokens[start]);
    if (name === undefined) fail(`${label} contains an invalid column name`);
    return name;
  });
  if (!columns.length) fail(`${label} cannot be empty`);
  return columns;
}

const CONSTRAINT_STARTERS = new Set([
  'constraint', 'not', 'null', 'default', 'primary', 'references', 'check',
  'unique', 'generated', 'identity', 'collate',
]);

function typeEnd(tokens: Token[], start: number, end: number): number {
  let depth = 0;
  for (let i = start; i < end; i += 1) {
    if (tokens[i]!.value === '(' || tokens[i]!.value === '[') depth += 1;
    else if (tokens[i]!.value === ')' || tokens[i]!.value === ']') depth -= 1;
    else if (depth === 0 && tokens[i]!.kind === 'word' && CONSTRAINT_STARTERS.has(tokens[i]!.value)) return i;
  }
  return end;
}

function tokensText(statement: string, tokens: Token[], start: number, end: number): string {
  if (start >= end) return '';
  return statement.slice(tokens[start]!.start, tokens[end - 1]!.end).trim();
}

function normalizeDataType(type: string): string {
  const compact = type.toLowerCase()
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .replace(/\s*\[\s*\]/g, '[]')
    .replace(/\s+/g, ' ')
    .trim();
  const aliases: Record<string, string> = {
    int: 'integer', int4: 'integer', int8: 'bigint', int2: 'smallint',
    bool: 'boolean', float4: 'real', float8: 'double precision',
    timestamptz: 'timestamp with time zone',
    timetz: 'time with time zone',
  };
  if (aliases[compact]) return aliases[compact]!;
  if (/^char\(\d+\)$/.test(compact)) return compact.replace(/^char/, 'character');
  if (/^varchar(\(\d+\))?$/.test(compact)) return compact.replace(/^varchar/, 'character varying');
  if (/^timestamp(\(\d+\))?$/.test(compact)) return `${compact} without time zone`;
  if (/^time(\(\d+\))?$/.test(compact)) return `${compact} without time zone`;
  return compact;
}

function nextConstraint(tokens: Token[], start: number, end: number): number {
  let depth = 0;
  for (let i = start; i < end; i += 1) {
    if (tokens[i]!.value === '(' || tokens[i]!.value === '[') depth += 1;
    else if (tokens[i]!.value === ')' || tokens[i]!.value === ']') depth -= 1;
    else if (depth === 0 && tokens[i]!.kind === 'word' && CONSTRAINT_STARTERS.has(tokens[i]!.value)) return i;
  }
  return end;
}

function setPrimaryKey(table: MutableTable, columns: string[], constraintName?: string): void {
  if (table.primaryKey) fail(`table ${table.name} declares more than one primary key`);
  table.primaryKey = columns;
  for (const name of columns) {
    const column = table.columns.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!column) fail(`primary key on ${table.name} references unknown column ${name}`);
    column.nullable = false;
  }
  table.indexes.push({
    name: constraintName ?? `${table.name}_pkey`,
    table: table.name,
    columns: [...columns],
    unique: true,
    method: 'btree',
    expressions: [],
  });
}

/**
 * A UNIQUE constraint is a unique index in everything the analysis cares about, so
 * it is recorded as one and the join fan-out proof reads it without changes.
 *
 * Unlike PRIMARY KEY this must NOT force the columns to NOT NULL. PostgreSQL treats
 * NULLs as distinct by default, so a unique column can hold many of them. Copying
 * the primary-key behaviour here would silently claim a column is non-nullable and
 * corrupt the null-rejection analysis.
 */
function addUniqueConstraint(table: MutableTable, columns: string[], constraintName?: string): void {
  for (const name of columns) {
    const column = table.columns.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!column) fail(`unique constraint on ${table.name} references unknown column ${name}`);
  }
  table.indexes.push({
    // PostgreSQL's own convention, so a recommendation never proposes creating an
    // index that already exists under the name the server would have chosen.
    name: constraintName ?? `${table.name}_${columns.join('_')}_key`,
    table: table.name,
    columns: [...columns],
    unique: true,
    method: 'btree',
    expressions: [],
  });
}

function parseReference(tokens: Token[], at: number, end: number): { table: string; columns: string[]; next: number } {
  const target = parseQualifiedName(tokens, at);
  if (!target) fail('REFERENCES must name a table');
  let next = target.next;
  let columns: string[] = [];
  if (tokens[next]?.value === '(') {
    const close = matchingParen(tokens, next, end);
    columns = parseIdentifierList(tokens, next, close, 'REFERENCES column list');
    next = close + 1;
  }
  return { table: target.parts.at(-1)!, columns, next };
}

/** Consume the referential-action grammar and stop before another column constraint. */
function referenceSuffixEnd(tokens: Token[], start: number, end: number): number {
  let i = start;
  while (i < end) {
    if (keyword(tokens[i], 'match')) {
      if (!['full', 'partial', 'simple'].some((value) => keyword(tokens[i + 1], value))) {
        fail('MATCH in a foreign key must be FULL, PARTIAL, or SIMPLE');
      }
      i += 2;
    } else if (keyword(tokens[i], 'on')) {
      if (!keyword(tokens[i + 1], 'delete') && !keyword(tokens[i + 1], 'update')) {
        fail('ON in a foreign key must specify DELETE or UPDATE');
      }
      i += 2;
      if (keyword(tokens[i], 'no') && keyword(tokens[i + 1], 'action')) i += 2;
      else if (keyword(tokens[i], 'set') && (keyword(tokens[i + 1], 'null') || keyword(tokens[i + 1], 'default'))) i += 2;
      else if (keyword(tokens[i], 'restrict') || keyword(tokens[i], 'cascade')) i += 1;
      else fail('foreign key ON action must be NO ACTION, RESTRICT, CASCADE, SET NULL, or SET DEFAULT');
    } else if (keyword(tokens[i], 'not') && keyword(tokens[i + 1], 'deferrable')) {
      i += 2;
    } else if (keyword(tokens[i], 'deferrable')) {
      i += 1;
    } else if (keyword(tokens[i], 'initially')) {
      if (!keyword(tokens[i + 1], 'deferred') && !keyword(tokens[i + 1], 'immediate')) {
        fail('foreign key INITIALLY must be DEFERRED or IMMEDIATE');
      }
      i += 2;
    } else {
      break;
    }
  }
  return i;
}

function parseColumn(statement: string, tokens: Token[], start: number, end: number, table: MutableTable): void {
  const name = identifier(tokens[start]);
  if (name === undefined) fail(`table ${table.name} has an invalid column definition`);
  if (table.columns.some((column) => column.name.toLowerCase() === name.toLowerCase())) {
    fail(`table ${table.name} declares column ${name} more than once`);
  }
  const endOfType = typeEnd(tokens, start + 1, end);
  const rawType = tokensText(statement, tokens, start + 1, endOfType);
  if (!rawType) fail(`column ${table.name}.${name} is missing a data type`);
  const column = { name, dataType: normalizeDataType(rawType), nullable: true };
  table.columns.push(column);

  let i = endOfType;
  let pendingConstraintName: string | undefined;
  while (i < end) {
    if (keyword(tokens[i], 'constraint')) {
      const constraintName = identifier(tokens[i + 1]);
      if (!constraintName) fail(`column ${table.name}.${name} has CONSTRAINT without a name`);
      pendingConstraintName = constraintName;
      i += 2;
    } else if (keyword(tokens[i], 'not') && keyword(tokens[i + 1], 'null')) {
      column.nullable = false;
      pendingConstraintName = undefined;
      i += 2;
    } else if (keyword(tokens[i], 'null')) {
      column.nullable = true;
      pendingConstraintName = undefined;
      i += 1;
    } else if (keyword(tokens[i], 'default')) {
      let next = nextConstraint(tokens, i + 1, end);
      // NULL is both a constraint keyword and a valid DEFAULT expression.
      if (next === i + 1 && keyword(tokens[next], 'null')) next = nextConstraint(tokens, next + 1, end);
      if (next === i + 1) fail(`column ${table.name}.${name} has DEFAULT without an expression`);
      pendingConstraintName = undefined;
      i = next;
    } else if (keyword(tokens[i], 'primary') && keyword(tokens[i + 1], 'key')) {
      setPrimaryKey(table, [name], pendingConstraintName);
      pendingConstraintName = undefined;
      i += 2;
    } else if (keyword(tokens[i], 'unique')) {
      addUniqueConstraint(table, [name], pendingConstraintName);
      pendingConstraintName = undefined;
      i += 1;
    } else if (keyword(tokens[i], 'check')) {
      // The predicate is accepted but not modelled. A CHECK cannot change the column
      // set, keys, indexes or nullability, which are the only things the analysis
      // reads, so skipping it loses nothing while letting a real dump through.
      if (tokens[i + 1]?.value !== '(') fail(`column ${table.name}.${name} has CHECK without a condition`);
      i = matchingParen(tokens, i + 1, end) + 1;
      pendingConstraintName = undefined;
    } else if (keyword(tokens[i], 'generated')) {
      // GENERATED ... AS IDENTITY is implicitly NOT NULL; GENERATED ... AS (expr)
      // STORED is an ordinary nullable column whose value happens to be computed.
      let j = i + 1;
      if (keyword(tokens[j], 'always')) j += 1;
      else if (keyword(tokens[j], 'by') && keyword(tokens[j + 1], 'default')) j += 2;
      else fail(`column ${table.name}.${name} has GENERATED without ALWAYS or BY DEFAULT`);
      if (!keyword(tokens[j], 'as')) fail(`column ${table.name}.${name} has GENERATED without AS`);
      j += 1;
      if (keyword(tokens[j], 'identity')) {
        column.nullable = false;
        j += 1;
        // Optional sequence options: IDENTITY ( START WITH 1 ... )
        if (tokens[j]?.value === '(') j = matchingParen(tokens, j, end) + 1;
      } else if (tokens[j]?.value === '(') {
        j = matchingParen(tokens, j, end) + 1;
        if (!keyword(tokens[j], 'stored')) fail(`column ${table.name}.${name} has a generated expression without STORED`);
        j += 1;
      } else {
        fail(`column ${table.name}.${name} has an unsupported GENERATED form`);
      }
      pendingConstraintName = undefined;
      i = j;
    } else if (keyword(tokens[i], 'references')) {
      const reference = parseReference(tokens, i + 1, end);
      table.foreignKeys ??= [];
      table.foreignKeys.push({ columns: [name], referencesTable: reference.table, referencesColumns: reference.columns });
      const suffixEnd = referenceSuffixEnd(tokens, reference.next, end);
      pendingConstraintName = undefined;
      i = suffixEnd;
    } else {
      const construct = tokens[i]?.raw ?? 'constraint';
      fail(`column ${table.name}.${name} uses unsupported construct ${construct}`);
    }
  }
}

function parseTableConstraint(tokens: Token[], start: number, end: number, table: MutableTable): void {
  let i = start;
  let constraintName: string | undefined;
  if (keyword(tokens[i], 'constraint')) {
    constraintName = identifier(tokens[i + 1]);
    if (!constraintName) fail(`table ${table.name} has CONSTRAINT without a name`);
    i += 2;
  }
  if (keyword(tokens[i], 'primary') && keyword(tokens[i + 1], 'key')) {
    if (tokens[i + 2]?.value !== '(') fail(`PRIMARY KEY on ${table.name} must contain a column list`);
    const close = matchingParen(tokens, i + 2, end);
    if (close + 1 !== end) fail(`PRIMARY KEY on ${table.name} has unsupported trailing options`);
    setPrimaryKey(table, parseIdentifierList(tokens, i + 2, close, 'PRIMARY KEY'), constraintName);
    return;
  }
  if (keyword(tokens[i], 'unique')) {
    if (tokens[i + 1]?.value !== '(') fail(`UNIQUE on ${table.name} must contain a column list`);
    const close = matchingParen(tokens, i + 1, end);
    // NULLS [NOT] DISTINCT and index parameters are deliberately not accepted:
    // rejecting is better than parsing them into something we did not model.
    if (close + 1 !== end) fail(`UNIQUE on ${table.name} has unsupported trailing options`);
    addUniqueConstraint(table, parseIdentifierList(tokens, i + 1, close, 'UNIQUE'), constraintName);
    return;
  }
  if (keyword(tokens[i], 'foreign') && keyword(tokens[i + 1], 'key')) {
    if (tokens[i + 2]?.value !== '(') fail(`FOREIGN KEY on ${table.name} must contain a column list`);
    const localClose = matchingParen(tokens, i + 2, end);
    const columns = parseIdentifierList(tokens, i + 2, localClose, 'FOREIGN KEY');
    if (!keyword(tokens[localClose + 1], 'references')) fail(`FOREIGN KEY on ${table.name} is missing REFERENCES`);
    const reference = parseReference(tokens, localClose + 2, end);
    if (reference.columns.length && reference.columns.length !== columns.length) {
      fail(`FOREIGN KEY on ${table.name} has mismatched local and referenced column counts`);
    }
    if (referenceSuffixEnd(tokens, reference.next, end) !== end) {
      fail(`FOREIGN KEY on ${table.name} has unsupported trailing options`);
    }
    table.foreignKeys ??= [];
    table.foreignKeys.push({ columns, referencesTable: reference.table, referencesColumns: reference.columns });
    return;
  }
  if (keyword(tokens[i], 'check')) {
    // Accepted but not modelled -- see the column-level CHECK note.
    if (tokens[i + 1]?.value !== '(') fail(`CHECK on ${table.name} must contain a condition`);
    if (matchingParen(tokens, i + 1, end) + 1 !== end) fail(`CHECK on ${table.name} has unsupported trailing options`);
    return;
  }
  const construct = tokens[i]?.raw ?? 'constraint';
  fail(`table ${table.name} uses unsupported table constraint ${construct}`);
}

/** Claim each of a table's index names for its schema, rejecting a reused name. */
function registerIndexes(state: ParseState, schema: string, table: MutableTable, from = 0): void {
  for (const index of table.indexes.slice(from)) {
    const normalized = `${schema}.${index.name}`.toLowerCase();
    if (state.indexes.has(normalized)) fail(`index ${index.name} is declared more than once`);
    state.indexes.set(normalized, table.name);
  }
}

/**
 * `PARTITION BY {RANGE|LIST|HASH} (key, ...)`. Returns the partition key columns.
 *
 * Expression keys are recorded separately: PostgreSQL allows no unique constraint at
 * all on a table partitioned by an expression, so they are not merely "no columns".
 */
function parsePartitionBy(tokens: Token[], at: number, end: number, table: MutableTable): PartitionKey {
  // `at` indexes the PARTITION keyword, so BY is at +1 and the method at +2.
  const method = tokens[at + 2];
  if (!keyword(method, 'range') && !keyword(method, 'list') && !keyword(method, 'hash')) {
    fail(`PARTITION BY on ${table.name} must use RANGE, LIST, or HASH`);
  }
  const open = at + 3;
  if (tokens[open]?.value !== '(') fail(`PARTITION BY on ${table.name} must contain a key`);
  const close = matchingParen(tokens, open, end);
  if (close + 1 !== end) fail(`PARTITION BY on ${table.name} has unsupported trailing options`);

  const columns: string[] = [];
  let hasExpression = false;
  for (const [start, stop] of splitTopLevel(tokens, open + 1, close)) {
    const name = stop === start + 1 ? identifier(tokens[start]) : undefined;
    if (name === undefined) hasExpression = true;
    else columns.push(name);
  }
  if (columns.length === 0 && !hasExpression) fail(`PARTITION BY on ${table.name} must name at least one key`);
  return { columns, hasExpression };
}

/**
 * PostgreSQL refuses a primary key or unique constraint on a partitioned table unless
 * it contains every partition key column, because it cannot enforce uniqueness across
 * partitions otherwise.
 *
 * Checking it here matters because uniqueness is what the join fan-out proof reads:
 * accepting a constraint PostgreSQL itself would reject would make SQLSage assert a
 * relation is unique when the real database could hold duplicates.
 */
function checkPartitionedUniqueness(table: MutableTable, key: PartitionKey | undefined): void {
  if (!key || (key.columns.length === 0 && !key.hasExpression)) return;
  for (const index of table.indexes) {
    if (!index.unique) continue;
    if (key.hasExpression) {
      // PostgreSQL cannot match a unique constraint against an expression key, so it
      // permits none at all. Accepting one would let SQLSage assert a uniqueness the
      // real database never enforces.
      fail(
        `unique constraint ${index.name} is not allowed on ${table.name}, which is ` +
        'partitioned by an expression',
      );
    }
    const covered = index.columns.map((column) => column.toLowerCase());
    const missing = key.columns.filter((column) => !covered.includes(column.toLowerCase()));
    if (missing.length) {
      fail(
        `unique constraint ${index.name} on partitioned table ${table.name} must include ` +
        `partition key column${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`,
      );
    }
  }
}

function createTable(statement: string, tokens: Token[], state: ParseState): void {
  let i = 2;
  if (keyword(tokens[i], 'if') && keyword(tokens[i + 1], 'not') && keyword(tokens[i + 2], 'exists')) i += 3;
  const qualified = parseQualifiedName(tokens, i);
  if (!qualified) fail('CREATE TABLE must name a table');
  const resolved = resolveTableName(qualified, state.currentSchema);
  i = qualified.next;
  const identity = tableIdentity(resolved.schema, resolved.name);
  if (state.tables.has(identity)) fail(`table ${resolved.schema}.${resolved.name} is declared more than once`);

  // `CREATE TABLE child PARTITION OF parent ...` has no column list of its own.
  if (keyword(tokens[i], 'partition') && keyword(tokens[i + 1], 'of')) {
    createPartitionOf(tokens, i + 2, resolved, identity, state);
    return;
  }

  if (tokens[i]?.value !== '(') fail(`CREATE TABLE ${resolved.name} must use an explicit column list`);
  const close = matchingParen(tokens, i);

  let partitionKey: PartitionKey | undefined;
  const table: MutableTable = { schema: resolved.schema, name: resolved.name, columns: [], indexes: [] };
  if (close !== tokens.length - 1) {
    if (!keyword(tokens[close + 1], 'partition') || !keyword(tokens[close + 2], 'by')) {
      fail(`CREATE TABLE ${resolved.name} has unsupported trailing options`);
    }
    partitionKey = parsePartitionBy(tokens, close + 1, tokens.length, table);
  }

  for (const [start, end] of splitTopLevel(tokens, i + 1, close)) {
    const first = tokens[start];
    if (isTableConstraintStart(first)) parseTableConstraint(tokens, start, end, table);
    else parseColumn(statement, tokens, start, end, table);
  }
  if (!table.columns.length) fail(`table ${resolved.name} has no columns`);
  for (const column of partitionKey?.columns ?? []) {
    if (!table.columns.some((candidate) => candidate.name.toLowerCase() === column.toLowerCase())) {
      fail(`PARTITION BY on ${resolved.name} references unknown column ${column}`);
    }
  }
  checkPartitionedUniqueness(table, partitionKey);

  state.tables.set(identity, table);
  if (partitionKey) state.partitionKeys.set(identity, partitionKey);
  registerIndexes(state, resolved.schema, table);
}

/**
 * A declarative partition is a queryable relation in its own right, so it becomes its
 * own table with the parent's columns and primary key copied in — which is what
 * PostgreSQL materialises on each partition.
 *
 * Note the asymmetry that makes this safe: a unique index declared on one partition is
 * unique only within that partition. Modelling partitions as separate tables keeps that
 * true, where merging them into the parent would over-claim uniqueness.
 */
function createPartitionOf(
  tokens: Token[],
  at: number,
  resolved: { schema: string; name: string },
  identity: string,
  state: ParseState,
): void {
  const parentName = parseQualifiedName(tokens, at);
  if (!parentName) fail(`PARTITION OF on ${resolved.name} must name a parent table`);
  const parentResolved = resolveTableName(parentName, state.currentSchema);
  const parent = state.tables.get(tableIdentity(parentResolved.schema, parentResolved.name));
  if (!parent) {
    fail(`${resolved.name} is declared PARTITION OF unknown table ${parentResolved.schema}.${parentResolved.name}; declare the parent first`);
  }

  const table: MutableTable = {
    schema: resolved.schema,
    name: resolved.name,
    columns: parent.columns.map((column) => ({ ...column })),
    indexes: [],
  };
  if (parent.primaryKey) {
    table.primaryKey = [...parent.primaryKey];
    table.indexes.push({
      name: `${resolved.name}_pkey`,
      table: resolved.name,
      columns: [...parent.primaryKey],
      unique: true,
      method: 'btree',
      expressions: [],
    });
  }
  if (parent.foreignKeys) table.foreignKeys = parent.foreignKeys.map((key) => ({ ...key }));

  state.tables.set(identity, table);
  registerIndexes(state, resolved.schema, table);
}

function rawItem(statement: string, tokens: Token[], start: number, end: number): string {
  return tokensText(statement, tokens, start, end).replace(/\s+/g, ' ').trim();
}

/**
 * Statements a `pg_dump --schema-only` file contains that carry nothing the analysis
 * reads. Skipping them is what lets a real dump be used directly.
 *
 * This is deliberately an **allowlist**, not a catch-all. Anything not named here still
 * fails loudly, because a parser that quietly ignores what it does not understand would
 * hand back a catalog that is silently missing keys or indexes — and every downstream
 * claim about uniqueness, nullability and fan-out would inherit that gap.
 *
 * Returns the reason it is ignorable, or undefined when the statement must be parsed.
 */
function ignorableStatement(tokens: Token[]): string | undefined {
  const at = (n: number) => tokens[n]?.value?.toLowerCase();
  const first = at(0);
  const second = at(1);

  // Ownership, permissions and comments never change the shape of the data.
  if (first === 'grant' || first === 'revoke') return 'permissions';
  if (first === 'comment' && second === 'on') return 'comment';
  if (first === 'alter' && second === 'default' && at(2) === 'privileges') return 'permissions';
  if (first === 'alter' && tokens.some((token) => token.value?.toLowerCase() === 'owner')) return 'ownership';

  // Sequences are reachable only through column defaults, which are already ignored.
  if ((first === 'create' || first === 'alter' || first === 'drop') && second === 'sequence') return 'sequence';

  // Extensions, types (including enums) and routines: a column typed by one of these
  // keeps the type name as an opaque string, which is all the analysis uses.
  if ((first === 'create' || first === 'drop') && second === 'extension') return 'extension';
  if ((first === 'create' || first === 'drop' || first === 'alter') && second === 'type') return 'type';
  if (first === 'create' && (second === 'function' || second === 'procedure' || second === 'trigger')) return 'routine';
  if (first === 'create' && second === 'or' && at(2) === 'replace' && at(3) !== 'view') return 'routine';

  // `SELECT pg_catalog.set_config(...)` appears in the dump preamble.
  if (first === 'select') return 'session setup';

  return undefined;
}

/**
 * One `ALTER TABLE` action. Constraint actions delegate to the same
 * `parseTableConstraint` used inside `CREATE TABLE`, so `ADD CONSTRAINT u UNIQUE (k)`
 * and an inline `UNIQUE (k)` cannot drift apart or disagree about naming.
 */
/**
 * Whether a CREATE TABLE element or ALTER TABLE ADD action is a table constraint
 * rather than a column definition.
 *
 * EXCLUDE and LIKE are listed even though neither is supported: without them the
 * element falls through to the column parser, which happily produced a phantom column
 * named "exclude" with data type "using gist(id with =)". Fail-closed only holds if
 * every constraint keyword is recognised here, so this list is shared by both call
 * sites rather than written out twice.
 */
function isTableConstraintStart(token: Token | undefined): boolean {
  return keyword(token, 'constraint') || keyword(token, 'primary') || keyword(token, 'foreign')
    || keyword(token, 'unique') || keyword(token, 'check') || keyword(token, 'exclude')
    || keyword(token, 'like');
}

function alterTableAction(statement: string, tokens: Token[], start: number, end: number, table: MutableTable): void {
  let i = start;

  if (keyword(tokens[i], 'add')) {
    i += 1;
    if (keyword(tokens[i], 'column')) {
      i += 1;
      if (keyword(tokens[i], 'if') && keyword(tokens[i + 1], 'not') && keyword(tokens[i + 2], 'exists')) i += 3;
      parseColumn(statement, tokens, i, end, table);
      return;
    }
    // `ADD COLUMN` may omit the COLUMN keyword; anything not constraint-shaped is a column.
    if (isTableConstraintStart(tokens[i])) parseTableConstraint(tokens, i, end, table);
    else parseColumn(statement, tokens, i, end, table);
    return;
  }

  if (keyword(tokens[i], 'alter')) {
    i += 1;
    if (keyword(tokens[i], 'column')) i += 1;
    const name = identifier(tokens[i]);
    if (name === undefined) fail(`ALTER TABLE ${table.name} has an invalid ALTER COLUMN action`);
    const column = table.columns.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!column) fail(`ALTER TABLE ${table.name} alters unknown column ${name}`);
    i += 1;
    if (keyword(tokens[i], 'set') && keyword(tokens[i + 1], 'not') && keyword(tokens[i + 2], 'null') && i + 3 === end) {
      column.nullable = false;
      return;
    }
    if (keyword(tokens[i], 'drop') && keyword(tokens[i + 1], 'not') && keyword(tokens[i + 2], 'null') && i + 3 === end) {
      // A column reachable by the primary key cannot become nullable.
      if (table.primaryKey?.some((key) => key.toLowerCase() === name.toLowerCase())) {
        fail(`ALTER TABLE ${table.name} cannot drop NOT NULL from primary key column ${name}`);
      }
      column.nullable = true;
      return;
    }
    // SET DEFAULT, TYPE changes and statistics targets do not affect the analysis,
    // but accepting them silently would imply we modelled them. Reject instead.
    fail(`ALTER TABLE ${table.name} has an unsupported ALTER COLUMN action on ${name}`);
  }

  // pg_dump emits the partition as a standalone CREATE TABLE and then attaches it, so
  // the child already exists as its own relation by the time this is reached. Only the
  // parent/child link is skipped, and that link carries nothing the analysis reads.
  if ((keyword(tokens[i], 'attach') || keyword(tokens[i], 'detach')) && keyword(tokens[i + 1], 'partition')) {
    return;
  }

  const action = tokens[start]?.raw ?? 'action';
  fail(`ALTER TABLE ${table.name} has unsupported action ${action}`);
}

/**
 * `ALTER TABLE` is applied to a table already declared in this file. Statement order
 * therefore matters, exactly as it does for PostgreSQL itself.
 */
function alterTable(statement: string, tokens: Token[], state: ParseState): void {
  let i = 2;
  if (keyword(tokens[i], 'if') && keyword(tokens[i + 1], 'exists')) i += 2;
  if (keyword(tokens[i], 'only')) i += 1;
  const qualified = parseQualifiedName(tokens, i);
  if (!qualified) fail('ALTER TABLE must name a table');
  const resolved = resolveTableName(qualified, state.currentSchema);
  const table = state.tables.get(tableIdentity(resolved.schema, resolved.name));
  if (!table) {
    fail(`ALTER TABLE refers to unknown table ${resolved.schema}.${resolved.name}; declare it with CREATE TABLE first`);
  }
  i = qualified.next;
  if (i >= tokens.length) fail(`ALTER TABLE ${resolved.name} has no action`);

  const knownIndexes = table.indexes.length;
  for (const [start, end] of splitTopLevel(tokens, i, tokens.length)) {
    alterTableAction(statement, tokens, start, end, table);
  }

  // Indexes implied by newly added constraints join the same duplicate-name check
  // CREATE TABLE and CREATE INDEX use, so a name can only be claimed once per schema.
  registerIndexes(state, resolved.schema, table, knownIndexes);
  checkPartitionedUniqueness(table, state.partitionKeys.get(tableIdentity(resolved.schema, resolved.name)));
}

/** Relations visible to a view's SELECT list, in FROM order. */
interface ViewSource {
  alias: string;
  table: MutableTable;
}

const SELECT_TAIL = new Set(['where', 'group', 'having', 'order', 'limit', 'offset', 'fetch', 'window', 'for']);

/**
 * Resolve a view's FROM clause to the tables already declared in this file.
 *
 * Deliberately narrow: a subquery or set operation in FROM, or a relation we have not
 * seen, is rejected rather than guessed at. A view whose columns we cannot resolve
 * faithfully is worse than no view at all, because every downstream claim about its
 * columns would rest on a guess.
 */
function parseViewSources(tokens: Token[], start: number, end: number, state: ParseState, viewName: string): ViewSource[] {
  const sources: ViewSource[] = [];
  let i = start;
  while (i < end) {
    if (tokens[i]?.value === '(') fail(`view ${viewName} selects from a subquery, which is not supported`);
    const qualified = parseQualifiedName(tokens, i);
    if (!qualified) fail(`view ${viewName} has an unresolvable FROM entry`);
    const resolved = resolveTableName(qualified, state.currentSchema);
    const table = state.tables.get(tableIdentity(resolved.schema, resolved.name));
    if (!table) {
      fail(`view ${viewName} selects from unknown relation ${resolved.schema}.${resolved.name}; declare it first`);
    }
    i = qualified.next;

    let alias = resolved.name;
    if (keyword(tokens[i], 'as')) i += 1;
    const candidate = identifier(tokens[i]);
    // A bare word here is an alias unless it starts the next clause.
    if (candidate !== undefined && !SELECT_TAIL.has(candidate) && !JOIN_WORDS.has(candidate) && candidate !== 'on' && candidate !== 'using') {
      alias = candidate;
      i += 1;
    }
    sources.push({ alias, table });

    // Skip to the next relation: past the join keywords and any ON/USING condition.
    while (i < end && !JOIN_WORDS.has(tokens[i]?.value ?? '') && tokens[i]?.value !== ',') i += 1;
    if (i >= end) break;
    if (tokens[i]?.value === ',') { i += 1; continue; }
    while (i < end && JOIN_WORDS.has(tokens[i]?.value ?? '')) i += 1;
  }
  if (sources.length === 0) fail(`view ${viewName} has no resolvable FROM relation`);
  return sources;
}

const JOIN_WORDS = new Set(['join', 'inner', 'left', 'right', 'full', 'cross', 'outer', 'natural', 'lateral']);

/**
 * Build the view's output columns from its SELECT list.
 *
 * Nullability is inherited **only** for a single-source view projecting a column
 * directly. Anything else reports nullable, because a view column's nullability is a
 * property of the whole query -- an outer join, aggregate or CASE can introduce NULLs
 * that the source column's declaration does not show. Over-claiming NOT NULL would
 * corrupt the null-rejection analysis; under-claiming only costs a weaker verdict.
 */
function parseViewColumns(
  tokens: Token[],
  selectStart: number,
  selectEnd: number,
  sources: ViewSource[],
  viewName: string,
): Column[] {
  const single = sources.length === 1;
  const columns: Column[] = [];

  const findSource = (alias: string): ViewSource | undefined =>
    sources.find((source) => source.alias.toLowerCase() === alias.toLowerCase()
      || source.table.name.toLowerCase() === alias.toLowerCase());

  const push = (name: string, dataType: string, nullable: boolean) => {
    if (columns.some((column) => column.name.toLowerCase() === name.toLowerCase())) {
      fail(`view ${viewName} produces column ${name} more than once`);
    }
    columns.push({ name, dataType, nullable });
  };

  for (const [start, end] of splitTopLevel(tokens, selectStart, selectEnd)) {
    // `*` and `t.*`
    if (tokens[start]?.value === '*' && end === start + 1) {
      for (const source of sources) {
        for (const column of source.table.columns) push(column.name, column.dataType, single ? column.nullable : true);
      }
      continue;
    }
    if (end === start + 3 && tokens[start + 1]?.value === '.' && tokens[start + 2]?.value === '*') {
      const alias = identifier(tokens[start]);
      const source = alias === undefined ? undefined : findSource(alias);
      if (!source) fail(`view ${viewName} expands ${alias ?? '?'}.* from an unknown relation`);
      for (const column of source.table.columns) push(column.name, column.dataType, single ? column.nullable : true);
      continue;
    }

    // Trailing `[AS] alias`
    let stop = end;
    let alias: string | undefined;
    if (end - start >= 2 && keyword(tokens[end - 2], 'as')) {
      alias = identifier(tokens[end - 1]);
      stop = end - 2;
    }

    // A direct column reference: `col` or `rel.col`.
    const direct = stop === start + 1
      ? { rel: undefined, col: identifier(tokens[start]) }
      : stop === start + 3 && tokens[start + 1]?.value === '.'
        ? { rel: identifier(tokens[start]), col: identifier(tokens[start + 2]) }
        : undefined;

    if (direct?.col !== undefined) {
      const candidates = direct.rel === undefined
        ? sources.filter((source) => source.table.columns.some((c) => c.name.toLowerCase() === direct.col!.toLowerCase()))
        : [findSource(direct.rel)].filter(Boolean) as ViewSource[];
      if (candidates.length === 0) fail(`view ${viewName} selects unknown column ${direct.rel ? `${direct.rel}.` : ''}${direct.col}`);
      if (candidates.length > 1) fail(`view ${viewName} selects ambiguous column ${direct.col}`);
      const column = candidates[0]!.table.columns.find((c) => c.name.toLowerCase() === direct.col!.toLowerCase());
      if (!column) fail(`view ${viewName} selects unknown column ${direct.rel}.${direct.col}`);
      push(alias ?? column.name, column.dataType, single ? column.nullable : true);
      continue;
    }

    // A computed expression. Its type is not inferable without a planner, so it is
    // recorded as unknown rather than guessed; an alias is required to name it.
    if (alias === undefined) {
      fail(`view ${viewName} has a computed output column without an AS alias, so it cannot be named`);
    }
    push(alias, 'unknown', true);
  }

  if (columns.length === 0) fail(`view ${viewName} produces no columns`);
  return columns;
}

function createView(tokens: Token[], state: ParseState, materialized: boolean): void {
  let i = materialized ? 3 : 2;
  if (keyword(tokens[i], 'if') && keyword(tokens[i + 1], 'not') && keyword(tokens[i + 2], 'exists')) i += 3;
  const qualified = parseQualifiedName(tokens, i);
  if (!qualified) fail('CREATE VIEW must name a view');
  const resolved = resolveTableName(qualified, state.currentSchema);
  const identity = tableIdentity(resolved.schema, resolved.name);
  i = qualified.next;

  let declaredNames: string[] | undefined;
  if (tokens[i]?.value === '(') {
    const close = matchingParen(tokens, i);
    declaredNames = parseIdentifierList(tokens, i, close, 'view column list');
    i = close + 1;
  }
  if (!keyword(tokens[i], 'as')) fail(`view ${resolved.name} must use AS before its query`);
  i += 1;
  if (keyword(tokens[i], 'with')) fail(`view ${resolved.name} uses a CTE, which is not supported`);
  if (!keyword(tokens[i], 'select')) fail(`view ${resolved.name} must be defined by a SELECT`);
  i += 1;
  if (keyword(tokens[i], 'distinct')) i += 1;

  // Locate FROM, and the end of the FROM clause.
  let from = -1;
  let depth = 0;
  for (let j = i; j < tokens.length; j += 1) {
    const value = tokens[j]!.value;
    if (value === '(') depth += 1;
    else if (value === ')') depth -= 1;
    else if (depth === 0 && (value === 'union' || value === 'intersect' || value === 'except')) {
      fail(`view ${resolved.name} uses a set operation, which is not supported`);
    } else if (depth === 0 && value === 'from' && from === -1) from = j;
  }
  if (from === -1) fail(`view ${resolved.name} must select FROM a relation`);

  let fromEnd = tokens.length;
  depth = 0;
  for (let j = from + 1; j < tokens.length; j += 1) {
    const value = tokens[j]!.value;
    if (value === '(') depth += 1;
    else if (value === ')') depth -= 1;
    else if (depth === 0 && SELECT_TAIL.has(value)) { fromEnd = j; break; }
  }

  const sources = parseViewSources(tokens, from + 1, fromEnd, state, resolved.name);
  let columns = parseViewColumns(tokens, i, from, sources, resolved.name);

  if (declaredNames) {
    if (declaredNames.length !== columns.length) {
      fail(`view ${resolved.name} declares ${declaredNames.length} column names but its query produces ${columns.length}`);
    }
    columns = columns.map((column, index) => ({ ...column, name: declaredNames![index]! }));
  }

  const existing = state.tables.get(identity);
  if (existing && existing.kind === undefined) fail(`table ${resolved.schema}.${resolved.name} is declared more than once`);
  const table: MutableTable = {
    schema: resolved.schema,
    name: resolved.name,
    kind: materialized ? 'materialized-view' : 'view',
    columns,
    indexes: [],
  };
  state.tables.set(identity, table);
}

function createIndex(statement: string, tokens: Token[], state: ParseState): void {
  let i = 1;
  let unique = false;
  if (keyword(tokens[i], 'unique')) {
    unique = true;
    i += 1;
  }
  if (!keyword(tokens[i], 'index')) fail('unsupported CREATE statement');
  i += 1;
  if (keyword(tokens[i], 'concurrently')) fail('CREATE INDEX CONCURRENTLY is not supported in schema imports');
  if (keyword(tokens[i], 'if') && keyword(tokens[i + 1], 'not') && keyword(tokens[i + 2], 'exists')) i += 3;
  const indexName = parseQualifiedName(tokens, i);
  if (!indexName) fail('CREATE INDEX must name an index');
  if (indexName.parts.length > 2) fail('three-part index names are not supported');
  i = indexName.next;
  if (!keyword(tokens[i], 'on')) fail('CREATE INDEX is missing ON');
  i += 1;
  if (keyword(tokens[i], 'only')) fail('CREATE INDEX ON ONLY is not supported in schema imports');
  const tableName = parseQualifiedName(tokens, i);
  if (!tableName) fail('CREATE INDEX ON must name a table');
  const resolved = resolveTableName(tableName, state.currentSchema);
  const table = state.tables.get(tableIdentity(resolved.schema, resolved.name));
  if (!table) fail(`CREATE INDEX references unknown table ${resolved.schema}.${resolved.name}`);
  i = tableName.next;

  let method: IndexDef['method'] = 'btree';
  if (keyword(tokens[i], 'using')) {
    const namedMethod = identifier(tokens[i + 1])?.toLowerCase() as IndexDef['method'] | undefined;
    if (!namedMethod || !INDEX_METHODS.has(namedMethod)) fail(`CREATE INDEX uses unsupported access method ${tokens[i + 1]?.raw ?? ''}`);
    method = namedMethod;
    i += 2;
  }
  if (tokens[i]?.value !== '(') fail('CREATE INDEX must contain a key list');
  const keyClose = matchingParen(tokens, i);
  const keys = splitTopLevel(tokens, i + 1, keyClose).map(([start, end]) => rawItem(statement, tokens, start, end));
  if (!keys.length || keys.some((key) => !key)) fail('CREATE INDEX key list cannot be empty');
  i = keyClose + 1;

  let includeColumns: string[] | undefined;
  if (keyword(tokens[i], 'include')) {
    if (tokens[i + 1]?.value !== '(') fail('CREATE INDEX INCLUDE must contain a column list');
    const includeClose = matchingParen(tokens, i + 1);
    includeColumns = parseIdentifierList(tokens, i + 1, includeClose, 'CREATE INDEX INCLUDE');
    i = includeClose + 1;
  }
  let where: string | undefined;
  if (keyword(tokens[i], 'where')) {
    where = rawItem(statement, tokens, i + 1, tokens.length);
    if (!where) fail('CREATE INDEX WHERE is missing a predicate');
    i = tokens.length;
  }
  if (i !== tokens.length) fail(`CREATE INDEX has unsupported trailing construct ${tokens[i]?.raw ?? ''}`);

  const bareIndexName = indexName.parts.at(-1)!;
  const indexSchema = indexName.parts.length === 2 ? indexName.parts[0]! : resolved.schema;
  const normalizedIndex = `${indexSchema}.${bareIndexName}`.toLowerCase();
  if (state.indexes.has(normalizedIndex)) fail(`index ${bareIndexName} is declared more than once`);
  const simpleIdentifier = /^(?:[a-z_][a-z0-9_$]*|"(?:[^"]|"")+")(?:\s+(?:asc|desc)(?:\s+nulls\s+(?:first|last))?)?$/i;
  const expressions = keys.filter((key) => !simpleIdentifier.test(key));
  table.indexes.push({
    name: bareIndexName,
    table: table.name,
    columns: keys,
    includeColumns,
    unique,
    method,
    where,
    expressions,
  });
  state.indexes.set(normalizedIndex, table.name);
}

function createSchema(tokens: Token[]): void {
  let i = 2;
  if (keyword(tokens[i], 'if') && keyword(tokens[i + 1], 'not') && keyword(tokens[i + 2], 'exists')) i += 3;
  const name = identifier(tokens[i]);
  if (!name) fail('CREATE SCHEMA must name a schema');
  if (i + 1 !== tokens.length) fail('CREATE SCHEMA options are not supported');
}

function dropSchema(tokens: Token[]): void {
  let i = 2;
  if (keyword(tokens[i], 'if') && keyword(tokens[i + 1], 'exists')) i += 2;
  if (!identifier(tokens[i])) fail('DROP SCHEMA must name a schema');
  i += 1;
  if (keyword(tokens[i], 'cascade') || keyword(tokens[i], 'restrict')) i += 1;
  if (i !== tokens.length) fail('DROP SCHEMA contains unsupported options');
}

function setSearchPath(tokens: Token[], state: ParseState): void {
  // Dumps open with SET statement_timeout, default_table_access_method and friends.
  // Only search_path changes how names resolve, so every other parameter is skipped.
  if (!keyword(tokens[1], 'search_path')) return;
  if (!keyword(tokens[2], 'to') && tokens[2]?.value !== '=') fail('SET search_path must use TO or =');
  const schemas: string[] = [];
  for (const [start, end] of splitTopLevel(tokens, 3, tokens.length)) {
    if (end !== start + 1) fail('SET search_path contains an invalid schema name');
    const name = identifier(tokens[start]);
    if (name === undefined) fail('SET search_path contains an invalid schema name');
    schemas.push(name);
  }
  if (schemas.some((schema) => schema.toLowerCase() === 'default')) {
    fail('SET search_path TO DEFAULT cannot be resolved without a live PostgreSQL role');
  }
  const selected = schemas.find((schema) => schema.toLowerCase() !== 'public' && schema !== '$user') ?? schemas[0];
  if (!selected) fail('SET search_path must name at least one schema');
  state.currentSchema = selected;
}

function finalize(state: ParseState): Catalog {
  if (!state.tables.size) fail('schema does not define any tables');
  const tables = [...state.tables.values()];
  for (const table of tables) {
    const columns = new Set(table.columns.map((column) => column.name.toLowerCase()));
    for (const foreignKey of table.foreignKeys ?? []) {
      for (const column of foreignKey.columns) {
        if (!columns.has(column.toLowerCase())) fail(`foreign key on ${table.name} references unknown local column ${column}`);
      }
      const candidates = tables.filter((candidate) => candidate.name.toLowerCase() === foreignKey.referencesTable.toLowerCase());
      if (candidates.length !== 1) fail(`foreign key on ${table.name} references unknown or ambiguous table ${foreignKey.referencesTable}`);
      const target = candidates[0]!;
      if (!foreignKey.referencesColumns.length) {
        if (!target.primaryKey) fail(`foreign key on ${table.name} omits referenced columns but ${target.name} has no primary key`);
        foreignKey.referencesColumns = [...target.primaryKey];
      }
      if (foreignKey.columns.length !== foreignKey.referencesColumns.length) {
        fail(`foreign key on ${table.name} has mismatched local and referenced column counts`);
      }
      const targetColumns = new Set(target.columns.map((column) => column.name.toLowerCase()));
      for (const column of foreignKey.referencesColumns) {
        if (!targetColumns.has(column.toLowerCase())) fail(`foreign key on ${table.name} references unknown column ${target.name}.${column}`);
      }
    }
    for (const index of table.indexes) {
      for (const key of index.columns) {
        if (/^[a-z_][a-z0-9_$]*$/i.test(key) && !columns.has(key.toLowerCase())) {
          fail(`index ${index.name} references unknown column ${table.name}.${key}`);
        }
      }
      for (const include of index.includeColumns ?? []) {
        if (!columns.has(include.toLowerCase())) fail(`index ${index.name} INCLUDE references unknown column ${table.name}.${include}`);
      }
    }
  }
  return {
    dialect: 'postgres',
    tables: tables.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/** Parse supported PostgreSQL DDL into SQLSage's offline catalog shape. */
export function parseSchemaCatalog(sql: string): Catalog {
  if (typeof sql !== 'string' || !sql.trim()) fail('schema SQL is empty');
  const state: ParseState = { currentSchema: 'public', tables: new Map(), indexes: new Map(), partitionKeys: new Map() };
  const statements = splitStatements(sql);
  for (let position = 0; position < statements.length; position += 1) {
    const statement = statements[position]!;
    const tokens = tokenize(statement);
    const number = position + 1;
    try {
      if (ignorableStatement(tokens)) continue;
      if (keyword(tokens[0], 'drop') && keyword(tokens[1], 'schema')) {
        dropSchema(tokens);
        continue;
      }
      if (keyword(tokens[0], 'create') && keyword(tokens[1], 'schema')) createSchema(tokens);
      else if (keyword(tokens[0], 'set')) setSearchPath(tokens, state);
      else if (keyword(tokens[0], 'create') && keyword(tokens[1], 'table')) createTable(statement, tokens, state);
      else if (keyword(tokens[0], 'create') && (keyword(tokens[1], 'index') || keyword(tokens[1], 'unique'))) {
        createIndex(statement, tokens, state);
      } else if (keyword(tokens[0], 'create') && keyword(tokens[1], 'view')) {
        createView(tokens, state, false);
      } else if (keyword(tokens[0], 'create') && keyword(tokens[1], 'materialized') && keyword(tokens[2], 'view')) {
        createView(tokens, state, true);
      } else if (keyword(tokens[0], 'create') && keyword(tokens[1], 'or') && keyword(tokens[2], 'replace')
                 && keyword(tokens[3], 'view')) {
        createView(tokens.slice(2), state, false);
      } else if (keyword(tokens[0], 'alter') && keyword(tokens[1], 'table')) {
        alterTable(statement, tokens, state);
      } else {
        const description = tokens.slice(0, 3).map((token) => token.raw).join(' ');
        statementFail(number, `unsupported statement ${description || '(empty)'}`);
      }
    } catch (error) {
      if (error instanceof SchemaInputError) {
        if (/^schema statement \d+:/.test(error.message)) throw error;
        throw new SchemaInputError(`schema statement ${number}: ${error.message}`);
      }
      throw error;
    }
  }
  return finalize(state);
}

/** Load a UTF-8 PostgreSQL schema file and parse it without connecting to a database. */
export async function loadSchemaCatalog(path: string): Promise<Catalog> {
  let sql: string;
  try {
    sql = await readFile(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SchemaInputError(`could not read schema ${path}: ${detail}`);
  }
  return parseSchemaCatalog(sql);
}
