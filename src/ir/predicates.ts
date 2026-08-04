/**
 * Predicate classification and sargability.
 *
 * "Sargable" here means exactly what `types.ts` says: *an index on the
 * referenced column could satisfy this predicate*. Not "an index exists" —
 * whether one should exist is M5's job — and not "the planner will pick it".
 * The verdict is about whether the predicate's shape leaves the door open.
 *
 * The rules below are shape rules, applied to whatever shape appears. There is
 * no branching on table names, query text, or anything corpus-specific.
 */
import type { Expr, ExprCall, ExprRef, SelectStatement } from 'pgsql-ast-parser';
import { equalitySelectivity, findColumn } from '../catalog.ts';
import type { Catalog, Predicate, PredicateKind, ResolvedColumnRef } from '../types.ts';
import {
  analyzeOperand,
  analyzePattern,
  castIsBinaryCoercible,
  castIsSessionDependent,
  containsAggregate,
  describeWrappers,
  disjuncts,
  functionIsSessionDependent,
  isInteger,
  normalizeType,
  qname,
  regexPrefix,
  type Operand,
} from './expressions.ts';
import type { Source } from './text.ts';

export interface PredicateContext {
  source: Source;
  catalog: Catalog;
  /** Resolve one column reference node against the current scope chain. */
  resolveRef(node: ExprRef): ResolvedColumnRef;
}

export type Clause = Predicate['clause'];

interface Verdict {
  sargable: boolean;
  reason: string;
}

