/**
 * Prioritization: turns a bag of findings, index recommendations and rewrites
 * into a ranked list of *issues*, where an issue is "one underlying problem
 * plus everything that addresses it".
 *
 * Three decisions live here, and they are the whole editorial value of M7:
 *
 *   1. How the explicit correctness/intent/performance category controls rank.
 *      Correctness always leads, because a 40% speedup on a query that
 *      triple-counts revenue is not the story.
 *   2. Which recommendations belong to which finding, so the reader sees
 *      "problem -> evidence -> fix" instead of three disconnected lists.
 *   3. What gets cut: `info` findings become a one-line "checked, no action"
 *      list, and low-confidence/low-severity findings are demoted out of the
 *      body rather than padding it.
 *
 * Everything is derived from the shared contracts in `src/types.ts`. There is no
 * knowledge of the corpus here — no query ids, no SQL text matching, no
 * fingerprints. Every rule below fires on a shape, not on an instance.
 */

import type {
  Analysis,
  ExecutionAnalysis,
  Finding,
  IndexRecommendation,
  QueryIR,
  Rewrite,
  Severity,
} from '../types.ts';
import { recognizeCreateIndexDdl } from './index-ddl.ts';

export type Confidence = 'high' | 'medium' | 'low';
export type IssueKind = Finding['category'];
export type Actionability = Finding['actionability'];

export interface DependencyProblem {
  rewriteId: string;
  rewriteTitle: string;
  requiredIndexId: string;
  reason: 'missing' | 'ambiguous';
}

export interface TimingValue {
  state: 'measured' | 'missing' | 'invalid';
  value?: number;
  detail?: string;
}

export interface TimingComparison {
  baseline: TimingValue;
  optimized: TimingValue;
  kind: 'improvement' | 'similar' | 'regression' | 'unavailable';
  deltaMs?: number;
  deltaPct?: number;
  ratio?: number;
  /** Why valid-looking endpoints could not produce trustworthy derived math. */
  detail?: string;
}

export interface SemanticRiskElsewhere {
  kind: 'correctness' | 'intent';
  title: string;
}

export interface Issue {
  key: string;
  title: string;
  kind: IssueKind;
  /** Worst severity in the cluster, as reported. */
  severity: Severity;
  /** Severity after the low-confidence penalty; drives ordering only. */
  effectiveSeverity: Severity;
  confidence: Confidence;
  /** Structured action state after combining findings and recommendations. */
  actionability: Actionability;
  /** Primary finding first; the rest are corroborating detail. */
  findings: Finding[];
  indexes: IndexRecommendation[];
  rewrites: Rewrite[];
  /** Runtime costs from M3 that name the same relations/columns as this issue. */
  costs: ExecutionAnalysis['dominantCosts'];
  /** Explicit, unresolved Rewrite.requiresIndexes references in this bundle. */
  dependencyProblems: DependencyProblem[];
  /** True only when a finding, not merely a rewrite, establishes why rows should change. */
  semanticChangeJustified?: boolean;
  /**
   * Set when this issue proposes a result-changing rewrite it cannot justify
   * itself, *and* the report does carry a correctness/intent risk elsewhere.
   * Without this the renderer would claim no such finding exists, which is a
   * statement about M7's own input and can be flatly false.
   */
  semanticRiskElsewhere?: SemanticRiskElsewhere;
  sortKey: number[];
}

export type VerdictKind =
  | 'wrong-results'
  | 'possible-wrong-results'
  | 'intent-required'
  | 'needs-work'
  | 'minor'
  | 'clean'
  | 'incomplete';

export interface ReportModel {
  title: string;
  subtitle?: string;
  originalSql?: string;
  verdict: { kind: VerdictKind; label: string; banner: string };
  bottomLine: string[];
  /** Ranked, most important first. */
  issues: Issue[];
  /** Priority-3 recommendations nothing depends on: cosmetic, never in the lede. */
  optional: Issue[];
  /** `info` findings: things a reader might expect us to flag, and why we did not. */
  cleared: Array<{ finding: Finding; followUps: string[] }>;
  /** Low-confidence, low-severity: named in one line each, not argued. */
  deferred: Finding[];
  /** Costs not claimed by any issue. */
  residualCosts: ExecutionAnalysis['dominantCosts'];
  execution?: ExecutionAnalysis;
  planShape?: string;
  /** M2 caveats that no rendered finding already covers. */
  uncoveredCaveats: Array<{ issue: string; why: string; sqlFragment?: string }>;
  semantics?: Analysis['semantics'];
  verification?: Analysis['verification'];
  timing: TimingComparison;
  dependencyProblems: DependencyProblem[];
  /** Every validation message, rejected and recovered alike, in discovery order. */
  validationProblems: string[];
  /** Input the renderer had to drop: these suppress a categorical verdict. */
  rejectedProblems: string[];
  /** Input the renderer coerced or ignored: visible, but not a safety gate. */
  recoveredProblems: string[];
  /** Things that limit how much the reader should trust this report. */
  limits: string[];
  counts: { findings: number; indexes: number; rewrites: number };
}

// ---------------------------------------------------------------------------
// Ordering primitives
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const CONFIDENCE_ORDER: Confidence[] = ['high', 'medium', 'low'];

export function severityRank(s: Severity | undefined): number {
  const i = SEVERITY_ORDER.indexOf((s ?? 'medium') as Severity);
  return i < 0 ? 2 : i;
}

function confidenceRank(c: Confidence | undefined): number {
  const i = CONFIDENCE_ORDER.indexOf((c ?? 'medium') as Confidence);
  return i < 0 ? 1 : i;
}

/** One notch down, floored at `low` so nothing is silently cleared by a demotion. */
function demote(s: Severity): Severity {
  const i = Math.min(severityRank(s) + 1, SEVERITY_ORDER.indexOf('low'));
  return SEVERITY_ORDER[i];
}

function issueKindRank(kind: IssueKind, severity: Severity): number {
  if (kind === 'correctness') return 0;
  if (kind === 'intent' && severityRank(severity) <= severityRank('high')) return 1;
  return 2;
}

function clusterClass(kind: IssueKind): 'intent' | 'non-intent' {
  // Intent findings represent a business choice and must not be swallowed by
  // a technically related optimization. Correctness and performance findings
  // may still form one deployable repair bundle.
  return kind === 'intent' ? 'intent' : 'non-intent';
}

// ---------------------------------------------------------------------------
// Correctness classification
// ---------------------------------------------------------------------------

interface Classification {
  kind: IssueKind;
}

/**
 * Editorial risk comes only from the shared contract. Titles, ids, impact,
 * remediation and caveats are deliberately absent from this decision: wording
 * may explain a category but can never change it.
 */
function classify(f: Finding): Classification {
  return { kind: f.category };
}

// ---------------------------------------------------------------------------
// Affinity: which recommendation addresses which finding
// ---------------------------------------------------------------------------

const STOP_TOKENS = new Set([
  'the', 'a', 'an', 'and', 'or', 'not', 'is', 'are', 'be', 'to', 'of', 'in', 'on', 'for', 'with',
  'by', 'as', 'at', 'from', 'this', 'that', 'it', 'its', 'add', 'use', 'using', 'fix', 'move',
  'rewrite', 'replace', 'query', 'index', 'indexes', 'scan', 'sql', 'select', 'where', 'group',
  'order', 'limit', 'offset', 'having', 'rows', 'row', 'column', 'columns', 'table', 'tables',
  'shop', 'public', 'create', 'concurrently', 'btree', 'gin', 'clause', 'predicate', 'filter',
]);

function tokenize(s: unknown): string[] {
  if (!s) return [];
  return String(s)
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
}

/**
 * The identifiers this query actually mentions. Restricting token overlap to
 * real schema names is what keeps affinity from matching on English prose.
 */
