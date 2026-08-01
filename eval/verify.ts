/**
 * Verification harness. Answers the two questions a critic cannot answer by
 * reading code:
 *
 *   1. Does this proposed index actually change the plan, and by how much?
 *   2. Does this proposed rewrite return the SAME ROWS as the original?
 *
 * Everything runs inside a transaction that is always rolled back, so the
 * database is never mutated. Indexes are created without CONCURRENTLY here
 * (CONCURRENTLY cannot run in a transaction) — that is a harness detail and
 * does not change whether the index helps.
 *
 * Usage:
 *   node eval/verify.ts index  <corpusId> "CREATE INDEX ... ON ..." ["CREATE INDEX ..."]
 *   node eval/verify.ts rewrite <corpusId> path/to/rewrite.sql [--with-index "CREATE INDEX ..."]
 *   node eval/verify.ts sql    "SELECT ..."            # ad-hoc: plan + timing
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { CORPUS } from '../corpus/queries.ts';
import { CONN, capturePlan, fingerprintResults } from '../src/db.ts';

function corpusSql(id: string): string {
  const q = CORPUS.find((c) => c.id === id || c.id.startsWith(id));
  if (!q) {
    throw new Error(`unknown corpus id "${id}". Known: ${CORPUS.map((c) => c.id).join(', ')}`);
  }
  return q.sql;
}

/** Summarizes a plan tree down to the shape a human compares at a glance. */
function planShape(node: any, depth = 0): string[] {
  if (!node) return [];
  const t = node['Node Type'];
  const rel = node['Relation Name'] ? ` on ${node['Relation Name']}` : '';
  const idx = node['Index Name'] ? ` using ${node['Index Name']}` : '';
  const actual = node['Actual Rows'] !== undefined
    ? ` (rows=${node['Actual Rows']}${node['Actual Loops'] > 1 ? ` loops=${node['Actual Loops']}` : ''}` +
      `${node['Actual Total Time'] !== undefined ? ` ${node['Actual Total Time'].toFixed(1)}ms` : ''})`
    : '';
  const removed = node['Rows Removed by Filter']
    ? ` [filtered out ${node['Rows Removed by Filter']}]` : '';
  const lines = [`${'  '.repeat(depth)}${t}${rel}${idx}${actual}${removed}`];
  for (const child of node['Plans'] ?? []) lines.push(...planShape(child, depth + 1));
  return lines;
}

async function inRollback<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(CONN);
  await client.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    await client.end();
  }
}

async function verifyIndex(id: string, ddls: string[]) {
  const sql = corpusSql(id);
  console.log(`\n=== ${id}: index verification ===\n`);

  const before = await inRollback((c) => capturePlan(c, sql, { runs: 3 }));
  console.log(`BEFORE  median ${before.medianMs.toFixed(1)} ms`);
  console.log(planShape(before.planJson && (before.planJson as any).Plan).join('\n'));

  const after = await inRollback(async (c) => {
    for (const ddl of ddls) {
      const safe = ddl.replace(/\bCONCURRENTLY\b/gi, '');
      console.log(`\n  applying: ${safe.trim().replace(/\s+/g, ' ').slice(0, 120)}`);
      await c.query(safe);
    }
    // Fresh statistics, or the planner will not know the index is worth using.
    await c.query('ANALYZE shop.orders, shop.order_items, shop.customers, shop.events, shop.products');
    return capturePlan(c, sql, { runs: 3 });
  });

  console.log(`\nAFTER   median ${after.medianMs.toFixed(1)} ms`);
  console.log(planShape(after.planJson && (after.planJson as any).Plan).join('\n'));

  const speedup = before.medianMs / after.medianMs;
  const usedIt = JSON.stringify(after.planJson).includes('Index Name');
  console.log(
    `\nVERDICT  ${speedup >= 1 ? speedup.toFixed(2) + 'x faster' : (1 / speedup).toFixed(2) + 'x SLOWER'}` +
      ` (${before.medianMs.toFixed(1)} -> ${after.medianMs.toFixed(1)} ms)` +
      `; plan uses an index: ${usedIt}`,
  );
  if (speedup < 1.15) {
    console.log('WARNING  under 1.15x — this index does not earn its write cost on this query.');
  }
}

