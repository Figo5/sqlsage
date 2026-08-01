/**
 * Round-7 independent M7 probe: differential CREATE INDEX recognition against
 * PostgreSQL 16.14. Every ordinary statement targets transaction-local TEMP
 * objects inside BEGIN/ROLLBACK. CONCURRENTLY is never executed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { recognizeCreateIndexDdl } from '../../src/report/index-ddl.ts';

interface PgResult {
  executed: boolean;
  syntaxRejected: boolean;
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
  other_flag boolean,
  status text,
  note text,
  order_id bigint,
  payload jsonb,
  tags text[],
  vacuum text,
  between text,
  "Display Name" text,
  "select" text,
  "authorization" text,
  "st!0061tus" text
);
CREATE TEMP TABLE vacuum (flag boolean);
CREATE TEMP TABLE between (flag boolean);
${ddl}
ROLLBACK;
`;
  const result = spawnSync('docker', psqlArgs, { input: sql, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return {
    executed: result.status === 0,
    syntaxRejected: /syntax error at or near|zero-length delimited identifier|invalid Unicode (?:surrogate pair|escape value)|unterminated (?:quoted string|dollar-quoted string|\/\* comment)/i.test(output),
    output,
  };
}

function assertServerSyntaxReject(ddl: string): void {
  const pg = postgres(ddl);
  assert.equal(pg.executed, false, ddl);
  assert.equal(pg.syntaxRejected, true, `${ddl}\n${pg.output}`);
}

assert.equal(shopIndexCount(), 8, 'precondition: persistent shop schema has eight indexes');

// First rerun every Round-6 false accept. None may be hidden behind an early
// stale assertion: each recognizer rejection and each server rejection is
// checked, and all eight cases complete before this tranche reports success.
const savedRound6FalseAccepts = [
  'CREATE INDEX ix_bad_with_a ON probe_things (status) WITH (fillfactor 80);',
  'CREATE INDEX ix_bad_with_b ON probe_things (status) WITH (fillfactor = 80 extra);',
  'CREATE INDEX ix_bad_with_c ON probe_things (status) WITH (fillfactor == 80);',
  'CREATE INDEX ix_bad_predicate ON probe_things (status) WHERE status = ANY ();',
  'CREATE INDEX ix_bad_include ON probe_things (status) INCLUDE (select);',
  'CREATE INDEX ix_bad_tablespace ON probe_things (status) TABLESPACE select;',
  String.raw`CREATE INDEX ix_bad_u_string ON probe_things ((U&'\D800'));`,
  String.raw`CREATE INDEX ix_bad_u_ident ON probe_things (U&"st\D800atus");`,
];

for (const ddl of savedRound6FalseAccepts) {
  assert.equal(recognizeCreateIndexDdl(ddl).valid, false, `saved false accept survived: ${ddl}`);
  assertServerSyntaxReject(ddl);
}
console.log(`PASS all ${savedRound6FalseAccepts.length} saved Round-6 false accepts now reject in M7 and PostgreSQL`);

// Broad live-valid controls: this is intentionally wider than the focused
// unit fixture and proves ordinary execution, not merely parser agreement.
const broadLiveValid = [
  'CREATE INDEX ix_basic ON probe_things (flag);',
  'CREATE INDEX ON probe_things (status);',
  `CREATE UNIQUE INDEX IF NOT EXISTS "Ix Probe"
     ON ONLY probe_things USING btree
     ((lower("Display Name")) COLLATE "C" text_ops DESC NULLS LAST, status ASC)
     INCLUDE (order_id, payload, "select")
     NULLS NOT DISTINCT
     WITH (fillfactor = 80, deduplicate_items = on)
     TABLESPACE pg_default
     WHERE status IS NOT NULL;`,
  `CREATE/**/INDEX/**/ix_comments ON/**/probe_things
     ((coalesce(note, 'semi;colon')), ((tags)[1]))
     WHERE note <> $body$also;data$body$; -- trailing ; comment`,
  'CREATE INDEX ix_key_decorations ON probe_things (status COLLATE "C" text_ops DESC NULLS LAST);',
  'CREATE INDEX ix_expression ON probe_things ((payload ->> \'key\'), ((tags)[1]));',
  'CREATE INDEX ix_keyword_columns ON probe_things (status) INCLUDE (between, vacuum, "authorization");',
  `CREATE INDEX ix_quantifier ON probe_things (status)
     WHERE status = ANY (ARRAY['open', 'ready']);`,
  `CREATE INDEX ix_supported_strings ON probe_things (status)
     WITH (fillfactor = '80', deduplicate_items = $v$on$v$);`,
];

for (const ddl of broadLiveValid) {
  const recognized = recognizeCreateIndexDdl(ddl);
  assert.equal(recognized.valid, true, ddl);
  const pg = postgres(ddl);
  assert.equal(pg.executed, true, `${ddl}\n${pg.output}`);
}
console.log(`PASS ${broadLiveValid.length} broad live-valid PostgreSQL 16 controls`);

// Position-sensitive concurrency signal only. These are not sent to PostgreSQL.
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
console.log('PASS CONCURRENTLY derives only from grammar position; no concurrent DDL executed');

interface NeighborCase { label: string; ddl: string }

// A deliberately mixed neighborhood. PostgreSQL is authoritative: a
// recognizer accept plus a server syntax/lexical rejection is a soundness bug;
// a recognizer reject after PostgreSQL executes or reaches a catalog/option
// semantic error is a conservative false reject. All cases run before any
// aggregate assertion, so one counterexample cannot hide later evidence.
const neighbors: NeighborCase[] = [
  // WITH names, values, operators, commas, and quoted forms.
  { label: 'with-empty', ddl: 'CREATE INDEX ix_n01 ON probe_things (status) WITH ();' },
  { label: 'with-name-only', ddl: 'CREATE INDEX ix_n02 ON probe_things (status) WITH (deduplicate_items);' },
  { label: 'with-missing-name', ddl: 'CREATE INDEX ix_n03 ON probe_things (status) WITH (= 80);' },
  { label: 'with-missing-value', ddl: 'CREATE INDEX ix_n04 ON probe_things (status) WITH (fillfactor =);' },
  { label: 'with-leading-comma', ddl: 'CREATE INDEX ix_n05 ON probe_things (status) WITH (, fillfactor = 80);' },
  { label: 'with-trailing-comma', ddl: 'CREATE INDEX ix_n06 ON probe_things (status) WITH (fillfactor = 80,);' },
  { label: 'with-double-comma', ddl: 'CREATE INDEX ix_n07 ON probe_things (status) WITH (fillfactor = 80,, deduplicate_items = on);' },
  { label: 'with-arrow-operator', ddl: 'CREATE INDEX ix_n08 ON probe_things (status) WITH (fillfactor => 80);' },
  { label: 'with-three-equals', ddl: 'CREATE INDEX ix_n09 ON probe_things (status) WITH (fillfactor === 80);' },
  { label: 'with-extra-value', ddl: 'CREATE INDEX ix_n10 ON probe_things (status) WITH (fillfactor = 80 90);' },
  { label: 'with-parenthesized-value', ddl: 'CREATE INDEX ix_n11 ON probe_things (status) WITH (fillfactor = (80));' },
  { label: 'with-qualified-name', ddl: 'CREATE INDEX ix_n12 ON probe_things (status) WITH (foo.bar = 1);' },
  { label: 'with-comment-separated-equals', ddl: 'CREATE INDEX ix_n13 ON probe_things (status) WITH (fillfactor /*a*/ = /*b*/ 80);' },
  { label: 'with-quoted-reserved-name', ddl: 'CREATE INDEX ix_n14 ON probe_things (status) WITH ("select" = 1);' },
  { label: 'with-unquoted-reserved-name', ddl: 'CREATE INDEX ix_n15 ON probe_things (status) WITH (select = 1);' },
  { label: 'with-decimal', ddl: 'CREATE INDEX ix_n16 ON probe_things (status) WITH (fillfactor = 80.0);' },
  { label: 'with-leading-decimal', ddl: 'CREATE INDEX ix_n17 ON probe_things (status) WITH (fillfactor = .8);' },
  { label: 'with-positive-sign', ddl: 'CREATE INDEX ix_n18 ON probe_things (status) WITH (fillfactor = +80);' },
  { label: 'with-negative-sign', ddl: 'CREATE INDEX ix_n19 ON probe_things (status) WITH (fillfactor = -1);' },
  { label: 'with-exponent', ddl: 'CREATE INDEX ix_n20 ON probe_things (status) WITH (fillfactor = 8e1);' },
  { label: 'with-signed-exponent', ddl: 'CREATE INDEX ix_n21 ON probe_things (status) WITH (fillfactor = 8e+1);' },
  { label: 'with-dollar-adjacent', ddl: 'CREATE INDEX ix_n22 ON probe_things (status) WITH (deduplicate_items=$v$on$v$);' },

  // Keyword categories across name positions and key expressions.
  { label: 'index-unreserved', ddl: 'CREATE INDEX vacuum ON probe_things (status);' },
  { label: 'index-col-name-keyword', ddl: 'CREATE INDEX between ON probe_things (status);' },
  { label: 'index-type-function-keyword', ddl: 'CREATE INDEX authorization ON probe_things (status);' },
  { label: 'index-reserved', ddl: 'CREATE INDEX select ON probe_things (status);' },
  { label: 'index-quoted-reserved', ddl: 'CREATE INDEX "select" ON probe_things (status);' },
  { label: 'table-unreserved', ddl: 'CREATE INDEX ix_n28 ON vacuum (flag);' },
  { label: 'table-col-name-keyword', ddl: 'CREATE INDEX ix_n29 ON between (flag);' },
  { label: 'table-type-function-keyword', ddl: 'CREATE INDEX ix_n30 ON authorization (flag);' },
  { label: 'table-reserved', ddl: 'CREATE INDEX ix_n31 ON select (flag);' },
  { label: 'method-unreserved', ddl: 'CREATE INDEX ix_n32 ON probe_things USING vacuum (status);' },
  { label: 'method-col-name-keyword', ddl: 'CREATE INDEX ix_n33 ON probe_things USING between (status);' },
  { label: 'method-type-function-keyword', ddl: 'CREATE INDEX ix_n34 ON probe_things USING authorization (status);' },
  { label: 'method-reserved', ddl: 'CREATE INDEX ix_n35 ON probe_things USING select (status);' },
  { label: 'include-unreserved', ddl: 'CREATE INDEX ix_n36 ON probe_things (status) INCLUDE (vacuum);' },
  { label: 'include-col-name-keyword', ddl: 'CREATE INDEX ix_n37 ON probe_things (status) INCLUDE (between);' },
  { label: 'include-type-function-keyword', ddl: 'CREATE INDEX ix_n38 ON probe_things (status) INCLUDE (authorization);' },
  { label: 'include-reserved', ddl: 'CREATE INDEX ix_n39 ON probe_things (status) INCLUDE (select);' },
  { label: 'include-quoted-reserved', ddl: 'CREATE INDEX ix_n40 ON probe_things (status) INCLUDE ("select", "authorization");' },
  { label: 'tablespace-unreserved', ddl: 'CREATE INDEX ix_n41 ON probe_things (status) TABLESPACE vacuum;' },
  { label: 'tablespace-col-name-keyword', ddl: 'CREATE INDEX ix_n42 ON probe_things (status) TABLESPACE between;' },
  { label: 'tablespace-type-function-keyword', ddl: 'CREATE INDEX ix_n43 ON probe_things (status) TABLESPACE authorization;' },
  { label: 'tablespace-reserved', ddl: 'CREATE INDEX ix_n44 ON probe_things (status) TABLESPACE select;' },
  { label: 'tablespace-quoted-reserved', ddl: 'CREATE INDEX ix_n45 ON probe_things (status) TABLESPACE "select";' },
  { label: 'key-unreserved', ddl: 'CREATE INDEX ix_n46 ON probe_things (vacuum);' },
  { label: 'key-col-name-keyword', ddl: 'CREATE INDEX ix_n47 ON probe_things (between);' },
  { label: 'key-type-function-keyword', ddl: 'CREATE INDEX ix_n48 ON probe_things (authorization);' },
  { label: 'key-reserved', ddl: 'CREATE INDEX ix_n49 ON probe_things (select);' },
  { label: 'key-quoted-reserved', ddl: 'CREATE INDEX ix_n50 ON probe_things ("select", "authorization");' },

  // Empty quantifiers, including nested/comment-separated spellings and
  // legitimate empty-array expressions that are not empty syntax.
  { label: 'where-any-empty-comment', ddl: 'CREATE INDEX ix_n51 ON probe_things (status) WHERE status = ANY (/*empty*/);' },
  { label: 'where-all-empty-nested', ddl: 'CREATE INDEX ix_n52 ON probe_things (status) WHERE status = ALL (( ));' },
  { label: 'where-some-empty-deep', ddl: 'CREATE INDEX ix_n53 ON probe_things (status) WHERE status = SOME (((/*empty*/)));' },
  { label: 'key-any-empty-comment', ddl: 'CREATE INDEX ix_n54 ON probe_things (((status = ANY (/*empty*/))));' },
  { label: 'key-all-empty-nested', ddl: 'CREATE INDEX ix_n55 ON probe_things (((status = ALL (( )))));' },
  { label: 'where-any-empty-array', ddl: 'CREATE INDEX ix_n56 ON probe_things (status) WHERE status = ANY (ARRAY[]::text[]);' },
  { label: 'key-some-nonempty', ddl: "CREATE INDEX ix_n57 ON probe_things (((status = SOME (ARRAY['open']))));" },

  // Malformed clauses, ordering, key decorations, and predicates.
  { label: 'include-empty', ddl: 'CREATE INDEX ix_n58 ON probe_things (status) INCLUDE ();' },
  { label: 'include-expression', ddl: 'CREATE INDEX ix_n59 ON probe_things (status) INCLUDE (lower(note));' },
  { label: 'include-qualified', ddl: 'CREATE INDEX ix_n60 ON probe_things (status) INCLUDE (probe_things.note);' },
  { label: 'include-trailing-comma', ddl: 'CREATE INDEX ix_n61 ON probe_things (status) INCLUDE (note,);' },
  { label: 'nulls-incomplete', ddl: 'CREATE INDEX ix_n62 ON probe_things (status) NULLS;' },
  { label: 'nulls-not-incomplete', ddl: 'CREATE INDEX ix_n63 ON probe_things (status) NULLS NOT;' },
  { label: 'nulls-wrong-order', ddl: 'CREATE INDEX ix_n64 ON probe_things (status) NULLS DISTINCT NOT;' },
  { label: 'nulls-duplicate', ddl: 'CREATE INDEX ix_n65 ON probe_things (status) NULLS DISTINCT NULLS NOT DISTINCT;' },
  { label: 'with-before-include', ddl: 'CREATE INDEX ix_n66 ON probe_things (status) WITH (fillfactor = 80) INCLUDE (note);' },
  { label: 'tablespace-before-with', ddl: 'CREATE INDEX ix_n67 ON probe_things (status) TABLESPACE pg_default WITH (fillfactor = 80);' },
  { label: 'where-before-include', ddl: 'CREATE INDEX ix_n68 ON probe_things (status) WHERE flag INCLUDE (note);' },
  { label: 'where-empty', ddl: 'CREATE INDEX ix_n69 ON probe_things (status) WHERE;' },
  { label: 'where-dangling-equals', ddl: 'CREATE INDEX ix_n70 ON probe_things (status) WHERE status =;' },
  { label: 'where-dangling-and', ddl: 'CREATE INDEX ix_n71 ON probe_things (status) WHERE flag AND;' },
  { label: 'where-comma', ddl: 'CREATE INDEX ix_n72 ON probe_things (status) WHERE flag, other_flag;' },
  { label: 'key-empty', ddl: 'CREATE INDEX ix_n73 ON probe_things ();' },
  { label: 'key-leading-comma', ddl: 'CREATE INDEX ix_n74 ON probe_things (, status);' },
  { label: 'key-trailing-comma', ddl: 'CREATE INDEX ix_n75 ON probe_things (status,);' },
  { label: 'key-double-decoration', ddl: 'CREATE INDEX ix_n76 ON probe_things (status DESC ASC);' },
  { label: 'key-missing-collation', ddl: 'CREATE INDEX ix_n77 ON probe_things (status COLLATE);' },
  { label: 'key-dangling-operator', ddl: 'CREATE INDEX ix_n78 ON probe_things ((status ||));' },
  { label: 'opclass-parameter-grammar', ddl: 'CREATE INDEX ix_n79 ON probe_things (status text_ops (foo = 1));' },

  // Quotes, dollar quotes, comments, semicolons, and trailing payload.
  { label: 'empty-index-ident', ddl: 'CREATE INDEX "" ON probe_things (status);' },
  { label: 'empty-table-ident', ddl: 'CREATE INDEX ix_n81 ON "" (status);' },
  { label: 'empty-method-ident', ddl: 'CREATE INDEX ix_n82 ON probe_things USING "" (status);' },
  { label: 'empty-key-ident', ddl: 'CREATE INDEX ix_n83 ON probe_things ("");' },
  { label: 'empty-collation-ident', ddl: 'CREATE INDEX ix_n84 ON probe_things (status COLLATE "");' },
  { label: 'unterminated-ordinary-string', ddl: "CREATE INDEX ix_n85 ON probe_things ((coalesce(note, 'unterminated));" },
  { label: 'unterminated-dollar', ddl: 'CREATE INDEX ix_n86 ON probe_things ((coalesce(note, $q$unterminated));' },
  { label: 'unterminated-comment', ddl: 'CREATE INDEX ix_n87 ON probe_things (status); /* unterminated' },
  { label: 'second-statement', ddl: 'CREATE INDEX ix_n88 ON probe_things (status); SELECT FROM;' },
  { label: 'extra-semicolon', ddl: 'CREATE INDEX ix_n89 ON probe_things (status); ;' },
  { label: 'lf-comment-payload', ddl: 'CREATE INDEX ix_n90 ON probe_things (status); -- comment\nSELECT FROM;' },
  { label: 'cr-comment-payload', ddl: 'CREATE INDEX ix_n91 ON probe_things (status); -- comment\rSELECT FROM;' },
  { label: 'dollar-adjacent-predicate', ddl: 'CREATE INDEX ix_n92 ON probe_things (status) WHERE note=$q$data$q$;' },
  { label: 'json-dollar-adjacent', ddl: "CREATE INDEX ix_n93 ON probe_things ((payload->>$q$key$q$));" },

  // Valid and invalid escape/Unicode spellings. The valid forms are expected
  // conservative false rejects; malformed surrogate escapes must reject on
  // both sides.
  { label: 'valid-e-string-key', ddl: String.raw`CREATE INDEX ix_n94 ON probe_things ((E'data\x21'));` },
  { label: 'valid-e-string-predicate', ddl: String.raw`CREATE INDEX ix_n95 ON probe_things (status) WHERE note = E'data\x21';` },
  { label: 'valid-lower-e-string', ddl: String.raw`CREATE INDEX ix_n96 ON probe_things ((e'data\x21'));` },
  { label: 'valid-u-string', ddl: String.raw`CREATE INDEX ix_n97 ON probe_things ((U&'d\0061ta'));` },
  { label: 'valid-u-ident', ddl: String.raw`CREATE INDEX ix_n98 ON probe_things (U&"st!0061tus" UESCAPE '!');` },
  { label: 'invalid-u-string-surrogate', ddl: String.raw`CREATE INDEX ix_n99 ON probe_things ((U&'\D800'));` },
  { label: 'invalid-u-ident-surrogate', ddl: String.raw`CREATE INDEX ix_n100 ON probe_things (U&"st\D800atus");` },
];

const falseAccepts: Array<{ label: string; ddl: string; output: string }> = [];
const safeFalseRejects: Array<{ label: string; ddl: string; server: 'executed' | 'semantic-error' }> = [];
const agreementRejects: string[] = [];
const acceptedOrSemantic: string[] = [];
for (const entry of neighbors) {
  const recognized = recognizeCreateIndexDdl(entry.ddl).valid;
  const pg = postgres(entry.ddl);
  if (recognized && pg.syntaxRejected) {
    falseAccepts.push({ label: entry.label, ddl: entry.ddl, output: pg.output });
  } else if (!recognized && !pg.syntaxRejected) {
    safeFalseRejects.push({ label: entry.label, ddl: entry.ddl, server: pg.executed ? 'executed' : 'semantic-error' });
  } else if (!recognized && pg.syntaxRejected) {
    agreementRejects.push(entry.label);
  } else {
    acceptedOrSemantic.push(entry.label);
  }
}

console.log(`MATRIX ${neighbors.length} neighbors: falseAccepts=${falseAccepts.length} safeFalseRejects=${safeFalseRejects.length} agreementRejects=${agreementRejects.length} acceptedOrSemantic=${acceptedOrSemantic.length}`);
for (const entry of falseAccepts) console.log(`FALSE_ACCEPT ${entry.label}: ${JSON.stringify(entry.ddl)}`);
for (const entry of safeFalseRejects) console.log(`SAFE_FALSE_REJECT ${entry.server} ${entry.label}`);

// Re-prove the CR disagreement through one raw -c command so it is the backend
// parser, not psql's file/statement splitter, that exposes the second statement.
{
  const ddl = 'CREATE INDEX ix_cr_raw ON probe_things (status); -- comment\rSELECT FROM;';
  const sql = `BEGIN; CREATE TEMP TABLE probe_things(status text); ${ddl} ROLLBACK;`;
  const result = spawnSync(
    'docker',
    ['exec', 'sqlsage-pg', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'sage', '-c', sql],
    { encoding: 'utf8' },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /syntax error at or near/i);
  assert.equal(recognizeCreateIndexDdl(ddl).valid, true);
  console.log('DEFECT raw PostgreSQL backend parse confirms bare CR ends the comment and exposes statement 2');
}

// Local runtime text guards that cannot be transported losslessly through the
// process boundary are still direct recognizer requirements.
for (const ddl of [
  `CREATE INDEX ix_bad_utf16 ON probe_things ("${String.fromCharCode(0xd800)}");`,
  'CREATE INDEX ix_bad_nul ON probe_things (status);\0SELECT FROM;',
]) {
  assert.equal(recognizeCreateIndexDdl(ddl).valid, false, 'ill-formed UTF-16/NUL must reject');
}
console.log('PASS ill-formed UTF-16 and NUL reject locally');

assert.equal(shopIndexCount(), 8, 'checkpoint: persistent shop schema still has eight indexes');
console.log('PASS full Round-7 matrix completed; persistent shop index count remains exactly eight');
assert.equal(falseAccepts.length, 0, `PostgreSQL syntax false accepts remain: ${falseAccepts.map((entry) => entry.label).join(', ')}`);
