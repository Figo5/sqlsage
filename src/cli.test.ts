import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('./cli.ts', import.meta.url).pathname;
const CATALOG = new URL('../corpus/catalog.json', import.meta.url).pathname;
const SCHEMA = new URL('../corpus/schema.sql', import.meta.url).pathname;
const Q01_PLAN = new URL('../groundtruth/q01-nonsargable-date.json', import.meta.url).pathname;
const Q10_PLAN = new URL('../groundtruth/q10-having-instead-of-where.json', import.meta.url).pathname;

function run(args: string[], input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('process CLI exposes help/version without loading a query', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /sqlsage analyze --query/);
  assert.match(help.stdout, /Exit codes/);
  assert.match(help.stdout, /--analyze executes the SELECT/);
  assert.match(help.stdout, /external\s+side effects.*volatile function/is);
  assert.equal(help.stderr, '');

  const version = run(['--version']);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^0\.1\.0\s*$/);
});

test('ordinary usage and file errors are concise and never leak a stack trace', () => {
  const unknown = run(['analyze', '--wat']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown option --wat/);
  assert.doesNotMatch(unknown.stderr, /\n\s+at /);

  const missing = run(['analyze', '--query', '/definitely/not/a/query.sql', '--catalog', CATALOG]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /file not found/);
  assert.doesNotMatch(missing.stderr, /\n\s+at /);
});

