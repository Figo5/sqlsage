/**
 * Relation-aware SQL three-valued null-rejection analysis.
 *
 * For an outer join's null-supplying relation, substitute SQL NULL for every
 * reference to that relation and abstractly evaluate the WHERE expression.
 * A predicate is null-rejecting only when TRUE is impossible. The evaluator
 * deliberately widens unsupported functions/operators to unknown, preventing
 * a categorical demotion unless PostgreSQL semantics prove it.
 */
import { parse } from 'pgsql-ast-parser';
import type { Expr, ExprCall, ExprRef, SelectFromStatement } from 'pgsql-ast-parser';
import type { Predicate, ResolvedColumnRef } from '../types.ts';
import { qname } from './expressions.ts';
import { sqlNameEquals } from './scope.ts';

export type NullRejectionOutcome = 'rejecting' | 'tolerant' | 'unknown';

export interface NullRejectionAnalysis {
  outcome: NullRejectionOutcome;
  /** Possible SQL truth values after substituting NULL for `relation`. */
  possibleTruths: Array<'true' | 'false' | 'unknown'>;
  reason: string;
}

type Truth = 'T' | 'F' | 'U';
type Primitive = string | number | boolean;

interface AbstractValue {
  canNull: boolean;
  constants: Primitive[];
  /** Some non-NULL value not enumerated in `constants`. */
  other: boolean;
  /** Unsupported semantics contributed to this value. */
  uncertain: boolean;
}

interface AbstractTruth {
  values: Set<Truth>;
  uncertain: boolean;
}

interface EvaluationContext {
  predicate: Predicate;
  relations: Set<string>;
}

/**
 * Keep the already-bound expression for in-process analysis. Predicate SQL is
 * still the durable, serializable fallback, but correctness need not depend on
 * reparsing reconstructed text before the IR crosses a JSON boundary.
 */
const BOUND_PREDICATE_EXPRESSIONS = new WeakMap<object, Expr>();

/** Internal binder hook; the public analysis API remains Predicate-based. */
export function recordPredicateExpression(predicate: Predicate, expression: Expr): void {
  BOUND_PREDICATE_EXPRESSIONS.set(predicate as object, expression);
}

const STRICT_BUILTINS = new Set([
  'abs', 'acos', 'asin', 'atan', 'atan2', 'btrim', 'cardinality', 'ceil', 'ceiling',
  'char_length', 'character_length', 'date', 'date_part', 'date_trunc', 'decode',
  'encode', 'exp', 'floor', 'json_array_length', 'jsonb_array_length',
  'json_extract_path', 'json_extract_path_text', 'jsonb_extract_path',
  'jsonb_extract_path_text', 'left', 'length', 'ln', 'log', 'lower', 'lpad',
  'ltrim', 'md5', 'octet_length', 'overlay', 'position', 'power', 'regexp_match',
  'regexp_matches', 'regexp_replace', 'repeat', 'replace', 'reverse', 'right',
  'round', 'rpad', 'rtrim', 'sha224', 'sha256', 'sha384', 'sha512', 'sign',
  'split_part', 'sqrt', 'strpos', 'substr', 'substring', 'to_char', 'to_date',
  'to_number', 'to_timestamp', 'translate', 'trim', 'trunc', 'upper', 'width_bucket',
]);

const COMPARISON_OPS = new Set([
  '=', '!=', '<>', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE', 'ILIKE', 'NOT ILIKE',
  '~', '~*', '!~', '!~*',
]);

const STRICT_VALUE_OPS = new Set([
  '+', '-', '*', '/', '%', '^', '#', '&', '|', '<<', '>>', '||', 'AT TIME ZONE',
  '->', '->>', '#>', '#>>',
]);

/** Analyze one predicate for one null-extended relation alias. */
export function analyzeNullRejection(
  predicate: Predicate,
  relation: string | readonly string[],
): NullRejectionAnalysis {
  const relationNames = typeof relation === 'string' ? [relation] : [...relation];
  const relationLabel = relationNames.join(', ');
  const expr = BOUND_PREDICATE_EXPRESSIONS.get(predicate as object) ?? parsePredicate(predicate.sql);
  if (!expr) {
    return {
      outcome: 'unknown',
      possibleTruths: ['true', 'false', 'unknown'],
      reason: 'the predicate fragment could not be reparsed as an expression, so null rejection is not proven.',
    };
  }

  const result = evaluateTruth(expr, { predicate, relations: new Set(relationNames) });
  const possibleTruths = [...result.values].map(truthLabel).sort(truthOrder);
  if (!result.values.has('T')) {
    return {
      outcome: 'rejecting',
      possibleTruths,
      reason:
        `After substituting NULL for every column from ${relationLabel}, the expression can evaluate only to ` +
        `${possibleTruths.join(' or ')}; SQL WHERE keeps only TRUE, so every null-extended row is discarded.`,
    };
  }
  if (result.uncertain) {
    return {
      outcome: 'unknown',
      possibleTruths,
      reason:
        `After substituting NULL for ${relationLabel}, TRUE cannot be ruled out because the expression contains ` +
        'a function or operator whose NULL behavior is not proven by this binder.',
    };
  }
  return {
    outcome: 'tolerant',
    possibleTruths,
    reason:
      `After substituting NULL for ${relationLabel}, the expression can evaluate to TRUE, so some null-extended rows can survive WHERE.`,
  };
}

