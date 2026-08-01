/**
 * Round-6 independent M7 probe: compare CREATE INDEX recognition with the
 * PostgreSQL 16.14 server grammar. Ordinary statements run only against a
 * TEMP table inside BEGIN/ROLLBACK. No persistent index is created.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { recognizeCreateIndexDdl } from '../../src/report/index-ddl.ts';

interface PgResult {
  executed: boolean;
  syntaxError: boolean;
  output: string;
}

const psqlArgs = [
  'exec', '-i', 'sqlsage-pg', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
  '-U', 'postgres', '-d', 'sage', '-f', '-',
];

function shopIndexCount(): number {
  const result = spawnSync(
    'docker',
    ['exec', 'sqlsage-pg', 'psql', '-X', '-U', 'postgres', '-d', 'sage', '-Atc',
      "SELECT count(*) FROM pg_indexes WHERE schemaname='shop';"],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim());
}

function postgres(ddl: string): PgResult {
  const sql = `
BEGIN;
CREATE TEMP TABLE probe_things (
  flag boolean,
  status text,
  note text,
  order_id bigint,
  payload jsonb,
  tags text[],
  "Display Name" text,
  "st!0061tus" text
);
${ddl}
ROLLBACK;
`;
  const result = spawnSync('docker', psqlArgs, { input: sql, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return {
    executed: result.status === 0,
    syntaxError: /syntax error at or near/i.test(output),
    output,
  };
}

assert.equal(shopIndexCount(), 8, 'precondition: persistent shop schema has eight indexes');

// Broad accepted family: every statement both passes the recognizer and is
// executed by PG16 on the transaction-local TEMP object.
const accepted = [
  'CREATE INDEX ix_basic ON probe_things (flag);',
  'CREATE INDEX ON probe_things (status);',
  `CREATE UNIQUE INDEX IF NOT EXISTS "Ix Probe"
     ON ONLY probe_things USING btree
     ((lower("Display Name")) COLLATE "C" text_ops DESC NULLS LAST, status ASC)
     INCLUDE (order_id, payload)
     NULLS NOT DISTINCT
     WITH (fillfactor = 80, deduplicate_items = on)
     TABLESPACE pg_default
     WHERE status IS NOT NULL;`,
  `CREATE/**/INDEX/**/ix_comments ON/**/probe_things
     ((coalesce(note, 'semi;colon')), ((tags)[1]))
     WHERE note <> $body$also;data$body$; -- trailing ; comment`,
  'CREATE INDEX ix_key_decorations ON probe_things (status COLLATE "C" text_ops DESC NULLS LAST);',
  'CREATE INDEX ix_expression ON probe_things ((payload ->> \'key\'), ((tags)[1]));',
];

for (const ddl of accepted) {
  const recognized = recognizeCreateIndexDdl(ddl);
  assert.equal(recognized.valid, true, ddl);
  const pg = postgres(ddl);
  assert.equal(pg.executed, true, `${ddl}\n${pg.output}`);
}
console.log(`PASS ${accepted.length} regular/unnamed/unique/quoted/expression/INCLUDE/partial/options PG16 forms`);

// PG16 rejects schema-qualified index names. The secondary parser currently
// catches this despite the lexer's permissive qualifiedIdentifier helper.
{
  const ddl = 'CREATE INDEX generic.ix_qualified ON probe_things (status);';
  assert.equal(recognizeCreateIndexDdl(ddl).valid, false);
  const pg = postgres(ddl);
  assert.equal(pg.executed, false);
  assert.equal(pg.syntaxError, true);
}
console.log('PASS schema-qualified index names are rejected with PostgreSQL 16');

// Soundness defects: these payloads pass recognition even though PG16 rejects
// their grammar. WITH is omitted from the normalized parser core, and its local
// check treats arbitrary expression-like token runs as storage parameters.
const falseAccepts = [
  'CREATE INDEX ix_bad_with_a ON probe_things (status) WITH (fillfactor 80);',
  'CREATE INDEX ix_bad_with_b ON probe_things (status) WITH (fillfactor = 80 extra);',
  'CREATE INDEX ix_bad_with_c ON probe_things (status) WITH (fillfactor == 80);',
  'CREATE INDEX ix_bad_predicate ON probe_things (status) WHERE status = ANY ();',
  'CREATE INDEX ix_bad_include ON probe_things (status) INCLUDE (select);',
  'CREATE INDEX ix_bad_tablespace ON probe_things (status) TABLESPACE select;',
];

for (const ddl of falseAccepts) {
  assert.equal(recognizeCreateIndexDdl(ddl).valid, true, `recognizer defect changed: ${ddl}`);
  const pg = postgres(ddl);
  assert.equal(pg.executed, false, ddl);
  assert.equal(pg.syntaxError, true, `${ddl}\n${pg.output}`);
}
console.log(`DEFECT ${falseAccepts.length} recognizer-accepted payloads are PostgreSQL 16 syntax errors`);

// Unicode escape validity is lost when U& strings/identifiers are normalized.
// PG rejects an unpaired surrogate before any catalog/object check.
for (const ddl of [
  String.raw`CREATE INDEX ix_bad_u_string ON probe_things ((U&'\D800'));`,
  String.raw`CREATE INDEX ix_bad_u_ident ON probe_things (U&"st\D800atus");`,
]) {
  assert.equal(recognizeCreateIndexDdl(ddl).valid, true, ddl);
  const pg = postgres(ddl);
  assert.equal(pg.executed, false, ddl);
  assert.match(pg.output, /invalid Unicode surrogate pair/i, ddl);
}
console.log('DEFECT invalid Unicode escape payloads are normalized into recognizer acceptance');

// Completeness defect: PG16's documented key grammar allows opclass parameters.
// The server parses this and reaches an operator-class semantic check, while the
// bundled secondary parser rejects the grammar before M7 can distinguish it.
{
  const ddl = 'CREATE INDEX ix_opclass_parameter ON probe_things (status text_ops (foo = 1));';
  assert.equal(recognizeCreateIndexDdl(ddl).valid, false);
  const pg = postgres(ddl);
  assert.equal(pg.executed, false);
  assert.equal(pg.syntaxError, false, pg.output);
  assert.match(pg.output, /operator class text_ops has no options/i);
}
console.log('DEFECT valid PG16 opclass-parameter grammar is conservatively rejected');

// A fully executable Unicode-escape identifier with an explicit UESCAPE clause
// is also valid PG16 grammar but rejected by the normalized secondary parser.
{
  const ddl = String.raw`CREATE INDEX ix_uescape ON probe_things (U&"st!0061tus" UESCAPE '!');`;
  assert.equal(recognizeCreateIndexDdl(ddl).valid, false);
  const pg = postgres(ddl);
  assert.equal(pg.executed, true, pg.output);
}
console.log('DEFECT legitimate U& identifier + UESCAPE syntax is rejected');

// CONCURRENTLY must not execute in this probe. The server's own \h grammar was
// checked separately; here only the recognizer's grammar-position signal is
// asserted against comment/string/identifier decoys.
for (const [ddl, expected] of [
  ['CREATE INDEX CONCURRENTLY ix_live ON probe_things (status);', true],
  ['CREATE INDEX ix_comment ON probe_things (status); -- CONCURRENTLY', false],
  ['CREATE INDEX "concurrently" ON probe_things (status);', false],
  ["CREATE INDEX ix_string ON probe_things ((coalesce(note, 'concurrently')));", false],
] as const) {
  const result = recognizeCreateIndexDdl(ddl);
  assert.equal(result.valid, true, ddl);
  if (result.valid) assert.equal(result.concurrently, expected, ddl);
}
console.log('PASS CONCURRENTLY derives only from its grammar position; no concurrent DDL executed');

assert.equal(shopIndexCount(), 8, 'postcondition: persistent shop schema still has eight indexes');
console.log('PASS persistent shop index count remains exactly eight');
