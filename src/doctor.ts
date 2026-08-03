/**
 * `sqlsage doctor` — validate the runtime, the input files, and the database
 * before the user tries to get an analysis out of them.
 *
 * Every failure carries an exact corrective command. A check that can only say
 * "something is wrong" is worth less than no check at all, because it costs the
 * user a debugging session instead of saving one.
 *
 * Safety: doctor is strictly read-only. It never issues DDL or DML, never runs
 * `EXPLAIN ANALYZE`, and does not execute the user's query. Its heaviest
 * database operation is `EXPLAIN` on a trivial constant select.
 */
import packageJson from '../package.json' with { type: 'json' };
import { CORPUS } from '../corpus/queries.ts';
import { loadCatalog } from './catalog.ts';
import type { DoctorCliOptions } from './cli-args.ts';
import { analyze } from './index.ts';
import { bundledCatalogPath } from './paths.ts';
import { loadPlanEvidence } from './plan-evidence.ts';
import { renderReport } from './report/index.ts';
import { loadSchemaCatalog } from './schema.ts';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Exact command the user should run. Required whenever status is 'fail'. */
  fix?: string;
}

function pass(name: string, detail: string): CheckResult {
  return { name, status: 'pass', detail };
}

function fail(name: string, detail: string, fix: string): CheckResult {
  return { name, status: 'fail', detail, fix };
}

function skip(name: string, detail: string): CheckResult {
  return { name, status: 'skip', detail };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `engines` field is the contract; read it rather than hardcoding a copy. */
function requiredMajor(): number | undefined {
  const raw = (packageJson as { engines?: { node?: string } }).engines?.node;
  const found = raw?.match(/(\d+)/);
  return found ? Number(found[1]) : undefined;
}

function checkNode(): CheckResult {
  const name = 'Node.js runtime';
  const current = process.versions.node;
  const major = Number(current.split('.')[0]);
  const needed = requiredMajor();
  if (needed === undefined) return pass(name, `Node ${current} (package.json declares no engine constraint)`);
  if (major >= needed) return pass(name, `Node ${current} satisfies >=${needed}`);
  return fail(
    name,
    `Node ${current} is older than the required >=${needed}`,
    `nvm install ${needed} && nvm use ${needed}    # or install Node ${needed}+ from https://nodejs.org`,
  );
}

async function checkBundledCatalog(): Promise<CheckResult> {
  const name = 'Bundled example catalog';
  const path = bundledCatalogPath();
  try {
    const catalog = await loadCatalog(path);
    return pass(name, `${catalog.tables.length} tables readable from the packaged catalog`);
  } catch (error) {
    return fail(
      name,
      `the packaged catalog could not be read: ${message(error)}`,
      'npm install --global sqlsage    # reinstall; the package appears to be incomplete',
    );
  }
}

/**
 * The only check that exercises the whole pipeline. A user whose install is
 * subtly broken should learn it here rather than from a confusing report.
 */
async function checkSelfTest(): Promise<CheckResult> {
  const name = 'End-to-end self-test';
  const query = CORPUS.find((entry) => entry.id.startsWith('q05')) ?? CORPUS[0];
  if (!query) return fail(name, 'no bundled corpus queries are present', 'npm install --global sqlsage    # reinstall');
  try {
    const catalog = await loadCatalog(bundledCatalogPath());
    const result = analyze(query.sql, catalog);
    const report = renderReport(result.analysis, { format: 'markdown' });
    if (!report.trim()) throw new Error('the renderer produced an empty report');
    if (result.missingModules.length) {
      return fail(
        name,
        `analyzer modules ${result.missingModules.join(', ')} did not run`,
        'npm install --global sqlsage    # reinstall; this build is missing analyzer modules',
      );
    }
    return pass(name, `analyzed the bundled ${query.id} and rendered ${report.split('\n').length} lines`);
  } catch (error) {
    return fail(name, `the analysis pipeline threw: ${message(error)}`, 'npm install --global sqlsage    # reinstall');
  }
}

async function checkCatalogFile(path: string): Promise<CheckResult> {
  const name = `Catalog file (${path})`;
  try {
    const catalog = await loadCatalog(path);
    return pass(name, `${catalog.tables.length} tables parsed`);
  } catch (error) {
    return fail(name, message(error), `sqlsage doctor --catalog ${path}    # after correcting the file`);
  }
}

async function checkSchemaFile(path: string): Promise<CheckResult> {
  const name = `Schema SQL file (${path})`;
  try {
    const catalog = await loadSchemaCatalog(path);
    if (catalog.tables.length === 0) {
      return fail(
        name,
        'the file parsed but declared no tables',
        `grep -c 'CREATE TABLE' ${path}    # confirm the file contains CREATE TABLE statements`,
      );
    }
    return pass(name, `${catalog.tables.length} tables parsed from DDL`);
  } catch (error) {
    return fail(name, message(error), `sqlsage doctor --schema ${path}    # after correcting the file`);
  }
}

function checkPlanFile(path: string): CheckResult {
  const name = `Plan file (${path})`;
  try {
    const plan = loadPlanEvidence(path);
    const embedded = plan.catalog ? ', embedded catalog present' : ', no embedded catalog (pair it with --catalog or --schema)';
    return pass(name, `${plan.mode} plan parsed${embedded}`);
  } catch (error) {
    return fail(
      name,
      message(error),
      `psql -qAt -c "EXPLAIN (FORMAT JSON) <your query>" > ${path}    # regenerate the plan`,
    );
  }
}

/**
 * Database checks run in one connection and in a read-only transaction, so a
 * misconfigured server cannot be altered by the act of diagnosing it.
 */
async function checkDatabase(options: DoctorCliOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const pg = await import('pg').catch(() => undefined);
  if (!pg) {
    return [fail('Database driver', 'the pg driver could not be loaded', 'npm install pg')];
  }
  const Client = (pg.default ?? pg).Client;
  const client = new Client({
    connectionString: options.databaseUrl,
    statement_timeout: options.statementTimeoutMs,
    application_name: 'sqlsage-doctor',
  });

  try {
    await client.connect();
  } catch (error) {
    return [
      fail(
        'Database connection',
        message(error),
        `psql "${options.databaseUrl}" -c "SELECT 1"    # confirm the URL, host, port, and credentials`,
      ),
    ];
  }

  try {
    const version = await client.query('SHOW server_version');
    const raw = String(version.rows[0]?.server_version ?? '');
    const major = Number(raw.split('.')[0]);
    results.push(
      Number.isFinite(major) && major >= 12
        ? pass('PostgreSQL version', `server_version ${raw}`)
        : fail('PostgreSQL version', `server_version ${raw} is older than the supported PostgreSQL 12+`, 'upgrade the server, or analyze offline with --catalog'),
    );

    const who = await client.query('SELECT current_user, current_database()');
    results.push(pass('Authentication', `connected as ${who.rows[0].current_user} to ${who.rows[0].current_database}`));

    // Read-only transaction: this is the safety boundary live analysis relies on.
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('EXPLAIN SELECT 1');
      await client.query('ROLLBACK');
      results.push(pass('Read-only EXPLAIN', 'EXPLAIN succeeds inside a read-only transaction'));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      results.push(fail('Read-only EXPLAIN', message(error), `psql "${options.databaseUrl}" -c "BEGIN READ ONLY; EXPLAIN SELECT 1; ROLLBACK"`));
    }

    const schema = options.schemaName;
    const present = await client.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [schema]);
    if (present.rowCount === 0) {
      results.push(
        fail(
          'Schema visibility',
          `schema ${JSON.stringify(schema)} is not visible to this user`,
          `psql "${options.databaseUrl}" -c "\\dn"    # list visible schemas, then pass --schema-name <name>`,
        ),
      );
    } else {
      results.push(pass('Schema visibility', `schema ${schema} is visible`));

      const readable = await client.query(
        `SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema = $1
           AND has_table_privilege(quote_ident(table_schema) || '.' || quote_ident(table_name), 'SELECT')`,
        [schema],
      );
      const n = readable.rows[0]?.n ?? 0;
      results.push(
        n > 0
          ? pass('Table read permission', `SELECT is permitted on ${n} table${n === 1 ? '' : 's'} in ${schema}`)
          : fail(
              'Table read permission',
              `no table in ${schema} is SELECT-able by this user`,
              `psql "${options.databaseUrl}" -c "GRANT USAGE ON SCHEMA ${schema} TO CURRENT_USER"    # run as an owner or superuser`,
            ),
      );

      const stats = await client.query('SELECT count(*)::int AS n FROM pg_stats WHERE schemaname = $1', [schema]);
      const rows = stats.rows[0]?.n ?? 0;
      results.push(
        rows > 0
          ? pass('Planner statistics', `${rows} pg_stats rows available for ${schema}`)
          : fail(
              'Planner statistics',
              `no planner statistics for ${schema}; index and cardinality advice will be weak`,
              `psql "${options.databaseUrl}" -c "ANALYZE"    # collect statistics (this writes stats, run it deliberately)`,
            ),
      );
    }
  } catch (error) {
    results.push(fail('Database inspection', message(error), `psql "${options.databaseUrl}" -c "SELECT 1"`));
  } finally {
    await client.end().catch(() => undefined);
  }

  return results;
}

