#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import packageJson from '../package.json' with { type: 'json' };
import { CORPUS } from '../corpus/queries.ts';
import { CatalogInputError, loadCatalog, validateCatalog } from './catalog.ts';
import { CliUsageError, parseCliArgs } from './cli-args.ts';
import type { AnalyzeCliOptions, DemoCliOptions, DoctorCliOptions, OutputFormat, QuerySource } from './cli-args.ts';
import { analyze } from './index.ts';
import { bindQuery } from './ir/index.ts';
import { collectLiveEvidence, LiveInputError } from './live.ts';
import { applyPlanEvidence, loadPlanEvidence, normalizePlanEvidence, PlanInputError } from './plan-evidence.ts';
import type { PlanEvidence } from './plan-evidence.ts';
import { runDoctorChecks, renderDoctorReport } from './doctor.ts';
import { buildModel, renderReport } from './report/index.ts';
import { loadSchemaCatalog, SchemaInputError } from './schema.ts';
import type { Catalog } from './types.ts';

export const HELP = `SQLSage ${packageJson.version} — explain and optimize PostgreSQL queries

Usage:
  sqlsage analyze --query query.sql --catalog catalog.json
  sqlsage analyze --sql "SELECT ..." --catalog catalog.json
  cat query.sql | sqlsage analyze --catalog catalog.json

Query input (choose one):
  --query, -q <file|->       SQL file, or - for stdin
  --sql <statement>         inline SQL

Metadata and evidence:
  --catalog <file>          SQLSage catalog JSON
  --schema <file>           PostgreSQL CREATE TABLE/INDEX schema SQL
  --plan <file>             saved PostgreSQL JSON plan or SQLSage evidence bundle
  --database-url <url>      live catalog plus PostgreSQL plan evidence
  --schema-name <name>      live database schema (default: public)

Output and safety:
  --format, -f <format>     text, markdown, or json
  --no-color                disable ANSI styling in text output
  --statement-timeout <ms> live database timeout (default: 30000)
  --analyze                 opt in to read-only EXPLAIN ANALYZE; requires --database-url

Safety: --analyze executes the SELECT. A read-only transaction cannot prevent external
side effects inside an unfamiliar user-defined volatile function; review the query first.

First steps:
  sqlsage demo                          analyze a bundled example; needs no files
  sqlsage doctor                        check the runtime and bundled assets
  sqlsage doctor --database-url <url>   also check connectivity and permissions

Bundled examples:
  sqlsage list
  sqlsage analyze --corpus q05 --format text

Exit codes: 0 analysis written; 1 usage/input/connection failure; 2 analysis blocked.
`;

/**
 * The demo query is chosen to show SQLSage doing the thing it is for: q05
 * returns the wrong answer, not merely a slow one. A demo that led with a
 * performance tip would misrepresent the product's strongest claim.
 */
const DEMO_CORPUS_ID = 'q05';

interface CliIo {
  stdout: { write(chunk: string): unknown; isTTY?: boolean };
  stderr: { write(chunk: string): unknown };
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
}

const processIo: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
};

async function readStdin(stdin: CliIo['stdin']): Promise<string> {
  let sql = '';
  for await (const chunk of stdin) sql += String(chunk);
  return sql;
}

async function resolveQuery(source: QuerySource, stdin: CliIo['stdin']): Promise<string> {
  if (source.kind === 'inline') return source.sql;
  if (source.kind === 'file') return readFile(source.path, 'utf8');
  if (source.kind === 'stdin') return readStdin(stdin);

  const exact = CORPUS.find((query) => query.id === source.id);
  if (exact) return exact.sql;
  const candidates = CORPUS.filter((query) => query.id.startsWith(source.id));
  if (candidates.length === 0) throw new CliUsageError(`unknown corpus id ${JSON.stringify(source.id)}; run sqlsage list`);
  if (candidates.length > 1) {
    throw new CliUsageError(`ambiguous corpus id ${JSON.stringify(source.id)}: ${candidates.map((q) => q.id).join(', ')}`);
  }
  return candidates[0].sql;
}

function selectedFormat(options: AnalyzeCliOptions, stdout: CliIo['stdout']): OutputFormat {
  return options.format ?? (stdout.isTTY ? 'text' : 'markdown');
}

function bundledCatalogPath(): string {
  return new URL('../corpus/catalog.json', import.meta.url).pathname;
}

interface AnalysisContext {
  mode: 'offline-catalog' | 'offline-schema' | 'saved-plan' | 'connected-plan' | 'connected-analyze';
  evidence: 'predicted-and-unverified' | 'plan-observed' | 'measured-baseline';
  catalog: Catalog;
  plan?: PlanEvidence;
}

