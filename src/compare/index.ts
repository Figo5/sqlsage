/**
 * Compare two captured plans and say what changed — and, only when the evidence
 * supports it, whether it got better.
 *
 * The hard part is not diffing. It is refusing to claim an improvement that two
 * captures cannot establish: a plan-only capture has no runtime to compare, two
 * single runs are not a benchmark, and two plans of different queries are not a
 * before and after at all.
 */
import type { PlanEvidence } from '../plan-evidence.ts';

export type ComparisonVerdictKind =
  | 'faster'
  | 'slower'
  | 'no-measurable-change'
  | 'shape-changed-only'
  | 'not-comparable';

export interface PlanComparison {
  before: SideSummary;
  after: SideSummary;
  /** Whether both captures describe the same statement, when both state one. */
  sameQuery: 'same' | 'different' | 'unknown';
  timing: {
    comparable: boolean;
    beforeMs?: number;
    afterMs?: number;
    deltaMs?: number;
    /** Symmetric speed multiple; >1 means `after` is that many times faster. */
    factor?: number;
    why?: string;
  };
  accessPaths: Array<{ relation: string; before?: string; after?: string; changed: boolean }>;
  indexes: { gained: string[]; lost: string[]; kept: string[] };
  joins: { gained: string[]; lost: string[] };
  spills: { introduced: string[]; resolved: string[]; persisting: string[] };
  worstEstimate: { before?: EstimateNote; after?: EstimateNote };
  verdict: { kind: ComparisonVerdictKind; headline: string; caveats: string[] };
}

interface SideSummary {
  mode: PlanEvidence['mode'];
  source: 'live' | 'saved';
  nodeTypes: string[];
  executionMs?: number;
  planningMs?: number;
}

interface EstimateNote {
  where: string;
  factor?: number;
  rowsMisjudged: number;
}

/** Below this, a difference between two single runs is not worth a verdict. */
const MEANINGFUL_FACTOR = 1.2;

function side(evidence: PlanEvidence): SideSummary {
  return {
    mode: evidence.mode,
    source: evidence.source === 'live' ? 'live' : 'saved',
    nodeTypes: [...evidence.summary.nodeTypes],
    executionMs: evidence.summary.executionMs,
    planningMs: evidence.summary.planningMs,
  };
}

function pathLabel(path: { nodeType: string; usingIndex?: string }): string {
  return path.usingIndex ? `${path.nodeType} using ${path.usingIndex}` : path.nodeType;
}

function spillLabel(spill: { nodeType: string; relation?: string }): string {
  return spill.relation ? `${spill.nodeType} on ${spill.relation}` : spill.nodeType;
}

function worstEstimate(evidence: PlanEvidence): EstimateNote | undefined {
  let worst: EstimateNote | undefined;
  for (const ratio of evidence.summary.rowEstimateRatios) {
    if (ratio.direction === 'accurate') continue;
    const rowsMisjudged = Math.abs(ratio.actualRows - ratio.estimatedRows) * (ratio.actualLoops || 1);
    if (!worst || rowsMisjudged > worst.rowsMisjudged) {
      worst = {
        where: ratio.relation ? `${ratio.nodeType} on ${ratio.relation}` : ratio.nodeType,
        factor: ratio.factor,
        rowsMisjudged,
      };
    }
  }
  return worst;
}

function difference(before: string[], after: string[]): { gained: string[]; lost: string[]; kept: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    gained: [...a].filter((item) => !b.has(item)).sort(),
    lost: [...b].filter((item) => !a.has(item)).sort(),
    kept: [...b].filter((item) => a.has(item)).sort(),
  };
}

