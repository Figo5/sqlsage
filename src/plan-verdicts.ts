/**
 * Mark performance findings as confirmed or contradicted by a captured plan.
 *
 * This consumes the normalized facts produced by `plan-evidence.ts` — never the
 * raw EXPLAIN JSON. A verdict states only what the plan factually shows; it does
 * not promise a speedup, and it never turns an unrecognized finding into a
 * confident claim.
 */
import type { NormalizedPlanNode, ObservedAccessPath } from './plan-evidence.ts';
import type { Finding } from './types.ts';

/**
 * The normalized execution facts a verdict may use. `PlanEvidence` satisfies
 * this shape, as does a hand-written fixture carrying the same structure.
 */
export interface PlanVerdictFacts {
  nodes: readonly NormalizedPlanNode[];
  summary: { accessPaths: readonly ObservedAccessPath[] };
}

type PlanVerdict = NonNullable<Finding['planVerdict']>;

const NON_SARGABLE_IDS = new Set([
  'non-sargable-function-on-column',
  'non-sargable-cast-on-column',
  'leading-wildcard-like',
  'unindexed-json-scalar-extraction',
]);

const ORDER_BY_RANDOM_ID = 'order-by-random-limit';
const DEEP_OFFSET_ID = 'deep-offset-pagination';

/**
 * Return findings with `planVerdict` attached to each performance finding.
 *
 * Findings in other categories are returned untouched: a plan observes execution
 * shape, not whether a NULL comparison changes the answer.
 */
export function applyPlanVerdicts(findings: Finding[], execution: PlanVerdictFacts): Finding[] {
  return findings.map((finding) => {
    if (finding.category !== 'performance') return finding;
    return { ...finding, planVerdict: verdictFor(finding, execution) };
  });
}

function verdictFor(finding: Finding, execution: PlanVerdictFacts): PlanVerdict {
  if (NON_SARGABLE_IDS.has(finding.id)) return nonSargableVerdict(finding, execution);
  if (finding.id === ORDER_BY_RANDOM_ID) return orderByRandomVerdict(execution);
  if (finding.id === DEEP_OFFSET_ID) return deepOffsetVerdict(finding, execution);
  return {
    status: 'not-observable',
    note: 'Plan evidence cannot confirm or contradict this finding type.',
  };
}

// ---------------------------------------------------------------------------
// Non-sargable predicates and their siblings
// ---------------------------------------------------------------------------

function nonSargableVerdict(finding: Finding, execution: PlanVerdictFacts): PlanVerdict {
  const relation = finding.evidence.relation;
  const column = finding.evidence.column;
  if (!relation) {
    return notObservable('Plan evidence does not name the relation for this finding.');
  }
  if (!column) {
    return notObservable(`Plan evidence does not name the column for this finding on ${relation}.`);
  }

  const accesses = execution.summary.accessPaths.filter((access) =>
    relationMatches(relation, access.relation, access.schema, access.alias),
  );
  if (!accesses.length) {
    return notObservable(`Plan does not read ${relation}.`);
  }

  const conditions = accesses.map((access) => conditionsFor(access, execution.nodes));
  const usesColumnAsIndexCondition = accesses.some((access, index) =>
    isIndexPath(access.path) && conditions[index]!.some((condition) => mentionsColumn(condition, column)),
  );
  const sequential = accesses.find((access) => access.path === 'seq-scan');

  // A sequential scan is the clearest observation the finding predicts. When the
  // same relation also appears behind a column-bearing index path, the plan is
  // mixed and the sequential fact still holds for the path the reader is asking
  // about; only a purely index-driven reach contradicts the claim.
  if (sequential) {
    return confirmed(`Plan reads ${relation} with a Seq Scan.`);
  }
  if (usesColumnAsIndexCondition) {
    const indexed = accesses.find((access, index) =>
      isIndexPath(access.path) && conditions[index]!.some((condition) => mentionsColumn(condition, column)),
    )!;
    return contradicted(
      `Plan reaches ${relation} with ${indexed.nodeType}${indexed.usingIndex ? ` (${indexed.usingIndex})` : ''}, whose index condition uses ${column}.`,
    );
  }

  const fullIndex = accesses.find((access) => access.path === 'index-scan' || access.path === 'index-only-scan');
  if (fullIndex) {
    return confirmed(
      `Plan reads ${relation} with a full ${fullIndex.nodeType} that does not use ${column} as an index condition.`,
    );
  }

  return notObservable(`Plan reaches ${relation} without a sequential or full index scan.`);
}

