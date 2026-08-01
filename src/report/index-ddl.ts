/**
 * Runtime recognition for the executable subset of PostgreSQL CREATE INDEX
 * accepted at the M7 boundary.
 *
 * This is deliberately not a prefix check. The lexer understands PostgreSQL
 * comments, quoted identifiers, string literals, and dollar-quoted text so a
 * semicolon only terminates the statement when it is actually executable.
 * The recognizer then checks the CREATE INDEX skeleton and the optional clauses
 * SQLSage emits. It is narrower than PostgreSQL's full grammar, but every value
 * it accepts is one complete CREATE INDEX statement rather than arbitrary SQL.
 */

import { parse } from 'pgsql-ast-parser';

type TokenKind = 'word' | 'quoted-ident' | 'string' | 'dollar-string' | 'number' | 'symbol' | 'operator';

interface Token {
  kind: TokenKind;
  text: string;
  value: string;
}

interface Lexed {
  ok: true;
  tokens: Token[];
}

interface LexFailure {
  ok: false;
  reason: string;
}

export type CreateIndexRecognition =
  | { valid: true; concurrently: boolean; indexName?: string }
  | { valid: false; reason: string };

function token(kind: TokenKind, text: string, value = text): Token {
  return { kind, text, value };
}

function isWordStart(ch: string | undefined): boolean {
  return !!ch && (/[A-Za-z_]/.test(ch) || ch.charCodeAt(0) >= 0x80);
}