function schemaVocabulary(ir: QueryIR | undefined): Set<string> {
  const v = new Set<string>();
  const add = (s?: unknown) => {
    if (typeof s !== 'string') return;
    for (const part of s.toLowerCase().split('.')) {
      if (part.length >= 2) v.add(part);
    }
  };
  const blocks = Array.isArray(ir?.blocks) ? ir.blocks : [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    for (const r of Array.isArray(b.relations) ? b.relations : []) {
      if (!r || typeof r !== 'object') continue;
      add(r.alias);
      add(r.source);
      for (const p of Array.isArray(r.localPredicates) ? r.localPredicates : []) {
        if (!p || typeof p !== 'object') continue;
        for (const c of Array.isArray(p.columns) ? p.columns : []) { add(c?.table); add(c?.column); }
      }
    }
    for (const p of [...(Array.isArray(b.predicates) ? b.predicates : []), ...(Array.isArray(b.having) ? b.having : [])]) {
      if (!p || typeof p !== 'object') continue;
      for (const c of Array.isArray(p.columns) ? p.columns : []) { add(c?.table); add(c?.column); }
    }
    for (const j of Array.isArray(b.joins) ? b.joins : []) {
      if (!j || typeof j !== 'object') continue;
      add(j.leftRelation);
      add(j.rightRelation);
      for (const k of Array.isArray(j.equiKeys) ? j.equiKeys : []) { add(k?.left?.table); add(k?.left?.column); add(k?.right?.table); add(k?.right?.column); }
    }
    for (const p of Array.isArray(b.projections) ? b.projections : []) {
      if (!p || typeof p !== 'object') continue;
      for (const c of Array.isArray(p.columns) ? p.columns : []) { add(c?.table); add(c?.column); }
    }
    for (const c of Array.isArray(b.groupBy) ? b.groupBy : []) { add(c?.table); add(c?.column); }
    for (const o of Array.isArray(b.orderBy) ? b.orderBy : []) { add(o?.column?.table); add(o?.column?.column); }
  }
  return v;
}

function identOverlap(a: string, b: string, vocab: Set<string>): number {
  if (vocab.size === 0) return 0;
  // Once tokens are restricted to identifiers actually present in the IR,
  // SQL words such as `orders` must not be treated as stop words: they may be
  // the exact table name that ties a cost to an issue.
  const identifiers = (s: string) =>
    s
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length >= 2 && vocab.has(t));
  const A = new Set(identifiers(a));
  if (A.size === 0) return 0;
  const B = new Set(identifiers(b));
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n;
}

function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function grainSentence(value: unknown): string {
  const grain = String(value ?? '').replace(/\s+/g, ' ').trim().replace(/[.]+$/, '');
  if (!grain) return '';
  if (/^(?:one|at most one|exactly one|zero or one|one or more)\s+rows?\b/i.test(grain)) {
    return `${grain[0]!.toUpperCase()}${grain.slice(1)}.`;
  }
  return `One row per ${grain}.`;
}

function sameRelation(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const tail = (s: string) => s.toLowerCase().split('.').pop()!.trim();
  return tail(a) === tail(b);
}

const ATTACH_THRESHOLD = 3;
const MERGE_THRESHOLD = 5;

function indexText(idx: IndexRecommendation): string {
  return [idx.table, ...(idx.columns ?? []), ...(idx.includeColumns ?? []), idx.where, idx.expectedEffect,
    idx.columnOrderRationale, ...(idx.serves ?? [])].filter(Boolean).join(' ');
}

function rewriteText(rw: Rewrite): string {
  return [rw.id, rw.title, rw.rationale, rw.equivalenceNotes].filter(Boolean).join(' ');
}

function indexAffinity(f: Finding, idx: IndexRecommendation, vocab: Set<string>): number {
  let score = 0;
  if (sameRelation(f.evidence?.relation, idx.table)) score += 3;
  const col = f.evidence?.column?.toLowerCase();
  if (col && [...(idx.columns ?? []), ...(idx.includeColumns ?? [])].some((c) => c.toLowerCase() === col)) score += 3;
  const frag = norm(f.evidence?.sqlFragment);
  if (frag.length >= 8 && (idx.serves ?? []).some((s) => norm(s).includes(frag) || frag.includes(norm(s)))) score += 4;
  score += Math.min(identOverlap(`${f.title} ${f.impact} ${f.evidence?.sqlFragment ?? ''}`, indexText(idx), vocab), 3);
  return score;
}

function rewriteAffinity(f: Finding, rw: Rewrite, vocab: Set<string>): number {
  let score = 0;
  const fTokens = new Set(tokenize(f.id));
  const rTokens = new Set(tokenize(rw.id));
  let slug = 0;
  for (const t of fTokens) if (rTokens.has(t)) slug++;
  score += Math.min(slug * 2, 4);
  const frag = norm(f.evidence?.sqlFragment);
  if (frag.length >= 8 && norm(rewriteText(rw)).includes(frag)) score += 4;
  score += Math.min(identOverlap(`${f.title} ${f.impact} ${f.evidence?.sqlFragment ?? ''}`, rewriteText(rw), vocab), 3);
  if (sameRelation(f.evidence?.relation, '') === false && f.evidence?.relation) {
    if (norm(rewriteText(rw)).includes(f.evidence.relation.toLowerCase().split('.').pop()!)) score += 1;
  }
  return score;
}

/** Exact shared-contract identity. DDL text and similar names are never evidence. */
function indexSatisfies(idx: IndexRecommendation, id: string): boolean {
  return isNonEmptyString(id) && isNonEmptyString(idx.id) && recognizeCreateIndexDdl(idx.ddl).valid && idx.id === id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

const SEVERITIES = new Set<Severity>(['critical', 'high', 'medium', 'low', 'info']);
const CONFIDENCES = new Set<Confidence>(['high', 'medium', 'low']);
const CATEGORIES = new Set<IssueKind>(['correctness', 'intent', 'performance']);
const ACTIONABILITIES = new Set<Actionability>(['required', 'optional', 'none']);
const INDEX_METHODS = new Set(['btree', 'hash', 'gin', 'gist', 'brin', 'spgist']);
const EQUIVALENCES = new Set(['exact', 'conditional', 'different-semantics']);
const PRIORITIES = new Set([1, 2, 3]);

function missingFindingFields(value: unknown): string[] {
  if (!isRecord(value)) return ['object'];
  const missing: string[] = [];
  if (!isNonEmptyString(value.id)) missing.push('id');
  if (!isNonEmptyString(value.title)) missing.push('title');
  if (!SEVERITIES.has(value.severity as Severity)) missing.push('severity');
  if (!CATEGORIES.has(value.category as IssueKind)) missing.push('category');
  if (!ACTIONABILITIES.has(value.actionability as Actionability)) missing.push('actionability');
  if (!isRecord(value.evidence) || !isNonEmptyString(value.evidence.sqlFragment)) missing.push('evidence.sqlFragment');
  if (isRecord(value.evidence) && value.evidence.relation !== undefined && !isString(value.evidence.relation)) missing.push('evidence.relation');
  if (isRecord(value.evidence) && value.evidence.column !== undefined && !isString(value.evidence.column)) missing.push('evidence.column');
  if (!isNonEmptyString(value.impact)) missing.push('impact');
  if (!isNonEmptyString(value.remediation)) missing.push('remediation');
  if (value.caveat !== undefined && !isString(value.caveat)) missing.push('caveat');
  if (!CONFIDENCES.has(value.confidence as Confidence)) missing.push('confidence');
  return missing;
}

function missingIndexFields(value: unknown): string[] {
  if (!isRecord(value)) return ['object'];
  const missing: string[] = [];
  if (!isNonEmptyString(value.id)) missing.push('id');
  if (!isNonEmptyString(value.ddl)) {
    missing.push('ddl');
  } else {
    const ddl = recognizeCreateIndexDdl(value.ddl);
    if (!ddl.valid) missing.push(`ddl (${ddl.reason})`);
  }
  if (!isNonEmptyString(value.table)) missing.push('table');
  if (!stringArray(value.columns)) missing.push('columns');
  if (value.includeColumns !== undefined && !stringArray(value.includeColumns)) missing.push('includeColumns');
  if (!INDEX_METHODS.has(value.method as string)) missing.push('method');
  if (value.where !== undefined && !isString(value.where)) missing.push('where');
  if (!isString(value.columnOrderRationale)) missing.push('columnOrderRationale');
  if (!stringArray(value.serves)) missing.push('serves');
  if (!isString(value.expectedEffect)) missing.push('expectedEffect');
  if (
    !isRecord(value.cost) ||
    !isString(value.cost.estimatedSizeNote) ||
    !isString(value.cost.writeImpact)
  ) missing.push('cost');
  if (!PRIORITIES.has(value.priority as number)) missing.push('priority');
  if (!CONFIDENCES.has(value.confidence as Confidence)) missing.push('confidence');
  if (value.supersedes !== undefined && !stringArray(value.supersedes)) missing.push('supersedes');
  if (value.redundantWith !== undefined && !stringArray(value.redundantWith)) missing.push('redundantWith');
  return missing;
}

function missingRewriteFields(value: unknown): string[] {
  if (!isRecord(value)) return ['object'];
  const missing: string[] = [];
  if (!isNonEmptyString(value.id)) missing.push('id');
  if (!isNonEmptyString(value.title)) missing.push('title');
  if (!isNonEmptyString(value.sql)) missing.push('sql');
  if (!isString(value.rationale)) missing.push('rationale');
  if (!EQUIVALENCES.has(value.equivalence as string)) missing.push('equivalence');
  if (!isString(value.equivalenceNotes)) missing.push('equivalenceNotes');
  if (value.expectedSpeedup !== undefined && !isString(value.expectedSpeedup)) missing.push('expectedSpeedup');
  if (value.requiresIndexes !== undefined && !stringArray(value.requiresIndexes)) missing.push('requiresIndexes');
  if (!PRIORITIES.has(value.priority as number)) missing.push('priority');
  return missing;
}

function validatedEntries<T>(
  value: unknown,
  label: string,
  inspect: (entry: unknown) => string[],
  problems: string[],
): T[] {
  if (!Array.isArray(value)) return [];
  const valid: T[] = [];
  value.forEach((entry, index) => {
    const missing = inspect(entry);
    if (missing.length) {
      problems.push(`${label} #${index + 1} was ignored because required fields are invalid: ${missing.join(', ')}.`);
    } else {
      valid.push(entry as T);
    }
  });
  return valid;
}

function validateTopLevel(a: Analysis, problems: string[]): void {
  if (!isNonEmptyString(a.sql)) problems.push('analysis.sql was missing, invalid, or blank.');
  if (!isNonEmptyString(a.catalogName)) problems.push('analysis.catalogName was missing, invalid, or blank.');
  if (!isRecord(a.ir)) return;
  if (Array.isArray(a.ir.blocks)) {
    a.ir.blocks.forEach((block, index) => {
      if (!isRecord(block)) problems.push(`ir.blocks[${index}] is not an object and was ignored for report affinity.`);
    });
  }
  if (Array.isArray(a.ir.bindingErrors)) {
    a.ir.bindingErrors.forEach((error, index) => {
      const valid =
        isRecord(error) &&
        isString(error.message) &&
        (error.severity === 'warn' || error.severity === 'error') &&
        (error.sqlFragment === undefined || isString(error.sqlFragment));
      if (!valid) problems.push(`ir.bindingErrors[${index}] was ignored because required fields are invalid.`);
    });
  }
}

function finiteOptional(value: unknown, path: string, problems: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`${path} was ignored because it is not a finite number.`);
    return undefined;
  }
  return value;
}