export function comparePlans(before: PlanEvidence, after: PlanEvidence): PlanComparison {
  const sameQuery: PlanComparison['sameQuery'] = before.sql && after.sql
    ? (normalize(before.sql) === normalize(after.sql) ? 'same' : 'different')
    : 'unknown';

  // Access paths are keyed by relation, which is what a reader is actually asking
  // about: "what happens to orders now?"
  const relations = [...new Set([
    ...before.summary.accessPaths.map((path) => path.relation),
    ...after.summary.accessPaths.map((path) => path.relation),
  ])].sort();
  const accessPaths = relations.map((relation) => {
    const b = before.summary.accessPaths.find((path) => path.relation === relation);
    const a = after.summary.accessPaths.find((path) => path.relation === relation);
    const beforeLabel = b ? pathLabel(b) : undefined;
    const afterLabel = a ? pathLabel(a) : undefined;
    return { relation, before: beforeLabel, after: afterLabel, changed: beforeLabel !== afterLabel };
  });

  const indexes = difference(before.summary.indexNames, after.summary.indexNames);
  const joinDiff = difference(
    before.summary.joins.map((join) => join.algorithm),
    after.summary.joins.map((join) => join.algorithm),
  );
  const spillDiff = difference(
    before.summary.spills.map(spillLabel),
    after.summary.spills.map(spillLabel),
  );

  const timing = compareTiming(before, after);
  const shapeChanged = accessPaths.some((entry) => entry.changed)
    || indexes.gained.length > 0 || indexes.lost.length > 0
    || joinDiff.gained.length > 0 || joinDiff.lost.length > 0;

  return {
    before: side(before),
    after: side(after),
    sameQuery,
    timing,
    accessPaths,
    indexes,
    joins: { gained: joinDiff.gained, lost: joinDiff.lost },
    spills: { introduced: spillDiff.gained, resolved: spillDiff.lost, persisting: spillDiff.kept },
    worstEstimate: { before: worstEstimate(before), after: worstEstimate(after) },
    verdict: decideVerdict(timing, shapeChanged, sameQuery),
  };
}

function normalize(sql: string): string {
  return sql.trim().replace(/;\s*$/, '').replace(/\s+/g, ' ').toLowerCase();
}

function compareTiming(before: PlanEvidence, after: PlanEvidence): PlanComparison['timing'] {
  // A plan-only capture never ran, so there is no runtime to compare. Saying
  // nothing here is the whole point: a cost estimate is not a measurement, and
  // presenting one as a speedup would be the confident-wrong claim this avoids.
  const unanalyzed = [
    before.mode === 'analyzed' ? undefined : 'the before capture is plan-only',
    after.mode === 'analyzed' ? undefined : 'the after capture is plan-only',
  ].filter(Boolean) as string[];
  if (unanalyzed.length) {
    return { comparable: false, why: `${unanalyzed.join(' and ')}, so no runtime was recorded to compare` };
  }

  const beforeMs = before.summary.executionMs;
  const afterMs = after.summary.executionMs;
  if (beforeMs === undefined || afterMs === undefined || beforeMs <= 0 || afterMs <= 0) {
    return { comparable: false, why: 'an execution time is missing from one of the captures' };
  }

  const factor = beforeMs / afterMs;
  return {
    comparable: true,
    beforeMs,
    afterMs,
    deltaMs: afterMs - beforeMs,
    factor: factor >= 1 ? factor : 1 / factor,
  };
}