function isWordPart(ch: string | undefined): boolean {
  return !!ch && (/[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80);
}

function scanSingleQuoted(source: string, quote: number, backslashEscapes: boolean): number | undefined {
  let i = quote + 1;
  while (i < source.length) {
    if (source[i] === "'") {
      if (source[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    if (backslashEscapes && source[i] === '\\') {
      if (i + 1 >= source.length) return undefined;
      i += 2;
      continue;
    }
    i++;
  }
  return undefined;
}

function scanDoubleQuoted(source: string, quote: number): number | undefined {
  let i = quote + 1;
  while (i < source.length) {
    if (source[i] === '"') {
      if (source[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return undefined;
}

function lexCreateIndex(source: string): Lexed | LexFailure {
  const tokens: Token[] = [];
  let i = 0;
  let terminated = false;

  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '-' && source[i + 1] === '-') {
      let lineEnd = i + 2;
      while (lineEnd < source.length && source[lineEnd] !== '\n' && source[lineEnd] !== '\r') lineEnd++;
      i = lineEnd < source.length ? lineEnd + 1 : source.length;
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) return { ok: false, reason: 'unterminated block comment' };
      continue;
    }

    if (terminated) {
      return { ok: false, reason: 'executable text follows the terminating semicolon' };
    }

    if (ch === ';') {
      terminated = true;
      i++;
      continue;
    }

    if ((ch === 'e' || ch === 'E') && source[i + 1] === "'") {
      return { ok: false, reason: 'escape string literals are outside the supported CREATE INDEX subset' };
    }

    if ((ch === 'u' || ch === 'U') && source[i + 1] === '&' && source[i + 2] === "'") {
      return { ok: false, reason: 'Unicode-escape literals are outside the supported CREATE INDEX subset' };
    }

    if ((ch === 'u' || ch === 'U') && source[i + 1] === '&' && source[i + 2] === '"') {
      return { ok: false, reason: 'Unicode-escape identifiers are outside the supported CREATE INDEX subset' };
    }

    if (ch === "'") {
      const end = scanSingleQuoted(source, i, false);
      if (end === undefined) return { ok: false, reason: 'unterminated string literal' };
      tokens.push(token('string', source.slice(i, end)));
      i = end;
      continue;
    }

    if (ch === '"') {
      const end = scanDoubleQuoted(source, i);
      if (end === undefined) return { ok: false, reason: 'unterminated quoted identifier' };
      const raw = source.slice(i, end);
      tokens.push(token('quoted-ident', raw, raw.slice(1, -1).replace(/""/g, '"')));
      i = end;
      continue;
    }

    if (ch === '$') {
      const opener = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(i))?.[0];
      if (opener) {
        const close = source.indexOf(opener, i + opener.length);
        if (close < 0) return { ok: false, reason: 'unterminated dollar-quoted string' };
        const end = close + opener.length;
        tokens.push(token('dollar-string', source.slice(i, end)));
        i = end;
        continue;
      }
    }

    if (isWordStart(ch)) {
      let end = i + 1;
      while (isWordPart(source[end])) end++;
      const raw = source.slice(i, end);
      tokens.push(token('word', raw));
      i = end;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (/[A-Za-z0-9_.]/.test(source[end] ?? '')) end++;
      tokens.push(token('number', source.slice(i, end)));
      i = end;
      continue;
    }

    if ('(),.'.includes(ch)) {
      tokens.push(token('symbol', ch));
      i++;
      continue;
    }

    let end = i + 1;
    while (end < source.length && !/\s/.test(source[end]) && !'(),.;\'"'.includes(source[end])) {
      if ((source[end] === '-' && source[end + 1] === '-') || (source[end] === '/' && source[end + 1] === '*')) break;
      end++;
    }
    tokens.push(token('operator', source.slice(i, end)));
    i = end;
  }

  return { ok: true, tokens };
}

function keyword(value: Token | undefined, expected: string): boolean {
  return value?.kind === 'word' && value.text.toUpperCase() === expected;
}

// PostgreSQL's `name`/`ColId` production accepts ordinary identifiers plus
// unreserved and column-name keywords.  Type/function-name and fully reserved
// keywords are not identifiers in these positions.  This is the PG16 set from
// `pg_get_keywords()` (categories T and R), kept local so validation never
// depends on a live database.
const PG16_NON_COLID_KEYWORDS = new Set([
  'ALL', 'ANALYSE', 'ANALYZE', 'AND', 'ANY', 'ARRAY', 'AS', 'ASC', 'ASYMMETRIC',
  'AUTHORIZATION', 'BINARY', 'BOTH', 'CASE', 'CAST', 'CHECK', 'COLLATE',
  'COLLATION', 'COLUMN', 'CONCURRENTLY', 'CONSTRAINT', 'CREATE', 'CROSS',
  'CURRENT_CATALOG', 'CURRENT_DATE', 'CURRENT_ROLE', 'CURRENT_SCHEMA',
  'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'CURRENT_USER', 'DEFAULT', 'DEFERRABLE',
  'DESC', 'DISTINCT', 'DO', 'ELSE', 'END', 'EXCEPT', 'FALSE', 'FETCH', 'FOR',
  'FOREIGN', 'FREEZE', 'FROM', 'FULL', 'GRANT', 'GROUP', 'HAVING', 'ILIKE',
  'IN', 'INITIALLY', 'INNER', 'INTERSECT', 'INTO', 'IS', 'ISNULL', 'JOIN',
  'LATERAL', 'LEADING', 'LEFT', 'LIKE', 'LIMIT', 'LOCALTIME', 'LOCALTIMESTAMP',
  'NATURAL', 'NOT', 'NOTNULL', 'NULL', 'OFFSET', 'ON', 'ONLY', 'OR', 'ORDER',
  'OUTER', 'OVERLAPS', 'PLACING', 'PRIMARY', 'REFERENCES', 'RETURNING', 'RIGHT',
  'SELECT', 'SESSION_USER', 'SIMILAR', 'SOME', 'SYMMETRIC', 'SYSTEM_USER',
  'TABLE', 'TABLESAMPLE', 'THEN', 'TO', 'TRAILING', 'TRUE', 'UNION', 'UNIQUE',
  'USER', 'USING', 'VARIADIC', 'VERBOSE', 'WHEN', 'WHERE', 'WINDOW', 'WITH',
]);

function identifier(value: Token | undefined): boolean {
  if (value?.kind === 'quoted-ident') return value.value.length > 0 && !value.value.includes('\0');
  return value?.kind === 'word' && !PG16_NON_COLID_KEYWORDS.has(value.text.toUpperCase());
}

function qualifiedIdentifier(tokens: Token[], start: number): { next: number; name: string } | undefined {
  if (!identifier(tokens[start])) return undefined;
  const names = [tokens[start].value];
  let next = start + 1;
  while (tokens[next]?.text === '.') {
    if (!identifier(tokens[next + 1])) return undefined;
    names.push(tokens[next + 1].value);
    next += 2;
  }
  return { next, name: names.join('.') };
}

function matchingParen(tokens: Token[], open: number): number | undefined {
  if (tokens[open]?.text !== '(') return undefined;
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].text === '(') depth++;
    else if (tokens[i].text === ')') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

function splitTopLevel(tokens: Token[]): Token[][] | undefined {
  const parts: Token[][] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text === '(') depth++;
    else if (tokens[i].text === ')') {
      depth--;
      if (depth < 0) return undefined;
    } else if (tokens[i].text === ',' && depth === 0) {
      parts.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return undefined;
  parts.push(tokens.slice(start));
  return parts;
}

const INCOMPLETE_EXPRESSION_TAIL = new Set([
  'AND', 'OR', 'NOT', 'IS', 'IN', 'LIKE', 'ILIKE', 'SIMILAR', 'BETWEEN', 'COLLATE', 'AT',
]);

function plausibleExpression(tokens: Token[]): boolean {
  if (!tokens.length) return false;
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (first.text === ',' || first.text === ')' || last.text === ',' || last.text === '(' || last.text === '.') return false;
  if (last.kind === 'operator') return false;
  if (last.kind === 'word' && INCOMPLETE_EXPRESSION_TAIL.has(last.text.toUpperCase())) return false;
  return true;
}

function expressionList(tokens: Token[]): boolean {
  const parts = splitTopLevel(tokens);
  return !!parts && parts.length > 0 && parts.every(plausibleExpression);
}

function includeList(tokens: Token[]): boolean {
  const parts = splitTopLevel(tokens);
  return !!parts && parts.length > 0 && parts.every((part) => part.length === 1 && identifier(part[0]));
}

function storageParameterName(value: Token | undefined): boolean {
  // PostgreSQL uses ColLabel here, which includes every keyword.  This
  // supported subset permits one non-empty, unqualified label.
  return value?.kind === 'word' ||
    (value?.kind === 'quoted-ident' && value.value.length > 0 && !value.value.includes('\0'));
}

function storageParameterValue(value: Token | undefined): boolean {
  if (!value) return false;
  if (value.kind === 'word' || value.kind === 'string' || value.kind === 'dollar-string') return true;
  // The lexer intentionally keeps suspicious numeric spellings together.
  // Only a plain decimal literal belongs to the accepted storage subset.
  return value.kind === 'number' && /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.text);
}

function storageParameterList(tokens: Token[]): boolean {
  const parts = splitTopLevel(tokens);
  return !!parts && parts.length > 0 && parts.every((part) =>
    part.length === 3 &&
    storageParameterName(part[0]) &&
    part[1]?.kind === 'operator' &&
    part[1].text === '=' &&
    storageParameterValue(part[2]),
  );
}

function containsEmptyQuantifier(tokens: Token[]): boolean {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!['ANY', 'ALL', 'SOME'].some((candidate) => keyword(tokens[i], candidate))) continue;
    if (tokens[i + 1]?.text !== '(') continue;
    if (matchingParen(tokens, i + 1) === i + 2) return true;
  }
  return false;
}

