export type OutputFormat = 'text' | 'markdown' | 'json';

export type QuerySource =
  | { kind: 'file'; path: string }
  | { kind: 'inline'; sql: string }
  | { kind: 'stdin' }
  | { kind: 'corpus'; id: string };

export interface AnalyzeCliOptions {
  command: 'analyze';
  query: QuerySource;
  catalogPath?: string;
  schemaPath?: string;
  planPath?: string;
  databaseUrl?: string;
  schemaName: string;
  format?: OutputFormat;
  runAnalyze: boolean;
  statementTimeoutMs: number;
  color: boolean | undefined;
}

export type CliOptions =
  | AnalyzeCliOptions
  | { command: 'help' }
  | { command: 'version' }
  | { command: 'list' };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

const VALUE_FLAGS = new Set([
  '--query', '-q', '--sql', '--catalog', '--schema', '--plan', '--database-url',
  '--schema-name', '--format', '-f', '--statement-timeout', '--corpus',
]);

function oneValue(values: Map<string, string>, canonical: string, aliases: string[] = []): string | undefined {
  const found = [canonical, ...aliases].filter((name) => values.has(name));
  if (found.length > 1) throw new CliUsageError(`use only one of ${found.join(', ')}`);
  return found.length ? values.get(found[0]) : undefined;
}

function positiveInteger(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CliUsageError(`${name} must be a positive integer; received ${JSON.stringify(raw)}`);
  }
  return value;
}

function queryFromFileFlag(raw: string): QuerySource {
  return raw === '-' ? { kind: 'stdin' } : { kind: 'file', path: raw };
}

/** Parse arguments without performing I/O, so process-level behavior stays testable. */
export function parseCliArgs(argv: string[], stdinIsTTY = true): CliOptions {
  const args = [...argv];
  if (args[0] === 'help') return { command: 'help' };
  if (args[0] === 'list') return { command: 'list' };
  if (args[0] === 'analyze') args.shift();

  if (args.includes('--help') || args.includes('-h')) return { command: 'help' };
  if (args.includes('--version') || args.includes('-V')) return { command: 'version' };
  if (args.includes('--list')) return { command: 'list' };
  if (args.length === 0 && stdinIsTTY) return { command: 'help' };

  const values = new Map<string, string>();
  const switches = new Set<string>();
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (VALUE_FLAGS.has(arg)) {
      if (values.has(arg)) throw new CliUsageError(`${arg} may be supplied only once`);
      const next = args[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        throw new CliUsageError(`${arg} requires a value`);
      }
      values.set(arg, next);
      i++;
      continue;
    }
    if (arg === '--analyze' || arg === '--no-color') {
      if (switches.has(arg)) throw new CliUsageError(`${arg} may be supplied only once`);
      switches.add(arg);
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') throw new CliUsageError(`unknown option ${arg}`);
    positionals.push(arg);
  }

  if (positionals.length > 1) {
    throw new CliUsageError('provide exactly one query source; use --query, --sql, a single positional query, or stdin');
  }

  const queryFile = oneValue(values, '--query', ['-q']);
  const inlineSql = oneValue(values, '--sql');
  const corpusId = oneValue(values, '--corpus');
  const querySources: QuerySource[] = [];
  if (queryFile !== undefined) querySources.push(queryFromFileFlag(queryFile));
  if (inlineSql !== undefined) querySources.push({ kind: 'inline', sql: inlineSql });
  if (corpusId !== undefined) querySources.push({ kind: 'corpus', id: corpusId });
  if (positionals.length) {
    const positional = positionals[0];
    querySources.push(
      positional === '-'
        ? { kind: 'stdin' }
        : positional.trim().toLowerCase().endsWith('.sql')
          ? { kind: 'file', path: positional }
          : { kind: 'inline', sql: positional },
    );
  }
  if (querySources.length === 0 && !stdinIsTTY) querySources.push({ kind: 'stdin' });
  if (querySources.length !== 1) {
    throw new CliUsageError('provide exactly one query source; use --query, --sql, --corpus, or stdin');
  }

  const catalogPath = oneValue(values, '--catalog');
  const schemaPath = oneValue(values, '--schema');
  const planPath = oneValue(values, '--plan');
  const databaseUrl = oneValue(values, '--database-url');
  const primaryMetadata = [catalogPath, schemaPath, databaseUrl].filter((value) => value !== undefined);
  if (primaryMetadata.length > 1) {
    throw new CliUsageError('use only one primary metadata source: --catalog, --schema, or --database-url');
  }
  if (planPath !== undefined && databaseUrl !== undefined) {
    throw new CliUsageError('--plan cannot be combined with --database-url; connected mode collects its own plan');
  }
  if (querySources[0].kind !== 'corpus' && primaryMetadata.length === 0 && planPath === undefined) {
    throw new CliUsageError('analysis requires --catalog, --schema, --plan, or --database-url');
  }

  const formatRaw = oneValue(values, '--format', ['-f']);
  if (formatRaw !== undefined && !['text', 'markdown', 'json'].includes(formatRaw)) {
    throw new CliUsageError(`--format must be text, markdown, or json; received ${JSON.stringify(formatRaw)}`);
  }

  const runAnalyze = switches.has('--analyze');
  if (runAnalyze && databaseUrl === undefined) {
    throw new CliUsageError('--analyze requires --database-url');
  }
  const schemaName = oneValue(values, '--schema-name') ?? 'public';
  if (!schemaName.trim()) throw new CliUsageError('--schema-name cannot be blank');
  if (values.has('--schema-name') && databaseUrl === undefined) {
    throw new CliUsageError('--schema-name requires --database-url');
  }
  if (values.has('--statement-timeout') && databaseUrl === undefined) {
    throw new CliUsageError('--statement-timeout requires --database-url');
  }

  return {
    command: 'analyze',
    query: querySources[0],
    catalogPath,
    schemaPath,
    planPath,
    databaseUrl,
    schemaName,
    format: formatRaw as OutputFormat | undefined,
    runAnalyze,
    statementTimeoutMs: positiveInteger(oneValue(values, '--statement-timeout'), '--statement-timeout', 30_000),
    color: switches.has('--no-color') ? false : undefined,
  };
}