async function verifyRewrite(id: string, rewriteSql: string, indexDdls: string[]) {
  const original = corpusSql(id);
  console.log(`\n=== ${id}: rewrite verification ===\n`);

  const base = await inRollback(async (c) => ({
    plan: await capturePlan(c, original, { runs: 3 }),
    fp: await fingerprintResults(c, original).catch((e) => ({ error: String(e) }) as any),
  }));

  const cand = await inRollback(async (c) => {
    for (const ddl of indexDdls) await c.query(ddl.replace(/\bCONCURRENTLY\b/gi, ''));
    if (indexDdls.length) await c.query('ANALYZE shop.orders, shop.order_items, shop.customers, shop.events, shop.products');
    return {
      plan: await capturePlan(c, rewriteSql, { runs: 3 }),
      fp: await fingerprintResults(c, rewriteSql).catch((e) => ({ error: String(e) }) as any),
    };
  });

  console.log(`ORIGINAL  ${base.plan.medianMs.toFixed(1)} ms, ` +
    `${base.fp.rowCount ?? '?'} rows, digest ${base.fp.digest ?? 'n/a'}`);
  console.log(`REWRITE   ${cand.plan.medianMs.toFixed(1)} ms, ` +
    `${cand.fp.rowCount ?? '?'} rows, digest ${cand.fp.digest ?? 'n/a'}`);

  const sameRows = base.fp.rowCount === cand.fp.rowCount;
  const sameDigest = base.fp.digest && base.fp.digest === cand.fp.digest;

  console.log(`\nEQUIVALENCE  rows ${sameRows ? 'match' : 'DIFFER'}` +
    `, digest ${sameDigest ? 'matches' : 'DIFFERS'}`);
  if (!sameDigest) {
    console.log('  NOTE: a differing digest is not automatically a bug — the rewrite may');
    console.log('  intentionally fix a correctness defect in the original (q05/q06/q07), or');
    console.log('  differ only in row order. Compare the samples and decide deliberately.');
    console.log('  original sample:', JSON.stringify(base.fp.sample ?? null).slice(0, 300));
    console.log('  rewrite  sample:', JSON.stringify(cand.fp.sample ?? null).slice(0, 300));
  }
  const speedup = base.plan.medianMs / cand.plan.medianMs;
  console.log(`SPEED        ${speedup >= 1 ? speedup.toFixed(2) + 'x faster' : (1 / speedup).toFixed(2) + 'x SLOWER'}`);
  console.log('\nREWRITE PLAN');
  console.log(planShape(cand.plan.planJson && (cand.plan.planJson as any).Plan).join('\n'));
}

async function verifyAdHoc(sql: string) {
  const r = await inRollback((c) => capturePlan(c, sql, { runs: 3 }));
  console.log(`median ${r.medianMs.toFixed(1)} ms (planning ${r.planningMs.toFixed(2)} ms)\n`);
  console.log(r.planText);
}

const [mode, ...rest] = process.argv.slice(2);
const withIndexAt = rest.indexOf('--with-index');
const indexDdls = withIndexAt >= 0 ? rest.slice(withIndexAt + 1) : [];
const positional = withIndexAt >= 0 ? rest.slice(0, withIndexAt) : rest;

if (mode === 'index') {
  await verifyIndex(positional[0], positional.slice(1));
} else if (mode === 'rewrite') {
  const src = positional[1];
  const sql = src.trim().toLowerCase().endsWith('.sql') ? await readFile(src, 'utf8') : src;
  await verifyRewrite(positional[0], sql, indexDdls);
} else if (mode === 'sql') {
  await verifyAdHoc(positional.join(' '));
} else {
  console.log(`usage:
  node eval/verify.ts index   <corpusId> "<CREATE INDEX ...>" ["<CREATE INDEX ...>"]
  node eval/verify.ts rewrite <corpusId> <file.sql|"SELECT ...">  [--with-index "<DDL>" ...]
  node eval/verify.ts sql     "<SELECT ...>"

corpus ids: ${CORPUS.map((c) => c.id).join(', ')}`);
}