test('piped SQL is recognized as the query source', () => {
  const result = run(['analyze', '--catalog', CATALOG, '--format', 'json'], 'SELECT customer_id FROM shop.customers LIMIT 1;');
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.complete, true);
  assert.deepEqual(output.analysis.missingModules, undefined);
  assert.doesNotMatch(result.stdout, /INCOMPLETE ANALYSIS —/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('a query file completes the primary offline text workflow', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sqlsage-cli-'));
  const queryPath = join(directory, 'query.sql');
  try {
    writeFileSync(queryPath, `SELECT customer_id, email
      FROM shop.customers
      WHERE loyalty_tier = 'gold';\n`);
    const result = run(['analyze', '--query', queryPath, '--catalog', CATALOG, '--format', 'text', '--no-color']);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /SQLSage analysis/);
    assert.match(result.stdout, /Result grain/);
    assert.doesNotMatch(result.stdout, /\u001b\[/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('malformed and unsupported SQL are blocked without a stack trace', () => {
  const malformed = run(['analyze', '--sql', 'SELECT FROM', '--catalog', CATALOG, '--format', 'json']);
  assert.equal(malformed.status, 2);
  const blocked = JSON.parse(malformed.stdout);
  assert.equal(blocked.complete, false);
  assert.equal(blocked.verdict.kind, 'incomplete');
  assert.match(malformed.stderr, /only SELECT statements are supported|schema-binding error/i);
  assert.doesNotMatch(malformed.stderr, /\n\s+at /);

  const nonSelect = run(['analyze', '--sql', 'DELETE FROM shop.customers', '--catalog', CATALOG]);
  assert.equal(nonSelect.status, 2);
  assert.match(nonSelect.stdout, /ANALYSIS INCOMPLETE/);
  assert.doesNotMatch(nonSelect.stdout, /NO PERFORMANCE ACTION|NO ACTION NEEDED/);
  assert.match(nonSelect.stderr, /only SELECT statements are supported/i);
  assert.doesNotMatch(nonSelect.stderr, /\n\s+at /);

  const nonSelectJson = run(['analyze', '--sql', 'DELETE FROM shop.customers', '--catalog', CATALOG, '--format', 'json']);
  assert.equal(nonSelectJson.status, 2);
  const blockedDelete = JSON.parse(nonSelectJson.stdout);
  assert.equal(blockedDelete.complete, false);
  assert.equal(blockedDelete.verdict.kind, 'incomplete');
  assert.match(blockedDelete.verdict.banner, /only SELECT statements are supported/i);
});

test('a closed stdout pipe exits without an uncaught stream stack trace', async () => {
  const child = spawn(process.execPath, [CLI, 'analyze', '--corpus', 'q01', '--plan', Q01_PLAN, '--format', 'json'], {
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.destroy();
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(outcome.signal, null);
  assert.equal(outcome.code, 1);
  assert.doesNotMatch(stderr, /Unhandled 'error' event|node:events|\n\s+at /);
});

test('schema SQL is a complete offline metadata source', () => {
  const result = run(['analyze', '--corpus', 'q05', '--schema', SCHEMA, '--format', 'json']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, 'offline-schema');
  assert.equal(output.evidence, 'predicted-and-unverified');
  assert.equal(output.complete, true);
  assert.equal(output.analysis.findings[0]?.id, 'not-in-nullable-subquery');
});

test('saved plans become observed baseline evidence and must match bundled SQL', () => {
  const result = run(['analyze', '--corpus', 'q10', '--plan', Q10_PLAN, '--format', 'json']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, 'saved-plan');
  assert.equal(output.evidence, 'measured-baseline');
  assert.equal(output.plan.mode, 'analyzed');
  assert.equal(output.plan.summary.executionMs, 6.644);
  assert.equal(output.sql, output.analysis.sql);
  assert.equal(output.catalog.tables.length, 6);
  assert.equal(output.planJson.Plan['Node Type'], 'Aggregate');
  assert.match(output.analysis.execution.accessPaths[0].reason, /Observed in the saved EXPLAIN ANALYZE/);

  const mismatch = run(['analyze', '--corpus', 'q10', '--plan', Q01_PLAN]);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /plan bundle SQL does not match/i);
  assert.doesNotMatch(mismatch.stderr, /\n\s+at /);
});

test('plan-aware JSON output is a reusable evidence bundle', () => {
  const first = run(['analyze', '--corpus', 'q10', '--plan', Q10_PLAN, '--format', 'json']);
  assert.equal(first.status, 0);
  const bundle = JSON.parse(first.stdout);
  const directory = mkdtempSync(join(tmpdir(), 'sqlsage-bundle-'));
  const bundlePath = join(directory, 'evidence.json');
  try {
    writeFileSync(bundlePath, first.stdout);
    const replay = run(['analyze', '--sql', bundle.sql, '--plan', bundlePath, '--format', 'json']);
    assert.equal(replay.status, 0);
    const replayed = JSON.parse(replay.stdout);
    assert.equal(replayed.mode, 'saved-plan');
    assert.equal(replayed.plan.summary.executionMs, bundle.plan.summary.executionMs);
    assert.deepEqual(replayed.analysis.execution.accessPaths, bundle.analysis.execution.accessPaths);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a raw plan still requires schema metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sqlsage-plan-'));
  const planPath = join(directory, 'plan.json');
  try {
    writeFileSync(planPath, JSON.stringify([{ Plan: { 'Node Type': 'Result' } }]));
    const result = run(['analyze', '--sql', 'SELECT 1', '--plan', planPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--plan requires --catalog or --schema/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('demo runs with no arguments, no files, and no database', () => {
  const demo = run(['demo']);
  assert.equal(demo.status, 0, demo.stderr);
  assert.equal(demo.stderr, '');

  // It must show SQLSage catching a real defect, not a performance nicety --
  // a demo that led with a tuning tip would misrepresent the product.
  assert.match(demo.stdout, /WRONG RESULTS/);
  assert.match(demo.stdout, /NOT IN/);
  // It names what it analyzed, and shows the SQL it used.
  assert.match(demo.stdout, /analyzing the bundled example q05/);
  assert.match(demo.stdout, /FROM shop\.customers c/);
  // And it ends with copy-pasteable next steps for the user's own query.
  assert.match(demo.stdout, /sqlsage analyze --sql "SELECT \.\.\." --catalog catalog\.json/);
  assert.doesNotMatch(demo.stdout, /\bundefined\b|\bNaN\b|\[object Object\]/);
});

test('demo honours --format json and stays machine-readable', () => {
  const demo = run(['demo', '--format', 'json']);
  assert.equal(demo.status, 0, demo.stderr);
  const parsed = JSON.parse(demo.stdout);
  assert.equal(parsed.product, 'sqlsage');
  assert.equal(parsed.formatVersion, 1);
  assert.equal(parsed.mode, 'offline-catalog');
  // JSON output carries no banner text; the prose belongs to the human formats.
  assert.doesNotMatch(demo.stdout, /Now try your own/);
});

test('doctor passes on a healthy install and points at the next command', () => {
  const doctor = run(['doctor']);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /PASS\s+Node\.js runtime/);
  assert.match(doctor.stdout, /PASS\s+Bundled example catalog/);
  assert.match(doctor.stdout, /PASS\s+End-to-end self-test/);
  assert.match(doctor.stdout, /Next: sqlsage demo/);
  // Unsupplied inputs are skipped, never silently reported as healthy.
  assert.match(doctor.stdout, /SKIP\s+Database/);
});

test('doctor validates supplied files and exits 1 with an exact corrective command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlsage-doctor-'));
  try {
    const badCatalog = join(dir, 'bad.json');
    writeFileSync(badCatalog, '{"tables": "not-an-array"}');

    const good = run(['doctor', '--catalog', CATALOG, '--schema', SCHEMA, '--plan', Q01_PLAN]);
    assert.equal(good.status, 0, good.stdout);
    assert.match(good.stdout, /PASS\s+Catalog file/);
    assert.match(good.stdout, /PASS\s+Schema SQL file/);
    assert.match(good.stdout, /PASS\s+Plan file/);

    const bad = run(['doctor', '--catalog', badCatalog]);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /FAIL\s+Catalog file/);
    // A failure without an exact command is the failure mode this command exists to avoid.
    assert.match(bad.stdout, /fix: sqlsage doctor --catalog/);
    assert.match(bad.stdout, /then re-run: sqlsage doctor/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor reports an unreachable database as a failure, not a crash', () => {
  const doctor = run(['doctor', '--database-url', 'postgresql://nobody@127.0.0.1:1/none']);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stdout, /FAIL\s+Database connection/);
  assert.match(doctor.stdout, /fix: psql "postgresql:\/\/nobody@127\.0\.0\.1:1\/none" -c "SELECT 1"/);
  assert.doesNotMatch(doctor.stdout, /at .*\.ts:\d+/); // no stack trace leaked
});

test('help documents demo and doctor as first steps', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /sqlsage demo/);
  assert.match(help.stdout, /sqlsage doctor/);
});