export async function runDoctorChecks(options: DoctorCliOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = [checkNode(), await checkBundledCatalog(), await checkSelfTest()];

  results.push(
    options.catalogPath
      ? await checkCatalogFile(options.catalogPath)
      : skip('Catalog file', 'not supplied; pass --catalog <file> to validate one'),
  );
  results.push(
    options.schemaPath
      ? await checkSchemaFile(options.schemaPath)
      : skip('Schema SQL file', 'not supplied; pass --schema <file> to validate one'),
  );
  results.push(
    options.planPath
      ? checkPlanFile(options.planPath)
      : skip('Plan file', 'not supplied; pass --plan <file> to validate one'),
  );

  if (options.databaseUrl) results.push(...(await checkDatabase(options)));
  else results.push(skip('Database', 'not supplied; pass --database-url <url> to check connectivity and permissions'));

  return results;
}

const MARK: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };

export function renderDoctorReport(results: CheckResult[]): string {
  const lines = [`SQLSage ${packageJson.version} — environment check`, ''];
  for (const result of results) {
    lines.push(`  ${MARK[result.status]}  ${result.name}`);
    lines.push(`        ${result.detail}`);
    if (result.fix) lines.push(`        fix: ${result.fix}`);
  }

  const failures = results.filter((result) => result.status === 'fail');
  const skipped = results.filter((result) => result.status === 'skip').length;
  lines.push('');
  if (failures.length === 0) {
    lines.push(`All ${results.length - skipped} checks passed${skipped ? ` (${skipped} skipped)` : ''}.`);
    lines.push('Next: sqlsage demo');
  } else {
    lines.push(`${failures.length} check${failures.length === 1 ? '' : 's'} failed: ${failures.map((f) => f.name).join(', ')}.`);
    lines.push('Apply the fix shown under each failure, then re-run: sqlsage doctor');
  }
  return lines.join('\n') + '\n';
}