function nonnegativeOptional(value: unknown, path: string, problems: string[]): number | undefined {
  const number = finiteOptional(value, path, problems);
  if (number !== undefined && number < 0) {
    problems.push(`${path} was ignored because it is negative.`);
    return undefined;
  }
  return number;
}

/** Keep valid M3 entries and make every rejected nested object visible. */
function validatedExecution(value: unknown, problems: string[]): ExecutionAnalysis | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push('Execution analysis was ignored because it is not an object.');
    return undefined;
  }

  const entries = <T>(
    field: string,
    required: string[],
    extra?: (entry: Record<string, unknown>, path: string) => T,
  ): T[] => {
    const raw = value[field];
    if (!Array.isArray(raw)) {
      problems.push(`execution.${field} was ignored because it is not an array.`);
      return [];
    }
    const out: T[] = [];
    raw.forEach((item, index) => {
      const path = `execution.${field}[${index}]`;
      if (!isRecord(item) || required.some((key) => !isString(item[key]))) {
        problems.push(`${path} was ignored because required text fields are missing.`);
        return;
      }
      out.push(extra ? extra(item, path) : (item as T));
    });
    return out;
  };

  const accessPaths = entries<ExecutionAnalysis['accessPaths'][number]>(
    'accessPaths',
    ['relation', 'path', 'reason'],
    (item, path) => {
      const estimatedRows = nonnegativeOptional(item.estimatedRows, `${path}.estimatedRows`, problems);
      return {
        relation: item.relation as string,
        path: ['seq-scan', 'index-scan', 'index-only-scan', 'bitmap-heap-scan', 'unknown'].includes(item.path as string)
          ? item.path as ExecutionAnalysis['accessPaths'][number]['path']
          : (problems.push(`${path}.path was invalid and was rendered as unknown.`), 'unknown'),
        ...(isString(item.usingIndex) ? { usingIndex: item.usingIndex } : {}),
        ...(estimatedRows !== undefined ? { estimatedRows } : {}),
        reason: item.reason as string,
      };
    },
  );
  const joinStrategies = entries<ExecutionAnalysis['joinStrategies'][number]>(
    'joinStrategies',
    ['join', 'algorithm', 'reason'],
    (item, path) => {
      const estimatedRows = nonnegativeOptional(item.estimatedRows, `${path}.estimatedRows`, problems);
      return {
        join: item.join as string,
        algorithm: ['nested-loop', 'hash-join', 'merge-join', 'unknown'].includes(item.algorithm as string)
          ? item.algorithm as ExecutionAnalysis['joinStrategies'][number]['algorithm']
          : (problems.push(`${path}.algorithm was invalid and was rendered as unknown.`), 'unknown'),
        reason: item.reason as string,
        ...(estimatedRows !== undefined ? { estimatedRows } : {}),
      };
    },
  );
  const dominantCosts = entries<ExecutionAnalysis['dominantCosts'][number]>(
    'dominantCosts',
    ['what', 'why'],
    (item, path) => {
      const share = finiteOptional(item.estimatedShare, `${path}.estimatedShare`, problems);
      if (share !== undefined && (share < 0 || share > 1)) {
        problems.push(`${path}.estimatedShare was ignored because it is outside 0..1.`);
      }
      return {
        what: item.what as string,
        why: item.why as string,
        ...(share !== undefined && share >= 0 && share <= 1 ? { estimatedShare: share } : {}),
      };
    },
  );
  const memoryRisks = entries<ExecutionAnalysis['memoryRisks'][number]>('memoryRisks', ['operation', 'why']);
  const estimationRisks = entries<ExecutionAnalysis['estimationRisks'][number]>(
    'estimationRisks',
    ['where', 'why', 'direction'],
    (item, path) => ({
      where: item.where as string,
      why: item.why as string,
      direction: ['over', 'under', 'unknown'].includes(item.direction as string)
        ? item.direction as 'over' | 'under' | 'unknown'
        : (problems.push(`${path}.direction was invalid and was rendered as unknown.`), 'unknown'),
      // Only a real boolean promotes a risk to the prominent treatment; anything
      // else is ignored rather than coerced, so a stray truthy value cannot shout.
      ...(item.severe === true ? { severe: true } : {}),
    }),
  );

  let scalability: ExecutionAnalysis['scalability'];
  if (!isRecord(value.scalability) || !isString(value.scalability.summary)) {
    problems.push('execution.scalability was incomplete; its summary was omitted.');
    scalability = { summary: '' };
  } else {
    scalability = {
      summary: value.scalability.summary,
      ...(isString(value.scalability.complexity) ? { complexity: value.scalability.complexity } : {}),
    };
  }
  return { accessPaths, joinStrategies, dominantCosts, memoryRisks, estimationRisks, scalability };
}

function validatedSemantics(value: unknown, problems: string[]): Analysis['semantics'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push('Semantic explanation was ignored because it is not an object.');
    return undefined;
  }
  const headline = isString(value.headline) ? value.headline : '';
  if (!isString(value.headline)) problems.push('semantics.headline was missing or invalid.');
  const steps = Array.isArray(value.steps)
    ? value.steps.filter((step, index): step is Analysis['semantics']['steps'][number] => {
        const ok =
          isRecord(step) &&
          isString(step.title) &&
          isString(step.detail) &&
          (step.sqlFragment === undefined || isString(step.sqlFragment));
        if (!ok) problems.push(`semantics.steps[${index}] was ignored because required text fields are missing.`);
        return ok;
      })
    : (problems.push('semantics.steps was ignored because it is not an array.'), []);
  const resultShape = isRecord(value.resultShape) ? value.resultShape : undefined;
  if (!resultShape || !isString(resultShape.grain) || !Array.isArray(resultShape.columns)) {
    problems.push('semantics.resultShape was incomplete; unavailable fields were omitted.');
  }
  const columns = Array.isArray(resultShape?.columns)
    ? resultShape.columns.filter((column, index): column is { name: string; meaning: string } => {
        const ok = isRecord(column) && isString(column.name) && isString(column.meaning);
        if (!ok) problems.push(`semantics.resultShape.columns[${index}] was ignored because required text fields are missing.`);
        return ok;
      })
    : [];
  const caveats = Array.isArray(value.caveats)
    ? value.caveats.filter((caveat, index): caveat is Analysis['semantics']['caveats'][number] => {
        const ok =
          isRecord(caveat) &&
          isString(caveat.issue) &&
          isString(caveat.why) &&
          (caveat.sqlFragment === undefined || isString(caveat.sqlFragment));
        if (!ok) problems.push(`semantics.caveats[${index}] was ignored because required text fields are missing.`);
        return ok;
      })
    : (problems.push('semantics.caveats was ignored because it is not an array.'), []);
  return {
    headline,
    steps,
    resultShape: { grain: isString(resultShape?.grain) ? resultShape.grain : '', columns },
    caveats,
  };
}

