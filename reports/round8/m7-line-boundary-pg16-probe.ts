/**
 * Round-8 independent critic probe: PostgreSQL 16 statement identity across
 * LF, CRLF, bare CR, and adjacent lexical contexts.
 *
 * Every CREATE INDEX targets a transaction-local TEMP table and is rolled
 * back. CREATE INDEX CONCURRENTLY is deliberately absent. All cases execute
 * before aggregate assertions so one disagreement cannot hide the rest.
 */
import assert from 'node:assert/strict';
import pg from 'pg';

import { CONN } from '../../src/db.ts';
import { recognizeCreateIndexDdl } from '../../src/report/index-ddl.ts';

type ServerExpectation = 'accept-one' | 'accept-two' | 'syntax-reject';

interface BoundaryCase {
  label: string;
  ddl: string;
  server: ServerExpectation;
  recognizer: boolean;
}

interface Observation {
  label: string;
  recognized: boolean;
  serverAccepted: boolean;
  serverCode?: string;
  tempIndexCount?: number;
  expected: BoundaryCase;
}

const endings = [
  { label: 'lf', value: '\n' },
  { label: 'crlf', value: '\r\n' },
  { label: 'cr', value: '\r' },
] as const;

const cases: BoundaryCase[] = [];
for (const ending of endings) {
  const e = ending.value;
  const suffix = ending.label;
  cases.push(
    {
      label: `${suffix}-trailing-comment`,
      ddl: `CREATE INDEX ix_${suffix}_trailing ON m7_line_boundary (flag); -- trailing${e}`,
      server: 'accept-one',
      recognizer: true,
    },
    {
      label: `${suffix}-leading-comment`,
      ddl: `-- leading${e}CREATE INDEX ix_${suffix}_leading ON m7_line_boundary (flag);`,
      server: 'accept-one',
      recognizer: true,
    },
    {
      label: `${suffix}-inter-token-comment`,
      ddl: `CREATE -- inter-token${e}INDEX ix_${suffix}_inter ON m7_line_boundary (flag);`,
      server: 'accept-one',
      recognizer: true,
    },
    {
      label: `${suffix}-payload-after-terminated-statement`,
      ddl: `CREATE INDEX ix_${suffix}_payload_a ON m7_line_boundary (flag); -- comment${e}SELECT FROM;`,
      server: 'syntax-reject',
      recognizer: false,
    },
    {
      label: `${suffix}-payload-without-semicolon`,
      ddl: `CREATE INDEX ix_${suffix}_payload_b ON m7_line_boundary (flag) -- comment${e}SELECT FROM;`,
      server: 'syntax-reject',
      recognizer: false,
    },
    {
      label: `${suffix}-second-valid-statement`,
      ddl:
        `CREATE INDEX ix_${suffix}_first ON m7_line_boundary (flag); -- comment${e}` +
        `CREATE INDEX ix_${suffix}_second ON m7_line_boundary (note);`,
      server: 'accept-two',
      recognizer: false,
    },
    {
      label: `${suffix}-ordinary-string-protected`,
      ddl:
        `CREATE INDEX ix_${suffix}_string ON m7_line_boundary ` +
        `((coalesce(note, '-- comment${e}SELECT FROM;')));`,
      server: 'accept-one',
      recognizer: true,
    },
    {
      label: `${suffix}-dollar-string-protected`,
      ddl:
        `CREATE INDEX ix_${suffix}_dollar ON m7_line_boundary ` +
        `((coalesce(note, $payload$-- comment${e}SELECT FROM;$payload$)));`,
      server: 'accept-one',
      recognizer: true,
    },
    {
      label: `${suffix}-block-comment-protected`,
      ddl:
        `CREATE INDEX ix_${suffix}_block ON m7_line_boundary ` +
        `(flag /* -- comment${e}SELECT FROM; */);`,
      server: 'accept-one',
      recognizer: true,
    },
    {
      label: `${suffix}-nested-block-comment-protected`,
      ddl:
        `CREATE /* outer /* -- comment${e}SELECT FROM; */ still outer */ ` +
        `INDEX ix_${suffix}_nested ON m7_line_boundary (flag);`,
      server: 'accept-one',
      recognizer: true,
    },
    {
      label: `${suffix}-quoted-identifier-protected`,
      ddl:
        `CREATE INDEX "ix_${suffix}--comment${e}SELECT FROM" ` +
        `ON m7_line_boundary (flag);`,
      server: 'accept-one',
      recognizer: true,
    },
    {
      label: `${suffix}-consecutive-comments-expose-payload`,
      ddl:
        `CREATE INDEX ix_${suffix}_comments ON m7_line_boundary (flag); ` +
        `-- first${e}-- second${e}SELECT FROM;`,
      server: 'syntax-reject',
      recognizer: false,
    },
  );
}