function parsePredicate(sql: string): Expr | undefined {
  try {
    const statement = parse(`SELECT 1 WHERE ${sql}`)[0] as SelectFromStatement | undefined;
    return statement?.type === 'select' ? statement.where ?? undefined : undefined;
  } catch {
    return undefined;
  }
}

function evaluateTruth(expr: Expr, ctx: EvaluationContext): AbstractTruth {
  const node = expr as Record<string, unknown> & { type?: string; op?: string };
  if (node.type === 'binary') {
    const leftExpr = node.left as Expr;
    const rightExpr = node.right as Expr;
    if (node.op === 'AND' || node.op === 'OR') {
      return combineBoolean(evaluateTruth(leftExpr, ctx), evaluateTruth(rightExpr, ctx), node.op);
    }
    if (COMPARISON_OPS.has(node.op ?? '')) {
      return compareValues(evaluateValue(leftExpr, ctx), evaluateValue(rightExpr, ctx), node.op!);
    }
    if (node.op === 'IN' || node.op === 'NOT IN') {
      const membership = evaluateIn(leftExpr, rightExpr, ctx);
      return node.op === 'NOT IN' ? negateTruth(membership) : membership;
    }
    return truthFromValue(evaluateValue(expr, ctx));
  }

  if (node.type === 'unary') {
    const operand = node.operand as Expr;
    if (node.op === 'NOT') return negateTruth(evaluateTruth(operand, ctx));
    if (node.op === 'IS NULL' || node.op === 'IS NOT NULL') {
      const value = evaluateValue(operand, ctx);
      const truths = new Set<Truth>();
      if (value.canNull) truths.add(node.op === 'IS NULL' ? 'T' : 'F');
      if (hasNonNull(value)) truths.add(node.op === 'IS NULL' ? 'F' : 'T');
      return { values: truths, uncertain: value.uncertain };
    }
    if (node.op?.startsWith('IS ')) {
      return evaluateBooleanTest(node.op, evaluateTruth(operand, ctx));
    }
    return truthFromValue(evaluateValue(expr, ctx));
  }

  if (node.type === 'ternary') {
    const value = node.value as Expr;
    const lo = node.lo as Expr;
    const hi = node.hi as Expr;
    const between = combineBoolean(
      compareValues(evaluateValue(value, ctx), evaluateValue(lo, ctx), '>='),
      compareValues(evaluateValue(value, ctx), evaluateValue(hi, ctx), '<='),
      'AND',
    );
    return node.op === 'NOT BETWEEN' ? negateTruth(between) : between;
  }

  return truthFromValue(evaluateValue(expr, ctx));
}

