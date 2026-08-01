/**
 * SQLSage shared contracts.
 *
 * These types are the interface between modules. Modules own their implementation;
 * their module; nobody edits this file without it being a cross-module decision.
 *
 * Pipeline:
 *   catalog + sql --(M1)--> QueryIR
 *   QueryIR       --(M2)--> SemanticExplanation
 *   QueryIR       --(M3)--> ExecutionAnalysis
 *   QueryIR       --(M4)--> Finding[]
 *   + findings    --(M5)--> IndexRecommendation[]
 *   + findings    --(M6)--> Rewrite[]
 *   everything    --(M7)--> rendered report
 */

// ===========================================================================
// Catalog: the schema + statistics the analyzer reasons over.
// Populated from a live Postgres (pg_class/pg_stats) or a static JSON fixture.
// ===========================================================================

export type Dialect = 'postgres';

export interface ColumnStats {
  /** Fraction of rows where the column is NULL (pg_stats.null_frac). */
  nullFrac: number;
  /**
   * pg_stats.n_distinct verbatim: positive = absolute distinct count,
   * negative = distinct count as a fraction of table rows (e.g. -1 = unique).
   */
  nDistinct: number;
  /** Most common values, highest frequency first. */
  mostCommonValues?: Array<{ value: string; frequency: number }>;
  /** pg_stats.correlation: physical/logical ordering correlation, -1..1. */
  correlation?: number;
  /** Average width in bytes (pg_stats.avg_width). */
  avgWidth?: number;
}

export interface Column {
  name: string;
  /** Postgres type name, e.g. 'bigint', 'text', 'timestamptz', 'jsonb'. */
  dataType: string;
  nullable: boolean;
  stats?: ColumnStats;
}

export interface IndexDef {
  name: string;
  table: string;
  /** Key columns in order. Order matters enormously; never sort these. */
  columns: string[];
  /** Non-key payload columns (Postgres INCLUDE). */
  includeColumns?: string[];
  unique: boolean;
  method: 'btree' | 'hash' | 'gin' | 'gist' | 'brin' | 'spgist';
  /** Predicate for a partial index, as written. */
  where?: string;
  /** Raw expression text when a key is an expression rather than a bare column. */
  expressions?: string[];
  /** Size in bytes, when known. */
  sizeBytes?: number;
}

export interface ForeignKey {
  columns: string[];
  referencesTable: string;
  referencesColumns: string[];
}

export interface Table {
  schema: string;
  name: string;
  columns: Column[];
  primaryKey?: string[];
  foreignKeys?: ForeignKey[];
  indexes: IndexDef[];
  /** Live row estimate (pg_class.reltuples). */
  rowCount?: number;
  /** Heap size in bytes. */
  sizeBytes?: number;
}

export interface Catalog {
  dialect: Dialect;
  /** Server version string, e.g. '16.4' — gates version-specific advice. */
  serverVersion?: string;
  tables: Table[];
  /** Relevant planner settings (work_mem, random_page_cost, ...). */
  settings?: Record<string, string>;
}

// ===========================================================================
// M1: Query IR — the bound, schema-resolved representation.
// ===========================================================================

/** A column reference resolved to a concrete table, or flagged unresolved. */
export interface ResolvedColumnRef {
  /** Alias as written in the query, if any. */
  alias?: string;
  table?: string;
  column: string;
  dataType?: string;
  /** Catalog/derived-output nullability, when it can be proved. */
  nullable?: boolean;
  /** Why nullability is known or why it remains unknown. */
  nullabilityReason?: string;
  /** True when binding failed (unknown column, ambiguous, dynamic). */
  unresolved?: boolean;
}

export type PredicateKind =
  | 'equality'
  | 'range'
  | 'in-list'
  | 'like-prefix'
  | 'like-infix'
  | 'null-check'
  | 'boolean'
  | 'join'
  | 'subquery'
  | 'other';

export interface Predicate {
  /** Source text of this predicate. */
  sql: string;
  kind: PredicateKind;
  columns: ResolvedColumnRef[];
  /**
   * Whether an index on the referenced column could satisfy this predicate.
   * False when a function or implicit cast wraps the column, when a leading
   * wildcard defeats a btree, etc. `sargableReason` explains the verdict.
   */
  sargable: boolean;
  sargableReason?: string;
  /** Estimated selectivity in 0..1, when the catalog supports estimating it. */
  selectivity?: number;
  /** Which query clause this came from. */
  clause: 'where' | 'join' | 'having' | 'on' | 'qualify';
  /** True when this predicate is negated (NOT IN, NOT EXISTS, <>). */
  negated?: boolean;
  /** Stable ids of subquery blocks syntactically contained in this predicate. */
  subqueryBlockIds?: string[];
}