const COMPARISONS = new Set(['=', '<', '<=', '>', '>=']);
const NEGATED_COMPARISONS = new Set(['!=', '<>']);
/** Operators a GIN/GiST index answers directly, but a btree never does. */
const NON_BTREE_INDEXABLE: Record<string, string> = {
  '@>': 'containment (@>)',
  '<@': 'containment (<@)',
  '?': 'jsonb key existence (?)',
  '?|': 'jsonb key existence (?|)',
  '?&': 'jsonb key existence (?&)',
  '@@': 'full-text match (@@)',
  '&&': 'overlap (&&)',
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildPredicate(expr: Expr, clause: Clause, ctx: PredicateContext): Predicate {
  const sql = ctx.source.of(expr);
  const columns = resolveColumns(expr, ctx);
  const { kind, negated } = classify(expr, ctx);
  const verdict = assess(expr, ctx, kind);
  const pred: Predicate = {
    sql,
    kind,
    columns,
    sargable: verdict.sargable,
    sargableReason: verdict.reason,
    clause,
  };
  if (negated) pred.negated = true;
  if (containsAggregate(expr)) pred.hasAggregate = true;
  if (kind === 'equality' && !negated) recordEqualityOperands(expr, ctx, pred);
  const sel = estimateSelectivity(expr, ctx, kind, negated);
  if (sel !== undefined) pred.selectivity = clamp(sel);
  return pred;
}

/**
 * Capture the two sides of a plain `=` predicate so consumers can prove one
 * side is pinned to a single value without re-parsing or string surgery. Only
 * ever recorded for an actual binary `=`; join-shaped and `IN`/`ANY` equalities
 * are classified to other kinds before we get here.
 */
function recordEqualityOperands(expr: Expr, ctx: PredicateContext, pred: Predicate): void {
  const binary = expr as { type?: string; op?: string; left?: Expr; right?: Expr };
  if (binary.type !== 'binary' || binary.op !== '=' || !binary.left || !binary.right) return;
  const left = analyzeOperand(binary.left);
  const right = analyzeOperand(binary.right);
  pred.equalityOperands = {
    left: ctx.source.of(binary.left),
    right: ctx.source.of(binary.right),
    leftConstant: left.constant,
    rightConstant: right.constant,
  };
}

/** Every column reference in this predicate, excluding nested subqueries. */
export function resolveColumns(expr: Expr, ctx: PredicateContext): ResolvedColumnRef[] {
  const op = analyzeOperand(expr);
  const seen = new Set<string>();
  const out: ResolvedColumnRef[] = [];
  for (const node of op.refs) {
    const ref = ctx.resolveRef(node);
    const key = `${ref.alias ?? ''}.${ref.table ?? ''}.${ref.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** Distinct relation aliases a predicate touches locally. */
export function relationsTouched(cols: ResolvedColumnRef[]): string[] {
  const s = new Set<string>();
  for (const c of cols) if (c.alias && !c.unresolved) s.add(c.alias);
  return [...s];
}

// ---------------------------------------------------------------------------
// Kind
// ---------------------------------------------------------------------------

function classify(expr: Expr, ctx: PredicateContext): { kind: PredicateKind; negated: boolean } {
  const n = expr as Record<string, unknown> & { type?: string };
  // An aggregate anywhere in the condition means the condition is evaluated
  // after grouping; none of the shape-based kinds describe it usefully.
  if (containsAggregate(expr)) return { kind: 'other', negated: false };
  switch (n.type) {
    case 'binary': {
      const op = String(n.op);
      const left = analyzeOperand(n.left as Expr);
      const right = analyzeOperand(n.right as Expr);
      if (op === 'OR' || op === 'AND') return { kind: 'boolean', negated: false };
      if (op === 'IN' || op === 'NOT IN') {
        const kind: PredicateKind = right.containsSubquery ? 'subquery' : 'in-list';
        return { kind, negated: op === 'NOT IN' };
      }
      if (op === 'LIKE' || op === 'NOT LIKE' || op === 'ILIKE' || op === 'NOT ILIKE') {
        const pat = patternOf(n.right as Expr);
        const infix = pat === undefined || analyzePattern(pat).shape === 'infix';
        return { kind: infix ? 'like-infix' : 'like-prefix', negated: op.startsWith('NOT') };
      }
      if (op === '~' || op === '~*' || op === '!~' || op === '!~*') {
        const pat = patternOf(n.right as Expr);
        const anchored = pat !== undefined && regexPrefix(pat) !== undefined;
        return { kind: anchored ? 'like-prefix' : 'like-infix', negated: op.startsWith('!') };
      }
      if (left.containsSubquery || right.containsSubquery) return { kind: 'subquery', negated: false };
      if (COMPARISONS.has(op) || NEGATED_COMPARISONS.has(op)) {
        const negated = NEGATED_COMPARISONS.has(op);
        if (op === '=' || negated) {
          if (isAnyCall(n.right as Expr)) return { kind: 'in-list', negated };
          if (isJoinShaped(expr, ctx)) return { kind: 'join', negated };
          return { kind: 'equality', negated };
        }
        if (isJoinShaped(expr, ctx)) return { kind: 'join', negated: false };
        return { kind: 'range', negated: false };
      }
      if (NON_BTREE_INDEXABLE[op]) return { kind: 'containment', negated: false };
      return { kind: 'other', negated: false };
    }
    case 'ternary': {
      const op = String(n.op);
      return { kind: 'range', negated: op === 'NOT BETWEEN' };
    }
    case 'unary': {
      const op = String(n.op);
      if (op === 'IS NULL') return { kind: 'null-check', negated: false };
      if (op === 'IS NOT NULL') return { kind: 'null-check', negated: true };
      if (op.startsWith('IS ')) return { kind: 'boolean', negated: op.includes('NOT') || op.includes('FALSE') };
      if (op === 'NOT') {
        const inner = classify(n.operand as Expr, ctx);
        return { kind: inner.kind, negated: !inner.negated };
      }
      return { kind: 'other', negated: false };
    }
    case 'call': {
      const c = expr as ExprCall;
      if (qname(c.function).toLowerCase() === 'exists') return { kind: 'subquery', negated: false };
      if (containsAggregate(expr)) return { kind: 'other', negated: false };
      return { kind: 'boolean', negated: false };
    }
    case 'ref':
    case 'boolean':
      return { kind: 'boolean', negated: false };
    case 'select':
    case 'union':
    case 'union all':
      return { kind: 'subquery', negated: false };
    default:
      return { kind: 'other', negated: false };
  }
}

function isAnyCall(e: Expr | undefined): boolean {
  if (!e || (e as { type?: string }).type !== 'call') return false;
  const name = qname((e as ExprCall).function).toLowerCase();
  return name === 'any' || name === 'some' || name === 'all';
}

/** True when the two sides are bare columns of two different relations. */
function isJoinShaped(expr: Expr, ctx: PredicateContext): boolean {
  const n = expr as { left?: Expr; right?: Expr };
  const l = analyzeOperand(n.left);
  const r = analyzeOperand(n.right);
  if (!l.refs.length || !r.refs.length) return false;
  const la = new Set(l.refs.map((x) => ctx.resolveRef(x).alias));
  const ra = new Set(r.refs.map((x) => ctx.resolveRef(x).alias));
  for (const a of la) if (a !== undefined && !ra.has(a)) return [...ra].some((b) => b !== undefined && !la.has(b));
  return false;
}

// ---------------------------------------------------------------------------
// Sargability
// ---------------------------------------------------------------------------

function assess(expr: Expr, ctx: PredicateContext, kind: PredicateKind): Verdict {
  const n = expr as Record<string, unknown> & { type?: string };

  if (containsAggregate(expr)) {
    return {
      sargable: false,
      reason: 'this condition depends on an aggregate value that exists only after grouping, so no index on a base column can evaluate it.',
    };
  }

  switch (n.type) {
    case 'binary':
      return assessBinary(expr, String(n.op), ctx, kind);
    case 'ternary':
      return assessBetween(expr, ctx);
    case 'unary':
      return assessUnary(expr, ctx);
    case 'call': {
      const c = expr as ExprCall;
      const fname = qname(c.function).toLowerCase();
      if (fname === 'exists') {
        return {
          sargable: false,
          reason:
            'EXISTS is a semi-join, not a column comparison: no index on the outer query can serve it directly, ' +
            'though an index inside the subquery is what makes it cheap.',
        };
      }
      return {
        sargable: false,
        reason: `the predicate is the result of ${fname}(), so an index on a bare column cannot serve it; only an expression index on the identical expression could.`,
      };
    }
    case 'ref': {
      const ref = ctx.resolveRef(expr as ExprRef);
      return {
        sargable: !ref.unresolved,
        reason: ref.unresolved
          ? 'the boolean column did not resolve, so sargability cannot be determined.'
          : `a bare boolean column is a plain equality test, which a btree index on ${label(ref)} can answer.`,
      };
    }
    default:
      if (kind === 'subquery') {
        return { sargable: false, reason: 'a bare subquery is evaluated as a filter; no index on the enclosing relation applies.' };
      }
      return { sargable: false, reason: 'unrecognised predicate shape; declining to claim an index could serve it.' };
  }
}

function assessBinary(expr: Expr, op: string, ctx: PredicateContext, kind: PredicateKind): Verdict {
  const n = expr as { left: Expr; right: Expr };

  if (op === 'OR') return assessDisjunction(expr, ctx);
  if (op === 'AND') {
    // Only reached if a caller passed an unflattened conjunction.
    const parts = [n.left, n.right].map((p) => assess(p, ctx, kind));
    return {
      sargable: parts.every((p) => p.sargable),
      reason: `conjunction: ${parts.map((p) => (p.sargable ? 'sargable' : 'not sargable')).join(' AND ')}.`,
    };
  }

  const left = analyzeOperand(n.left);
  const right = analyzeOperand(n.right);

  // --- membership -------------------------------------------------------
  if (op === 'IN' || op === 'NOT IN') {
    if (right.containsSubquery) {
      const probe = bareSide(left, right, ctx);
      if (probe?.ref.unresolved) return unresolvedVerdict(probe.ref);
      if (op === 'NOT IN') {
        return {
          sargable: false,
          reason:
            'NOT IN against a subquery is applied as a SubPlan filter (hashed when the planner can fit it); no index on the outer column serves it directly. ' +
            'On PostgreSQL 16 a nullable subquery result also blocks conversion to an anti-join, unlike NOT EXISTS.',
        };
      }
      if (!probe) return wrappedVerdict(left, right, ctx, 'IN');
      if (!isCatalogColumn(ctx, probe.ref)) return derivedColumnVerdict(probe.ref);
      return {
        sargable: true,
        reason: `IN (subquery) is planned as a semi-join, so an index on ${label(probe.ref)} can be used when the subquery drives the loop; it is not a direct index condition.`,
      };
    }
    const probe = bareSide(left, right, ctx);
    if (!probe) return wrappedVerdict(left, right, ctx, op);
    if (probe.ref.unresolved) return unresolvedVerdict(probe.ref);
    if (!isCatalogColumn(ctx, probe.ref)) return derivedColumnVerdict(probe.ref);
    if (op === 'NOT IN') {
      return {
        sargable: false,
        reason: `NOT IN over a value list is the negation of a set of equalities, which has no contiguous btree range; Postgres applies it as a filter on ${label(probe.ref)}.`,
      };
    }
    if (!right.constant) {
      return {
        sargable: false,
        reason: `the IN list depends on another column in the same row, so it provides no row-independent values for an index on ${label(probe.ref)} to seek.`,
      };
    }
    return {
      sargable: true,
      reason: `IN over a constant list compiles to = ANY(...), which a btree index on ${label(probe.ref)} answers as a series of index conditions.`,
    };
  }

  // --- pattern matching -------------------------------------------------
  if (op === 'LIKE' || op === 'NOT LIKE' || op === 'ILIKE' || op === 'NOT ILIKE') {
    return assessLike(expr, op, ctx, left, right);
  }
  if (op === '~' || op === '~*' || op === '!~' || op === '!~*') {
    return assessRegex(expr, op, ctx, left, right);
  }

  // --- GIN/GiST operators ----------------------------------------------
  if (NON_BTREE_INDEXABLE[op]) {
    const probe = bareSide(left, right, ctx);
    if (!probe) return wrappedVerdict(left, right, ctx, op);
    if (probe.ref.unresolved) return unresolvedVerdict(probe.ref);
    if (!isCatalogColumn(ctx, probe.ref)) return derivedColumnVerdict(probe.ref);
    return {
      sargable: true,
      reason: `${NON_BTREE_INDEXABLE[op]} is not a btree operator, but a GIN (or GiST) index on ${label(probe.ref)} supports it directly.`,
    };
  }

  // --- subquery comparison ---------------------------------------------
  if (left.containsSubquery || right.containsSubquery) {
    const probe = bareSide(left, right, ctx);
    if (probe) {
      if (probe.ref.unresolved) return unresolvedVerdict(probe.ref);
      if (!isCatalogColumn(ctx, probe.ref)) return derivedColumnVerdict(probe.ref);
      return {
        sargable: false,
        reason: `${label(probe.ref)} is compared against a subquery result, which is not known until the subquery runs; Postgres evaluates this as a filter (a correlated subquery re-runs per row).`,
      };
    }
    return { sargable: false, reason: 'both sides depend on a subquery result, so no index condition can be formed.' };
  }

  // --- inequality -------------------------------------------------------
  if (NEGATED_COMPARISONS.has(op)) {
    const probe = bareSide(left, right, ctx);
    if (probe?.ref.unresolved) return unresolvedVerdict(probe.ref);
    if (probe && !isCatalogColumn(ctx, probe.ref)) return derivedColumnVerdict(probe.ref);
    const who = probe ? label(probe.ref) : 'the column';
    return {
      sargable: false,
      reason: `an inequality (${op}) selects everything outside one point, which is not a contiguous btree range; Postgres evaluates it as a filter on ${who} rather than as an index condition.`,
    };
  }

  // --- ordinary comparisons --------------------------------------------
  if (COMPARISONS.has(op)) {
    const probe = bareSide(left, right, ctx);
    if (!probe) return wrappedVerdict(left, right, ctx, op);
    if (probe.ref.unresolved) return unresolvedVerdict(probe.ref);
    if (!isCatalogColumn(ctx, probe.ref)) return derivedColumnVerdict(probe.ref);
    const other = probe.other;
    if (other.constant || other.hasParameter) {
      if (literalForcesColumnCast(probe.ref.dataType, other.literal)) {
        return {
          sargable: false,
          reason:
            `${label(probe.ref)} is an integer column but the comparison value is fractional, so PostgreSQL promotes the column to numeric; ` +
            `that implicit cast prevents a btree index on ${probe.ref.column} from becoming an index condition.`,
        };
      }
      return {
        sargable: true,
        reason: `${label(probe.ref)} appears bare on one side and is compared against a value that does not depend on the row, so a btree index with ${probe.ref.column} as its leading key can turn this into an index condition.`,
      };
    }
    // Other side is a column: join key if it belongs to a different relation.
    const otherAliases = new Set(other.refs.map((r) => ctx.resolveRef(r).alias));
    if (otherAliases.size === 1 && !otherAliases.has(probe.ref.alias)) {
      const otherRef = ctx.resolveRef(other.refs[0]!);
      if (other.bare) {
        const otherIsBase = isCatalogColumn(ctx, otherRef);
        return {
          sargable: true,
          reason:
            `${label(probe.ref)} and ${label(otherRef)} are both bare columns of different relations, so this is a join key: ` +
            (otherIsBase
              ? 'an index on either side can drive a nested-loop or merge join.'
              : `the catalog proves only ${label(probe.ref)} is a base-table column, so only an index on that side is established here.`),
        };
      }
      return {
        sargable: true,
        reason: `${label(probe.ref)} is bare and the other side, ${describeWrappers(other.wrappers) || 'an expression'} over ${label(otherRef)}, belongs to a different relation, so the value is a constant per outer row and an index on ${probe.ref.column} can probe it.`,
      };
    }
    return {
      sargable: false,
      reason: `both sides reference ${probe.ref.alias ?? 'the same relation'}, so there is no row-independent bound for an index on ${probe.ref.column} to seek to; the comparison is evaluated per row.`,
    };
  }

  return { sargable: false, reason: `operator ${op} is not one this binder can prove an index serves; declining to claim sargability.` };
}

function assessLike(
  expr: Expr,
  op: string,
  ctx: PredicateContext,
  left: Operand,
  right: Operand,
): Verdict {
  const n = expr as { left: Expr; right: Expr };
  const probe = bareSide(left, right, ctx);
  const caseInsensitive = op.includes('ILIKE');
  const negated = op.startsWith('NOT');

  if (!probe) return wrappedVerdict(left, right, ctx, op);
  if (probe.ref.unresolved) return unresolvedVerdict(probe.ref);
  if (!isCatalogColumn(ctx, probe.ref)) return derivedColumnVerdict(probe.ref);
  const who = label(probe.ref);

  if (negated) {
    return {
      sargable: false,
      reason: `NOT ${caseInsensitive ? 'ILIKE' : 'LIKE'} is the complement of a pattern match, which is not a contiguous btree range; it is always evaluated as a filter on ${who}.`,
    };
  }

  const pat = patternOf(n.right);
  if (pat === undefined) {
    return {
      sargable: false,
      reason: `the pattern is not a literal, so no prefix range can be derived at plan time and ${who} cannot be probed by a btree index.`,
    };
  }

  if (caseInsensitive) {
    return {
      sargable: false,
      reason: `ILIKE compares case-insensitively, which no plain btree index on ${who} orders by; a trigram (pg_trgm GIN) index or an index on lower(${probe.ref.column}) with a matching lower(...) predicate is required.`,
    };
  }

  const shape = analyzePattern(pat);
  if (shape.shape === 'infix') {
    return {
      sargable: false,
      reason: `the pattern '${pat}' begins with a wildcard, so there is no known prefix to seek to and a btree index on ${who} is useless; infix matching needs a trigram (pg_trgm GIN) index.`,
    };
  }
  if (shape.shape === 'exact') {
    return {
      sargable: true,
      reason: `the pattern '${pat}' contains no wildcards, so it is an equality test that a btree index on ${who} answers directly.`,
    };
  }
  return {
    sargable: true,
    reason:
      `the pattern '${pat}' has a trailing wildcard only, so it is the prefix range ${who} >= '${shape.prefix}' and < '${shape.prefix}' || high-byte, which a btree can seek — ` +
      'but only under the C collation or via an index declared with text_pattern_ops, because any other collation orders text differently from byte order.',
  };
}

function assessRegex(
  expr: Expr,
  op: string,
  ctx: PredicateContext,
  left: Operand,
  right: Operand,
): Verdict {
  const n = expr as { right: Expr };
  const probe = bareSide(left, right, ctx);
  if (!probe) return wrappedVerdict(left, right, ctx, op);
  if (probe.ref.unresolved) return unresolvedVerdict(probe.ref);
  if (!isCatalogColumn(ctx, probe.ref)) return derivedColumnVerdict(probe.ref);
  const who = label(probe.ref);
  if (op.startsWith('!')) {
    return { sargable: false, reason: `a negated regex match (${op}) has no contiguous btree range and is always a filter on ${who}.` };
  }
  if (op === '~*') {
    return { sargable: false, reason: `case-insensitive regex (~*) cannot use a btree index on ${who}; a trigram (pg_trgm GIN) index is the applicable structure.` };
  }
  const pat = patternOf(n.right);
  const prefix = pat === undefined ? undefined : regexPrefix(pat);
  if (prefix === undefined) {
    return {
      sargable: false,
      reason: `the regex is not anchored to a literal prefix, so no btree range can be derived for ${who}; a trigram (pg_trgm GIN) index is the applicable structure.`,
    };
  }
  return {
    sargable: true,
    reason: `the regex is anchored at '^${prefix}', which Postgres can turn into a prefix range on ${who} — but only with a text_pattern_ops btree index unless the database collation is C.`,
  };
}

function assessBetween(expr: Expr, ctx: PredicateContext): Verdict {
  const n = expr as { value: Expr; lo: Expr; hi: Expr; op: string };
  const value = analyzeOperand(n.value);
  const lo = analyzeOperand(n.lo);
  const hi = analyzeOperand(n.hi);
  const negated = n.op === 'NOT BETWEEN';

  if (!value.bare) {
    return wrappedVerdict(value, lo, ctx, n.op);
  }
  const ref = ctx.resolveRef(value.bare);
  if (ref.unresolved) return unresolvedVerdict(ref);
  if (!isCatalogColumn(ctx, ref)) return derivedColumnVerdict(ref);
  if (negated) {
    return {
      sargable: (lo.constant || lo.hasParameter) && (hi.constant || hi.hasParameter),
      reason:
        (lo.constant || lo.hasParameter) && (hi.constant || hi.hasParameter)
          ? `NOT BETWEEN is two disjoint ranges (${label(ref)} < lower OR ${label(ref)} > upper), which PostgreSQL can answer with two btree scans combined by BitmapOr; because the complement is often broad, the planner may still prefer a sequential scan.`
          : `the NOT BETWEEN bounds depend on other columns, so no row-independent btree ranges can be formed for ${label(ref)}.`,
    };
  }
  if (!(lo.constant || lo.hasParameter) || !(hi.constant || hi.hasParameter)) {
    return {
      sargable: false,
      reason: `the bounds of the BETWEEN depend on other columns, so there is no fixed range for an index on ${label(ref)} to seek.`,
    };
  }
  return {
    sargable: true,
    reason: `${label(ref)} appears bare between two row-independent bounds, which is exactly the contiguous range a btree index scan seeks (note BETWEEN is inclusive at both ends).`,
  };
}

function assessUnary(expr: Expr, ctx: PredicateContext): Verdict {
  const n = expr as { op: string; operand: Expr };
  const operand = analyzeOperand(n.operand);

  if (n.op === 'IS NULL' || n.op === 'IS NOT NULL') {
    if (!operand.bare) {
      return {
        sargable: false,
        reason: operand.wrappers.length
          ? `${describeWrappers(operand.wrappers)} wraps the column, so the NULL test is on a computed value that no index on the bare column covers.`
          : 'the NULL test is not on a bare column, so no index on a base column applies.',
      };
    }
    const ref = ctx.resolveRef(operand.bare);
    if (ref.unresolved) return unresolvedVerdict(ref);
    if (!isCatalogColumn(ctx, ref)) return derivedColumnVerdict(ref);
    const frac = nullFraction(ctx.catalog, ref);
    const share =
      frac === undefined
        ? ''
        : ` pg_stats puts ${label(ref)} at ${(frac * 100).toFixed(1)}% NULL, so this side of the test ${
            (n.op === 'IS NULL' ? frac : 1 - frac) < 0.1 ? 'is selective enough to be worth an index' : 'is probably too broad for an index scan to win'
          }.`;
    return {
      sargable: true,
      reason: `btree indexes store NULLs and Postgres accepts ${n.op} as an index condition on ${label(ref)}, so an index can serve it.${share}`,
    };
  }

  if (n.op === 'NOT') {
    const inner = n.operand as { type?: string; function?: { name: string; schema?: string } };
    if (inner.type === 'call' && qname(inner.function).toLowerCase() === 'exists') {
      return {
        sargable: false,
        reason:
          'NOT EXISTS is an anti-join rather than an outer-column index condition. Its performance depends on indexed predicates inside the correlated subquery, and it preserves correct NULL semantics.',
      };
    }
    return {
      sargable: false,
      reason: 'a NOT wrapped around the whole condition inverts the match set, which is not a contiguous btree range; it is evaluated as a filter.',
    };
  }

  if (n.op.startsWith('IS ')) {
    if (!operand.bare) {
      return { sargable: false, reason: `${n.op} is applied to an expression rather than a bare column, so no index on a base column applies.` };
    }
    const ref = ctx.resolveRef(operand.bare);
    if (ref.unresolved) return unresolvedVerdict(ref);
    if (!isCatalogColumn(ctx, ref)) return derivedColumnVerdict(ref);
    return { sargable: true, reason: `${n.op} on the bare column ${label(ref)} is an equality test a btree index can answer.` };
  }

  return { sargable: false, reason: `unary operator ${n.op} is not one this binder can prove an index serves.` };
}

function assessDisjunction(expr: Expr, ctx: PredicateContext): Verdict {
  const branches = disjuncts(expr);
  const verdicts = branches.map((b) => ({ sql: ctx.source.of(b), v: assess(b, ctx, classify(b, ctx).kind) }));
  const bad = verdicts.filter((x) => !x.v.sargable);
  const branchRelations = branches.map((branch) => {
    const aliases = new Set<string>();
    let unresolved = false;
    for (const node of analyzeOperand(branch).refs) {
      const ref = ctx.resolveRef(node);
      if (ref.unresolved || !ref.alias) unresolved = true;
      else aliases.add(ref.alias);
    }
    return { aliases: [...aliases], unresolved };
  });
  const oneScanAlias =
    branchRelations.length > 0 &&
    branchRelations.every(
      (branch) =>
        !branch.unresolved &&
        branch.aliases.length === 1 &&
        branch.aliases[0] === branchRelations[0]!.aliases[0],
    )
      ? branchRelations[0]!.aliases[0]
      : undefined;
  const cols = new Set<string>();
  for (const b of branches) for (const r of analyzeOperand(b).refs) cols.add(label(ctx.resolveRef(r)));
  const branchDetail = verdicts
    .map((b) => `\`${b.sql}\` is ${b.v.sargable ? '' : 'not '}sargable: ${b.v.reason.replace(/\.$/, '')}`)
    .join('; ');

  if (bad.length === 0 && oneScanAlias) {
    return {
      sargable: true,
      reason:
        `${branchDetail}. Every branch of this ${branches.length}-way OR is individually sargable on the same ${oneScanAlias} scan, so Postgres can combine per-branch index scans with a BitmapOr — ` +
        `but that needs an index for each of ${[...cols].join(', ')}; a single composite index cannot serve an OR across different columns.`,
    };
  }
  if (bad.length === 0) {
    const aliases = [...new Set(branchRelations.flatMap((branch) => branch.aliases))];
    return {
      sargable: false,
      reason:
        `${branchDetail}. Although every leaf is indexable in isolation, the OR spans ${aliases.length ? aliases.join(', ') : 'an unresolved/constant branch'}; ` +
        'BitmapOr can combine bitmap scans only for one heap relation, not across inputs of a join, so this compound predicate is not scan-sargable.',
    };
  }
  return {
    sargable: false,
    reason:
      `${branchDetail}. A disjunction is only as index-friendly as its worst branch: ` +
      'because that branch must be checked on every row, no BitmapOr can avoid reading the whole relation.',
  };
}

/**
 * Verdict for a comparison with no bare-column side. Names the wrapper that
 * killed it, because that is the whole point of the finding.
 */
function wrappedVerdict(a: Operand, b: Operand, ctx: PredicateContext, op: string): Verdict {
  const wrapped = a.wrapped ? a : b.wrapped ? b : undefined;
  if (wrapped?.wrapped) {
    const ref = ctx.resolveRef(wrapped.wrapped);
    // A lone binary-coercible cast changes nothing PostgreSQL stores, so the
    // column is still effectively bare and an index on it still applies.
    const only = wrapped.wrappers.length === 1 ? wrapped.wrappers[0] : undefined;
    if (only?.kind === 'cast' && castIsBinaryCoercible(ref.dataType, only.to)) {
      return {
        sargable: true,
        reason:
          `the cast to ${only.to} on ${label(ref)} is binary-coercible — PostgreSQL performs no conversion — ` +
          `so the column is still effectively bare and a btree index with ${ref.column} as its leading key can serve this ${op}.`,
      };
    }
    const desc = describeWrappers(wrapped.wrappers);
    const extra = immutabilityNote(wrapped, ctx, ref);
    const alt = expressionIndexHint(wrapped);
    return {
      sargable: false,
      reason: `${desc} wraps ${label(ref)}, so the ${op} compares a computed value that no btree index on the bare column stores; ${alt}${extra}`,
    };
  }
  if (a.constant && b.constant) {
    return { sargable: false, reason: 'both sides are constants, so this predicate does not reference a column at all.' };
  }
  if (a.refs.length > 1 || b.refs.length > 1) {
    return {
      sargable: false,
      reason: 'the comparison mixes several columns inside one expression, so there is no single bare column an index could be seeked on.',
    };
  }
  return {
    sargable: false,
    reason: `neither side of the ${op} is a bare column reference, so no index on a base column can be turned into an index condition.`,
  };
}

function expressionIndexHint(op: Operand): string {
  const outer = op.wrappers[0];
  if (outer?.kind === 'member') {
    return (
      'only a btree expression index on the identical extraction can serve this predicate directly; ' +
      'a GIN index on the jsonb column would require rewriting the predicate to a supported operator such as containment (@>)'
    );
  }
  return 'only an expression index built on the identical expression could serve it';
}

/** Note when a cast on the column side is not even indexable as an expression. */
function immutabilityNote(op: Operand, ctx: PredicateContext, ref: ResolvedColumnRef): string {
  for (const w of op.wrappers) {
    if (w.kind === 'cast' && castIsSessionDependent(ref.dataType, w.to)) {
      return `. Note that ${normalizeType(ref.dataType)} -> ${normalizeType(w.to)} is STABLE, not IMMUTABLE (it reads the session TimeZone), so it cannot be indexed as an expression either without pinning a zone`;
    }
    if (w.kind === 'function' && functionIsSessionDependent(w.name, ref.dataType, w.argCount)) {
      return `. Note that ${w.name}() over ${normalizeType(ref.dataType)} is STABLE, not IMMUTABLE because it depends on the session TimeZone, so PostgreSQL cannot use that expression in an index without first pinning a time zone`;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Operand helpers
// ---------------------------------------------------------------------------

interface Probe {
  ref: ResolvedColumnRef;
  other: Operand;
}

/** The side that is a bare column, paired with the other side. */
function bareSide(a: Operand, b: Operand, ctx: PredicateContext): Probe | undefined {
  if (a.bare && b.bare) {
    const left = ctx.resolveRef(a.bare);
    const right = ctx.resolveRef(b.bare);
    // Prefer a catalog-backed side. A derived/CTE output cannot itself own an
    // index, while the base-table side of the same join still can.
    if (!isCatalogColumn(ctx, left) && isCatalogColumn(ctx, right)) return { ref: right, other: a };
    return { ref: left, other: b };
  }
  if (a.bare) return { ref: ctx.resolveRef(a.bare), other: b };
  if (b.bare) return { ref: ctx.resolveRef(b.bare), other: a };
  return undefined;
}

function isCatalogColumn(ctx: PredicateContext, ref: ResolvedColumnRef): boolean {
  return !!ref.table && !ref.unresolved && !!findColumn(ctx.catalog, ref.table, ref.column);
}

function unresolvedVerdict(ref: ResolvedColumnRef): Verdict {
  return {
    sargable: false,
    reason: `${label(ref)} could not be resolved to a catalog column, so this binder cannot prove that any index can serve the predicate.`,
  };
}

function derivedColumnVerdict(ref: ResolvedColumnRef): Verdict {
  return {
    sargable: false,
    reason:
      `${label(ref)} is an output of a CTE, subquery, or function rather than a catalog base-table column, so it cannot own an index directly. ` +
      'The predicate may still be pushed into its producing block, but this IR has insufficient expression lineage to promise that.',
  };
}

function label(ref: ResolvedColumnRef): string {
  if (ref.unresolved) return `${ref.alias ? ref.alias + '.' : ''}${ref.column} (unresolved)`;
  return `${ref.alias ?? ref.table ?? ''}${ref.alias || ref.table ? '.' : ''}${ref.column}`;
}

function patternOf(e: Expr | undefined): string | undefined {
  const op = analyzeOperand(e);
  if (op.literal && op.literal.type === 'string') return String(op.literal.value);
  return undefined;
}

function nullFraction(catalog: Catalog, ref: ResolvedColumnRef): number | undefined {
  if (!ref.table || ref.unresolved) return undefined;
  return findColumn(catalog, ref.table, ref.column)?.stats?.nullFrac;
}

// ---------------------------------------------------------------------------
// Selectivity — only where the catalog actually supports a number.
// ---------------------------------------------------------------------------

function estimateSelectivity(
  expr: Expr,
  ctx: PredicateContext,
  kind: PredicateKind,
  negated: boolean,
): number | undefined {
  const n = expr as Record<string, unknown> & { type?: string };

  if (kind === 'null-check' && n.type === 'unary') {
    const operand = analyzeOperand(n.operand as Expr);
    if (!operand.bare) return undefined;
    const ref = ctx.resolveRef(operand.bare);
    const frac = nullFraction(ctx.catalog, ref);
    if (frac === undefined) return undefined;
    return negated ? 1 - frac : frac;
  }

  if (n.type === 'binary' && String(n.op) === 'OR') {
    const branches = disjuncts(expr);
    const aliases = branches.map((branch) => {
      const set = new Set(
        analyzeOperand(branch).refs
          .map((node) => ctx.resolveRef(node))
          .filter((ref) => !ref.unresolved && ref.alias)
          .map((ref) => ref.alias!),
      );
      return [...set];
    });
    if (
      aliases.length === 0 ||
      aliases.some((set) => set.length !== 1 || set[0] !== aliases[0]![0])
    ) return undefined;
    const parts = branches.map((d) => estimateSelectivity(d, ctx, classify(d, ctx).kind, false));
    if (parts.some((p) => p === undefined)) return undefined;
    // Independence assumption; stated as such in NOTES.md.
    return 1 - parts.reduce<number>((acc, p) => acc * (1 - p!), 1);
  }

  if (kind === 'equality' && n.type === 'binary') {
    const left = analyzeOperand(n.left as Expr);
    const right = analyzeOperand(n.right as Expr);
    const probe = bareSide(left, right, ctx);
    if (!probe || !probe.other.literal || !probe.ref.table || probe.ref.unresolved) return undefined;
    const sel = equalitySelectivity(ctx.catalog, probe.ref.table, probe.ref.column, String(probe.other.literal.value));
    if (sel === undefined) return undefined;
    return negated ? 1 - sel : sel;
  }

  if (kind === 'in-list' && n.type === 'binary' && String(n.op).endsWith('IN')) {
    const left = analyzeOperand(n.left as Expr);
    const list = n.right as { type?: string; expressions?: Expr[] };
    if (!left.bare || list?.type !== 'list' || !Array.isArray(list.expressions)) return undefined;
    const ref = ctx.resolveRef(left.bare);
    if (!ref.table || ref.unresolved) return undefined;
    let total = 0;
    for (const item of list.expressions) {
      const lit = analyzeOperand(item).literal;
      if (!lit) return undefined;
      const sel = equalitySelectivity(ctx.catalog, ref.table, ref.column, String(lit.value));
      if (sel === undefined) return undefined;
      total += sel;
    }
    return negated ? 1 - Math.min(total, 1) : Math.min(total, 1);
  }

  // Ranges and pattern matches need a histogram; the catalog fixture carries
  // only n_distinct and the MCV list, so we decline rather than invent one.
  return undefined;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * A comparison of an integer column against a fractional literal silently
 * promotes the *column* to numeric, which defeats an integer btree. Narrow on
 * purpose: only flagged where the promotion is certain.
 */
export function literalForcesColumnCast(colType: string | undefined, literal: Operand['literal']): boolean {
  if (!literal || literal.type !== 'number') return false;
  return isInteger(colType) && !Number.isInteger(literal.value as number);
}
