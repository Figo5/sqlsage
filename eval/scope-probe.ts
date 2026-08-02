import { loadSchemaCatalog } from '../src/schema.ts';
import { bindQuery } from '../src/ir/index.ts';
import { loadCatalog } from '../src/catalog.ts';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'scope-'));
const BASE = `CREATE SCHEMA shop;\nCREATE TABLE shop.t (id bigint PRIMARY KEY, k bigint NOT NULL, v text);\n`;
const DDL: [string, string][] = [
  ['ALTER TABLE', `${BASE}ALTER TABLE shop.t ADD COLUMN extra text;`],
  ['UNIQUE constraint (column)', `${BASE.replace('v text','v text UNIQUE')}`],
  ['UNIQUE constraint (table)', `${BASE}ALTER TABLE shop.t ADD CONSTRAINT u UNIQUE (k);`],
  ['UNIQUE index', `${BASE}CREATE UNIQUE INDEX i ON shop.t (k);`],
  ['generated column', `CREATE SCHEMA shop;\nCREATE TABLE shop.t (id bigint PRIMARY KEY, a int, b int GENERATED ALWAYS AS (a*2) STORED);`],
  ['identity column', `CREATE SCHEMA shop;\nCREATE TABLE shop.t (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);`],
  ['partitioned table', `CREATE SCHEMA shop;\nCREATE TABLE shop.t (id bigint, d date) PARTITION BY RANGE (d);`],
  ['CHECK constraint', `CREATE SCHEMA shop;\nCREATE TABLE shop.t (id bigint PRIMARY KEY, n int CHECK (n > 0));`],
  ['multi-schema', `CREATE SCHEMA a;\nCREATE SCHEMA b;\nCREATE TABLE a.x (id bigint PRIMARY KEY);\nCREATE TABLE b.y (id bigint PRIMARY KEY, xid bigint REFERENCES a.x(id));`],
  ['partial index', `${BASE}CREATE INDEX i ON shop.t (k) WHERE v IS NOT NULL;`],
  ['expression index', `${BASE}CREATE INDEX i ON shop.t (lower(v));`],
  ['INCLUDE index', `${BASE}CREATE INDEX i ON shop.t (k) INCLUDE (v);`],
  ['GIN index', `${BASE}CREATE INDEX i ON shop.t USING gin (v);`],
  ['CREATE VIEW', `${BASE}CREATE VIEW shop.vw AS SELECT id FROM shop.t;`],
  ['CREATE MATERIALIZED VIEW', `${BASE}CREATE MATERIALIZED VIEW shop.mv AS SELECT id FROM shop.t;`],
];
console.log('## Schema DDL');
for (const [name, sql] of DDL) {
  const p = join(dir, 'a.sql'); writeFileSync(p, sql);
  try { const c = await loadSchemaCatalog(p); console.log(`ACCEPT | ${name} | ${c.tables.length} table(s)`); }
  catch (e: any) { console.log(`REJECT | ${name} | ${String(e.message).slice(0,80)}`); }
}
const cat = await loadCatalog(new URL('../corpus/catalog.json', import.meta.url).pathname);
const Q: [string,string][] = [
  ['parameter $1', "SELECT * FROM shop.orders o WHERE o.customer_id = $1"],
  ['INSERT', 'INSERT INTO shop.orders (order_id) VALUES (1)'],
  ['UPDATE', 'UPDATE shop.orders SET status = %s'.replace('%s',"'x'")],
  ['DELETE', 'DELETE FROM shop.orders'],
  ['UNION', 'SELECT customer_id FROM shop.orders UNION SELECT customer_id FROM shop.customers'],
  ['window function', 'SELECT row_number() OVER (PARTITION BY customer_id) FROM shop.orders'],
  ['recursive CTE', 'WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n+1 FROM r WHERE n<5) SELECT n FROM r'],
  ['LATERAL', 'SELECT c.customer_id FROM shop.customers c JOIN LATERAL (SELECT o.order_id FROM shop.orders o WHERE o.customer_id=c.customer_id) t ON true'],
  ['GROUPING SETS', 'SELECT customer_id, count(*) FROM shop.orders GROUP BY GROUPING SETS ((customer_id),())'],
  ['DISTINCT ON', 'SELECT DISTINCT ON (customer_id) customer_id FROM shop.orders'],
];
console.log('\n## Queries');
for (const [name, sql] of Q) {
  try {
    const ir = bindQuery(sql, cat);
    const errs = (ir.bindingErrors??[]).filter((e:any)=>e.severity==='error').length;
    console.log(`${errs? 'BIND-ERR':'OK      '} | ${name} | type=${ir.statementType} errors=${errs}`);
  } catch (e:any) { console.log(`THROW    | ${name} | ${String(e.message).slice(0,60)}`); }
}