function timingValue(value: unknown): TimingValue {
  if (value === undefined) return { state: 'missing' };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { state: 'invalid', detail: 'the supplied value is not finite' };
  }
  if (value <= 0) return { state: 'invalid', detail: `${value} ms is not positive` };
  return { state: 'measured', value };
}

export function compareTimings(verification: Analysis['verification'] | undefined): TimingComparison {
  const baseline = timingValue(verification?.baselineMs);
  const optimized = timingValue(verification?.optimizedMs);
  if (baseline.state !== 'measured' || optimized.state !== 'measured') {
    return { baseline, optimized, kind: 'unavailable' };
  }
  const deltaMs = optimized.value! - baseline.value!;
  const deltaPct = deltaMs / baseline.value!;
  const ratio = deltaMs <= 0 ? baseline.value! / optimized.value! : optimized.value! / baseline.value!;
  if (![deltaMs, deltaPct, ratio].every(Number.isFinite) || ratio <= 0) {
    return {
      baseline,
      optimized,
      kind: 'unavailable',
      detail: 'derived timing arithmetic was non-finite',
    };
  }
  const kind = deltaPct <= -0.15 ? 'improvement' : deltaPct >= 0.15 ? 'regression' : 'similar';
  return { baseline, optimized, kind, deltaMs, deltaPct, ratio };
}

function validatedVerification(value: unknown, problems: string[]): Analysis['verification'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push('Verification was ignored because it is not an object.');
    return undefined;
  }
  const out: Record<string, unknown> = {};
  if ('baselineMs' in value) out.baselineMs = value.baselineMs;
  if ('optimizedMs' in value) out.optimizedMs = value.optimizedMs;
  if ('resultsMatch' in value) {
    if (typeof value.resultsMatch === 'boolean') out.resultsMatch = value.resultsMatch;
    else problems.push('verification.resultsMatch was ignored because it is not boolean.');
  }
  if ('baselinePlan' in value) out.baselinePlan = value.baselinePlan;
  if ('optimizedPlan' in value) out.optimizedPlan = value.optimizedPlan;
  return out as Analysis['verification'];
}

function dependencyProblemFor(
  rw: Rewrite,
  requiredIndexId: string,
  indexes: IndexRecommendation[],
): DependencyProblem | undefined {
  const matches = indexes.filter((idx) => indexSatisfies(idx, requiredIndexId));
  if (matches.length === 1) return undefined;
  return {
    rewriteId: rw.id,
    rewriteTitle: rw.title,
    requiredIndexId,
    reason: matches.length === 0 ? 'missing' : 'ambiguous',
  };
}

function collectDependencyProblems(rewrites: Rewrite[], indexes: IndexRecommendation[]): DependencyProblem[] {
  return rewrites.flatMap((rw) =>
    (rw.requiresIndexes ?? []).flatMap((id) => {
      const problem = dependencyProblemFor(rw, id, indexes);
      return problem ? [problem] : [];
    }),
  );
}

/**
 * Findings own the editorial meaning of a change. Recommendations without a
 * finding still need a sensible state, so priority 1/2 is required work and
 * priority 3 is optional. Safety blockers always require attention even when
 * the blocked proposal was otherwise low priority.
 */
function combineActionability(
  findings: Finding[],
  indexes: IndexRecommendation[],
  rewrites: Rewrite[],
  dependencyProblems: DependencyProblem[],
): Actionability {
  if (dependencyProblems.length || rewrites.some((rw) => rw.equivalence === 'different-semantics')) return 'required';
  if (findings.some((finding) => finding.actionability === 'required')) return 'required';
  if ([...indexes, ...rewrites].some((recommendation) => recommendation.priority < 3)) return 'required';
  if (
    findings.some((finding) => finding.actionability === 'optional') ||
    indexes.length > 0 ||
    rewrites.length > 0
  ) return 'optional';
  return 'none';
}

// ---------------------------------------------------------------------------
// Union-find over findings, so two findings describing one problem cluster
// ---------------------------------------------------------------------------

function makeUnionFind(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  return {
    find,
    union(a: number, b: number) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    },
  };
}

interface RecommendationComponent {
  /** Stable construction order; used only as a deterministic final tie-breaker. */
  order: number;
  indexPositions: number[];
  rewritePositions: number[];
  /** True when at least one valid exact-ID dependency edge built this component. */
  hasDependencyEdge: boolean;
  /** Live finding positions supported by recommendation affinity. */
  findingPositions: number[];
}

/**
 * Build deployable change sets before asking which finding they address.
 *
 * Only a Rewrite.requiresIndexes value that resolves to exactly one valid
 * IndexRecommendation.id creates an edge. Missing, blank, and duplicate IDs
 * deliberately create no edge: those are dependency blockers, not weak hints
 * that may be repaired with DDL text, physical names, or severity.
 */
function buildRecommendationComponents(
  indexes: IndexRecommendation[],
  rewrites: Rewrite[],
): RecommendationComponent[] {
  const nodeCount = indexes.length + rewrites.length;
  const uf = makeUnionFind(nodeCount);
  const validEdges: Array<[number, number]> = [];

  rewrites.forEach((rw, ri) => {
    for (const required of rw.requiresIndexes ?? []) {
      const matches = indexes
        .map((idx, ii) => ({ idx, ii }))
        .filter(({ idx }) => indexSatisfies(idx, required));
      if (matches.length !== 1) continue;
      const indexNode = matches[0].ii;
      const rewriteNode = indexes.length + ri;
      uf.union(indexNode, rewriteNode);
      validEdges.push([indexNode, rewriteNode]);
    }
  });

  const grouped = new Map<number, RecommendationComponent>();
  for (let node = 0; node < nodeCount; node++) {
    const root = uf.find(node);
    const component = grouped.get(root) ?? {
      order: node,
      indexPositions: [],
      rewritePositions: [],
      hasDependencyEdge: false,
      findingPositions: [],
    };
    component.order = Math.min(component.order, node);
    if (node < indexes.length) component.indexPositions.push(node);
    else component.rewritePositions.push(node - indexes.length);
    grouped.set(root, component);
  }

  for (const [indexNode] of validEdges) {
    const component = grouped.get(uf.find(indexNode));
    if (component) component.hasDependencyEdge = true;
  }
  return [...grouped.values()].sort((a, b) => a.order - b.order);
}

/**
 * Relationship strength, never urgency, selects finding affinity. Equal best
 * scores retain every tied finding instead of choosing by severity/input order.
 */
function strongestAffinityPositions(scores: number[]): number[] {
  const best = Math.max(0, ...scores);
  if (best < ATTACH_THRESHOLD) return [];
  return scores.flatMap((score, position) => score === best ? [position] : []);
}

// ---------------------------------------------------------------------------
// Model construction
// ---------------------------------------------------------------------------

