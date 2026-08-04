/**
 * Expression shape analysis.
 *
 * The binder needs to answer, over and over: "is this operand a *bare* column,
 * or is something wrapped around it?" That single question drives sargability,
 * so it is worth doing once, precisely, in one place.
 */
import type { Expr, ExprCall, ExprRef, SelectStatement } from 'pgsql-ast-parser';
import type { Source } from './text.ts';

// ---------------------------------------------------------------------------
// Wrappers: anything sitting between the comparison operator and the column.
// ---------------------------------------------------------------------------

export type Wrapper =
  | { kind: 'function'; label: string; name: string; argCount: number }
  | { kind: 'cast'; label: string; to: string }
  | { kind: 'member'; label: string; op: '->' | '->>' }
  | { kind: 'arith'; label: string; op: string }
  | { kind: 'extract'; label: string; field: string }
  | { kind: 'other'; label: string };

export interface Operand {
  /** Every column reference under this operand, excluding nested subqueries. */
  refs: ExprRef[];
  /** Wrappers between the top of the operand and its single column, if any. */
  wrappers: Wrapper[];
  /** Set when the operand is literally a column reference and nothing else. */
  bare?: ExprRef;
  /** Set when exactly one column sits under a non-empty wrapper chain. */
  wrapped?: ExprRef;
  containsSubquery: boolean;
  /** No columns and no subquery: a literal, a cast of a literal, a parameter. */
  constant: boolean;
  /** A bound parameter appears somewhere ($1, :name). */
  hasParameter: boolean;
  /** Literal value when the operand is a plain string/number literal. */
  literal?: { value: string | number | boolean; type: 'string' | 'number' | 'boolean' };
}

const SUBQUERY_TYPES = new Set(['select', 'union', 'union all', 'with', 'with recursive', 'values']);

function isSubquery(e: Expr): e is SelectStatement {
  return SUBQUERY_TYPES.has((e as { type?: string }).type ?? '');
}

/** Decompose an operand into (column, wrappers) plus constant-ness. */
export function analyzeOperand(expr: Expr | null | undefined): Operand {
  const op: Operand = {
    refs: [],
    wrappers: [],
    containsSubquery: false,
    constant: false,
    hasParameter: false,
  };
  if (!expr) return op;

  // Walk the *spine* first: as long as there is exactly one child that could
  // hold a column, record the wrapper and descend.
  let node: Expr = expr;
  const spine: Wrapper[] = [];
  for (;;) {
    const t = (node as { type?: string }).type;
    if (t === 'cast') {
      const c = node as { to: { name: string }; operand: Expr };
      spine.push({ kind: 'cast', label: `::${c.to?.name ?? '?'}`, to: c.to?.name ?? '?' });
      node = c.operand;
      continue;
    }
    if (t === 'member') {
      const m = node as { op: '->' | '->>'; member: string | number; operand: Expr };
      spine.push({ kind: 'member', label: `${m.op}'${m.member}'`, op: m.op });
      node = m.operand;
      continue;
    }
    if (t === 'extract') {
      const x = node as { field: { name: string }; from: Expr };
      spine.push({ kind: 'extract', label: `extract(${x.field?.name ?? '?'} from ...)`, field: x.field?.name ?? '?' });
      node = x.from;
      continue;
    }
    if (t === 'call') {
      const c = node as ExprCall;
      const columnArgs = (c.args ?? []).filter((a) => containsColumn(a));
      spine.push({
        kind: 'function',
        label: `${qname(c.function)}()`,
        name: qname(c.function),
        argCount: c.args?.length ?? 0,
      });
      if (columnArgs.length === 1) {
        node = columnArgs[0]!;
        continue;
      }
      break; // zero or many column args: not a single-column wrapper chain
    }
    if (t === 'binary') {
      const b = node as { op: string; left: Expr; right: Expr };
      if (ARITH_OPS.has(b.op)) {
        const withCol = [b.left, b.right].filter((s) => containsColumn(s));
        spine.push({ kind: 'arith', label: `${b.op}`, op: b.op });
        if (withCol.length === 1) {
          node = withCol[0]!;
          continue;
        }
      } else if (b.op === 'AT TIME ZONE') {
        spine.push({ kind: 'other', label: 'AT TIME ZONE' });
        node = b.left;
        continue;
      }
      break;
    }
    if (t === 'unary') {
      const u = node as { op: string; operand: Expr };
      if (u.op === '-' || u.op === '+') {
        spine.push({ kind: 'arith', label: u.op, op: u.op });
        node = u.operand;
        continue;
      }
      break;
    }
    break;
  }

  collect(expr, op);
  op.constant = op.refs.length === 0 && !op.containsSubquery;

  if ((expr as { type?: string }).type === 'ref' && (expr as ExprRef).name !== '*') {
    op.bare = expr as ExprRef;
  } else if (op.refs.length === 1 && spine.length > 0 && (node as { type?: string }).type === 'ref') {
    op.wrapped = node as ExprRef;
    op.wrappers = spine;
  } else if (op.refs.length >= 1 && spine.length > 0) {
    op.wrappers = spine;
  }

  const lit = literalOf(expr);
  if (lit) op.literal = lit;
  return op;
}