// Adjacent Unicode/control whitespace is not a PostgreSQL line-comment
// terminator. Both sides should keep the apparent payload inside the comment.
for (const boundary of [
  { label: 'nel', value: '\u0085' },
  { label: 'line-separator', value: '\u2028' },
  { label: 'paragraph-separator', value: '\u2029' },
  { label: 'form-feed', value: '\f' },
  { label: 'vertical-tab', value: '\v' },
]) {
  cases.push({
    label: `${boundary.label}-is-not-comment-ending`,
    ddl:
      `CREATE INDEX ix_${boundary.label.replace(/-/g, '_')} ON m7_line_boundary (flag); ` +
      `-- comment${boundary.value}SELECT FROM;`,
    server: 'accept-one',
    recognizer: true,
  });
}

// Mixed real line endings must stop at the first CR/LF and expose payload.
for (const boundary of [
  { label: 'cr-cr', value: '\r\r' },
  { label: 'lf-cr', value: '\n\r' },
  { label: 'crlf-cr', value: '\r\n\r' },
]) {
  cases.push({
    label: `${boundary.label}-exposes-payload`,
    ddl:
      `CREATE INDEX ix_${boundary.label.replace(/-/g, '_')} ON m7_line_boundary (flag); ` +
      `-- comment${boundary.value}SELECT FROM;`,
    server: 'syntax-reject',
    recognizer: false,
  });
}

assert.ok(cases.length >= 40);
assert.equal(cases.some((entry) => /CONCURRENTLY/i.test(entry.ddl)), false);

const client = new pg.Client(CONN);
await client.connect();

async function shopIndexCount(): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM pg_indexes WHERE schemaname = 'shop'",
  );
  return Number(result.rows[0]?.count);
}

const startCount = await shopIndexCount();
const observations: Observation[] = [];

for (const entry of cases) {
  await client.query('BEGIN');
  await client.query('CREATE TEMP TABLE m7_line_boundary(flag boolean, note text) ON COMMIT DROP');
  const recognized = recognizeCreateIndexDdl(entry.ddl).valid;
  let serverAccepted = false;
  let serverCode: string | undefined;
  let tempIndexCount: number | undefined;
  try {
    await client.query(entry.ddl);
    serverAccepted = true;
    const count = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_class rel ON rel.oid = i.indrelid
      WHERE rel.relname = 'm7_line_boundary'
    `);
    tempIndexCount = Number(count.rows[0]?.count);
  } catch (error) {
    const pgError = error as { code?: string };
    serverCode = pgError.code;
  } finally {
    await client.query('ROLLBACK');
  }
  observations.push({
    label: entry.label,
    recognized,
    serverAccepted,
    serverCode,
    tempIndexCount,
    expected: entry,
  });
}

const endCount = await shopIndexCount();
await client.end();

// Aggregate only after every live case has run.
const failures: string[] = [];
for (const result of observations) {
  if (result.recognized !== result.expected.recognizer) {
    failures.push(`${result.label}: recognizer=${result.recognized}, expected=${result.expected.recognizer}`);
  }
  if (result.expected.server === 'syntax-reject') {
    if (result.serverAccepted || result.serverCode !== '42601') {
      failures.push(
        `${result.label}: serverAccepted=${result.serverAccepted}, code=${result.serverCode ?? 'none'}, expected syntax 42601`,
      );
    }
  } else {
    const expectedCount = result.expected.server === 'accept-two' ? 2 : 1;
    if (!result.serverAccepted || result.tempIndexCount !== expectedCount) {
      failures.push(
        `${result.label}: serverAccepted=${result.serverAccepted}, indexes=${result.tempIndexCount ?? 'none'}, expected=${expectedCount}`,
      );
    }
  }
}
if (startCount !== 8 || endCount !== 8) {
  failures.push(`persistent shop index count ${startCount} -> ${endCount}, expected 8 -> 8`);
}

const accepted = observations.filter((entry) => entry.serverAccepted).length;
const rejected = observations.length - accepted;
const recognized = observations.filter((entry) => entry.recognized).length;
console.log(
  `MATRIX cases=${observations.length} serverAccepted=${accepted} serverSyntaxRejected=${rejected} ` +
  `recognizerAccepted=${recognized} failures=${failures.length}`,
);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(`SHOP_INDEXES ${startCount} -> ${endCount}`);

assert.deepEqual(failures, []);
console.log('PASS LF, CRLF, bare-CR, protected lexical neighbors, and non-boundary controls agree with PostgreSQL 16');