function decideVerdict(
  timing: PlanComparison['timing'],
  shapeChanged: boolean,
  sameQuery: PlanComparison['sameQuery'],
): PlanComparison['verdict'] {
  const caveats: string[] = [];
  if (sameQuery === 'different') {
    caveats.push('The two captures describe different statements, so this is a comparison of two queries rather than a before and after of one.');
  }
  if (timing.comparable) {
    // One run each is not a benchmark, and saying so beside the number is the
    // difference between evidence and a claim.
    caveats.push('Each side is a single capture. One run is not a benchmark: caching, concurrent load and plan-choice variation all move these numbers.');
  }

  if (!timing.comparable) {
    return {
      kind: shapeChanged ? 'shape-changed-only' : 'not-comparable',
      headline: shapeChanged
        ? `The plan shape changed, but ${timing.why}.`
        : `No comparable difference could be established: ${timing.why}.`,
      caveats,
    };
  }

  const factor = timing.factor ?? 1;
  const afterFaster = (timing.deltaMs ?? 0) < 0;
  if (factor < MEANINGFUL_FACTOR) {
    return {
      kind: 'no-measurable-change',
      headline: `Runtime is within ${MEANINGFUL_FACTOR}x between the two captures (${fmtMs(timing.beforeMs)} then ${fmtMs(timing.afterMs)}), which two single runs cannot separate from noise.`,
      caveats,
    };
  }
  return {
    kind: afterFaster ? 'faster' : 'slower',
    headline: afterFaster
      ? `The after capture ran ${factor.toFixed(2)}x faster (${fmtMs(timing.beforeMs)} then ${fmtMs(timing.afterMs)}).`
      : `The after capture ran ${factor.toFixed(2)}x slower (${fmtMs(timing.beforeMs)} then ${fmtMs(timing.afterMs)}).`,
    caveats,
  };
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return 'unknown';
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 10_000) return `${Math.round(ms).toLocaleString('en-US')} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

const VERDICT_LABEL: Record<ComparisonVerdictKind, string> = {
  faster: 'FASTER',
  slower: 'SLOWER',
  'no-measurable-change': 'NO MEASURABLE CHANGE',
  'shape-changed-only': 'PLAN CHANGED, RUNTIME NOT COMPARED',
  'not-comparable': 'NOT COMPARABLE',
};

export function renderComparison(comparison: PlanComparison, format: 'text' | 'markdown'): string {
  const md = format === 'markdown';
  const out: string[] = [];
  const h1 = (text: string) => out.push(md ? `# ${text}` : `${text}\n${'='.repeat(text.length)}`);
  const h2 = (text: string) => out.push(md ? `\n## ${text}` : `\n${text}\n${'-'.repeat(text.length)}`);

  h1('SQLSage plan comparison');
  out.push('');
  out.push(md ? `> ## ${VERDICT_LABEL[comparison.verdict.kind]}` : VERDICT_LABEL[comparison.verdict.kind]);
  out.push(md ? `>\n> ${comparison.verdict.headline}` : comparison.verdict.headline);
  for (const caveat of comparison.verdict.caveats) out.push(md ? `>\n> ${caveat}` : `  ${caveat}`);

  h2('Captures');
  out.push(`- before: ${comparison.before.source} ${comparison.before.mode === 'analyzed' ? 'EXPLAIN ANALYZE' : 'plan-only EXPLAIN'}${comparison.before.executionMs !== undefined ? `, ${fmtMs(comparison.before.executionMs)}` : ''}`);
  out.push(`- after:  ${comparison.after.source} ${comparison.after.mode === 'analyzed' ? 'EXPLAIN ANALYZE' : 'plan-only EXPLAIN'}${comparison.after.executionMs !== undefined ? `, ${fmtMs(comparison.after.executionMs)}` : ''}`);
  if (comparison.sameQuery === 'unknown') {
    out.push('- statement: not stated by these captures, so SQLSage cannot confirm both describe the same query');
  } else {
    out.push(`- statement: ${comparison.sameQuery === 'same' ? 'identical in both captures' : 'DIFFERENT between the captures'}`);
  }

  const changed = comparison.accessPaths.filter((entry) => entry.changed);
  h2('Access paths');
  if (!changed.length) out.push('- unchanged for every relation in both plans');
  for (const entry of changed) {
    out.push(`- ${entry.relation}: ${entry.before ?? 'absent'} -> ${entry.after ?? 'absent'}`);
  }

  if (comparison.indexes.gained.length || comparison.indexes.lost.length) {
    h2('Indexes');
    for (const name of comparison.indexes.gained) out.push(`- now used: ${name}`);
    for (const name of comparison.indexes.lost) out.push(`- no longer used: ${name}`);
  }

  if (comparison.joins.gained.length || comparison.joins.lost.length) {
    h2('Join strategies');
    for (const name of comparison.joins.gained) out.push(`- introduced: ${name}`);
    for (const name of comparison.joins.lost) out.push(`- no longer used: ${name}`);
  }

  if (comparison.spills.introduced.length || comparison.spills.resolved.length || comparison.spills.persisting.length) {
    h2('Disk spills');
    for (const name of comparison.spills.resolved) out.push(`- resolved: ${name}`);
    for (const name of comparison.spills.introduced) out.push(`- introduced: ${name}`);
    for (const name of comparison.spills.persisting) out.push(`- still spilling: ${name}`);
  }

  const { before: wb, after: wa } = comparison.worstEstimate;
  if (wb || wa) {
    h2('Worst row misestimate');
    out.push(`- before: ${wb ? `${wb.where}, about ${wb.rowsMisjudged.toLocaleString('en-US')} row(s) misjudged` : 'none reported'}`);
    out.push(`- after:  ${wa ? `${wa.where}, about ${wa.rowsMisjudged.toLocaleString('en-US')} row(s) misjudged` : 'none reported'}`);
  }

  return `${out.join('\n')}\n`;
}
