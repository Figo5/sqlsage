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

interface ParseState {
  currentSchema: string;
  tables: Map<string, MutableTable>;
  indexes: Map<string, string>;
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
      const tag = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) fail('schema contains dollar-quoted SQL, which the offline importer does not support');
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
  const construct = tokens[i]?.raw ?? 'constraint';
  fail(`table ${table.name} uses unsupported table constraint ${construct}`);
}

function createTable(statement: string, tokens: Token[], state: ParseState): void {
  let i = 2;
  if (keyword(tokens[i], 'if') && keyword(tokens[i + 1], 'not') && keyword(tokens[i + 2], 'exists')) i += 3;
  const qualified = parseQualifiedName(tokens, i);
  if (!qualified) fail('CREATE TABLE must name a table');
  const resolved = resolveTableName(qualified, state.currentSchema);
  i = qualified.next;
  if (tokens[i]?.value !== '(') fail(`CREATE TABLE ${resolved.name} must use an explicit column list`);
  const close = matchingParen(tokens, i);
  if (close !== tokens.length - 1) fail(`CREATE TABLE ${resolved.name} has unsupported trailing options`);
  const identity = tableIdentity(resolved.schema, resolved.name);
  if (state.tables.has(identity)) fail(`table ${resolved.schema}.${resolved.name} is declared more than once`);

  const table: MutableTable = { schema: resolved.schema, name: resolved.name, columns: [], indexes: [] };
  for (const [start, end] of splitTopLevel(tokens, i + 1, close)) {
    const first = tokens[start];
    const isConstraint = keyword(first, 'constraint') || keyword(first, 'primary')
      || keyword(first, 'foreign') || keyword(first, 'unique') || keyword(first, 'check');
    if (isConstraint) parseTableConstraint(tokens, start, end, table);
    else parseColumn(statement, tokens, start, end, table);
  }
  if (!table.columns.length) fail(`table ${resolved.name} has no columns`);
  state.tables.set(identity, table);
  for (const index of table.indexes) {
    const normalized = `${resolved.schema}.${index.name}`.toLowerCase();
    if (state.indexes.has(normalized)) fail(`index ${index.name} is declared more than once`);
    state.indexes.set(normalized, resolved.name);
  }
}

function rawItem(statement: string, tokens: Token[], start: number, end: number): string {
  return tokensText(statement, tokens, start, end).replace(/\s+/g, ' ').trim();
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
  if (!keyword(tokens[1], 'search_path')) fail(`unsupported SET parameter ${tokens[1]?.raw ?? ''}`);
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
  const state: ParseState = { currentSchema: 'public', tables: new Map(), indexes: new Map() };
  const statements = splitStatements(sql);
  for (let position = 0; position < statements.length; position += 1) {
    const statement = statements[position]!;
    const tokens = tokenize(statement);
    const number = position + 1;
    try {
      if (keyword(tokens[0], 'drop') && keyword(tokens[1], 'schema')) {
        dropSchema(tokens);
        continue;
      }
      if (keyword(tokens[0], 'create') && keyword(tokens[1], 'schema')) createSchema(tokens);
      else if (keyword(tokens[0], 'set')) setSearchPath(tokens, state);
      else if (keyword(tokens[0], 'create') && keyword(tokens[1], 'table')) createTable(statement, tokens, state);
      else if (keyword(tokens[0], 'create') && (keyword(tokens[1], 'index') || keyword(tokens[1], 'unique'))) {
        createIndex(statement, tokens, state);
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
