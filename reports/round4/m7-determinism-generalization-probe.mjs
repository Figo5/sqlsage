/** Round-4 independent M7 probe: process determinism, format identity, mutation, and schema inertness. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { buildModel, renderReport } from '../../src/report/index.ts';
import {
  degradedAnalysis,
  fanOutAnalysis,
  healthyAnalysis,
  nonSargableAnalysis,
} from '../../src/report/fixtures.ts';

const ANSI = /\u001b\[[0-9;]*m/g;
const fixtures = [fanOutAnalysis, nonSargableAnalysis, healthyAnalysis, degradedAnalysis];

function hash(s) {
  return createHash('sha256').update(s).digest('hex');
}

// Color must style only: stripping M7 ANSI produces the exact plain bytes for
// a critical report, q01 coupling, q10 no-action, and degraded input.
for (const [i, value] of fixtures.entries()) {
  const plain = renderReport(value, { format: 'terminal', color: false, width: 80 });
  const colored = renderReport(value, { format: 'terminal', color: true, width: 80 });
  assert.equal(colored.replace(ANSI, ''), plain, `fixture ${i}`);
  assert.doesNotMatch(plain, /\u001b/);
}
console.log('PASS ANSI-stripped terminal is byte-identical for critical/q01/q10/degraded reports');

// Separate-process determinism, not two calls inside one VM.
const childCode = [
  "import { renderReport } from './src/report/index.ts';",
  "import { nonSargableAnalysis } from './src/report/fixtures.ts';",
  "process.stdout.write(renderReport(nonSargableAnalysis,{format:'terminal',color:false,width:80}));",
].join('');
const outputs = Array.from({ length: 3 }, () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
});
assert.equal(new Set(outputs).size, 1);
console.log('PASS separate-process determinism sha256=', hash(outputs[0]));

// Neither model construction nor either renderer may reorder/mutate input.
for (const value of fixtures) {
  const before = structuredClone(value);
  buildModel(value);
  renderReport(value, { format: 'markdown' });
  renderReport(value, { format: 'terminal', color: true });
  assert.deepEqual(value, before);
}
console.log('PASS model/render paths do not mutate caller analyses');

// Rename the four-character corpus schema to a four-character generic schema
// everywhere in a full report. Equal length avoids clipping artifacts. If the
// lone STOP_TOKENS literal "shop" were load-bearing, structure or normalized
// output would drift.
const renamed = JSON.parse(JSON.stringify(nonSargableAnalysis).replaceAll('shop', 'mart'));
const originalModel = buildModel(nonSargableAnalysis);
const renamedModel = buildModel(renamed);
const structural = (model) => ({
  verdict: model.verdict,
  issues: model.issues.map((issue) => ({
    kind: issue.kind,
    severity: issue.severity,
    actionability: issue.actionability,
    findings: issue.findings.map((f) => f.id),
    indexes: issue.indexes.map((i) => i.id),
    rewrites: issue.rewrites.map((r) => r.id),
    dependencies: issue.dependencyProblems,
  })),
  optional: model.optional.map((issue) => issue.key),
  cleared: model.cleared.map((entry) => entry.finding.id),
  counts: model.counts,
});
assert.deepEqual(structural(renamedModel), structural(originalModel));
const originalReport = renderReport(nonSargableAnalysis, { format: 'markdown' });
const renamedReport = renderReport(renamed, { format: 'markdown' }).replaceAll('mart', 'shop');
assert.equal(renamedReport, originalReport);
console.log('PASS shop->mart schema rename is structurally and byte-normalized inert');

// Audit executable runtime text after removing comments. Fixtures and tests are
// intentionally excluded; comments can name historical q01 evidence but cannot
// branch at runtime.
const runtimeFiles = ['src/report/prioritize.ts', 'src/report/index.ts', 'src/report/blocks.ts'];
const executable = runtimeFiles.map((path) => readFileSync(path, 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
assert.doesNotMatch(executable, /\bq(?:0[1-9]|1[0-2])\b/i);
assert.doesNotMatch(executable, /date_trunc\s*\(|order_items|customer_id\s*<\s*1000|not\s+in\s*\(/i);
console.log('PASS no corpus query id, SQL fingerprint, or anchor phrase in executable renderer source');

console.log('all determinism/generalization probe assertions completed');