async function offlineCatalog(options: AnalyzeCliOptions, plan: PlanEvidence | undefined): Promise<{ catalog: Catalog; mode: AnalysisContext['mode'] }> {
  if (options.catalogPath) return { catalog: await loadCatalog(options.catalogPath), mode: 'offline-catalog' };
  if (options.schemaPath) return { catalog: await loadSchemaCatalog(options.schemaPath), mode: 'offline-schema' };
  if (options.query.kind === 'corpus') {
    return { catalog: await loadCatalog(bundledCatalogPath()), mode: 'offline-catalog' };
  }
  if (plan?.catalog !== undefined) {
    return { catalog: validateCatalog(plan.catalog), mode: 'saved-plan' };
  }
  if (options.planPath) {
    throw new CliUsageError('--plan requires --catalog or --schema unless the evidence bundle embeds a SQLSage catalog');
  }
  throw new CliUsageError('analysis requires --catalog, --schema, or --database-url');
}

function normalizedStatement(sql: string, catalog: Catalog): string {
  return bindQuery(sql, catalog).normalizedSql ?? sql.trim().replace(/;\s*$/, '');
}

function assertPlanMatchesQuery(sql: string, catalog: Catalog, plan: PlanEvidence): void {
  if (!plan.sql) return;
  if (normalizedStatement(sql, catalog) !== normalizedStatement(plan.sql, catalog)) {
    throw new PlanInputError('saved plan bundle SQL does not match the query being analyzed');
  }
}

function withPlan(
  result: ReturnType<typeof analyze>,
  plan: PlanEvidence,
): ReturnType<typeof analyze> {
  return { ...result, analysis: applyPlanEvidence(result.analysis, plan) };
}

function jsonOutput(result: ReturnType<typeof analyze>, context: AnalysisContext): string {
  const model = buildModel(result.analysis);
  return JSON.stringify({
    formatVersion: 1,
    product: 'sqlsage',
    mode: context.mode,
    evidence: context.evidence,
    plan: context.plan ? { mode: context.plan.mode, summary: context.plan.summary } : undefined,
    sql: context.plan ? result.analysis.sql : undefined,
    catalog: context.plan ? context.catalog : undefined,
    planJson: context.plan ? context.plan.document : undefined,
    complete: result.missingModules.length === 0 && model.verdict.kind !== 'incomplete',
    verdict: model.verdict,
    analysis: result.analysis,
  }, null, 2) + '\n';
}

