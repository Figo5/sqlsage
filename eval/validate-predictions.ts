/**
 * Validates offline predictions against measured reality.
 *
 *   node eval/validate-predictions.ts            compact summary
 *   node eval/validate-predictions.ts --verbose  every comparison, including skips
 *
 * `eval/run.ts` checks that the analyzer *composes* — that findings, indexes and
 * rewrites appear where the corpus expects them. It never opens `groundtruth/`,
 * so a change that broke every row estimate in the tool passed it unnoticed.
 * This script closes that gap: it compares what the analyzer predicts offline
 * against `Actual Rows` captured from a real EXPLAIN (ANALYZE).
 *
 * No database is required. Ground truth is committed, so this runs in CI.
 * Refresh it with `npm run groundtruth` against a seeded PostgreSQL.
 *
 * ## Reading `Actual Rows` correctly
 *
 * PostgreSQL reports `Actual Rows` *per loop*, and a node's loop count means
 * two different things:
 *
 *   - **Re-scanned** (inner side of a Nested Loop): loops is the outer row
 *     count, and the node emits `Actual Rows` per probe. SQLSage predicts the
 *     per-probe figure, so that is what we compare.
 *   - **Parallel or once-through**: loops is the number of processes that ran
 *     the node, so the relation-wide total is `Actual Rows x Actual Loops`.
 *
 * Comparing against the wrong one manufactures failures that look damning and
 * are not: q01's `c` predicts 1 row and is right, while the total across its
 * 48437 probes is 48437. A validator that reported that as a 48000x error would
 * be committing precisely the over-claiming this suite exists to catch.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CORPUS } from '../corpus/queries.ts';
import { loadCatalog } from '../src/catalog.ts';
import { analyze } from '../src/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

/**
 * A prediction may be off by this factor in either direction before it counts
 * as broken. Deliberately loose: the question is "does this still track
 * reality?", not "is the cardinality model precise". Planner-grade accuracy is
 * not on offer offline, and a tight bound here would fail on catalog drift
 * rather than on regressions.
 */
const RATIO_TOLERANCE = 10;

/**
 * The suite must not be able to pass by predicting *nothing*. Tolerance checks
 * are vacuous over an empty set, so a refactor that dropped every estimate
 * would sail through a ratio-only gate — the exact failure being fixed here.
 * This floor is the current validated count; raise it as coverage grows.
 */
const MIN_VALIDATED = 11;

/**
 * Access paths SQLSage predicts wrongly today, kept explicit so the gate can
 * fail on *new* mispredictions without pretending these are correct.
 *
 * The one entry is a modelling limit, not an oversight. `o` has no index
 * serving its row conditions, and the index that leads with its join key is set
 * aside because that join's own driver (`c`, 200k rows) looks too large for
 * repeated lookups. PostgreSQL reaches `orders` later in the chain, after
 * `p.category_id = 42` has cut the input to a few hundred rows, and uses the
 * index. Predicting that needs join-order reasoning the analyzer does not do.
 *
 * The prose no longer claims no index applies — it names the index and the
 * assumption that set it aside (docs/AUDIT-2026-08-03.md P0-3). What remains
 * wrong is the path label alone.
 */
const KNOWN_PATH_MISMATCHES = new Map<string, string>([
  ['q08-distinct-hides-fanout/o', 'predicts seq-scan; PostgreSQL drives it from a filtered chain and uses an Index Scan'],
]);

interface Observed {
  perLoop: number;
  total: number;
  loops: number;
  rescanned: boolean;
  nodeType: string;
  indexName?: string;
  occurrences: number;
}

/**
 * Indexes every aliased scan node in a plan tree. An alias appearing more than
 * once is recorded but never compared: with two nodes to choose from there is
 * no honest single answer, and guessing would invent a verdict.
 */
function observeRelations(plan: unknown): Map<string, Observed> {
  const out = new Map<string, Observed>();
  const walk = (node: any, parent: any, childIndex: number): void => {
    const alias = node?.['Alias'];
    if (typeof alias === 'string') {
      const existing = out.get(alias);
      if (existing) {
        existing.occurrences++;
      } else {
        const rows = Number(node['Actual Rows'] ?? 0);
        const loops = Number(node['Actual Loops'] ?? 1);
        out.set(alias, {
          perLoop: rows,
          total: rows * loops,
          loops,
          // A Nested Loop's second child is its inner, re-scanned input.
          rescanned: parent?.['Node Type'] === 'Nested Loop' && childIndex === 1,
          nodeType: String(node['Node Type'] ?? 'unknown'),
          indexName: node['Index Name'],
          occurrences: 1,
        });
      }
    }
    for (const [i, child] of (node?.['Plans'] ?? []).entries()) walk(child, node, i);
  };
  walk((plan as any)?.Plan, null, 0);
  return out;
}

