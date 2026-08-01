/**
 * Renders every report fixture in both formats and prints them.
 *
 *   node eval/dump-report.ts                 # both formats, colour auto
 *   node eval/dump-report.ts markdown        # one format only
 *   node eval/dump-report.ts terminal --color
 *   node eval/dump-report.ts --first15       # just the first screenful of each
 *
 * The point is not that it exits 0. The point is to read the output the way a
 * reader would, especially the first fifteen lines.
 */

import { buildModel, renderReport } from '../src/report/index.ts';
import { FIXTURES, degradedAnalysis, fanOutAnalysis, healthyAnalysis, nonSargableAnalysis } from '../src/report/fixtures.ts';

const args = process.argv.slice(2);
const formats = (['markdown', 'terminal'] as const).filter(
  (f) => args.includes(f) || !args.some((a) => a === 'markdown' || a === 'terminal'),
);
const forceColor = args.includes('--color') ? true : args.includes('--no-color') ? false : undefined;
const firstOnly = args.includes('--first15');

const bar = (s: string) => `\n${'#'.repeat(78)}\n## ${s}\n${'#'.repeat(78)}\n`;

let failures = 0;

for (const { name, note, analysis } of FIXTURES) {
  for (const format of formats) {
    process.stdout.write(bar(`${name}  [${format}]`));
    process.stdout.write(`(${note})\n\n`);
    try {
      const out = renderReport(analysis, { format, color: forceColor });
      if (/\b(?:undefined|NaN)\b|\[object Object\]/m.test(out)) {
        failures++;
        process.stdout.write('!!! output contains a placeholder value\n');
      }
      const lines = out.split('\n');
      process.stdout.write(firstOnly ? lines.slice(0, 15).join('\n') + '\n' : out);
      if (firstOnly) {
        process.stdout.write(`... (${lines.length} lines total)\n`);
      }
    } catch (err) {
      failures++;
      process.stdout.write(`!!! renderReport threw: ${(err as Error).stack}\n`);
    }
  }
}

// Determinism and degradation checks, since a report that changes between runs
// cannot be diffed in review.
process.stdout.write(bar('checks'));
for (const { name, analysis } of FIXTURES) {
  const a = renderReport(analysis, { format: 'markdown' });
  const b = renderReport(analysis, { format: 'markdown' });
  const plain = renderReport(analysis, { format: 'terminal', color: false });
  const colored = renderReport(analysis, { format: 'terminal', color: true });
  const ESC = '\u001b';
  const strippedEqual = colored.split(new RegExp(`${ESC}\\[[0-9;]*m`, 'g')).join('') === plain;
  const ok = a === b && strippedEqual && !plain.includes(ESC);
  if (!ok) failures++;
  process.stdout.write(
    `${ok ? 'ok  ' : 'FAIL'}  ${name}: deterministic=${a === b} colour-strips-to-plain=${strippedEqual}\n`,
  );
}