function evaluateValue(expr: Expr, ctx: EvaluationContext): AbstractValue {
  const node = expr as Record<string, unknown> & { type?: string; op?: string };
  switch (node.type) {
    case 'null':
      return nullValue();
    case 'boolean':
    case 'string':
    case 'integer':
    case 'numeric':
      return constantValue(node.value as Primitive);
    case 'ref':
      return referenceValue(expr as ExprRef, ctx);
    case 'parameter':
      return anyValue(false);
    case 'cast': {
      const operand = evaluateValue(node.operand as Expr, ctx);
      if (onlyNull(operand)) return operand;
      // A cast is strict, but retaining a pre-cast literal would make unsafe
      // assumptions such as numeric 1 versus text '1'. Preserve nullness only.
      return {
        canNull: operand.canNull,
        constants: [],
        other: hasNonNull(operand),
        uncertain: operand.uncertain,
      };
    }
    case 'member': {
      const operand = evaluateValue(node.operand as Expr, ctx);
      if (onlyNull(operand)) return operand;
      // JSON extraction is strict in the container but may also yield NULL for
      // a missing key even when the container is non-NULL.
      return {
        canNull: operand.canNull || hasNonNull(operand),
        constants: [],
        other: hasNonNull(operand),
        uncertain: operand.uncertain,
      };
    }
    case 'extract': {
      const operand = evaluateValue(node.from as Expr, ctx);
      if (onlyNull(operand)) return operand;
      return strictUnknownResult([operand], false);
    }
    case 'call':
      return evaluateCall(expr as ExprCall, ctx);
    case 'binary': {
      if (node.op === 'AND' || node.op === 'OR' || COMPARISON_OPS.has(node.op ?? '') || node.op === 'IN' || node.op === 'NOT IN') {
        return valueFromTruth(evaluateTruth(expr, ctx));
      }
      const operands = [evaluateValue(node.left as Expr, ctx), evaluateValue(node.right as Expr, ctx)];
      if (STRICT_VALUE_OPS.has(node.op ?? '')) return strictUnknownResult(operands, false);
      return anyValue(true, operands.some((value) => value.uncertain));
    }
    case 'unary': {
      if (node.op === 'NOT' || node.op?.startsWith('IS ')) return valueFromTruth(evaluateTruth(expr, ctx));
      const operand = evaluateValue(node.operand as Expr, ctx);
      if (node.op === '+' || node.op === '-') return strictUnknownResult([operand], false);
      return anyValue(true, true);
    }
    case 'ternary':
      return valueFromTruth(evaluateTruth(expr, ctx));
    case 'case':
      return evaluateCase(node, ctx);
    case 'array':
    case 'list':
      return { canNull: false, constants: [], other: true, uncertain: false };
    case 'select':
    case 'union':
    case 'union all':
    case 'with':
    case 'with recursive':
      return anyValue(true, true);
    default:
      return anyValue(true, true);
  }
}

function referenceValue(node: ExprRef, ctx: EvaluationContext): AbstractValue {
  const qualifier = node.table?.name;
  const candidates = ctx.predicate.columns.filter((ref) => {
    if (!sqlNameEquals(ref.column, node.name)) return false;
    if (!qualifier) return true;
    return !!ref.alias && sqlNameEquals(ref.alias, qualifier);
  });
  const unique = dedupeResolved(candidates);
  if (unique.length !== 1) return anyValue(true, true);
  const ref = unique[0]!;
  if (ref.alias && [...ctx.relations].some((relation) => sqlNameEquals(ref.alias!, relation))) return nullValue();
  if (ref.nullable === false) return { canNull: false, constants: [], other: true, uncertain: false };
  if (ref.nullable === true) return { canNull: true, constants: [], other: true, uncertain: false };
  return anyValue(true, true);
}

function evaluateCall(call: ExprCall, ctx: EvaluationContext): AbstractValue {
  const name = qname(call.function).toLowerCase();
  const args = (call.args ?? []).map((arg) => evaluateValue(arg, ctx));
  if (name === 'coalesce') return evaluateCoalesce(args);
  if (name === 'greatest' || name === 'least') return evaluateGreatest(args);
  if (name === 'nullif') return evaluateNullIf(args);
  if (name === 'concat') {
    // concat() ignores NULL arguments and returns non-NULL text.
    return { canNull: false, constants: [], other: true, uncertain: args.some((arg) => arg.uncertain) };
  }
  if (name === 'concat_ws') {
    // A NULL separator makes concat_ws NULL; remaining NULLs are skipped.
    const separator = args[0] ?? anyValue(true, true);
    return {
      canNull: separator.canNull,
      constants: [],
      other: hasNonNull(separator),
      uncertain: args.some((arg) => arg.uncertain),
    };
  }
  if (STRICT_BUILTINS.has(name)) {
    return strictUnknownResult(args, false);
  }
  // Routine metadata is not in Catalog. An unrecognized function may be
  // STRICT or may deliberately turn NULL into a non-NULL sentinel.
  return anyValue(true, true);
}

function evaluateCoalesce(args: AbstractValue[]): AbstractValue {
  const out = emptyValue();
  let canReach = true;
  for (const arg of args) {
    if (!canReach) break;
    addNonNull(out, arg);
    out.uncertain ||= arg.uncertain;
    canReach = arg.canNull;
  }
  out.canNull = canReach;
  return out;
}

function evaluateGreatest(args: AbstractValue[]): AbstractValue {
  const out = emptyValue();
  for (const arg of args) {
    addNonNull(out, arg);
    out.uncertain ||= arg.uncertain;
  }
  out.canNull = args.length === 0 || args.every((arg) => arg.canNull);
  return out;
}

