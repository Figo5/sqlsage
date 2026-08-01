/**
 * Product acceptance over the twelve-query corpus.
 *
 *   node eval/run.ts            compact summary
 *   node eval/run.ts --verbose  plus binding and gate detail
 *
 * This is an offline workflow test against frozen catalog metadata. It checks
 * composition and the named safety/correctness gates for the CLI-first product;
 * it does not turn predicted behavior into measured database evidence.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CORPUS } from '../corpus/queries.ts';
import { loadCatalog } from '../src/catalog.ts';
import { analyze } from '../src/index.ts';
import { renderReport } from '../src/report/index.ts';
import type { Analysis, QueryBlockIR } from '../src/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');
const catalog = await loadCatalog(join(ROOT, 'corpus', 'catalog.json'));

function multipliedAliases(blocks: QueryBlockIR[]): string[] {
  const seen = new Set<string>();
  for (const block of blocks) {
    for (const join of block.joins) {
      for (const alias of join.multipliedRelations ?? []) seen.add(alias);
    }
  }
  return [...seen].sort();
}

function hasFinding(analysis: Analysis, id: string): boolean {
  return analysis.findings.some((finding) => finding.id === id);
}

function corpusGate(shortId: string, analysis: Analysis): string[] {
  const problems: string[] = [];
  if (shortId === 'q01') {
    if (!hasFinding(analysis, 'non-sargable-function-on-column')) problems.push('q01 non-sargable finding absent');
    const rewrite = analysis.rewrites.find((candidate) => /half-open-range/.test(candidate.id));
    if (!rewrite || !/>=/.test(rewrite.sql) || !/</.test(rewrite.sql)) problems.push('q01 half-open rewrite absent');
    if (!rewrite?.requiresIndexes?.length) problems.push('q01 rewrite/index dependency absent');
    if (rewrite?.requiresIndexes?.some((id) => !analysis.indexes.some((index) => index.id === id))) {
      problems.push('q01 dependency does not resolve to emitted index');
    }
  }
  if (shortId === 'q05') {
    const finding = analysis.findings.find((candidate) => candidate.id === 'not-in-nullable-subquery');
    const rewrite = analysis.rewrites.find((candidate) => /not-in-to-not-exists/.test(candidate.id));
    if (finding?.category !== 'correctness' || finding.actionability !== 'required') {
      problems.push('q05 nullable NOT IN is not a required correctness blocker');
    }
    if (rewrite?.equivalence !== 'different-semantics' || !/NOT EXISTS/i.test(rewrite.sql)) {
      problems.push('q05 intentional NOT EXISTS repair absent');
    }
  }
  if (shortId === 'q06') {
    const finding = analysis.findings.find((candidate) => candidate.id === 'aggregate-over-one-to-many-fanout');
    if (finding?.category !== 'correctness' || finding.actionability !== 'required') {
      problems.push('q06 fan-out is not a required correctness blocker');
    }
    if (analysis.indexes.length) problems.push('q06 receives distracting index advice');
    if (analysis.rewrites[0]?.equivalence !== 'different-semantics') problems.push('q06 repair is not explicitly result-changing');
  }
  if (shortId === 'q07') {
    const finding = analysis.findings.find((candidate) => candidate.id === 'left-join-null-rejected-in-where');
    if (finding?.category !== 'intent' || finding.actionability !== 'required') {
      problems.push('q07 is not an explicit intent decision');
    }
    if (analysis.rewrites.length) problems.push('q07 silently chooses join semantics');
  }
  if (shortId === 'q10') {
    if (analysis.findings.length || analysis.indexes.length || analysis.rewrites.length) {
      problems.push('q10 false-positive trap produced an action');
    }
  }
  return problems;
}

let failures = 0;
const rows: string[] = [];

for (const query of CORPUS) {
  try {
    const { analysis, missingModules } = analyze(query.sql, catalog);
    const markdown = renderReport(analysis, { format: 'markdown' });
    const terminal = renderReport(analysis, { format: 'terminal', color: false });
    const hardBinding = analysis.ir.bindingErrors.filter((error) => error.severity === 'error');
    const multiplied = multipliedAliases(analysis.ir.blocks);
    const problems: string[] = [];

    if (hardBinding.length) problems.push(`${hardBinding.length} binding error(s)`);
    if (missingModules.length) problems.push(`missing modules: ${missingModules.join(', ')}`);
    if (!analysis.semantics.headline.trim() || /unavailable|not implemented/i.test(analysis.semantics.headline)) {
      problems.push('semantics is not substantive');
    }
    if (!analysis.execution.scalability.summary.trim() || /unavailable|not implemented/i.test(analysis.execution.scalability.summary)) {
      problems.push('execution assessment is not substantive');
    }
    if (!markdown.trim() || !terminal.trim()) problems.push('empty report');
    if (/\bundefined\b|\[object Object\]|\bNaN\b|One row per One row per/i.test(markdown)) {
      problems.push('placeholder or malformed prose leaked');
    }
    if (query.id.startsWith('q06') && !multiplied.includes('o')) problems.push('q06 order fan-out signal missing');
    problems.push(...corpusGate(query.id.slice(0, 3), analysis));

    if (problems.length) failures++;
    rows.push(
      `${query.id.padEnd(30)} ${String(analysis.ir.blocks.length).padStart(2)} blk  ` +
        `${String(analysis.findings.length).padStart(2)} findings  ` +
        `${String(analysis.indexes.length).padStart(2)} indexes  ` +
        `${String(analysis.rewrites.length).padStart(2)} rewrites` +
        (problems.length ? `  FAIL: ${problems.join('; ')}` : '  ok'),
    );

    if (verbose) {
      for (const error of analysis.ir.bindingErrors) rows.push(`    ${error.severity}: ${error.message}`);
      for (const problem of problems) rows.push(`    gate: ${problem}`);
    }
  } catch (error) {
    failures++;
    rows.push(`${query.id.padEnd(30)} THREW: ${(error as Error).message.split('\n')[0]}`);
  }
}

console.log('SQLSage CLI-first product acceptance — offline catalog evidence\n');
console.log(rows.join('\n'));
console.log(`\n${CORPUS.length - failures}/${CORPUS.length} workflows passed.` + (failures ? ` ${failures} FAILED.` : ''));
console.log('Evidence status: predicted and unverified; no query or candidate DDL was executed.');

process.exitCode = failures ? 1 : 0;