export interface JoinIR {
  type: 'inner' | 'left' | 'right' | 'full' | 'cross' | 'semi' | 'anti' | 'lateral';
  leftRelation: string;
  rightRelation: string;
  /** Equality keys that a hash/merge join could use. */
  equiKeys: Array<{ left: ResolvedColumnRef; right: ResolvedColumnRef }>;
  /** Non-equality join conditions (range joins, inequality, function calls). */
  residualPredicates: Predicate[];
  /**
   * True when the join multiplies the rows of **either** input.
   *
   * ⚠️ This is deliberately orientation-independent. An earlier definition —
   * "the right side is not unique on the join key" — made the verdict depend on
   * how the author happened to order their FROM clause: writing q06 as
   * `order_items JOIN orders JOIN customers` reported `fanOut=false` on every
   * join while the server returned the identical 3.0000x-inflated revenue.
   * A correctness signal that five modules consume must not flip on spelling.
   *
   * `fanOut` alone does not tell you whether a *particular* aggregate is
   * over-counted. For that, read `multipliedRelations`.
   */
  fanOut: boolean;
  fanOutReason?: string;
  /**
   * Which input's rows get duplicated. 'left' means each left row can appear
   * several times (the right side is not unique on the key); 'right' means the
   * mirror image; 'both' means neither side is unique.
   */
  fanOutSide?: 'left' | 'right' | 'both' | 'none';
  /**
   * Aliases whose rows this join duplicates. An aggregate over any column of a
   * relation named here is over-counted — this is exactly what makes q06's
   * `sum(o.total_cents)` wrong, in either spelling.
   *
   * When the left *input* is multiplied, every relation joined so far is listed,
   * because the whole joined product is duplicated, not just the named
   * `leftRelation`.
   */
  multipliedRelations?: string[];
}

export interface RelationIR {
  /** Alias used in the query, or the table name when unaliased. */
  alias: string;
  /** Base table name, or the CTE/subquery name it resolves to. */
  source: string;
  kind: 'table' | 'cte' | 'subquery' | 'values' | 'function';
  /** Local (single-relation) predicates that can be pushed to the scan. */
  localPredicates: Predicate[];
  estimatedRows?: number;
}

export interface QueryBlockIR {
  /** Stable id, e.g. 'main', 'cte:recent', 'sub:1'. */
  id: string;
  kind: 'select' | 'insert' | 'update' | 'delete' | 'cte' | 'subquery' | 'set-op';
  relations: RelationIR[];
  joins: JoinIR[];
  predicates: Predicate[];
  projections: Array<{
    sql: string;
    alias?: string;
    columns: ResolvedColumnRef[];
    /** Stable ids of scalar/EXISTS subquery blocks contained in this projection. */
    subqueryBlockIds?: string[];
  }>;
  groupBy: ResolvedColumnRef[];
  /**
   * Lossless GROUP BY items in source order. Unlike `groupBy`, this preserves
   * expressions and ordinals while still exposing their resolved base columns.
   */
  groupByExpressions?: Array<{
    sql: string;
    columns: ResolvedColumnRef[];
    ordinal?: number;
  }>;
  having: Predicate[];
  orderBy: Array<{ column: ResolvedColumnRef | null; sql: string; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }>;
  limit?: number;
  offset?: number;
  distinct?: boolean;
  windowFunctions: Array<{ sql: string; partitionBy: ResolvedColumnRef[]; orderBy: string[] }>;
  aggregates: Array<{ sql: string; func: string; distinct?: boolean }>;
  /** Set operation joining this block to the next, if any. */
  setOp?: { op: 'union' | 'union-all' | 'intersect' | 'except'; withBlock: string };
  /** True when a correlated reference reaches out to an enclosing block. */
  correlated?: boolean;
  correlationRefs?: ResolvedColumnRef[];
}

export interface QueryIR {
  dialect: Dialect;
  originalSql: string;
  /** Normalized/formatted SQL, literals preserved. */
  normalizedSql?: string;
  statementType: 'select' | 'insert' | 'update' | 'delete' | 'other';
  blocks: QueryBlockIR[];
  /** Id of the outermost block. */
  rootBlockId: string;
  /** Everything binding could not resolve — consumers should inspect this first. */
  bindingErrors: Array<{ message: string; sqlFragment?: string; severity: 'warn' | 'error' }>;
}

// ===========================================================================
// M2: Plain-English semantics — what the query *means*, not how it runs.
// ===========================================================================

export interface SemanticExplanation {
  /** One sentence a product manager would understand. */
  headline: string;
  /**
   * Ordered narrative of what the engine produces, logically. Each step is a
   * complete sentence in plain English with no SQL jargon left unexplained.
   */
  steps: Array<{ title: string; detail: string; sqlFragment?: string }>;
  /** The shape of the result: one row per what, with which columns. */
  resultShape: { grain: string; columns: Array<{ name: string; meaning: string }> };
  /**
   * Semantic traps the reader would otherwise miss: NULL handling, duplicate
   * multiplication from a fan-out join, timezone/boundary issues, LEFT JOIN
   * demoted to INNER by a WHERE clause, etc.
   */
  caveats: Array<{ issue: string; why: string; sqlFragment?: string }>;
}

// ===========================================================================
// M3: Predicted execution behavior — how it will actually run and what hurts.
// ===========================================================================

export type AccessPath =
  | 'seq-scan'
  | 'index-scan'
  | 'index-only-scan'
  | 'bitmap-heap-scan'
  | 'unknown';

