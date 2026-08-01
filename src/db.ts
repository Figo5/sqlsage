/**
 * Live-database access. Used by the eval harness to collect ground truth and to
 * verify that recommendations actually change the plan. The analyzer itself
 * never requires a connection — it reasons from the catalog.
 */
import pg from 'pg';

export const CONN = {
  host: process.env.SQLSAGE_PGHOST ?? '127.0.0.1',
  port: Number(process.env.SQLSAGE_PGPORT ?? 55432),
  user: process.env.SQLSAGE_PGUSER ?? 'postgres',
  password: process.env.SQLSAGE_PGPASSWORD ?? 'sage',
  database: process.env.SQLSAGE_PGDATABASE ?? 'sage',
};

export async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(CONN);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export interface PlanCapture {
  sql: string;
  /** EXPLAIN (FORMAT JSON) tree, including actual rows/time/buffers. */
  planJson: unknown;
  /** Human-readable plan — this is what an expert actually reads. */
  planText: string;
  executionMs: number;
  planningMs: number;
  /** Median of the timed runs, to damp cache-warming noise. */
  medianMs: number;
  runs: number[];
}

/**
 * Runs the query a few times and returns the plan plus a median timing.
 * The first run is discarded: it measures cold cache, not the query.
 */
export async function capturePlan(
  client: pg.Client,
  sql: string,
  opts: { runs?: number; timeoutMs?: number } = {},
): Promise<PlanCapture> {
  const runs = opts.runs ?? 3;
  await client.query(`SET statement_timeout = ${opts.timeoutMs ?? 120_000}`);

  const stripped = sql.trim().replace(/;\s*$/, '');
  const timings: number[] = [];
  let planJson: unknown = null;
  let executionMs = 0;
  let planningMs = 0;

  for (let i = 0; i <= runs; i++) {
    const res = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON) ${stripped}`,
    );
    const plan = res.rows[0]['QUERY PLAN'][0];
    if (i === 0) continue; // discard cold run
    timings.push(plan['Execution Time']);
    planJson = plan;
    executionMs = plan['Execution Time'];
    planningMs = plan['Planning Time'];
  }

  const textRes = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS) ${stripped}`,
  );
  const planText = textRes.rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');

  const sorted = [...timings].sort((a, b) => a - b);
  return {
    sql,
    planJson,
    planText,
    executionMs,
    planningMs,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    runs: timings,
  };
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(canonicalize);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

/**
 * Runs a query and fingerprints its complete result multiset by default.
 *
 * Passing `limit` is useful for an explicitly sampled diagnostic, but callers
 * doing equivalence checks must omit it: equal first pages do not prove equal
 * results. Row order is deliberately ignored; row multiplicity is preserved.
 */
export async function fingerprintResults(
  client: pg.Client,
  sql: string,
  limit?: number,
): Promise<{ rowCount: number; digest: string; sample: unknown[] }> {
  const stripped = sql.trim().replace(/;\s*$/, '');
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error(`fingerprint limit must be a non-negative safe integer; got ${limit}`);
  }
  const limitSql = limit === undefined ? '' : ` LIMIT ${limit}`;
  const res = await client.query(`SELECT * FROM (${stripped}) _sqlsage_fp${limitSql}`);
  const norm = res.rows
    .map((r) => JSON.stringify(canonicalize(r)))
    .sort()
    .join('\n');
  const { createHash } = await import('node:crypto');
  return {
    rowCount: res.rowCount ?? 0,
    digest: createHash('sha256').update(norm).digest('hex').slice(0, 16),
    sample: res.rows.slice(0, 3),
  };
}