const invariant = (name: string, ok: boolean) => {
  if (!ok) failures++;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${name}\n`);
};

const fanOut = buildModel(fanOutAnalysis);
invariant('correctness issue leads the fan-out report', fanOut.issues[0]?.kind === 'correctness');

const nonSargable = buildModel(nonSargableAnalysis);
const coupled = nonSargable.issues.find((issue) => issue.rewrites.some((rw) => rw.requiresIndexes?.length));
invariant(
  'required index stays with its rewrite',
  !!coupled && coupled.indexes.some((idx) => idx.ddl.includes('idx_orders_status_created_at_incl')),
);

const healthy = renderReport(healthyAnalysis, { format: 'markdown' });
invariant('healthy report does not manufacture an action list', !healthy.includes('## Do this first'));

const narrow = renderReport(degradedAnalysis, { format: 'terminal', color: false, width: 40 });
invariant(
  'terminal prose respects a 40-column width',
  narrow.split('\n').every((line) => line.startsWith('    ') || line.length <= 40),
);

// Round-2 adversarial regressions. These deliberately vary wording and runtime
// shape so passing does not depend on the curated fixture prose.
const q05Paraphrase = structuredClone(healthyAnalysis);
q05Paraphrase.findings = [{
  id: 'three-valued-comparison-excludes-candidates',
  title: 'Candidate membership is evaluated with an indeterminate marker',
  severity: 'critical',
  category: 'correctness',
  actionability: 'required',
  evidence: { sqlFragment: 'candidate_id NOT IN (SELECT nullable_id FROM source)' },
  impact: 'A nullable subquery value causes every candidate to fail the requested exclusion test.',
  remediation: 'Confirm the intended population and use a null-safe anti-join.',
  confidence: 'high',
}];
q05Paraphrase.indexes = [];
q05Paraphrase.rewrites = [];
q05Paraphrase.semantics.caveats = [];
q05Paraphrase.verification = undefined;
invariant(
  'structured correctness category leads despite paraphrased q05 wording',
  buildModel(q05Paraphrase).issues[0]?.kind === 'correctness' &&
    buildModel(q05Paraphrase).verdict.kind === 'wrong-results',
);

const q07Paraphrase = structuredClone(q05Paraphrase);
q07Paraphrase.findings = [{
  id: 'right-filter-removes-null-extension',
  title: 'WHERE predicate eliminates NULL-extended rows',
  severity: 'high',
  category: 'intent',
  actionability: 'required',
  evidence: { sqlFragment: "WHERE right_side.status = 'complete'" },
  impact: 'The statement behaves as an inner join and excludes entities lacking a matching row.',
  remediation: 'Choose the unmatched-row behavior before selecting a rewrite branch.',
  confidence: 'high',
}];
invariant(
  'structured intent category leads despite paraphrased q07 wording',
  buildModel(q07Paraphrase).issues[0]?.kind === 'intent' &&
    buildModel(q07Paraphrase).verdict.kind === 'intent-required',
);

const negatedPerformance = structuredClone(q05Paraphrase);
negatedPerformance.findings = [{
  id: 'intentional-duplicates-cost-sort-work',
  title: 'Duplicate rows increase sort work',
  severity: 'high',
  category: 'performance',
  actionability: 'required',
  evidence: { sqlFragment: 'ORDER BY intentional_duplicate_key' },
  impact: 'The duplicates are intentional and the result is correct; only sort volume increases.',
  remediation: 'Tune the sort only if measured latency warrants it.',
  confidence: 'high',
}];
invariant(
  'correctness-shaped prose cannot override performance category',
  buildModel(negatedPerformance).issues[0]?.kind === 'performance' &&
    buildModel(negatedPerformance).verdict.kind !== 'wrong-results',
);

const regression = structuredClone(healthyAnalysis);
regression.verification = { baselineMs: 100, optimizedMs: 300, resultsMatch: true };
const regressionReport = renderReport(regression);
invariant(
  '300 ms from a 100 ms baseline is a measured regression',
  buildModel(regression).timing.kind === 'regression' &&
    regressionReport.includes('3.00x regression') &&
    !regressionReport.includes('effectively unchanged'),
);

const zeroTiming = structuredClone(healthyAnalysis);
zeroTiming.verification = { baselineMs: 100, optimizedMs: 0 };
const zeroReport = renderReport(zeroTiming);
invariant(
  'zero timing is invalid and never becomes a fabricated ratio',
  buildModel(zeroTiming).timing.kind === 'unavailable' &&
    zeroReport.includes('timing invalid') &&
    !zeroReport.includes('1000000'),
);

const prefixDependency = structuredClone(nonSargableAnalysis);
prefixDependency.rewrites[0].requiresIndexes = ['idx_orders_status'];
const prefixReport = renderReport(prefixDependency);
invariant(
  'index-id prefixes and DDL substrings do not satisfy dependencies',
  buildModel(prefixDependency).dependencyProblems[0]?.reason === 'missing' &&
    prefixReport.includes('Action blocked') &&
    !prefixReport.includes('coupled rewrite + index'),
);

const malformed = structuredClone(healthyAnalysis);
malformed.findings = [{}] as never;
malformed.indexes = [{}] as never;
malformed.rewrites = [{}] as never;
malformed.execution = { ...malformed.execution, dominantCosts: [{}] } as never;
const malformedReport = renderReport(malformed);
invariant(
  'malformed nested entries are rejected visibly without placeholders',
  buildModel(malformed).verdict.kind === 'incomplete' &&
    malformedReport.includes('Malformed analyzer input') &&
    !/\b(?:undefined|NaN)\b|\[object Object\]/m.test(malformedReport),
);

const controlled = structuredClone(healthyAnalysis);
controlled.semantics.headline = 'headline\u001b[31mred\u0007bell\u0085next';
controlled.sql = 'SELECT 1; -- \u001b[2J\u0000';
const controlledPlain = renderReport(controlled, { format: 'terminal', color: false });
invariant(
  'untrusted C0/C1/ANSI controls are escaped even with color disabled',
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(controlledPlain) &&
    controlledPlain.includes('\\x1B[31mred\\x07bell\\x85next'),
);

const selfContained = renderReport(fanOutAnalysis);
invariant(
  'report is self-contained with executive grain and original SQL',
  selfContained.includes('**Result grain.**') && selfContained.includes('## Original SQL'),
);

// Empty-input guard: every field absent.
try {
  const out = renderReport({} as never, { format: 'terminal', color: false });
  const incomplete = out.includes('ANALYSIS INCOMPLETE') && !out.includes('NO ACTION NEEDED');
  if (!incomplete) failures++;
  process.stdout.write(`${incomplete ? 'ok  ' : 'FAIL'}  empty analysis renders as incomplete (${out.split('\n').length} lines), no throw\n`);
  process.stdout.write(out.split('\n').map((l) => '      | ' + l).join('\n') + '\n');
} catch (err) {
  failures++;
  process.stdout.write(`FAIL  empty analysis threw: ${(err as Error).message}\n`);
}

process.stdout.write(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exitCode = failures ? 1 : 0;
