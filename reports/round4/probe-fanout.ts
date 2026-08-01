/**
 * Round-4 independent probe: fan-out / multipliedRelations under shapes the
 * builder said were untested — RIGHT/FULL joins, LATERAL, derived tables,
 * 4+ chains, self-joins, comma joins, and multi-block queries.
 */
import { readFile } from 'node:fs/promises';
import { bindQuery } from '../../src/ir/index.ts';
import type { Catalog, QueryIR } from '../../src/types.ts';

const catalog = JSON.parse(await readFile(new URL('../../corpus/catalog.json', import.meta.url), 'utf8')) as Catalog;

function show(label: string, sql: string, opts: { roundTrip?: boolean } = {}): void {
  let ir: QueryIR = bindQuery(sql, catalog);
  if (opts.roundTrip) ir = JSON.parse(JSON.stringify(ir)) as QueryIR;
  console.log(`\n### ${label}`);
  console.log(`    ${sql.replace(/\s+/g, ' ').trim()}`);
  for (const e of ir.bindingErrors) console.log(`    !! [${e.severity}] ${e.message}`);
  for (const b of ir.blocks) {
    if (b.joins.length === 0 && ir.blocks.length === 1) continue;
    for (const j of b.joins) {
      console.log(
        `    [${b.id}] ${j.leftRelation} --${j.type}--> ${j.rightRelation}` +
          ` fanOut=${j.fanOut} side=${j.fanOutSide} multiplied=[${(j.multipliedRelations ?? []).join(',')}]`,
      );
    }
  }
}