function evaluateNullIf(args: AbstractValue[]): AbstractValue {
  const first = args[0] ?? anyValue(true, true);
  const second = args[1] ?? anyValue(true, true);
  if (onlyNull(first)) return first;
  return {
    canNull: true,
    constants: [...first.constants],
    other: first.other,
    uncertain: first.uncertain || second.uncertain,
  };
}

function evaluateCase(node: Record<string, unknown>, ctx: EvaluationContext): AbstractValue {
  const out = emptyValue();
  const whens = (node.whens ?? []) as Array<{ when: Expr; value: Expr }>;
  let canContinue = true;
  let controlUncertain = false;
  const base = node.value ? evaluateValue(node.value as Expr, ctx) : undefined;
  for (const branch of whens) {
    if (!canContinue) break;
    const condition = base
      ? compareValues(base, evaluateValue(branch.when, ctx), '=')
      : evaluateTruth(branch.when, ctx);
    controlUncertain ||= condition.uncertain;
    if (condition.values.has('T')) mergeValue(out, evaluateValue(branch.value, ctx));
    canContinue = condition.values.has('F') || condition.values.has('U');
  }
  if (canContinue) {
    if (node.else) mergeValue(out, evaluateValue(node.else as Expr, ctx));
    else out.canNull = true;
  }
  out.uncertain ||= controlUncertain;
  return out;
}

function evaluateIn(leftExpr: Expr, rightExpr: Expr, ctx: EvaluationContext): AbstractTruth {
  const right = rightExpr as { type?: string; expressions?: Expr[] };
  if (right.type !== 'list' || !Array.isArray(right.expressions)) {
    return { values: new Set(['T', 'F', 'U']), uncertain: true };
  }
  const left = evaluateValue(leftExpr, ctx);
  let result: AbstractTruth | undefined;
  for (const item of right.expressions) {
    const equality = compareValues(left, evaluateValue(item, ctx), '=');
    result = result ? combineBoolean(result, equality, 'OR') : equality;
  }
  return result ?? { values: new Set(['F']), uncertain: left.uncertain };
}

function compareValues(left: AbstractValue, right: AbstractValue, op: string): AbstractTruth {
  const values = new Set<Truth>();
  if (left.canNull || right.canNull) values.add('U');
  if (hasNonNull(left) && hasNonNull(right)) {
    if (op === '~' || op === '~*' || op === '!~' || op === '!~*') {
      // JavaScript and PostgreSQL regex dialects are not identical. Both
      // truth results are possible for non-NULL operands; nullness is still
      // modeled exactly above.
      values.add('T');
      values.add('F');
      return { values, uncertain: left.uncertain || right.uncertain };
    }
    const exactLeft = !left.other && left.constants.length > 0;
    const exactRight = !right.other && right.constants.length > 0;
    if (exactLeft && exactRight) {
      for (const a of left.constants) {
        for (const b of right.constants) values.add(compareConstants(a, b, op) ? 'T' : 'F');
      }
    } else {
      // Unknown non-NULL values can either match or fail a comparison/pattern.
      values.add('T');
      values.add('F');
    }
  }
  return { values, uncertain: left.uncertain || right.uncertain };
}

function compareConstants(a: Primitive, b: Primitive, op: string): boolean {
  switch (op) {
    case '=': return a === b;
    case '!=':
    case '<>': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case 'LIKE': return typeof a === 'string' && typeof b === 'string' && likeRegex(b, false).test(a);
    case 'ILIKE': return typeof a === 'string' && typeof b === 'string' && likeRegex(b, true).test(a);
    case 'NOT LIKE': return !(typeof a === 'string' && typeof b === 'string' && likeRegex(b, false).test(a));
    case 'NOT ILIKE': return !(typeof a === 'string' && typeof b === 'string' && likeRegex(b, true).test(a));
    default:
      // Regex exact evaluation is unnecessary for null rejection; choosing
      // either result here would be unsound, so callers widen nonstandard ops.
      return false;
  }
}