export function buildModel(analysis: Analysis): ReportModel {
  const a = (analysis ?? {}) as Analysis;
  const validationProblems: string[] = [];
  validateTopLevel(a, validationProblems);
  const allFindings = validatedEntries<Finding>(a.findings, 'Finding', missingFindingFields, validationProblems);
  const indexes = validatedEntries<IndexRecommendation>(a.indexes, 'Index recommendation', missingIndexFields, validationProblems);
  const rewrites = validatedEntries<Rewrite>(a.rewrites, 'Rewrite', missingRewriteFields, validationProblems);
  const execution = validatedExecution(a.execution, validationProblems);
  const semantics = validatedSemantics(a.semantics, validationProblems);
  const verification = validatedVerification(a.verification, validationProblems);
  const timing = compareTimings(verification);
  if (timing.baseline.state === 'invalid') {
    validationProblems.push(`verification.baselineMs is invalid: ${timing.baseline.detail}.`);
  }
  if (timing.optimized.state === 'invalid') {
    validationProblems.push(`verification.optimizedMs is invalid: ${timing.optimized.detail}.`);
  }
  if (timing.detail) {
    validationProblems.push(`verification timing comparison is invalid: ${timing.detail}.`);
  }
  const dependencyProblems = collectDependencyProblems(rewrites, indexes);
  const duplicateIndexIds = [...new Set(indexes.map((idx) => idx.id))].filter(
    (id) => indexes.filter((idx) => idx.id === id).length > 1,
  );
  for (const id of duplicateIndexIds) {
    validationProblems.push(`Index recommendation id "${id}" is duplicated; references to it are ambiguous.`);
  }
  const vocab = schemaVocabulary(a.ir);

  // 1. Split off performance observations that explicitly call for no change.
  //    Severity says how important a fact is; only the structured actionability
  //    field says whether it belongs in an action queue. Correctness and intent
  //    risks stay visible even if upstream could not propose a safe change.
  const cleared = allFindings.filter((f) => f.category === 'performance' && f.actionability === 'none');
  const candidates = allFindings.filter((f) => !(f.category === 'performance' && f.actionability === 'none'));

  // 2. Classify, then apply the low-confidence penalty. A low-confidence
  //    correctness claim keeps its rank and gets a badge instead: hedging the
  //    order of a wrong-results report would be worse than hedging its wording.
  const classified = candidates.map((f, i) => {
    const c = classify(f);
    const effective =
      f.confidence === 'low' && c.kind === 'performance' ? demote(f.severity) : f.severity;
    return { f, i, ...c, effective };
  });

  // 3. Cut the noise floor: unconfident and unimportant, with nothing attached.
  const deferredIdx = new Set<number>();
  for (const c of classified) {
    if (c.kind !== 'performance' || c.f.actionability !== 'none') continue;
    if (c.f.confidence === 'low' && severityRank(c.effective) >= severityRank('low')) deferredIdx.add(c.i);
  }

  const live = classified.filter((c) => !deferredIdx.has(c.i));
  const deferred = classified.filter((c) => deferredIdx.has(c.i)).map((c) => c.f);

  // 4. Exact-ID dependency components are deployable change sets. Build them
  //    before affinity so a shared index, a multi-index rewrite, or a chain of
  //    rewrites/indexes can never be consumed by separate issue assignments.
  const components = buildRecommendationComponents(indexes, rewrites);
  const indexAffinityScores = indexes.map((idx) => live.map((c) => indexAffinity(c.f, idx, vocab)));
  const rewriteAffinityScores = rewrites.map((rw) => live.map((c) => rewriteAffinity(c.f, rw, vocab)));
  const idxCandidates = indexAffinityScores.map((scores) =>
    scores.flatMap((score, position) => score >= MERGE_THRESHOLD ? [position] : []),
  );
  const rwCandidates = rewriteAffinityScores.map((scores) =>
    scores.flatMap((score, position) => score >= MERGE_THRESHOLD ? [position] : []),
  );

  for (const component of components) {
    const positions = new Set<number>();
    for (const ii of component.indexPositions) {
      for (const position of strongestAffinityPositions(indexAffinityScores[ii] ?? [])) positions.add(position);
    }
    for (const ri of component.rewritePositions) {
      for (const position of strongestAffinityPositions(rewriteAffinityScores[ri] ?? [])) positions.add(position);
    }
    component.findingPositions = [...positions].sort((a, b) => a - b);
  }

  // 5. Cluster findings that are the same problem stated twice.
  const uf = makeUnionFind(live.length);
  for (let x = 0; x < live.length; x++) {
    for (let y = x + 1; y < live.length; y++) {
      const fx = live[x].f;
      const fy = live[y].f;
      const sameFragment =
        norm(fx.evidence?.sqlFragment).length >= 8 &&
        norm(fx.evidence?.sqlFragment) === norm(fy.evidence?.sqlFragment);
      if (
        clusterClass(live[x].kind) === clusterClass(live[y].kind) &&
        sameFragment &&
        sameRelation(fx.evidence?.relation, fy.evidence?.relation)
      ) uf.union(x, y);
    }
  }
  for (const positions of rwCandidates) {
    for (const cls of ['intent', 'non-intent'] as const) {
      const sameClass = positions.filter((position) => clusterClass(live[position].kind) === cls);
      for (let k = 1; k < sameClass.length; k++) uf.union(sameClass[0], sameClass[k]);
    }
  }
  for (const positions of idxCandidates) {
    for (const cls of ['intent', 'non-intent'] as const) {
      const sameClass = positions.filter((position) => clusterClass(live[position].kind) === cls);
      for (let k = 1; k < sameClass.length; k++) uf.union(sameClass[0], sameClass[k]);
    }
  }
  // A component may address several findings through different members. Keep
  // those findings and the complete change set in one issue; category and
  // severity rank that issue later, but never decide component ownership.
  for (const component of components) {
    for (let k = 1; k < component.findingPositions.length; k++) {
      uf.union(component.findingPositions[0], component.findingPositions[k]);
    }
  }

  // 6. Materialize clusters.
  const groups = new Map<number, number[]>();
  live.forEach((_, pos) => {
    const root = uf.find(pos);
    const g = groups.get(root) ?? [];
    g.push(pos);
    groups.set(root, g);
  });

  const componentsByFindingRoot = new Map<number, RecommendationComponent[]>();
  for (const component of components) {
    if (component.findingPositions.length === 0) continue;
    const root = uf.find(component.findingPositions[0]);
    const attached = componentsByFindingRoot.get(root) ?? [];
    attached.push(component);
    componentsByFindingRoot.set(root, attached);
  }

  const dominantCosts = execution?.dominantCosts ?? [];
  const claimedCosts = new Set<number>();

  const issues: Issue[] = [];
  for (const [root, positions] of groups) {
    positions.sort((p, q) => {
      const risk = issueKindRank(live[p].kind, live[p].effective) - issueKindRank(live[q].kind, live[q].effective);
      if (risk !== 0) return risk;
      const d = severityRank(live[p].effective) - severityRank(live[q].effective);
      if (d !== 0) return d;
      const c = confidenceRank(live[p].f.confidence) - confidenceRank(live[q].f.confidence);
      if (c !== 0) return c;
      return live[p].i - live[q].i;
    });

    const members = positions.map((p) => live[p]);
    const primary = members[0];
    const attachedComponents = componentsByFindingRoot.get(root) ?? [];
    const attachedIndexPositions = new Set(attachedComponents.flatMap((component) => component.indexPositions));
    const attachedRewritePositions = new Set(attachedComponents.flatMap((component) => component.rewritePositions));
    const attachedIdx = indexes.filter((_, ii) => attachedIndexPositions.has(ii));
    const attachedRw = rewrites.filter((_, ri) => attachedRewritePositions.has(ri));
    const findingCorrectness = members.find((m) => m.kind === 'correctness');
    const findingIntent = members.find((m) => m.kind === 'intent');
    const materialIntent = members.find(
      (m) => m.kind === 'intent' && severityRank(m.effective) <= severityRank('high'),
    );
    const findingSemanticRisk = findingCorrectness ?? findingIntent;
    const ungroundedSemanticChange = !findingSemanticRisk && attachedRw.some((rw) => rw.equivalence === 'different-semantics');
    const kind: IssueKind = findingCorrectness
      ? 'correctness'
      : materialIntent
        ? 'intent'
        : ungroundedSemanticChange
          ? 'correctness'
          : 'performance';
    const issueDependencyProblems = dependencyProblems.filter((problem) =>
      attachedRw.some((rw) => rw.id === problem.rewriteId),
    );

    // Runtime costs that name the same relations/columns belong here, not in a
    // separate "where the time goes" list the reader has to cross-reference.
    const issueText = members
      .map((m) => `${m.f.title} ${m.f.impact} ${m.f.evidence?.relation ?? ''} ${m.f.evidence?.column ?? ''} ${m.f.evidence?.sqlFragment ?? ''}`)
      .join(' ');
    const costs = dominantCosts.filter((dc, ci) => {
      if (claimedCosts.has(ci)) return false;
      const ok = identOverlap(issueText, `${dc.what} ${dc.why}`, vocab) >= 2;
      if (ok) claimedCosts.add(ci);
      return ok;
    });

    // A multi-finding component stays intact, but urgency cannot leak across
    // categories: a critical performance observation does not make a low
    // intent caveat material, and an urgent intent choice does not rewrite a
    // performance finding's supplied severity.
    const kindMembers = members.filter((member) => member.kind === kind);
    const severityMembers = kindMembers.length ? kindMembers : members;
    const severity = SEVERITY_ORDER[Math.min(...severityMembers.map((m) => severityRank(m.f.severity)))];
    const effectiveSeverity = SEVERITY_ORDER[Math.min(...severityMembers.map((m) => severityRank(m.effective)))];
    // Confidence belongs to the highest-severity claim that titles the issue.
    // A low-confidence corroborating detail must not erase strong primary
    // evidence; conversely, a high-confidence minor detail cannot rescue a
    // low-confidence critical claim.
    const confidence = (ungroundedSemanticChange ? 'low' : primary.f.confidence ?? 'medium') as Confidence;

    const quantified = /\d/.test(`${primary.f.impact}`) ? 0 : 1;
    const bestPriority = Math.min(
      ...[...attachedIdx.map((x) => x.priority ?? 3), ...attachedRw.map((x) => x.priority ?? 3), 3],
    );

    issues.push({
      key: `issue-${root}`,
      title: primary.f.title,
      kind,
      severity,
      effectiveSeverity,
      confidence,
      actionability: combineActionability(
        members.map((m) => m.f),
        attachedIdx,
        attachedRw,
        issueDependencyProblems,
      ),
      findings: members.map((m) => m.f),
      indexes: attachedIdx,
      rewrites: attachedRw,
      costs,
      dependencyProblems: issueDependencyProblems,
      semanticChangeJustified: !!findingSemanticRisk,
      sortKey: [
        issueKindRank(kind, effectiveSeverity),
        severityRank(effectiveSeverity),
        confidenceRank(primary.f.confidence),
        quantified,
        bestPriority,
        primary.i,
      ],
    });
  }

  // 7. Components with no proven finding affinity still render once, intact.
  //    A result-changing component stays an explicit confirmation branch when
  //    the report already contains a structural intent/correctness risk; it
  //    must not manufacture a competing correctness leader merely because the
  //    relationship could not be proved by affinity.
  const elsewhereMember =
    live.find((member) =>
      member.kind === 'intent' && severityRank(member.effective) <= severityRank('high')) ??
    live.find((member) => member.kind === 'correctness');
  const semanticRiskElsewhere: SemanticRiskElsewhere | undefined = elsewhereMember
    ? { kind: elsewhereMember.kind as 'correctness' | 'intent', title: elsewhereMember.f.title }
    : undefined;

  for (const component of components.filter((candidate) => candidate.findingPositions.length === 0)) {
    const componentIndexes = component.indexPositions.map((position) => indexes[position]);
    const componentRewrites = component.rewritePositions.map((position) => rewrites[position]);
    const componentRewriteIds = new Set(componentRewrites.map((rw) => rw.id));
    const componentDependencyProblems = dependencyProblems.filter((problem) => componentRewriteIds.has(problem.rewriteId));
    const changesResults = componentRewrites.some((rw) => rw.equivalence === 'different-semantics');
    const bestPriority = Math.min(
      ...componentIndexes.map((idx) => idx.priority ?? 3),
      ...componentRewrites.map((rw) => rw.priority ?? 3),
      3,
    );
    const sev: Severity = changesResults ? 'high' : bestPriority === 1 ? 'high' : bestPriority === 2 ? 'medium' : 'low';
    const kind: IssueKind = changesResults ? semanticRiskElsewhere?.kind ?? 'correctness' : 'performance';
    const leadRewrite = componentRewrites[0];
    const leadIndex = componentIndexes[0];
    const title = leadRewrite
      ? changesResults && semanticRiskElsewhere?.kind === 'intent'
        ? `Intent-confirmation branch — ${leadRewrite.title}`
        : changesResults && semanticRiskElsewhere
          ? `Result-changing proposal requiring confirmation — ${leadRewrite.title}`
          : changesResults
            ? `Unjustified result-changing rewrite — ${leadRewrite.title}`
            : leadRewrite.title
      : `Missing index on ${leadIndex.table} (${(leadIndex.columns ?? []).join(', ')})`;
    const confidence: Confidence = changesResults
      ? 'low'
      : leadRewrite
        ? 'medium'
        : leadIndex.confidence ?? 'medium';

    issues.push({
      key: `${component.hasDependencyEdge ? 'change-set' : 'recommendation'}-${component.order}`,
      title,
      kind,
      severity: sev,
      effectiveSeverity: sev,
      confidence,
      actionability: combineActionability([], componentIndexes, componentRewrites, componentDependencyProblems),
      findings: [],
      indexes: componentIndexes,
      rewrites: componentRewrites,
      costs: [],
      dependencyProblems: componentDependencyProblems,
      semanticChangeJustified: false,
      ...(changesResults && semanticRiskElsewhere ? { semanticRiskElsewhere } : {}),
      sortKey: [
        issueKindRank(kind, sev),
        severityRank(sev),
        confidenceRank(confidence),
        1,
        bestPriority,
        1000 + component.order,
      ],
    });
  }

  const bySortKey = (x: Issue, y: Issue) => {
    for (let i = 0; i < Math.max(x.sortKey.length, y.sortKey.length); i++) {
      const d = (x.sortKey[i] ?? 0) - (y.sortKey[i] ?? 0);
      if (d !== 0) return d;
    }
    return x.key.localeCompare(y.key);
  };
  issues.sort(bySortKey);

  // 7b. Structured optional findings and priority-3 orphan recommendations are
  //     cleanup, not first-screen work. Semantic/correctness risks and blocked
  //     dependencies remain in the main report even if their proposed change
  //     was marked optional.
  const optional = issues.filter(
    (i) =>
      i.kind === 'performance' &&
      i.actionability === 'optional' &&
      i.dependencyProblems.length === 0 &&
      !i.rewrites.some((rw) => rw.equivalence === 'different-semantics'),
  );
  const optionalKeys = new Set(optional.map((i) => i.key));
  const mainIssues = issues.filter((i) => !optionalKeys.has(i.key));

  // Point the cleared findings at any cleanup that grew out of them, so the two
  // halves of "we checked this, and here is the cosmetic version" stay joined.
  const clearedEntries = cleared.map((f) => {
    const followUps = optional
      .filter((o) =>
        o.rewrites.some((rw) => rewriteAffinity(f, rw, vocab) >= ATTACH_THRESHOLD) ||
        o.indexes.some((ix) => indexAffinity(f, ix, vocab) >= ATTACH_THRESHOLD),
      )
      .map((o) => o.title);
    return { finding: f, followUps };
  });

  const residualCosts = dominantCosts.filter((_, ci) => !claimedCosts.has(ci));

  // 8. M2's caveats overlap heavily with M4's findings. Drop the ones already
  //    argued above; a reader who sees the same defect twice stops reading.
  const renderedText = [...issues.flatMap((i) => i.findings), ...cleared]
    .map((f) => `${f.title} ${f.impact} ${f.evidence?.sqlFragment ?? ''}`)
    .join(' | ');
  const uncoveredCaveats = (semantics?.caveats ?? []).filter((c) => {
    const frag = norm(c.sqlFragment);
    if (frag.length >= 8 && norm(renderedText).includes(frag)) return false;
    return identOverlap(`${c.issue} ${c.why}`, renderedText, vocab) < 2;
  });

  const verdict = decideVerdict(
    a,
    mainIssues,
    cleared,
    deferred,
    uncoveredCaveats,
    verification,
    timing,
    validationProblems,
    dependencyProblems,
  );
  const limits = collectLimits(a, mainIssues, deferred, rewrites, verification, validationProblems, dependencyProblems);
  const originalSql =
    typeof a.sql === 'string' && a.sql.trim()
      ? a.sql
      : typeof a.ir?.originalSql === 'string' && a.ir.originalSql.trim()
        ? a.ir.originalSql
        : undefined;

  return {
    title: 'SQLSage analysis',
    subtitle: semantics?.headline || undefined,
    originalSql,
    verdict,
    bottomLine: composeBottomLine(
      semantics,
      mainIssues,
      cleared,
      uncoveredCaveats,
      verdict.kind,
      timing,
      verification,
      dependencyProblems,
    ),
    issues: mainIssues,
    optional,
    cleared: clearedEntries,
    deferred,
    residualCosts,
    execution,
    planShape: composePlanShape(execution),
    uncoveredCaveats,
    semantics,
    verification,
    timing,
    dependencyProblems,
    validationProblems,
    limits,
    counts: { findings: allFindings.length, indexes: indexes.length, rewrites: rewrites.length },
  };
}

