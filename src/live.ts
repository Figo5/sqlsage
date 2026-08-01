/**
 * Safe live-PostgreSQL evidence boundary for the CLI.
 *
 * The caller is expected to parse and bind the query first. This module still
 * enforces one read-only statement so a semicolon cannot escape the EXPLAIN
 * wrapper. It never executes a rewrite or DDL recommendation.
 */
import pg from 'pg';
import { parse } from 'pgsql-ast-parser';

import { introspect as introspectCatalog } from './catalog.ts';
import { bindQuery } from './ir/index.ts';
import type { Catalog } from './types.ts';

export const DEFAULT_LIVE_STATEMENT_TIMEOUT_MS = 30_000;

export class LiveInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveInputError';
  }
}

export interface LiveEvidenceInput {
  /** PostgreSQL connection string passed directly to pg.Client. */
  databaseUrl: string;
  /** One already-parsed/bound read-only statement. */
  sql: string;
  /** Schema to introspect. Defaults to public. */
  schema?: string;
  /** Opt in to executing the statement under EXPLAIN ANALYZE. Default false. */
  analyze?: boolean;
  /** Transaction-local PostgreSQL statement timeout. Default 30 seconds. */
  statementTimeoutMs?: number;
}

export interface LiveEvidence {
  catalog: Catalog;
  /** The value returned in PostgreSQL's single `QUERY PLAN` JSON column. */
  planJson: unknown;
  schema: string;
  mode: 'estimated' | 'analyzed';
  statementTimeoutMs: number;
}

export interface LiveQueryResult {
  rows: Array<Record<string, unknown>>;
}

/** The pg.Client surface used here, intentionally small for deterministic tests. */
export interface LiveClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<LiveQueryResult>;
  end(): Promise<void>;
}

export interface LiveDependencies {
  createClient?: (databaseUrl: string) => LiveClient;
  introspect?: (client: LiveClient, schema: string) => Promise<Catalog>;
}

interface ValidatedInput {
  databaseUrl: string;
  sql: string;
  schema: string;
  analyze: boolean;
  statementTimeoutMs: number;
}

const READ_ONLY_ROOT_TYPES = new Set(['select', 'union', 'union all', 'values']);
const WRITE_NODE_TYPES = new Set([
  'insert',
  'update',
  'delete',
  'create table',
  'create index',
  'create schema',
  'create sequence',
  'create extension',
  'alter table',
  'drop table',
  'drop index',
  'drop schema',
  'drop sequence',
  'truncate table',
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsWriteNode(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsWriteNode(entry, seen));
  const object = value as Record<string, unknown>;
  if (typeof object.type === 'string' && WRITE_NODE_TYPES.has(object.type.toLowerCase())) return true;
  return Object.values(object).some((entry) => containsWriteNode(entry, seen));
}

function rootIsReadOnly(statement: unknown): boolean {
  if (!record(statement) || typeof statement.type !== 'string') return false;
  const type = statement.type.toLowerCase();
  if (type === 'with' || type === 'with recursive') {
    return rootIsReadOnly(statement.in) && !containsWriteNode(statement.bind);
  }
  return READ_ONLY_ROOT_TYPES.has(type) && !containsWriteNode(statement);
}

function validateSql(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LiveInputError('live SQL must be a nonblank read-only statement.');
  }
  let statements: unknown[];
  try {
    statements = parse(value);
  } catch {
    throw new LiveInputError('live SQL must be one parseable read-only statement.');
  }
  if (statements.length !== 1) {
    throw new LiveInputError('live SQL must contain exactly one statement.');
  }
  if (!rootIsReadOnly(statements[0])) {
    throw new LiveInputError('live SQL must be a read-only SELECT statement.');
  }
  return value.trim().replace(/;\s*$/, '');
}

function validateInput(input: LiveEvidenceInput): ValidatedInput {
  if (!record(input)) throw new LiveInputError('live input must be an object.');
  if (typeof input.databaseUrl !== 'string' || !input.databaseUrl.trim()) {
    throw new LiveInputError('database URL is required.');
  }
  const schemaValue = input.schema ?? 'public';
  if (typeof schemaValue !== 'string' || !schemaValue.trim() || schemaValue.includes('\0')) {
    throw new LiveInputError('schema must be a nonblank PostgreSQL schema name.');
  }
  if (input.analyze !== undefined && typeof input.analyze !== 'boolean') {
    throw new LiveInputError('analyze must be boolean.');
  }
  const timeout = input.statementTimeoutMs ?? DEFAULT_LIVE_STATEMENT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new LiveInputError('statement timeout must be a positive safe integer in milliseconds.');
  }
  return {
    databaseUrl: input.databaseUrl.trim(),
    sql: validateSql(input.sql),
    schema: schemaValue.trim(),
    analyze: input.analyze ?? false,
    statementTimeoutMs: timeout,
  };
}

function defaultClient(databaseUrl: string): LiveClient {
  return new pg.Client({ connectionString: databaseUrl }) as unknown as LiveClient;
}

async function defaultIntrospect(client: LiveClient, schema: string): Promise<Catalog> {
  return introspectCatalog(client as unknown as pg.Client, schema);
}

function explainSql(sql: string, analyze: boolean): string {
  const options = analyze
    ? 'ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON'
    : 'VERBOSE, SETTINGS, FORMAT JSON';
  return `EXPLAIN (${options}) ${sql}`;
}

function extractPlan(result: LiveQueryResult): unknown {
  const row = result.rows[0];
  if (!row || !Object.hasOwn(row, 'QUERY PLAN')) {
    throw new Error('PostgreSQL returned no JSON EXPLAIN plan.');
  }
  return row['QUERY PLAN'];
}

/**
 * Introspect one schema and capture one JSON EXPLAIN on one connection.
 *
 * Both modes use an explicit read-only transaction and transaction-local
 * timeout. The default EXPLAIN never executes the statement. `analyze: true`
 * is the only path that adds ANALYZE/BUFFERS, and rollback is attempted before
 * the client is ended on every success or failure after BEGIN.
 */
export async function collectLiveEvidence(
  input: LiveEvidenceInput,
  dependencies: LiveDependencies = {},
): Promise<LiveEvidence> {
  const validated = validateInput(input);
  const createClient = dependencies.createClient ?? defaultClient;
  const introspect = dependencies.introspect ?? defaultIntrospect;
  const client = createClient(validated.databaseUrl);

  let transactionStarted = false;
  let failed = false;
  let failure: unknown;
  let evidence: LiveEvidence | undefined;

  try {
    await client.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('SET TRANSACTION READ ONLY');
    // Safe interpolation: timeout was validated as a positive safe integer.
    await client.query(`SET LOCAL statement_timeout = '${validated.statementTimeoutMs}ms'`);

    const catalog = await introspect(client, validated.schema);
    const ir = bindQuery(validated.sql, catalog);
    const bindingErrors = ir.bindingErrors.filter((error) => error.severity === 'error');
    if (ir.statementType !== 'select' || bindingErrors.length) {
      const detail = bindingErrors[0]?.message ?? `received ${ir.statementType}`;
      throw new LiveInputError(`live analysis is blocked by schema binding: ${detail}`);
    }
    const plan = await client.query(explainSql(validated.sql, validated.analyze));
    evidence = {
      catalog,
      planJson: extractPlan(plan),
      schema: validated.schema,
      mode: validated.analyze ? 'analyzed' : 'estimated',
      statementTimeoutMs: validated.statementTimeoutMs,
    };
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
    try {
      await client.end();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }

  if (failed) throw failure;
  return evidence!;
}