const ARITH_OPS = new Set(['+', '-', '*', '/', '%', '||', '^', '#', '&', '|', '<<', '>>']);

function collect(e: Expr | null | undefined, out: Operand): void {
  if (!e || typeof e !== 'object') return;
  const t = (e as { type?: string }).type;
  if (t === 'ref') {
    if ((e as ExprRef).name !== '*') out.refs.push(e as ExprRef);
    return;
  }
  if (t === 'parameter') {
    out.hasParameter = true;
    return;
  }
  if (isSubquery(e)) {
    out.containsSubquery = true;
    return; // do not descend: inner columns belong to the inner block
  }
  for (const key of Object.keys(e)) {
    if (key === '_location' || key === 'type' || key === 'function' || key === 'table') continue;
    const v = (e as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) for (const x of v) collect(x as Expr, out);
    else if (v && typeof v === 'object') collect(v as Expr, out);
  }
}

function containsColumn(e: Expr | null | undefined): boolean {
  const probe: Operand = { refs: [], wrappers: [], containsSubquery: false, constant: false, hasParameter: false };
  collect(e, probe);
  return probe.refs.length > 0;
}

function literalOf(e: Expr): Operand['literal'] {
  const t = (e as { type?: string }).type;
  if (t === 'string') return { value: (e as { value: string }).value, type: 'string' };
  if (t === 'integer' || t === 'numeric') return { value: (e as { value: number }).value, type: 'number' };
  if (t === 'boolean') return { value: (e as { value: boolean }).value, type: 'boolean' };
  if (t === 'cast') return literalOf((e as { operand: Expr }).operand);
  return undefined;
}

export function qname(n: { name: string; schema?: string } | undefined): string {
  if (!n) return '?';
  return n.schema && n.schema !== 'pg_catalog' ? `${n.schema}.${n.name}` : n.name;
}

/** Render a wrapper chain as prose: "date_trunc() and a cast to date". */
export function describeWrappers(ws: Wrapper[]): string {
  const parts = ws.map((w) => {
    switch (w.kind) {
      case 'function':
        return `the function ${w.name}()`;
      case 'cast':
        return `a cast to ${w.to}`;
      case 'member':
        return `the jsonb accessor ${w.op}`;
      case 'arith':
        return `arithmetic (${w.op})`;
      case 'extract':
        return `extract(${w.field})`;
      default:
        return w.label;
    }
  });
  if (parts.length === 1) return parts[0]!;
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]!;
}

// ---------------------------------------------------------------------------
// Type facts used for cast reasoning.
// ---------------------------------------------------------------------------

export function normalizeType(t: string | undefined): string {
  if (!t) return '';
  const base = t.toLowerCase().replace(/\(.*\)$/, '').trim();
  switch (base) {
    case 'timestamp with time zone':
      return 'timestamptz';
    case 'timestamp without time zone':
      return 'timestamp';
    case 'time with time zone':
      return 'timetz';
    case 'time without time zone':
      return 'time';
    case 'character varying':
      return 'varchar';
    case 'character':
      return 'bpchar';
    case 'double precision':
      return 'float8';
    default:
      return base;
  }
}

const INTEGER_TYPES = new Set(['smallint', 'integer', 'int', 'int2', 'int4', 'int8', 'bigint']);
const TEXTY = new Set(['text', 'varchar', 'bpchar', 'char', 'name', 'citext']);

export function isInteger(t: string | undefined): boolean {
  return INTEGER_TYPES.has(normalizeType(t));
}
export function isTexty(t: string | undefined): boolean {
  return TEXTY.has(normalizeType(t));
}

