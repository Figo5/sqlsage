/**
 * Collects the ground truth every critic judges against:
 *   - the frozen catalog (schema + pg_stats)
 *   - a real EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS) for each corpus query
 *
 * Run:  node eval/collect-groundtruth.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CORPUS } from '../corpus/queries.ts';
import { introspect, saveCatalog } from '../src/catalog.ts';
import { capturePlan, fingerprintResults, withClient } from '../src/db.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'groundtruth');

await mkdir(OUT, { recursive: true });

await withClient(async (client) => {
  console.log('Introspecting catalog...');
  const cat = await introspect(client, 'shop');
  await saveCatalog(cat, join(ROOT, 'corpus', 'catalog.json'));
  console.log(`  ${cat.tables.length} tables, pg ${cat.serverVersion}`);

  const index: Array<Record<string, unknown>> = [];

  for (const q of CORPUS) {
    process.stdout.write(`${q.id} ... `);
    try {
      const plan = await capturePlan(client, q.sql, { runs: 3 });
      let fp: Awaited<ReturnType<typeof fingerprintResults>> | null = null;
      try {
        fp = await fingerprintResults(client, q.sql);
      } catch (e) {
        // Some corpus queries are legitimately unwrappable (ORDER BY position etc.)
        fp = null;
      }
      await writeFile(
        join(OUT, `${q.id}.json`),
        JSON.stringify({ id: q.id, sql: q.sql, ...plan, fingerprint: fp }, null, 2) + '\n',
      );
      await writeFile(
        join(OUT, `${q.id}.txt`),
        `-- ${q.id}: ${q.title}\n-- median execution: ${plan.medianMs.toFixed(1)} ms ` +
          `(runs: ${plan.runs.map((r) => r.toFixed(0)).join(', ')} ms), planning: ${plan.planningMs.toFixed(2)} ms\n` +
      `-- rows returned (complete result): ${fp ? fp.rowCount : 'n/a'}\n\n${q.sql}\n\n${plan.planText}\n`,
      );
      index.push({
        id: q.id, title: q.title, medianMs: plan.medianMs,
        planningMs: plan.planningMs, rowCount: fp?.rowCount ?? null,
        digest: fp?.digest ?? null,
      });
      console.log(`${plan.medianMs.toFixed(0)} ms`);
    } catch (e) {
      console.log(`FAILED: ${(e as Error).message}`);
      index.push({ id: q.id, title: q.title, error: (e as Error).message });
    }
  }

  await writeFile(join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log('\nGround truth written to groundtruth/');
});