// ---------------------------------------------------------------------------
// Verdict and lede
// ---------------------------------------------------------------------------

function hasHardBindingErrors(ir: QueryIR | undefined): boolean {
  return Array.isArray(ir?.bindingErrors) && ir.bindingErrors.some((e) => e?.severity === 'error');
}

function missingAnalysisParts(a: Analysis): string[] {
  const missing: string[] = [];
  if (!a?.ir || !Array.isArray(a.ir.blocks) || !Array.isArray(a.ir.bindingErrors)) missing.push('bound query IR');
  if (!a?.semantics) missing.push('semantic explanation');
  if (!a?.execution) missing.push('execution analysis');
  if (!Array.isArray(a?.findings)) missing.push('findings');
  if (!Array.isArray(a?.indexes)) missing.push('index recommendations');
  if (!Array.isArray(a?.rewrites)) missing.push('rewrite recommendations');
  // A module that never ran reports no findings, which is byte-identical to a module
  // that ran and found nothing. Only the producer knows which, so it has to say so.
  // Anything declared here blocks a categorical verdict exactly like a rejected field.
  const declared = a?.missingModules;
  if (Array.isArray(declared)) {
    const named = declared.filter(isNonEmptyString).map((m) => m.trim());
    if (named.length) missing.push(`analyzer modules ${[...new Set(named)].sort().join(', ')}`);
  }
  const blocked = a?.blockedReasons;
  if (Array.isArray(blocked)) {
    const reasons = blocked.filter(isNonEmptyString).map((reason) => reason.trim());
    if (reasons.length) missing.push(`blocked scope: ${[...new Set(reasons)].join('; ')}`);
  }
  return missing;
}

