import { q05Analysis, q07Analysis, clone } from './adv-m7.ts';
import { buildModel, renderReport } from '../../src/report/index.ts';
import type { Analysis } from '../../src/types.ts';

const sec = (t: string) => console.log('\n' + '='.repeat(76) + '\n## ' + t + '\n' + '='.repeat(76));

// ---- D4: malformed but non-empty DDL satisfies a coupled dependency -------
sec('D4. "ddl" = DROP TABLE, referenced by exact id from requiresIndexes');
const d4 = clone(q05Analysis) as Analysis;
d4.rewrites[0].requiresIndexes = ['idx_events_checkout_customer'];
d4.indexes[0].ddl = 'DROP TABLE shop.events;';
const d4out = renderReport(d4, { format: 'markdown' });
console.log('verdict=' + buildModel(d4).verdict.kind + '  depProblems=' + buildModel(d4).dependencyProblems.length);
console.log(d4out.split('\n').filter((l, i, arr) =>
  /Do this first/.test(l) || /Index \(/.test(l) || /DROP TABLE/.test(l) || /Before you run it/.test(l) ||
  /Required companion/.test(l) || (i > 0 && /^1\. /.test(l))).join('\n'));

// ---- D2: unterminated bold in the "Action blocked" lede -------------------
sec('D2. Action-blocked lede markup');
const d2 = clone(q05Analysis) as Analysis;
d2.rewrites[0].requiresIndexes = ['idx_nope'];
for (const fmt of ['markdown', 'terminal'] as const) {
  const out = renderReport(d2, { format: fmt, color: false });
  console.log('--- ' + fmt + ' ---');
  console.log(out.split('\n').filter((l) => /Action blocked/.test(l) || /Do not deploy/.test(l)).join('\n'));
}

// ---- D1: orphaned different-semantics rewrite, phrasing sweep -------------
sec('D1. q07 intent + result-changing rewrite: does the rewrite attach?');
const phrasings: Array<[string, (a: Analysis) => void]> = [
  ['as authored (no "orders" token in rewrite prose)', () => {}],
  ['rewrite rationale mentions shop.orders', (a) => { a.rewrites[0].rationale += ' The shop.orders rows are unchanged.'; }],
  ['rewrite id shares a slug token with the finding id', (a) => { a.rewrites[0].id = 'outer-join-predicate-placement'; a.findings[0].id = 'outer-join-demoted-by-where'; }],
  ['finding evidence fragment verbatim inside rewrite notes', (a) => { a.rewrites[0].equivalenceNotes += " Moves WHERE o.status = 'complete' into ON."; }],
];
for (const [name, mutate] of phrasings) {
  const a = clone(q07Analysis) as Analysis;
  mutate(a);
  const m = buildModel(a);
  console.log(`\n[${name}]`);
  console.log('  verdict = ' + m.verdict.label);
  console.log('  issue#1 = ' + m.issues[0]?.kind + ' :: ' + m.issues[0]?.title);
  console.log('  lede    = ' + (m.bottomLine[0] ?? '').slice(0, 130));
}

// ---- D5: does a trivial recovered field mask a real correctness verdict? --
sec('D5. cosmetic/recovered validation problem vs a real correctness blocker');
const variants: Array<[string, (a: Analysis) => void]> = [
  ['catalogName blank (cosmetic)', (a) => { a.catalogName = ''; }],
  ['execution.accessPaths[0].path typo -> recovered as unknown', (a) => { (a.execution.accessPaths[0] as never as Record<string, unknown>).path = 'seqscan'; }],
  ['dominantCosts[0].estimatedShare = 1.5 -> ignored', (a) => { a.execution.dominantCosts[0].estimatedShare = 1.5; }],
  ['a 5th semantics step missing .detail -> entry ignored', (a) => { (a.semantics.steps as unknown as unknown[]).push({ title: 'stray' }); }],
];
for (const [name, mutate] of variants) {
  const a = clone(q05Analysis) as Analysis;
  mutate(a);
  const m = buildModel(a);
  console.log(`\n[${name}] -> verdict=${m.verdict.label}`);
  console.log('  banner: ' + m.verdict.banner.slice(0, 120));
}

// ---- D6: coupling break when the rewrite orphans but the index attaches ---
sec('D6. rewrite requires an index that attached to a different finding');
const d6 = clone(q05Analysis) as Analysis;
// Give the index strong affinity to the finding, and the rewrite none.
d6.rewrites[0].id = 'zzz';
d6.rewrites[0].title = 'Alternative formulation';
d6.rewrites[0].rationale = 'Uses a different construct.';
d6.rewrites[0].equivalenceNotes = 'Same population.';
d6.rewrites[0].equivalence = 'exact';
d6.rewrites[0].requiresIndexes = ['idx_events_checkout_customer'];
const m6 = buildModel(d6);
console.log('issues=' + m6.issues.length);
m6.issues.forEach((i, n) => console.log(`  §${n + 1} ${i.kind} "${i.title}" rewrites=[${i.rewrites.map(r => r.id)}] indexes=[${i.indexes.map(x => x.id)}]`));
console.log('depProblems=' + m6.dependencyProblems.length);
console.log(renderReport(d6, { format: 'markdown' }).split('\n').filter((l) => /^## |^1\. |^2\. |Required companion/.test(l)).join('\n'));
