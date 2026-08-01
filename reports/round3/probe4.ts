import { q05Analysis, clone } from './adv-m7.ts';
import { renderReport, buildModel } from '../../src/report/index.ts';
import type { Analysis } from '../../src/types.ts';

const sec = (t: string) => console.log('\n' + '='.repeat(76) + '\n## ' + t + '\n' + '='.repeat(76));

// --- F1: rigorous fence-escape test --------------------------------------
// Walk the document tracking fence state. A payload line is "escaped" only if
// it is OUTSIDE every fenced region.
function escapedLines(md: string, needles: string[]): string[] {
  const lines = md.split('\n');
  let open: string | null = null;
  const escaped: string[] = [];
  for (const line of lines) {
    const fence = line.match(/^(`{3,})/);
    if (open === null && fence) { open = fence[1]; continue; }
    if (open !== null && fence && fence[1].length >= open.length && line.trim() === fence[1]) { open = null; continue; }
    if (open === null && needles.some((n) => line.includes(n))) escaped.push(line);
  }
  return escaped;
}

sec('F1. backtick runs — does any payload line escape its code block?');
for (const run of [3, 4, 6, 10]) {
  const a = clone(q05Analysis) as Analysis;
  const t = '`'.repeat(run);
  a.sql = `SELECT 1; -- ${t}\n# INJECTED_SQL_HEADING\n> INJECTED_QUOTE`;
  a.ir.originalSql = a.sql;
  a.indexes[0].ddl = `CREATE INDEX x ON t (a); -- ${t}sql\n# INJECTED_DDL_HEADING`;
  a.rewrites[0].sql = `SELECT 2; -- ${t}\n# INJECTED_RW_HEADING`;
  const md = renderReport(a, { format: 'markdown' });
  const leaks = escapedLines(md, ['INJECTED_SQL_HEADING', 'INJECTED_DDL_HEADING', 'INJECTED_RW_HEADING', 'INJECTED_QUOTE']);
  const fences = [...new Set((md.match(/^`{3,}/gm) ?? []).map((f) => f.length))].sort((x, y) => x - y);
  console.log(`  run=${run}: fence widths=${fences.join(',')}  leaked lines=${leaks.length}${leaks.length ? ' -> ' + JSON.stringify(leaks) : ''}`);
}

// --- F2: NO_COLOR and TTY -------------------------------------------------
sec('F2. NO_COLOR / FORCE_COLOR / TERM=dumb');
const ESC = '';
const cases = [
  ['NO_COLOR=1, isTTY=true', { NO_COLOR: '1' }, true],
  ['NO_COLOR="", isTTY=true', { NO_COLOR: '' }, true],
  ['TERM=dumb, isTTY=true', { TERM: 'dumb' }, true],
  ['no env, isTTY=true', {}, true],
  ['no env, isTTY=false', {}, false],
  ['FORCE_COLOR=0, isTTY=true', { FORCE_COLOR: '0' }, true],
] as const;
const realEnv = process.env;
const realTTY = process.stdout.isTTY;
for (const [name, env, tty] of cases) {
  (process as { env: unknown }).env = { ...env };
  (process.stdout as { isTTY?: boolean }).isTTY = tty;
  const out = renderReport(q05Analysis, { format: 'terminal' });
  console.log(`  ${name} -> ANSI present: ${out.includes(ESC)}`);
}
(process as { env: unknown }).env = realEnv;
(process.stdout as { isTTY?: boolean }).isTTY = realTTY;

// --- F3: is the 'shop' stop-token load-bearing? ---------------------------
sec("F3. rename schema shop -> warehouse everywhere; does output change shape?");
const base = JSON.stringify(q05Analysis);
const renamed = JSON.parse(base.replace(/shop/g, 'warehouse')) as Analysis;
const mA = buildModel(q05Analysis);
const mB = buildModel(renamed);
console.log('  original: verdict=' + mA.verdict.label + ' issues=' + mA.issues.length +
  ' §1 idx=[' + mA.issues[0]?.indexes.map((i) => i.id) + '] rw=[' + mA.issues[0]?.rewrites.map((r) => r.id) + ']');
console.log('  renamed : verdict=' + mB.verdict.label + ' issues=' + mB.issues.length +
  ' §1 idx=[' + mB.issues[0]?.indexes.map((i) => i.id) + '] rw=[' + mB.issues[0]?.rewrites.map((r) => r.id) + ']');
const nA = renderReport(q05Analysis).replace(/shop/g, 'X');
const nB = renderReport(renamed).replace(/warehouse/g, 'X');
console.log('  reports identical after schema-name normalisation: ' + (nA === nB));

// --- F4: correctness finding with actionability none, full body -----------
sec('F4. correctness finding, actionability=none, no rewrite/index — what guidance?');
const f4 = clone(q05Analysis) as Analysis;
f4.findings[0].actionability = 'none';
f4.indexes = []; f4.rewrites = []; f4.verification = undefined;
const f4out = renderReport(f4);
console.log(f4out.split('\n').slice(0, 12).join('\n'));
console.log('  ...');
console.log('  remediation text present anywhere? ' + f4out.includes('Replace NOT IN with NOT EXISTS'));
console.log('  "Do this first" present? ' + f4out.includes('Do this first'));

// --- F5: cross-process determinism ---------------------------------------
sec('F5. cross-process determinism handled by shell (see next command)');
console.log(renderReport(q05Analysis, { format: 'markdown' }).length + ' chars');