function reject(reason: string): CreateIndexRecognition {
  return { valid: false, reason };
}

function parserTokenText(value: Token): string {
  // pgsql-ast-parser 12.0.2 does not understand PostgreSQL dollar quotes or
  // every PostgreSQL string payload. The lexer has already proved supported
  // strings terminate correctly, so normalize their payload while retaining
  // the surrounding expression grammar for the parser check. Unicode and
  // escape-string spellings are rejected before this point.
  if (value.kind === 'string' || value.kind === 'dollar-string') return "''";
  return value.text;
}

function parserAcceptsCore(
  tokens: Token[],
  keyClose: number,
  onlyPosition: number | undefined,
  wherePosition: number | undefined,
): boolean {
  // INCLUDE and NULLS [NOT] DISTINCT are valid PostgreSQL but unsupported by
  // pgsql-ast-parser 12.0.2. Parse a semantics-preserving core that retains the
  // full key expressions and partial predicate; the recognizer above checks the
  // omitted clause syntax and ordering itself. ONLY is also normalized because
  // the dependency parser does not implement it.
  const core = tokens
    .slice(0, keyClose + 1)
    .filter((_, position) => position !== onlyPosition);
  if (wherePosition !== undefined) core.push(...tokens.slice(wherePosition));
  try {
    const statements = parse(core.map(parserTokenText).join(' '));
    return statements.length === 1 && statements[0]?.type === 'create index';
  } catch {
    return false;
  }
}