/**
 * Casts whose result depends on a session setting, so they are STABLE rather
 * than IMMUTABLE and therefore cannot appear in an expression index at all.
 * Keyed `from->to`; anything not listed is treated as unknown, not as unsafe.
 */
const STABLE_CASTS = new Set([
  'timestamptz->date',
  'timestamptz->timestamp',
  'timestamptz->time',
  'timestamptz->text',
  'timestamptz->varchar',
  'timestamp->timestamptz',
  'date->timestamptz',
  'time->timetz',
  'timetz->time',
]);

export function castIsSessionDependent(from: string | undefined, to: string | undefined): boolean {
  if (!from || !to) return false;
  return STABLE_CASTS.has(`${normalizeType(from)}->${normalizeType(to)}`);
}

/**
 * Casts PostgreSQL performs with no work at all — `pg_cast.castmethod = 'b'`.
 * The value's on-disk representation is unchanged, so the column is still
 * effectively bare and an ordinary index on it remains usable.
 *
 * Confirmed on PostgreSQL 16.14: with a btree on a `text` column,
 * `WHERE email::varchar = 'u7@x.com'` plans as `Index Scan`, and so does
 * `WHERE code::text = 'c7'` on a `varchar` column. Treating these as
 * non-sargable produced a performance finding advising the reader to remove a
 * cast that costs nothing and blocks nothing.
 *
 * Taken from `SELECT castsource::regtype, casttarget::regtype FROM pg_cast
 * WHERE castmethod = 'b'`, restricted to types this analyzer can see in a
 * catalog. Lossy casts — `timestamptz::date`, `bigint::text` — are not here,
 * and both genuinely fall back to a sequential scan.
 */
const BINARY_COERCIBLE_CASTS = new Set([
  'varchar->text', 'text->varchar',
  'varchar->bpchar', 'text->bpchar',
  'xml->text', 'xml->varchar', 'xml->bpchar',
  'bit->varbit', 'varbit->bit',
  'cidr->inet',
]);

export function castIsBinaryCoercible(from: string | undefined, to: string | undefined): boolean {
  if (!from || !to) return false;
  const source = normalizeType(from);
  const target = normalizeType(to);
  // A cast to the column's own type is a no-op, whatever the type is.
  return source === target || BINARY_COERCIBLE_CASTS.has(`${source}->${target}`);
}

/**
 * Common PostgreSQL functions whose volatility rules affect expression-index
 * advice. This is intentionally narrow: unknown functions stay unknown rather
 * than being labelled immutable. A STABLE expression cannot be indexed.
 */

export function functionIsSessionDependent(
  name: string,
  argType: string | undefined,
  argCount?: number,
): boolean {
  const fn = name.toLowerCase();
  const type = normalizeType(argType);
  if (fn === 'to_char') return true; // PostgreSQL marks every to_char overload STABLE.
  if (fn === 'age') return argCount === 1; // two-timestamp age() is IMMUTABLE.
  if (fn === 'date_trunc') {
    // The PG 16 three-argument timestamptz overload pins the zone and is
    // IMMUTABLE; the ordinary two-argument timestamptz overload reads TimeZone.
    return type === 'timestamptz' && (argCount === undefined || argCount < 3);
  }
  if (fn === 'date_part') return type === 'timestamptz';
  if (fn === 'date') return type === 'timestamptz';
  return false;
}

// ---------------------------------------------------------------------------
// LIKE pattern analysis.
// ---------------------------------------------------------------------------

export interface PatternShape {
  /** 'exact': no wildcards. 'prefix': wildcards, but not at position 0. */
  shape: 'exact' | 'prefix' | 'infix';
  /** The literal characters before the first wildcard. */
  prefix: string;
}

/** Classify a LIKE pattern, honouring the default backslash escape. */
export function analyzePattern(pattern: string): PatternShape {
  let prefix = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      if (i + 1 < pattern.length) {
        prefix += pattern[i + 1];
        i++;
        continue;
      }
      prefix += ch;
      continue;
    }
    if (ch === '%' || ch === '_') {
      return { shape: prefix.length === 0 ? 'infix' : 'prefix', prefix };
    }
    prefix += ch;
  }
  return { shape: 'exact', prefix };
}