function hasJustifiedResultChange(issues: Issue[]): boolean {
  return issues.some(
    (i) => i.semanticChangeJustified && i.rewrites.some((rw) => rw.equivalence === 'different-semantics'),
  );
}

function decideVerdict(
  a: Analysis,
  issues: Issue[],
  cleared: Finding[],
  deferred: Finding[],
  uncoveredCaveats: ReportModel['uncoveredCaveats'],
  verification: Analysis['verification'] | undefined,
  timing: TimingComparison,
  validationProblems: string[],
  dependencyProblems: DependencyProblem[],
): ReportModel['verdict'] {
  // Trust gates precede every categorical claim. A polished correctness or
  // intent finding must not acquire an absolute verdict when binding failed,
  // required evidence was rejected, or a deployable bundle is unresolved.
  // The issues remain in the model and render below this provisional banner.
  const hardBinding = hasHardBindingErrors(a?.ir);
  const missing = missingAnalysisParts(a);
  if (hardBinding || missing.length || validationProblems.length || dependencyProblems.length) {
    const reasons = [
      ...(hardBinding ? ['hard schema-binding errors'] : []),
      ...(missing.length ? [`missing ${missing.join(', ')}`] : []),
      ...(validationProblems.length ? [`${validationProblems.length} malformed field${validationProblems.length === 1 ? '' : 's'}`] : []),
      ...(dependencyProblems.length ? [`${dependencyProblems.length} unresolved index dependenc${dependencyProblems.length === 1 ? 'y' : 'ies'}`] : []),
    ];
    return {
      kind: 'incomplete',
      label: 'ANALYSIS INCOMPLETE',
      banner:
        `This report is provisional (${reasons.join('; ')}). The risks and candidate actions remain visible below, ` +
        'but rejected or unresolved analyzer data prevents a categorical safety or deployability verdict.',
    };
  }

  const correctness = issues.filter((i) => i.kind === 'correctness');
  const confidentCorrectness = correctness.filter((i) => i.confidence !== 'low');

  if (confidentCorrectness.length) {
    const n = correctness.length;
    return {
      kind: 'wrong-results',
      label: 'WRONG RESULTS',
      banner:
        n === 1
          ? 'This query returns wrong answers today. Fix that before you spend a minute on its speed.'
          : `This query returns wrong answers today (${n} separate defects). Fix those before you spend a minute on its speed.`,
    };
  }

  if (verification?.resultsMatch === false && !hasJustifiedResultChange(issues)) {
    return {
      kind: 'possible-wrong-results',
      label: 'RESULTS CHANGED',
      banner:
        'Live verification says the proposed version returns different rows, but no established correctness fix explains why. Do not ship it until that difference is reconciled.',
    };
  }
  if (correctness.length) {
    return {
      kind: 'possible-wrong-results',
      label: 'POSSIBLE WRONG RESULTS',
      banner:
        'There is a plausible correctness defect here, but the analyzer is not confident. Verify it against real data before acting on anything else in this report.',
    };
  }

  const intentBlockers = issues.filter(
    (i) => i.kind === 'intent' && severityRank(i.effectiveSeverity) <= severityRank('high'),
  );
  if (intentBlockers.length) {
    return {
      kind: 'intent-required',
      label: 'INTENT REQUIRED',
      banner:
        intentBlockers.length === 1
          ? 'The SQL has a material semantic choice that the analyzer cannot make for you. Confirm the intended rows before tuning or shipping a rewrite.'
          : `${intentBlockers.length} material semantic choices need an owner. Confirm the intended rows before tuning or shipping a rewrite.`,
    };
  }

  if (timing.kind === 'regression') {
    return {
      kind: 'needs-work',
      label: 'MEASURED REGRESSION',
      banner: 'The tested variant is materially slower than baseline. Do not ship it as an optimization until the regression is explained or removed.',
    };
  }

  const top = issues[0];
  if (top && severityRank(top.effectiveSeverity) <= severityRank('high')) {
    return { kind: 'needs-work', label: 'ACTION NEEDED', banner: 'No correctness or intent blocker was reported. There is evidence-backed performance work to do.' };
  }
  if (top) {
    return { kind: 'minor', label: 'MINOR ISSUES', banner: 'Nothing urgent. A few things are worth cleaning up when you are next in this file.' };
  }
  const checked = cleared.length;
  const uncertain = deferred.length;
  return {
    kind: 'clean',
    label: uncoveredCaveats.length ? 'NO PERFORMANCE ACTION' : 'NO ACTION NEEDED',
    banner:
      uncoveredCaveats.length
        ? `No performance change is justified. Confirm ${uncoveredCaveats.length} semantic caveat${uncoveredCaveats.length === 1 ? '' : 's'} below before relying on the result as a business answer.`
        : checked && uncertain
        ? `No actionable problem was found. ${checked} check${checked === 1 ? '' : 's'} cleared; ${uncertain} low-confidence observation${uncertain === 1 ? '' : 's'} remain${uncertain === 1 ? 's' : ''} visible below.`
        : checked
          ? `No actionable problem was found. ${checked} check${checked === 1 ? '' : 's'} cleared below.`
          : uncertain
            ? `No actionable problem was established. ${uncertain} low-confidence observation${uncertain === 1 ? '' : 's'} remain${uncertain === 1 ? 's' : ''} visible below.`
            : 'No actionable problem was found in the complete analysis.',
  };
}

function firstSentence(s: unknown, max = 200): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  const out = m ? m[0] : t;
  return out.length > max ? out.slice(0, max - 1).replace(/[\s,;:]+\S*$/, '') + '…' : out;
}