function isIndexPath(path: ObservedAccessPath['path']): boolean {
  return path === 'index-scan' || path === 'index-only-scan' || path === 'bitmap-heap-scan';
}

/**
 * Index conditions attached to the node that produced an access path. A bitmap
 * heap scan carries no condition itself, so its descendant bitmap index scan is
 * consulted; that child has no relation name, which is why the search starts
 * from the parent node.
 */
function conditionsFor(access: ObservedAccessPath, nodes: readonly NormalizedPlanNode[]): string[] {
  const roots = nodes.filter((node) =>
    node.nodeType === access.nodeType &&
    relationMatches(access.relation, node.relation, node.schema, node.alias),
  );
  const conditions: string[] = [];
  for (const root of roots) {
    if (root.indexCondition) conditions.push(root.indexCondition);
    for (const descendant of flatten(root.children)) {
      if (descendant.indexCondition && /index/i.test(descendant.nodeType)) {
        conditions.push(descendant.indexCondition);
      }
    }
  }
  return conditions;
}

function flatten(nodes: readonly NormalizedPlanNode[]): NormalizedPlanNode[] {
  const out: NormalizedPlanNode[] = [];
  const visit = (node: NormalizedPlanNode) => {
    out.push(node);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

function mentionsColumn(condition: string, column: string): boolean {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, 'i').test(condition);
}

/**
 * Match a finding's relation (`shop.orders`, `orders`) against the names a plan
 * node carries. The plan records the bare relation plus schema and alias, so a
 * schema-qualified evidence relation is compared by its last segment.
 */
function relationMatches(evidenceRelation: string, ...candidates: Array<string | undefined>): boolean {
  const target = evidenceRelation.toLowerCase();
  const targetTail = target.split('.').pop()!;
  return candidates.some((candidate) => {
    if (!candidate) return false;
    const value = candidate.toLowerCase();
    return value === target || value === targetTail || value.split('.').pop() === targetTail;
  });
}

// ---------------------------------------------------------------------------
// ORDER BY random() LIMIT n
// ---------------------------------------------------------------------------

function orderByRandomVerdict(execution: PlanVerdictFacts): PlanVerdict {
  const sort = execution.nodes.find((node) =>
    /sort/i.test(node.nodeType) || /heapsort|top-n/i.test(node.sortMethod ?? ''),
  );
  if (sort) {
    const method = sort.sortMethod ? ` (${sort.sortMethod})` : '';
    return confirmed(`Plan contains a ${sort.nodeType} node${method}.`);
  }
  if (!execution.nodes.length) {
    return notObservable('Plan evidence contains no execution nodes.');
  }
  return contradicted('Plan contains no Sort node.');
}

// ---------------------------------------------------------------------------
// Deep OFFSET pagination
// ---------------------------------------------------------------------------

function deepOffsetVerdict(finding: Finding, execution: PlanVerdictFacts): PlanVerdict {
  const match = /\bOFFSET\s+(\d+)/i.exec(finding.evidence.sqlFragment);
  const offset = match ? Number(match[1]) : undefined;
  if (offset === undefined || !Number.isFinite(offset)) {
    return notObservable('The finding does not state an OFFSET to compare with the plan.');
  }

  const limit = execution.nodes.find((node) => /^limit$/i.test(node.nodeType));
  const input = limit?.children[0];
  if (!input) {
    return notObservable(`Plan has no Limit node with input rows to compare against OFFSET ${offset}.`);
  }

  const loops = input.actualLoops ?? 1;
  const observed = input.actualRows !== undefined ? input.actualRows : input.planRows;
  if (observed === undefined) {
    return notObservable(`Plan's Limit input has no row count to compare against OFFSET ${offset}.`);
  }
  const rows = observed * loops;
  if (rows >= offset) {
    const verb = input.actualRows !== undefined ? 'produced' : 'is expected to produce';
    return confirmed(`Plan's Limit input ${verb} ${formatNumber(rows)} rows, at least the OFFSET of ${formatNumber(offset)}.`);
  }
  return notObservable(
    `Plan's Limit input produced ${formatNumber(rows)} rows, fewer than the OFFSET of ${formatNumber(offset)}.`,
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

// ---------------------------------------------------------------------------
// Small constructors
// ---------------------------------------------------------------------------

function confirmed(note: string): PlanVerdict {
  return { status: 'confirmed', note };
}

function contradicted(note: string): PlanVerdict {
  return { status: 'contradicted', note };
}

function notObservable(note: string): PlanVerdict {
  return { status: 'not-observable', note };
}