function likeRegex(pattern: string, insensitive: boolean): RegExp {
  let source = '^';
  let escaped = false;
  for (const char of pattern) {
    if (escaped) {
      source += escapeRegex(char);
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '%') {
      source += '.*';
    } else if (char === '_') {
      source += '.';
    } else {
      source += escapeRegex(char);
    }
  }
  if (escaped) source += '\\\\';
  return new RegExp(source + '$', insensitive ? 'i' : '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function combineBoolean(left: AbstractTruth, right: AbstractTruth, op: 'AND' | 'OR'): AbstractTruth {
  const values = new Set<Truth>();
  for (const a of left.values) for (const b of right.values) values.add(booleanPair(a, b, op));
  return { values, uncertain: left.uncertain || right.uncertain };
}

function booleanPair(a: Truth, b: Truth, op: 'AND' | 'OR'): Truth {
  if (op === 'AND') {
    if (a === 'F' || b === 'F') return 'F';
    if (a === 'T' && b === 'T') return 'T';
    return 'U';
  }
  if (a === 'T' || b === 'T') return 'T';
  if (a === 'F' && b === 'F') return 'F';
  return 'U';
}

function negateTruth(input: AbstractTruth): AbstractTruth {
  const values = new Set<Truth>();
  for (const value of input.values) values.add(value === 'T' ? 'F' : value === 'F' ? 'T' : 'U');
  return { values, uncertain: input.uncertain };
}

function evaluateBooleanTest(op: string, input: AbstractTruth): AbstractTruth {
  const values = new Set<Truth>();
  const normalized = op.toUpperCase();
  for (const value of input.values) {
    let matches = false;
    if (normalized.includes('TRUE')) matches = value === 'T';
    else if (normalized.includes('FALSE')) matches = value === 'F';
    else if (normalized.includes('UNKNOWN')) matches = value === 'U';
    if (normalized.includes('NOT')) matches = !matches;
    values.add(matches ? 'T' : 'F');
  }
  return { values, uncertain: input.uncertain };
}

function truthFromValue(value: AbstractValue): AbstractTruth {
  const values = new Set<Truth>();
  if (value.canNull) values.add('U');
  for (const constant of value.constants) {
    if (constant === true) values.add('T');
    else if (constant === false) values.add('F');
    else {
      values.add('T');
      values.add('F');
    }
  }
  if (value.other) {
    values.add('T');
    values.add('F');
  }
  return { values, uncertain: value.uncertain };
}

function valueFromTruth(truth: AbstractTruth): AbstractValue {
  return {
    canNull: truth.values.has('U'),
    constants: [
      ...(truth.values.has('T') ? [true] : []),
      ...(truth.values.has('F') ? [false] : []),
    ],
    other: false,
    uncertain: truth.uncertain,
  };
}

function strictUnknownResult(args: AbstractValue[], forceUncertain: boolean): AbstractValue {
  if (args.some(onlyNull)) {
    return {
      canNull: true,
      constants: [],
      other: false,
      uncertain: forceUncertain || args.some((arg) => arg.uncertain),
    };
  }
  const allCanBeNonNull = args.every(hasNonNull);
  return {
    canNull: args.some((arg) => arg.canNull) || allCanBeNonNull,
    constants: [],
    other: allCanBeNonNull,
    uncertain: forceUncertain || args.some((arg) => arg.uncertain),
  };
}

function nullValue(): AbstractValue {
  return { canNull: true, constants: [], other: false, uncertain: false };
}

function constantValue(value: Primitive): AbstractValue {
  return { canNull: false, constants: [value], other: false, uncertain: false };
}

function anyValue(canNull = true, uncertain = false): AbstractValue {
  return { canNull, constants: [], other: true, uncertain };
}

function emptyValue(): AbstractValue {
  return { canNull: false, constants: [], other: false, uncertain: false };
}

function onlyNull(value: AbstractValue): boolean {
  return value.canNull && !hasNonNull(value);
}

function hasNonNull(value: AbstractValue): boolean {
  return value.other || value.constants.length > 0;
}

function addNonNull(target: AbstractValue, source: AbstractValue): void {
  for (const value of source.constants) {
    if (!target.constants.some((candidate) => candidate === value && typeof candidate === typeof value)) {
      target.constants.push(value);
    }
  }
  target.other ||= source.other;
}

function mergeValue(target: AbstractValue, source: AbstractValue): void {
  target.canNull ||= source.canNull;
  target.uncertain ||= source.uncertain;
  addNonNull(target, source);
}

function dedupeResolved(refs: ResolvedColumnRef[]): ResolvedColumnRef[] {
  const out: ResolvedColumnRef[] = [];
  for (const ref of refs) {
    if (!out.some((candidate) =>
      candidate.alias === ref.alias && candidate.table === ref.table && candidate.column === ref.column
    )) out.push(ref);
  }
  return out;
}

function truthLabel(value: Truth): 'true' | 'false' | 'unknown' {
  return value === 'T' ? 'true' : value === 'F' ? 'false' : 'unknown';
}

function truthOrder(a: string, b: string): number {
  return ['true', 'false', 'unknown'].indexOf(a) - ['true', 'false', 'unknown'].indexOf(b);
}
