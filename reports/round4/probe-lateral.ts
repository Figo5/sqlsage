/**
 * Round-4 probe: correlated LATERAL fan-out, checked against the live server.
 *
 * A correlated LATERAL spells its join condition inside its own block, so the
 * outer ON reads `ON true` and looks keyless. The question this probe settles is
 * not "what does the IR say" but "is an aggregate over the lateral's own columns
 * actually over-counted" -- answered by summing on the server, not by reasoning.
 *
 * Scoped to a customer_id slice so it stays fast enough to re-run freely.
 * Read-only: no DDL, no indexes created, nothing to roll back.
 *
 *   node reports/round4/probe-lateral.ts
 */
import { loadCatalog } from '../../src/catalog.ts';
import { bindQuery } from '../../src/ir/index.ts';
import { withClient } from '../../src/db.ts';

const SLICE = 5000;

const CASES = [
  {
    name: 'A. outer unique on the correlation key -> lateral rows NOT multiplied',
    expect: { side: 'left', multiplied: ['c'] },
    sql: `SELECT c.customer_id, sum(t.total_cents) AS s
          FROM shop.customers c
          JOIN LATERAL (SELECT o.total_cents FROM shop.orders o
                        WHERE o.customer_id = c.customer_id) t ON true
          WHERE c.customer_id <= ${SLICE}
          GROUP BY c.customer_id`,
    // The lateral's own column, summed over the join, must equal the plain sum.
    lateralTotal: `SELECT sum(t.total_cents)::bigint AS v
                   FROM shop.customers c
                   JOIN LATERAL (SELECT o.total_cents FROM shop.orders o
                                 WHERE o.customer_id = c.customer_id) t ON true
                   WHERE c.customer_id <= ${SLICE}`,
    truth: `SELECT sum(o.total_cents)::bigint AS v FROM shop.orders o
            WHERE o.customer_id <= ${SLICE}`,
  },
  {
    name: 'B. inner unique on the correlation key, outer NOT -> lateral rows ARE multiplied',
    expect: { side: 'right', multiplied: ['t'] },
    sql: `SELECT o.order_id, t.customer_id
          FROM shop.orders o
          JOIN LATERAL (SELECT c.customer_id FROM shop.customers c
                        WHERE c.customer_id = o.customer_id) t ON true
          WHERE o.customer_id <= ${SLICE}`,
    lateralTotal: `SELECT sum(t.customer_id)::bigint AS v
                   FROM shop.orders o
                   JOIN LATERAL (SELECT c.customer_id FROM shop.customers c
                                 WHERE c.customer_id = o.customer_id) t ON true
                   WHERE o.customer_id <= ${SLICE}`,
    truth: `SELECT sum(c.customer_id)::bigint AS v FROM shop.customers c
            WHERE c.customer_id <= ${SLICE}
              AND EXISTS (SELECT 1 FROM shop.orders o WHERE o.customer_id = c.customer_id)`,
  },
  {
    name: 'C. neither side unique on the correlation key -> both multiplied',
    expect: { side: 'both', multiplied: ['o', 't'] },
    sql: `SELECT o.order_id, t.total_cents
          FROM shop.orders o
          JOIN LATERAL (SELECT o2.total_cents FROM shop.orders o2
                        WHERE o2.customer_id = o.customer_id) t ON true
          WHERE o.customer_id <= 200`,
    lateralTotal: `SELECT sum(t.total_cents)::bigint AS v
                   FROM shop.orders o
                   JOIN LATERAL (SELECT o2.total_cents FROM shop.orders o2
                                 WHERE o2.customer_id = o.customer_id) t ON true
                   WHERE o.customer_id <= 200`,
    truth: `SELECT sum(o2.total_cents)::bigint AS v FROM shop.orders o2
            WHERE o2.customer_id <= 200`,
  },
  {
    name: 'D. uncorrelated lateral -> genuinely keyless, stays pessimistic',
    expect: { side: 'both', multiplied: ['c', 't'] },
    sql: `SELECT c.customer_id, t.total_cents
          FROM shop.customers c
          JOIN LATERAL (SELECT o.total_cents FROM shop.orders o
                        WHERE o.status = 'complete' LIMIT 3) t ON true
          WHERE c.customer_id <= 10`,
  },
];

const catalog = await loadCatalog('corpus/catalog.json');

let failures = 0;

for (const c of CASES) {
  console.log(`\n### ${c.name}`);
  const ir = bindQuery(c.sql, catalog);
  const main = ir.blocks.find((b) => b.id === 'main')!;
  const join = main.joins[0];
  if (!join) {
    console.log('  !! no join produced');
    failures++;
    continue;
  }
  const got = { side: join.fanOutSide, multiplied: [...(join.multipliedRelations ?? [])].sort() };
  const want = { side: c.expect.side, multiplied: [...c.expect.multiplied].sort() };
  const ok = got.side === want.side && JSON.stringify(got.multiplied) === JSON.stringify(want.multiplied);
  console.log(`  IR    : side=${got.side} multiplied=[${got.multiplied}]`);
  console.log(`  expect: side=${want.side} multiplied=[${want.multiplied}]  ${ok ? 'OK' : '<-- MISMATCH'}`);
  if (!ok) failures++;

  if (c.lateralTotal && c.truth) {
    const [lat, tru] = await withClient(async (client) => Promise.all([client.query(c.lateralTotal), client.query(c.truth)]));
    const a = BigInt(lat.rows[0].v ?? 0);
    const b = BigInt(tru.rows[0].v ?? 0);
    const inflated = a !== b;
    // The IR claims the lateral's own rows are multiplied iff 't' is listed.
    const claims = got.multiplied.includes('t');
    const agrees = inflated === claims;
    console.log(`  server: lateral sum=${a} true sum=${b} -> ${inflated ? `INFLATED ${(Number(a) / Number(b)).toFixed(4)}x` : 'exact'}`);
    console.log(`  IR ${claims ? 'claims' : 'does not claim'} t is multiplied  ${agrees ? 'OK -- matches the server' : '<-- CONTRADICTS THE SERVER'}`);
    if (!agrees) failures++;
  }
}

console.log(`\n${failures === 0 ? 'all lateral checks passed' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