/** True when the predicted path kind is consistent with the executed node type. */
function pathAgrees(predicted: string, nodeType: string): boolean {
  const node = nodeType.toLowerCase();
  switch (predicted) {
    case 'seq-scan':
      return node === 'seq scan';
    case 'index-scan':
      return node === 'index scan';
    case 'index-only-scan':
      return node === 'index only scan';
    case 'bitmap-heap-scan':
      return node.startsWith('bitmap');
    default:
      // Unmodelled kinds are not asserted against; silence beats a false verdict.
      return true;
  }
}

const catalog = await loadCatalog(join(ROOT, 'corpus', 'catalog.json'));

let validated = 0;
let failures = 0;
let worstRatio = 1;
let worstLabel = '';
const rows: string[] = [];
const notes: string[] = [];

for (const query of CORPUS) {
  let ground: any;
  try {
    ground = JSON.parse(readFileSync(join(ROOT, 'groundtruth', `${query.id}.json`), 'utf8'));
  } catch (error) {
    failures++;
    rows.push(`${query.id.padEnd(30)} NO GROUND TRUTH: ${(error as Error).message.split('\n')[0]}`);
    continue;
  }

  const observed = observeRelations(ground.planJson);
  const { analysis } = analyze(query.sql, catalog);
  const problems: string[] = [];
  let checkedHere = 0;

  for (const path of analysis.execution.accessPaths) {
    // Relations inside a nested block are labelled `alias (block:id)`. Their
    // aliases are not unique across blocks and the block may be flattened away
    // in the real plan, so they cannot be matched to a plan node by alias.
    const scoped = /^(\S+)\s+\((.+)\)$/.exec(path.relation);
    if (scoped) {
      if (verbose) notes.push(`  ${query.id} ${path.relation}: skipped, nested block not addressable by alias`);
      continue;
    }

    const seen = observed.get(path.relation);
    if (!seen) {
      if (verbose) notes.push(`  ${query.id} ${path.relation}: skipped, no scan node with this alias`);
      continue;
    }
    if (seen.occurrences > 1) {
      if (verbose) notes.push(`  ${query.id} ${path.relation}: skipped, alias scanned ${seen.occurrences} times`);
      continue;
    }

    const key = `${query.id}/${path.relation}`;
    if (!pathAgrees(path.path, seen.nodeType)) {
      const known = KNOWN_PATH_MISMATCHES.get(key);
      if (known) {
        if (verbose) notes.push(`  ${query.id} ${path.relation}: known misprediction — ${known}`);
      } else {
        problems.push(`${path.relation} predicted ${path.path}, executed as ${seen.nodeType}`);
      }
    } else if (KNOWN_PATH_MISMATCHES.has(key)) {
      // Fail loudly rather than let a fixed bug rot in the baseline.
      problems.push(`${path.relation} now predicts the right path — remove it from KNOWN_PATH_MISMATCHES`);
    }

    if (path.estimatedRows === undefined) continue;
    const actual = seen.rescanned ? seen.perLoop : seen.total;
    if (actual <= 0) {
      if (verbose) notes.push(`  ${query.id} ${path.relation}: skipped, node emitted no rows`);
      continue;
    }

    const ratio = path.estimatedRows / actual;
    validated++;
    checkedHere++;
    const drift = ratio >= 1 ? ratio : 1 / ratio;
    if (ratio > RATIO_TOLERANCE || ratio < 1 / RATIO_TOLERANCE) {
      problems.push(
        `${path.relation} estimated ${Math.round(path.estimatedRows)} rows, measured ${actual}` +
          ` (${drift.toFixed(1)}x off${seen.rescanned ? ', per probe' : ''})`,
      );
    } else if (drift > worstRatio) {
      // Tracked only across predictions that passed, so the headline cannot
      // report a failing drift as though it were within tolerance.
      worstRatio = drift;
      worstLabel = `${key} (${Math.round(path.estimatedRows)} vs ${actual})`;
    }
  }

  if (problems.length) failures++;
  rows.push(
    `${query.id.padEnd(30)} ${String(checkedHere).padStart(2)} checked` +
      (problems.length ? `  FAIL: ${problems.join('; ')}` : '  ok'),
  );
}

console.log('SQLSage prediction validation — offline predictions vs measured EXPLAIN ANALYZE\n');
console.log(rows.join('\n'));
if (notes.length) console.log(`\nskipped comparisons:\n${notes.join('\n')}`);

console.log(`\n${validated} predictions validated against ground truth.`);
if (worstLabel) console.log(`Widest drift within tolerance: ${worstRatio.toFixed(1)}x at ${worstLabel}.`);

if (validated < MIN_VALIDATED) {
  failures++;
  console.log(
    `\nFAIL: only ${validated} predictions were validated, below the floor of ${MIN_VALIDATED}.` +
      `\n      Tolerance checks pass vacuously over an empty set, so losing coverage is` +
      `\n      itself a regression: the analyzer has stopped predicting something it used to.`,
  );
}

console.log(
  failures
    ? `\n${failures} FAILED.`
    : `\nAll predictions track measured reality within ${RATIO_TOLERANCE}x.`,
);

process.exitCode = failures ? 1 : 0;