const cases: Array<[string, string]> = [
  // ---- axis 1: the Round-3 gap, all orientations -------------------------
  ['q06 as written', `SELECT c.customer_id, sum(o.total_cents) FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id JOIN shop.order_items oi ON oi.order_id = o.order_id GROUP BY c.customer_id`],
  ['q06 items-first', `SELECT c.customer_id, sum(o.total_cents) FROM shop.order_items oi JOIN shop.orders o ON oi.order_id = o.order_id JOIN shop.customers c ON o.customer_id = c.customer_id GROUP BY c.customer_id`],
  ['q06 orders-first', `SELECT c.customer_id, sum(o.total_cents) FROM shop.orders o JOIN shop.order_items oi ON oi.order_id = o.order_id JOIN shop.customers c ON o.customer_id = c.customer_id GROUP BY c.customer_id`],

  // ---- axis 2: RIGHT and FULL -------------------------------------------
  ['RIGHT: orders RIGHT JOIN customers (customers preserved)', `SELECT * FROM shop.orders o RIGHT JOIN shop.customers c ON c.customer_id = o.customer_id`],
  ['RIGHT: customers RIGHT JOIN orders (orders preserved)', `SELECT * FROM shop.customers c RIGHT JOIN shop.orders o ON o.customer_id = c.customer_id`],
  ['RIGHT q06: items RIGHT JOIN orders RIGHT JOIN customers', `SELECT c.customer_id, sum(o.total_cents) FROM shop.order_items oi RIGHT JOIN shop.orders o ON oi.order_id = o.order_id RIGHT JOIN shop.customers c ON o.customer_id = c.customer_id GROUP BY c.customer_id`],
  ['RIGHT q06 mirror: customers RIGHT JOIN orders RIGHT JOIN items', `SELECT c.customer_id, sum(o.total_cents) FROM shop.customers c RIGHT JOIN shop.orders o ON o.customer_id = c.customer_id RIGHT JOIN shop.order_items oi ON oi.order_id = o.order_id GROUP BY c.customer_id`],
  ['FULL: customers FULL JOIN orders', `SELECT * FROM shop.customers c FULL JOIN shop.orders o ON o.customer_id = c.customer_id`],
  ['FULL: orders FULL JOIN customers', `SELECT * FROM shop.orders o FULL JOIN shop.customers c ON c.customer_id = o.customer_id`],
  ['FULL chain: customers FULL JOIN orders FULL JOIN items', `SELECT c.customer_id, sum(o.total_cents) FROM shop.customers c FULL JOIN shop.orders o ON o.customer_id = c.customer_id FULL JOIN shop.order_items oi ON oi.order_id = o.order_id GROUP BY c.customer_id`],
  ['LEFT: orders LEFT JOIN customers (PK on right)', `SELECT * FROM shop.orders o LEFT JOIN shop.customers c ON c.customer_id = o.customer_id`],
  ['FULL USING', `SELECT * FROM shop.customers c FULL JOIN shop.orders o USING (customer_id)`],
  ['RIGHT USING', `SELECT * FROM shop.customers c RIGHT JOIN shop.orders o USING (customer_id)`],

  // ---- axis 3: LATERAL and derived tables --------------------------------
  ['LATERAL top-1 per customer', `SELECT c.customer_id, t.order_id FROM shop.customers c JOIN LATERAL (SELECT o.order_id FROM shop.orders o WHERE o.customer_id = c.customer_id ORDER BY o.created_at DESC LIMIT 1) t ON true`],
  ['LATERAL unbounded', `SELECT c.customer_id, t.order_id FROM shop.customers c JOIN LATERAL (SELECT o.order_id FROM shop.orders o WHERE o.customer_id = c.customer_id) t ON true`],
  ['LATERAL LEFT', `SELECT c.customer_id, t.order_id FROM shop.customers c LEFT JOIN LATERAL (SELECT o.order_id FROM shop.orders o WHERE o.customer_id = c.customer_id) t ON true`],
  ['derived pre-aggregated (grouped, unique)', `SELECT c.customer_id, d.revenue FROM shop.customers c JOIN (SELECT o.customer_id, sum(o.total_cents) AS revenue FROM shop.orders o GROUP BY o.customer_id) d ON d.customer_id = c.customer_id`],
  ['derived not unique', `SELECT c.customer_id, d.order_id FROM shop.customers c JOIN (SELECT o.customer_id, o.order_id FROM shop.orders o) d ON d.customer_id = c.customer_id`],
  ['derived on the LEFT, unique right', `SELECT d.customer_id FROM (SELECT o.customer_id FROM shop.orders o) d JOIN shop.customers c ON c.customer_id = d.customer_id`],
  ['CTE pre-aggregated then joined', `WITH per_order AS (SELECT oi.order_id, sum(oi.quantity) AS q FROM shop.order_items oi GROUP BY oi.order_id) SELECT c.customer_id, sum(o.total_cents) FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id JOIN per_order p ON p.order_id = o.order_id GROUP BY c.customer_id`],

  // ---- axis 4: long chains and self-joins --------------------------------
  ['5-relation chain', `SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id JOIN shop.order_items oi ON oi.order_id = o.order_id JOIN shop.products p ON p.product_id = oi.product_id JOIN shop.categories g ON g.category_id = p.category_id`],
  ['5-relation chain reversed', `SELECT c.customer_id FROM shop.categories g JOIN shop.products p ON p.category_id = g.category_id JOIN shop.order_items oi ON oi.product_id = p.product_id JOIN shop.orders o ON o.order_id = oi.order_id JOIN shop.customers c ON c.customer_id = o.customer_id`],
  ['self-join orders on PK (1:1)', `SELECT a.order_id FROM shop.orders a JOIN shop.orders b ON b.order_id = a.order_id`],
  ['self-join orders on customer_id (m:n)', `SELECT a.order_id, sum(a.total_cents) FROM shop.orders a JOIN shop.orders b ON b.customer_id = a.customer_id GROUP BY a.order_id`],
  ['self-join then aggregate over the third alias', `SELECT c.customer_id, sum(a.total_cents) FROM shop.customers c JOIN shop.orders a ON a.customer_id = c.customer_id JOIN shop.orders b ON b.customer_id = c.customer_id GROUP BY c.customer_id`],
  ['diamond: two children of the same parent', `SELECT o.order_id, sum(o.total_cents) FROM shop.orders o JOIN shop.order_items i1 ON i1.order_id = o.order_id JOIN shop.order_items i2 ON i2.order_id = o.order_id GROUP BY o.order_id`],

  // ---- axis 5: comma joins and mixed grammar -----------------------------
  ['comma cross join', `SELECT * FROM shop.customers c, shop.products p`],
  ['comma then JOIN (comma is looser)', `SELECT c.customer_id FROM shop.customers c, shop.orders o JOIN shop.order_items oi ON oi.order_id = o.order_id`],
  ['comma equi-join in WHERE (old-style)', `SELECT c.customer_id, sum(o.total_cents) FROM shop.customers c, shop.orders o, shop.order_items oi WHERE o.customer_id = c.customer_id AND oi.order_id = o.order_id GROUP BY c.customer_id`],

  // ---- axis 6: multi-block state -----------------------------------------
  ['two identical derived blocks side by side', `SELECT * FROM (SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id) d1, (SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id) d2`],
  ['block 1 multiplies o, block 2 is a 1:1 join on o', `SELECT * FROM (SELECT o.order_id FROM shop.orders o JOIN shop.order_items oi ON oi.order_id = o.order_id) d1, (SELECT o.order_id FROM shop.orders o JOIN shop.order_items oi ON oi.order_item_id = o.order_id) d2`],
  ['same shape alone (control for the previous case)', `SELECT o.order_id FROM shop.orders o JOIN shop.order_items oi ON oi.order_item_id = o.order_id`],
  ['CTE multiplies c, main block joins c 1:1', `WITH x AS (SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id) SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.order_id = c.customer_id`],
  ['control: main block alone', `SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.order_id = c.customer_id`],
];

for (const [label, sql] of cases) show(label, sql);

console.log('\n\n======== JSON ROUND-TRIP ========');
show('q06 as written (after JSON.parse(JSON.stringify))', `SELECT c.customer_id, sum(o.total_cents) FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id JOIN shop.order_items oi ON oi.order_id = o.order_id GROUP BY c.customer_id`, { roundTrip: true });
const a = bindQuery(`SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id JOIN shop.order_items oi ON oi.order_id = o.order_id`, catalog);
const b = JSON.parse(JSON.stringify(a)) as QueryIR;
console.log('byte-identical re-serialization:', JSON.stringify(a) === JSON.stringify(b));
console.log('multipliedRelations survive:', JSON.stringify(b.blocks[0]!.joins.map((j) => j.multipliedRelations)));
console.log('fanOutSide survive:', JSON.stringify(b.blocks[0]!.joins.map((j) => j.fanOutSide)));