/** Recognize one complete executable PostgreSQL CREATE INDEX statement. */
export function recognizeCreateIndexDdl(value: unknown): CreateIndexRecognition {
  if (typeof value !== 'string' || value.trim().length === 0) return reject('DDL is blank');
  if (!value.isWellFormed() || value.includes('\0')) return reject('DDL contains invalid Unicode text');
  const lexed = lexCreateIndex(value);
  if (!lexed.ok) return reject(lexed.reason);
  const tokens = lexed.tokens;
  if (!tokens.length) return reject('DDL contains only comments or whitespace');

  let pos = 0;
  if (!keyword(tokens[pos], 'CREATE')) return reject('statement does not begin with executable CREATE');
  pos++;
  if (keyword(tokens[pos], 'UNIQUE')) pos++;
  if (!keyword(tokens[pos], 'INDEX')) return reject('CREATE is not followed by INDEX');
  pos++;

  const concurrently = keyword(tokens[pos], 'CONCURRENTLY');
  if (concurrently) pos++;

  let ifNotExists = false;
  if (keyword(tokens[pos], 'IF')) {
    if (!keyword(tokens[pos + 1], 'NOT') || !keyword(tokens[pos + 2], 'EXISTS')) {
      return reject('IF must be followed by NOT EXISTS');
    }
    ifNotExists = true;
    pos += 3;
  }

  let indexName: string | undefined;
  if (!keyword(tokens[pos], 'ON')) {
    const parsedName = qualifiedIdentifier(tokens, pos);
    if (!parsedName) return reject('index name or ON clause is missing');
    indexName = parsedName.name;
    pos = parsedName.next;
  } else if (ifNotExists) {
    return reject('IF NOT EXISTS requires an index name');
  }

  if (!keyword(tokens[pos], 'ON')) return reject('ON clause is missing after the index name');
  pos++;
  const onlyPosition = keyword(tokens[pos], 'ONLY') ? pos : undefined;
  if (onlyPosition !== undefined) pos++;

  const table = qualifiedIdentifier(tokens, pos);
  if (!table) return reject('indexed table is missing after ON');
  pos = table.next;

  if (keyword(tokens[pos], 'USING')) {
    pos++;
    if (!identifier(tokens[pos])) return reject('USING method is missing');
    pos++;
  }

  if (tokens[pos]?.text !== '(') return reject('index key list is missing');
  const keyClose = matchingParen(tokens, pos);
  if (keyClose === undefined) return reject('index key list has unbalanced parentheses');
  const keyTokens = tokens.slice(pos + 1, keyClose);
  if (!expressionList(keyTokens)) return reject('index key list is empty or incomplete');
  if (containsEmptyQuantifier(keyTokens)) return reject('index key list contains an empty ANY, ALL, or SOME construct');
  pos = keyClose + 1;

  let clauseRank = 0;
  let wherePosition: number | undefined;
  const seen = new Set<string>();
  while (pos < tokens.length) {
    let clause: string;
    let rank: number;
    if (keyword(tokens[pos], 'INCLUDE')) {
      clause = 'INCLUDE'; rank = 1;
    } else if (keyword(tokens[pos], 'NULLS')) {
      clause = 'NULLS'; rank = 2;
    } else if (keyword(tokens[pos], 'WITH')) {
      clause = 'WITH'; rank = 3;
    } else if (keyword(tokens[pos], 'TABLESPACE')) {
      clause = 'TABLESPACE'; rank = 4;
    } else if (keyword(tokens[pos], 'WHERE')) {
      clause = 'WHERE'; rank = 5;
    } else {
      return reject(`unexpected token ${JSON.stringify(tokens[pos].text)} after the index definition`);
    }
    if (rank < clauseRank || seen.has(clause)) return reject(`${clause} clause is duplicated or out of order`);
    clauseRank = rank;
    seen.add(clause);
    if (clause === 'WHERE') wherePosition = pos;
    pos++;

    if (clause === 'INCLUDE' || clause === 'WITH') {
      if (tokens[pos]?.text !== '(') return reject(`${clause} clause is missing its parenthesized list`);
      const close = matchingParen(tokens, pos);
      if (close === undefined) return reject(`${clause} clause has unbalanced parentheses`);
      const content = tokens.slice(pos + 1, close);
      const valid = clause === 'INCLUDE' ? includeList(content) : storageParameterList(content);
      if (!valid) {
        return reject(clause === 'INCLUDE'
          ? 'INCLUDE list must contain PostgreSQL column identifiers'
          : 'WITH list must contain parameter = scalar-value items');
      }
      pos = close + 1;
      continue;
    }

    if (clause === 'NULLS') {
      if (keyword(tokens[pos], 'NOT')) pos++;
      if (!keyword(tokens[pos], 'DISTINCT')) return reject('NULLS must be followed by DISTINCT or NOT DISTINCT');
      pos++;
      continue;
    }

    if (clause === 'TABLESPACE') {
      if (!identifier(tokens[pos])) return reject('TABLESPACE name is missing');
      pos++;
      continue;
    }

    const predicate = tokens.slice(pos);
    if (!plausibleExpression(predicate) || splitTopLevel(predicate) === undefined) {
      return reject('WHERE predicate is empty, incomplete, or unbalanced');
    }
    if (containsEmptyQuantifier(predicate)) {
      return reject('WHERE predicate contains an empty ANY, ALL, or SOME construct');
    }
    pos = tokens.length;
  }

  if (!parserAcceptsCore(tokens, keyClose, onlyPosition, wherePosition)) {
    return reject('index key expression or WHERE predicate is not valid PostgreSQL syntax');
  }

  return { valid: true, concurrently, ...(indexName ? { indexName } : {}) };
}