export type JoinAlgorithm = 'nested-loop' | 'hash-join' | 'merge-join' | 'unknown';

export interface ExecutionAnalysis {
  /** Predicted access path per relation, with the reason it was chosen. */
  accessPaths: Array<{
    relation: string;
    path: AccessPath;
    usingIndex?: string;
    /** Rows the scan is expected to emit after local predicates. */
    estimatedRows?: number;
    reason: string;
  }>;
  joinStrategies: Array<{
    join: string;
    algorithm: JoinAlgorithm;
    reason: string;
    /** Rows expected out of this join. */
    estimatedRows?: number;
  }>;
  /**
   * Ranked list of what actually dominates runtime. This is the section a
   * senior engineer writes first and everyone else writes last.
   */
  dominantCosts: Array<{
    what: string;
    why: string;
    /** Rough share of total runtime, 0..1, when it can be reasoned about. */
    estimatedShare?: number;
  }>;
  /** Operations that will spill to disk at the given work_mem. */
  memoryRisks: Array<{ operation: string; why: string }>;
  /** Places where the planner's row estimate is likely to be badly wrong. */
  estimationRisks: Array<{ where: string; why: string; direction: 'over' | 'under' | 'unknown' }>;
  /** How runtime grows with data volume. */
  scalability: { summary: string; complexity?: string };
}

// ===========================================================================
// M4: Findings — concrete, evidence-backed problems.
// ===========================================================================

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  /** Stable slug, e.g. 'non-sargable-function-on-column'. */
  id: string;
  title: string;
  severity: Severity;
  /** Structured editorial class; renderers must never infer this from prose. */
  category: 'correctness' | 'intent' | 'performance';
  /** Whether this finding calls for a concrete change, optional cleanup, or observation only. */
  actionability: 'required' | 'optional' | 'none';
  /** The exact SQL that triggers this. Findings without evidence are noise. */
  evidence: { sqlFragment: string; relation?: string; column?: string };
  /** Why it matters *here*, with the catalog numbers that make it matter. */
  impact: string;
  /** What to do about it, one sentence. Detail belongs in M5/M6. */
  remediation: string;
  /** False-positive guard: when this finding would NOT apply. */
  caveat?: string;
  confidence: 'high' | 'medium' | 'low';
}

// ===========================================================================
// M5: Index recommendations.
// ===========================================================================

export interface IndexRecommendation {
  /** Stable identifier referenced by Rewrite.requiresIndexes. */
  id: string;
  /** Executable DDL, including CONCURRENTLY where appropriate. */
  ddl: string;
  table: string;
  columns: string[];
  includeColumns?: string[];
  method: IndexDef['method'];
  where?: string;
  /** Why the columns are in THIS order. Equality first, then range, etc. */
  columnOrderRationale: string;
  /** Which predicates/sorts this index serves. */
  serves: string[];
  /** Expected effect on the plan, stated concretely. */
  expectedEffect: string;
  /** Write amplification, storage, and maintenance cost. */
  cost: { estimatedSizeNote: string; writeImpact: string };
  /** Indexes this makes redundant, and existing ones it duplicates. */
  supersedes?: string[];
  redundantWith?: string[];
  priority: 1 | 2 | 3;
  confidence: 'high' | 'medium' | 'low';
}

// ===========================================================================
// M6: Rewrites.
// ===========================================================================

export interface Rewrite {
  id: string;
  title: string;
  sql: string;
  /** What changed and why it is faster. */
  rationale: string;
  /**
   * Whether results are provably identical, and under what assumptions.
   * 'conditional' MUST list the assumption (e.g. "join key is unique").
   */
  equivalence: 'exact' | 'conditional' | 'different-semantics';
  equivalenceNotes: string;
  expectedSpeedup?: string;
  /** Stable IndexRecommendation.id values required for this rewrite to pay off. */
  requiresIndexes?: string[];
  priority: 1 | 2 | 3;
}

// ===========================================================================
// M7: The assembled analysis.
// ===========================================================================

export interface Analysis {
  sql: string;
  catalogName: string;
  ir: QueryIR;
  semantics: SemanticExplanation;
  execution: ExecutionAnalysis;
  findings: Finding[];
  indexes: IndexRecommendation[];
  rewrites: Rewrite[];
  /**
   * Analyzer modules that did not run, e.g. `['M4','M5']`. An empty or absent list
   * asserts that every module ran.
   *
   * A renderer MUST NOT emit a categorical verdict while this is non-empty. Without
   * it, the absence of findings is indistinguishable from a clean bill of health:
   * q06 over-reports revenue by exactly 3.0000x and rendered as `NO ACTION NEEDED
   * ... in the complete analysis` purely because M4 was not there to find anything.
   */
  missingModules?: string[];
  /** Product-scope reasons this analysis cannot support a categorical verdict. */
  blockedReasons?: string[];
  /** Populated only when a live connection was available. */
  verification?: {
    baselinePlan?: unknown;
    optimizedPlan?: unknown;
    baselineMs?: number;
    optimizedMs?: number;
    resultsMatch?: boolean;
  };
}