/** Literal prefix of an anchored POSIX regex, or undefined when unanchored. */
export function regexPrefix(pattern: string): string | undefined {
  if (!pattern.startsWith('^')) return undefined;
  let prefix = '';
  for (let i = 1; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if ('.*+?[]{}()|\\$'.includes(ch)) break;
    prefix += ch;
  }
  return prefix.length > 0 ? prefix : undefined;
}

// ---------------------------------------------------------------------------
// Aggregates and window functions.
// ---------------------------------------------------------------------------

const AGGREGATE_NAMES = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'stddev', 'stddev_pop', 'stddev_samp',
  'variance', 'var_pop', 'var_samp', 'bool_and', 'bool_or', 'every',
  'array_agg', 'string_agg', 'json_agg', 'jsonb_agg', 'json_object_agg',
  'jsonb_object_agg', 'bit_and', 'bit_or', 'xmlagg', 'corr', 'covar_pop',
  'covar_samp', 'regr_slope', 'regr_intercept', 'percentile_cont',
  'percentile_disc', 'mode', 'range_agg', 'range_intersect_agg',
]);

/** Window-only functions: these are never aggregates without OVER. */
const WINDOW_ONLY = new Set([
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile',
  'lag', 'lead', 'first_value', 'last_value', 'nth_value',
]);

export function isWindowCall(c: ExprCall): boolean {
  return !!c.over || WINDOW_ONLY.has(qname(c.function).toLowerCase());
}

export function isAggregateCall(c: ExprCall): boolean {
  if (c.over) return false; // an aggregate with OVER is a window function
  const name = qname(c.function).toLowerCase();
  if (AGGREGATE_NAMES.has(name)) return true;
  // Aggregate-only syntax proves it even for a user-defined aggregate.
  return !!(c.distinct || c.filter || c.withinGroup || (c.orderBy && c.orderBy.length > 0));
}

/** Walk an expression, invoking `fn` on every call node outside subqueries. */
export function forEachCall(e: Expr | null | undefined, fn: (c: ExprCall) => void): void {
  if (!e || typeof e !== 'object') return;
  const t = (e as { type?: string }).type;
  if (isSubquery(e as Expr)) return;
  if (t === 'call') fn(e as ExprCall);
  for (const key of Object.keys(e)) {
    if (key === '_location' || key === 'type' || key === 'function' || key === 'table') continue;
    const v = (e as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) for (const x of v) forEachCall(x as Expr, fn);
    else if (v && typeof v === 'object') forEachCall(v as Expr, fn);
  }
}

/** Does this expression contain an aggregate call at this nesting level? */
export function containsAggregate(e: Expr | null | undefined): boolean {
  let found = false;
  forEachCall(e, (c) => {
    if (isAggregateCall(c)) found = true;
  });
  return found;
}

/** Every subquery that appears directly inside this expression. */
export function subqueriesIn(e: Expr | null | undefined, out: SelectStatement[] = []): SelectStatement[] {
  if (!e || typeof e !== 'object') return out;
  if (isSubquery(e as Expr)) {
    out.push(e as SelectStatement);
    return out;
  }
  for (const key of Object.keys(e)) {
    if (key === '_location' || key === 'type' || key === 'table') continue;
    const v = (e as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) for (const x of v) subqueriesIn(x as Expr, out);
    else if (v && typeof v === 'object') subqueriesIn(v as Expr, out);
  }
  return out;
}

/** Flatten `a AND b AND c` into its conjuncts, leaving OR/NOT intact. */
export function conjuncts(e: Expr | null | undefined, out: Expr[] = []): Expr[] {
  if (!e) return out;
  const n = e as { type?: string; op?: string; left?: Expr; right?: Expr };
  if (n.type === 'binary' && n.op === 'AND') {
    conjuncts(n.left, out);
    conjuncts(n.right, out);
    return out;
  }
  out.push(e);
  return out;
}

/** Flatten `a OR b OR c` into its disjuncts. */
export function disjuncts(e: Expr | null | undefined, out: Expr[] = []): Expr[] {
  if (!e) return out;
  const n = e as { type?: string; op?: string; left?: Expr; right?: Expr };
  if (n.type === 'binary' && n.op === 'OR') {
    disjuncts(n.left, out);
    disjuncts(n.right, out);
    return out;
  }
  out.push(e);
  return out;
}

/** Convenience: source text of a node, trimmed. */
export function textOf(src: Source, node: unknown): string {
  return src.of(node);
}