async function runAnalysis(options: AnalyzeCliOptions, io: CliIo): Promise<number> {
  const sql = (await resolveQuery(options.query, io.stdin)).trim();
  if (!sql) throw new CliUsageError('query input is empty');

  let result: ReturnType<typeof analyze>;
  let context: AnalysisContext;
  try {
    if (options.databaseUrl) {
      const live = await collectLiveEvidence({
        databaseUrl: options.databaseUrl,
        sql,
        schema: options.schemaName,
        analyze: options.runAnalyze,
        statementTimeoutMs: options.statementTimeoutMs,
      });
      const plan = normalizePlanEvidence(live.planJson);
      result = withPlan(analyze(sql, live.catalog), plan);
      context = {
        mode: options.runAnalyze ? 'connected-analyze' : 'connected-plan',
        evidence: plan.mode === 'analyzed' ? 'measured-baseline' : 'plan-observed',
        catalog: live.catalog,
        plan,
      };
    } else {
      const plan = options.planPath ? loadPlanEvidence(options.planPath) : undefined;
      const metadata = await offlineCatalog(options, plan);
      result = analyze(sql, metadata.catalog);
      if (plan) {
        assertPlanMatchesQuery(sql, metadata.catalog, plan);
        result = withPlan(result, plan);
      }
      context = {
        mode: plan ? 'saved-plan' : metadata.mode,
        evidence: plan ? (plan.mode === 'analyzed' ? 'measured-baseline' : 'plan-observed') : 'predicted-and-unverified',
        catalog: metadata.catalog,
        plan,
      };
    }
  } catch (error) {
    if (error instanceof CliUsageError || error instanceof CatalogInputError || error instanceof SchemaInputError || error instanceof PlanInputError || error instanceof LiveInputError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const prefix = options.databaseUrl ? 'database connection or EXPLAIN failed' : 'analysis failed';
    io.stderr.write(`sqlsage: ${prefix}: ${message}\n`);
    return 1;
  }

  const hardBinding = result.analysis.ir.bindingErrors.filter((error) => error.severity === 'error');
  const blocked = result.analysis.ir.statementType !== 'select' || hardBinding.length > 0 || result.missingModules.length > 0;
  const format = selectedFormat(options, io.stdout);
  if (format === 'json') {
    io.stdout.write(jsonOutput(result, context));
  } else {
    io.stdout.write(renderReport(result.analysis, {
      format: format === 'text' ? 'terminal' : 'markdown',
      color: options.color,
    }) + '\n');
  }

  if (result.analysis.ir.statementType !== 'select') {
    io.stderr.write(`sqlsage: only SELECT statements are supported in this release; received ${result.analysis.ir.statementType}\n`);
  } else if (hardBinding.length) {
    io.stderr.write(`sqlsage: analysis is blocked by ${hardBinding.length} schema-binding error${hardBinding.length === 1 ? '' : 's'}\n`);
  } else if (result.missingModules.length) {
    io.stderr.write(`sqlsage: analysis is incomplete because modules ${result.missingModules.join(', ')} did not run\n`);
  }
  return blocked ? 2 : 0;
}

async function runDemo(options: DemoCliOptions, io: CliIo): Promise<number> {
  const query = CORPUS.find((entry) => entry.id.startsWith(DEMO_CORPUS_ID));
  if (!query) throw new CliUsageError(`the bundled example ${DEMO_CORPUS_ID} is missing; reinstall sqlsage`);

  const catalog = await loadCatalog(bundledCatalogPath());
  const result = analyze(query.sql, catalog);
  const format = options.format ?? (io.stdout.isTTY ? 'text' : 'markdown');

  if (format === 'json') {
    io.stdout.write(jsonOutput(result, { mode: 'offline-catalog', evidence: 'predicted-and-unverified', catalog }));
    return 0;
  }

  // The banner goes to stdout ahead of the report: a note written afterwards, or
  // to stderr, is lost the moment someone pipes the output to a file.
  io.stdout.write(
    `SQLSage demo — analyzing the bundled example ${query.id}: ${query.title}\n` +
      'No database, no catalog, and no files of your own are involved.\n\n' +
      `${query.sql.trim()}\n\n` +
      '─'.repeat(72) + '\n\n',
  );
  io.stdout.write(renderReport(result.analysis, {
    format: format === 'text' ? 'terminal' : 'markdown',
    color: options.color,
  }) + '\n');
  io.stdout.write(
    '\n' + '─'.repeat(72) + '\n' +
      'That report came from the query and schema alone — no query was executed.\n\n' +
      'Now try your own:\n' +
      '  sqlsage analyze --sql "SELECT ..." --catalog catalog.json\n' +
      '  sqlsage analyze --query slow.sql --schema schema.sql\n' +
      '  sqlsage analyze --query slow.sql --plan plan.json\n\n' +
      'No catalog yet?  sqlsage doctor --database-url "$DATABASE_URL"\n' +
      'More examples:    sqlsage list\n',
  );
  return 0;
}

async function runDoctor(options: DoctorCliOptions, io: CliIo): Promise<number> {
  const results = await runDoctorChecks(options);
  io.stdout.write(renderDoctorReport(results));
  return results.some((result) => result.status === 'fail') ? 1 : 0;
}

export async function runCli(argv: string[], io: CliIo = processIo): Promise<number> {
  try {
    const options = parseCliArgs(argv, io.stdin.isTTY === true);
    if (options.command === 'help') {
      io.stdout.write(HELP);
      return 0;
    }
    if (options.command === 'version') {
      io.stdout.write(`${packageJson.version}\n`);
      return 0;
    }
    if (options.command === 'demo') return await runDemo(options, io);
    if (options.command === 'doctor') return await runDoctor(options, io);
    if (options.command === 'list') {
      for (const query of CORPUS) io.stdout.write(`${query.id.padEnd(32)} ${query.title}\n`);
      return 0;
    }
    return await runAnalysis(options, io);
  } catch (error) {
    if (
      error instanceof CliUsageError ||
      error instanceof CatalogInputError ||
      error instanceof SchemaInputError ||
      error instanceof PlanInputError ||
      error instanceof LiveInputError
    ) {
      io.stderr.write(`sqlsage: ${error.message}\nTry 'sqlsage --help' for usage.\n`);
      return 1;
    }
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    const message = error instanceof Error ? error.message : String(error);
    const prefix = code === 'ENOENT' ? 'file not found' : 'input error';
    io.stderr.write(`sqlsage: ${prefix}: ${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
const isMain = invokedPath
  ? realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))
  : false;
if (isMain) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', () => {
      // Closed pipes and output-device failures are ordinary CLI output errors,
      // not reasons to print Node's uncaught-event stack trace.
      process.exitCode = 1;
    });
  }
  process.exitCode = await runCli(process.argv.slice(2));
}
