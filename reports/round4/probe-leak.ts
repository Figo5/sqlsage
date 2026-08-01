/** Round-4 probe: cross-block leakage of multipliedAliases, and comma-join coverage. */
import { readFile } from 'node:fs/promises';
import { bindQuery } from '../../src/ir/index.ts';
import type { Catalog } from '../../src/types.ts';

const catalog = JSON.parse(await readFile(new URL('../../corpus/catalog.json', import.meta.url), 'utf8')) as Catalog;

function dump(label: string, sql: string): void {
  const ir = bindQuery(sql, catalog);
  console.log(`\n### ${label}`);
  console.log(`    ${sql.replace(/\s+/g, ' ').trim()}`);
  for (const e of ir.bindingErrors) console.log(`    !! [${e.severity}] ${e.message}`);
  for (const b of ir.blocks) {
    console.log(`    block ${b.id}: relations=[${b.relations.map((r) => r.alias).join(',')}] joins=${b.joins.length}`);
    for (const j of b.joins) {
      console.log(`      ${j.leftRelation} --${j.type}--> ${j.rightRelation} fanOut=${j.fanOut} side=${j.fanOutSide} multiplied=[${(j.multipliedRelations ?? []).join(',')}]`);
      console.log(`        reason: ${j.fanOutReason}`);
    }
    const joinPreds = b.predicates.filter((p) => p.kind === 'join');
    if (joinPreds.length) console.log(`      join-kind predicates: ${joinPreds.map((p) => p.sql).join(' | ')}`);
  }
}

console.log('======== A. cross-block leakage ========');
dump('CONTROL: 1:1 join alone', `SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.order_id = c.customer_id`);
dump('SAME BLOCK preceded by an unrelated CTE that multiplies c',
  `WITH x AS (SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id) SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.order_id = c.customer_id`);
dump('CONTROL: two identical derived blocks',
  `SELECT * FROM (SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id) d1, (SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id) d2`);
dump('scalar subquery after the main block multiplies o',
  `SELECT o.order_id, (SELECT count(*) FROM shop.orders o2 JOIN shop.order_items x ON x.order_item_id = o2.order_id) AS n FROM shop.orders o JOIN shop.order_items oi ON oi.order_id = o.order_id`);

console.log('\n\n======== B. comma joins ========');
dump('q06 in old-style comma form (identical semantics)',
  `SELECT c.customer_id, sum(o.total_cents) AS revenue FROM shop.customers c, shop.orders o, shop.order_items oi WHERE o.customer_id = c.customer_id AND oi.order_id = o.order_id AND o.status = 'complete' GROUP BY c.customer_id`);
dump('plain comma cross join', `SELECT * FROM shop.customers c, shop.products p`);
dump('comma join mixed with explicit JOIN',
  `SELECT c.customer_id, sum(o.total_cents) FROM shop.customers c, shop.orders o JOIN shop.order_items oi ON oi.order_id = o.order_id WHERE o.customer_id = c.customer_id GROUP BY c.customer_id`);
dump('explicit CROSS JOIN keyword', `SELECT * FROM shop.customers c CROSS JOIN shop.products p`);

console.log('\n\n======== C. LATERAL multiplied set ========');
dump('correlated LATERAL, aggregate over the lateral output is CORRECT',
  `SELECT c.customer_id, sum(t.total_cents) FROM shop.customers c JOIN LATERAL (SELECT o.total_cents FROM shop.orders o WHERE o.customer_id = c.customer_id) t ON true GROUP BY c.customer_id`);
dump('same query written as a plain join (control)',
  `SELECT c.customer_id, sum(o.total_cents) FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id GROUP BY c.customer_id`);