export function fmtMs(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  if (ms < 0.05) return `${ms.toPrecision(3)} ms`;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 10000) return `${Math.round(ms).toLocaleString('en-US')} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function fmtPct(x: number | undefined): string | undefined {
  if (typeof x !== 'number' || !isFinite(x) || x < 0 || x > 1) return undefined;
  return `${Math.round(x * 100)}%`;
}

function composeBottomLine(
  semantics: Analysis['semantics'] | undefined,
  issues: Issue[],
  cleared: Finding[],
  uncoveredCaveats: ReportModel['uncoveredCaveats'],
  kind: VerdictKind,
  timing: TimingComparison,
  verification: Analysis['verification'] | undefined,
  dependencyProblems: DependencyProblem[],
): string[] {
  const out: string[] = [];
  const top = issues[0];

  if (top) {
    const lead = top.findings[0];
    const what = lead ? `**${lead.title}.** ${firstSentence(lead.impact, 260)}` : `**${top.title}.**`;
    out.push(what);

    const rest = issues.length - 1;
    const otherCorrectness = issues.filter((i) => i.kind === 'correctness').length - (top.kind === 'correctness' ? 1 : 0);
    const tail: string[] = [];
    if (otherCorrectness > 0) {
      tail.push(`${otherCorrectness} further correctness defect${otherCorrectness === 1 ? '' : 's'} below`);
    }
    const perf = issues.filter((i) => i.kind === 'performance').length;
    if (top.kind === 'correctness' && perf > 0) {
      tail.push(`${perf} performance issue${perf === 1 ? '' : 's'}, which should wait until the results are right`);
    } else if (rest > 0 && otherCorrectness === 0) {
      tail.push(`${rest} further issue${rest === 1 ? '' : 's'} below`);
    }
    if (tail.length) out.push(`Also: ${tail.join('; ')}.`);
  } else if (kind === 'clean') {
    const reasons = cleared
      .map((c) => firstSentence(c.title, 110).replace(/[.!?…]+$/, ''))
      .filter(Boolean)
      .slice(0, 2);
    out.push(
      reasons.length
        ? `Nothing to change for performance: ${reasons.join('; ')}.`
        : 'No actionable change was supported by the available evidence.',
    );
    const caveat = uncoveredCaveats[0];
    if (caveat) {
      out.push(`**Confirm intent — ${firstSentence(caveat.issue, 120)}** ${firstSentence(caveat.why, 220)}`);
    }
  }

  const grain = grainSentence(semantics?.resultShape?.grain);
  if (grain) out.push(`**Result grain.** ${grain}`);

  if (dependencyProblems.length) {
    const ids = [...new Set(dependencyProblems.map((problem) => problem.requiredIndexId))];
    const ambiguous = dependencyProblems.some((problem) => problem.reason === 'ambiguous');
    out.push(
      `**Action blocked — required index ${ids.length === 1 ? 'ID' : 'IDs'} ${ids.map((id) => `\`${id}\``).join(', ')} ` +
      `${ambiguous ? `${dependencyProblems.length === 1 ? 'is' : 'include references that are'} ambiguous` : `${dependencyProblems.length === 1 ? 'was' : 'were'} not supplied`}. ` +
      'Do not deploy the dependent rewrite until every ID resolves to exactly one recommendation.',
    );
  }

  const timingLine = formatTimingComparison(timing, verification !== undefined);
  if (timingLine) out.push(timingLine);

  if (verification?.resultsMatch === false) {
    const expectedDifference = hasJustifiedResultChange(issues);
    out.push(
      expectedDifference
        ? '_Verification note: the tested rewrite returns different rows. That can be expected for a correctness repair or an intent branch; confirm the new rows against the intended business meaning or an independent oracle._'
        : '_Verification warning: the proposed query returns different rows, and no established result-changing fix explains it. Treat the rewrites below as unsafe until you reconcile that._',
    );
  }
  return out.filter(Boolean);
}

function timingStateText(label: string, value: TimingValue): string {
  if (value.state === 'measured') return `${label} ${fmtMs(value.value)}`;
  if (value.state === 'invalid') return `${label} timing invalid (${value.detail})`;
  return `${label} not measured`;
}

function formatTimingComparison(timing: TimingComparison, supplied: boolean): string | undefined {
  if (!supplied) return undefined;
  const base = timingStateText('baseline', timing.baseline);
  const opt = timingStateText('optimized', timing.optimized);
  if (timing.kind === 'unavailable') {
    const reason = timing.detail ? ` (${timing.detail})` : '';
    return `Live timing: ${base}; ${opt}. A paired comparison is unavailable${reason}.`;
  }
  const baseMs = fmtMs(timing.baseline.value)!;
  const optMs = fmtMs(timing.optimized.value)!;
  const delta = fmtMs(Math.abs(timing.deltaMs!))!;
  const pctValue = Math.abs(timing.deltaPct! * 100);
  const pct = `${pctValue !== 0 && pctValue < 0.05 ? pctValue.toPrecision(3) : pctValue.toFixed(1)}%`;
  if (timing.kind === 'improvement') {
    return `Measured timing: ${baseMs} -> ${optMs}, ${delta} faster (${pct}; ${timing.ratio!.toFixed(2)}x speedup).`;
  }
  if (timing.kind === 'regression') {
    return `**Measured regression:** ${baseMs} -> ${optMs}, ${delta} slower (${pct}; ${timing.ratio!.toFixed(2)}x regression).`;
  }
  const direction = timing.deltaMs === 0 ? 'no absolute change' : `${delta} ${timing.deltaMs! > 0 ? 'slower' : 'faster'}`;
  return `Measured timing: ${baseMs} -> ${optMs}, ${direction} (${pct}); within the ±15% noise-range threshold, so effectively unchanged.`;
}

function composePlanShape(execution: ExecutionAnalysis | undefined): string | undefined {
  if (!execution) return undefined;
  const paths = (execution.accessPaths ?? []).slice(0, 6);
  const parts = paths.map((p) => {
    const bits = [`\`${p.relation}\``, (p.path ?? 'unknown').replace(/-/g, ' ')];
    if (p.usingIndex) bits.push(`via \`${p.usingIndex}\``);
    if (typeof p.estimatedRows === 'number') bits.push(`~${p.estimatedRows.toLocaleString('en-US')} rows`);
    // The reason is only interesting where the path is a symptom.
    if ((p.path === 'seq-scan' || p.path === 'unknown') && p.reason) bits.push(`(${firstSentence(p.reason, 90)})`);
    return bits.join(' ');
  });
  const joins = execution.joinStrategies ?? [];
  if (joins.length) {
    const counts = new Map<string, number>();
    for (const j of joins) counts.set(j.algorithm ?? 'unknown', (counts.get(j.algorithm ?? 'unknown') ?? 0) + 1);
    const summary = [...counts.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([alg, n]) => `${n}× ${alg.replace(/-/g, ' ')}`)
      .join(', ');
    parts.push(`joins: ${summary}`);
  }
  return parts.length ? parts.join('; ') + '.' : undefined;
}

function collectLimits(
  a: Analysis,
  issues: Issue[],
  deferred: Finding[],
  rewrites: Rewrite[],
  verification: Analysis['verification'] | undefined,
  validationProblems: string[],
  dependencyProblems: DependencyProblem[],
): string[] {
  const limits: string[] = [];
  const bindingErrors = Array.isArray(a?.ir?.bindingErrors) ? a.ir.bindingErrors : [];
  for (const e of bindingErrors) {
    if (!e || typeof e.message !== 'string' || !e.message) continue;
    const where = typeof e.sqlFragment === 'string' && e.sqlFragment ? ` (\`${norm(e.sqlFragment).slice(0, 60)}\`)` : '';
    const message = `${e.message}${where}`.replace(/[.!?]+$/, '');
    limits.push(`${e.severity === 'error' ? 'Unresolved' : 'Partially resolved'}: ${message}.`);
  }
  const missing = missingAnalysisParts(a);
  if (missing.length) limits.push(`Analyzer output was missing: ${missing.join(', ')}.`);
  const lowConf = issues.filter((i) => i.confidence === 'low');
  if (lowConf.length) {
    limits.push(
      `${lowConf.length} issue${lowConf.length === 1 ? '' : 's'} below rest${lowConf.length === 1 ? 's' : ''} on low-confidence reasoning and ${lowConf.length === 1 ? 'is' : 'are'} marked as such.`,
    );
  }
  if (deferred.length) {
    limits.push(`${deferred.length} low-confidence, low-impact observation${deferred.length === 1 ? '' : 's'} did not meet the bar for a recommendation; ${deferred.length === 1 ? 'it is' : 'they are'} listed rather than argued.`);
  }
  const conditionalWithoutAssumption = rewrites.filter(
    (rw) => rw.equivalence === 'conditional' && !norm(rw.equivalenceNotes),
  );
  if (conditionalWithoutAssumption.length) {
    limits.push(
      `${conditionalWithoutAssumption.length} conditionally equivalent rewrite${conditionalWithoutAssumption.length === 1 ? '' : 's'} omitted the required assumption; ${conditionalWithoutAssumption.length === 1 ? 'it is' : 'they are'} unsafe to apply as written.`,
    );
  }
  for (const problem of validationProblems) limits.push(`Malformed analyzer input: ${problem}`);
  for (const problem of dependencyProblems) {
    limits.push(
      `Unresolved dependency: rewrite \`${problem.rewriteId}\` requires index recommendation id ` +
      `\`${problem.requiredIndexId}\`, which is ${problem.reason === 'missing' ? 'missing' : 'duplicated and ambiguous'}.`,
    );
  }
  if (verification?.resultsMatch === true && rewrites.some((rw) => rw.equivalence === 'different-semantics')) {
    limits.push(
      'A rewrite is marked as result-changing but happened to match on the verification data; that sample does not prove semantic equivalence.',
    );
  }
  return limits;
}
