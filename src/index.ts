/**
 * The SQLSage pipeline.
 *
 * `analyze()` uses the product implementations by default while retaining
 * module injection for focused tests and downstream embedding. A caller that
 * deliberately passes a partial module set still receives `missingModules`;
 * absence is never treated as a clean analysis.
 */
import { detectAntiPatterns } from './antipatterns/index.ts';
import { explainSemantics } from './explain/index.ts';
import { recommendIndexes } from './indexes/index.ts';
import { bindQuery } from './ir/index.ts';
import { predictExecution } from './plan/index.ts';
import { proposeRewrites } from './rewrite/index.ts';
import type {
  Analysis,
  Catalog,
  ExecutionAnalysis,
  Finding,
  IndexRecommendation,
  Rewrite,
  SemanticExplanation,
} from './types.ts';

export type ModuleId = 'M2' | 'M3' | 'M4' | 'M5' | 'M6';

/** Optional implementations, injected as they come online. */
export interface Modules {
  explainSemantics?: (ir: ReturnType<typeof bindQuery>, catalog: Catalog) => SemanticExplanation;
  predictExecution?: (ir: ReturnType<typeof bindQuery>, catalog: Catalog) => ExecutionAnalysis;
  detectAntiPatterns?: (ir: ReturnType<typeof bindQuery>, catalog: Catalog) => Finding[];
  recommendIndexes?: (ir: ReturnType<typeof bindQuery>, catalog: Catalog, findings: Finding[]) => IndexRecommendation[];
  proposeRewrites?: (ir: ReturnType<typeof bindQuery>, catalog: Catalog, findings: Finding[]) => Rewrite[];
}

export interface PipelineResult {
  analysis: Analysis;
  /** Modules with no implementation. Callers MUST surface this. */
  missingModules: ModuleId[];
}

/** Production modules used by the CLI and package API. */
export const DEFAULT_MODULES: Required<Modules> = {
  explainSemantics,
  predictExecution,
  detectAntiPatterns,
  recommendIndexes,
  proposeRewrites,
};

/**
 * A semantics placeholder that states its own absence rather than inventing an
 * explanation. M7 must render this without claiming the query was understood.
 */
function absentSemantics(): SemanticExplanation {
  return {
    headline: 'Plain-English explanation is unavailable — the semantics module (M2) is not implemented.',
    steps: [],
    resultShape: { grain: 'unknown — M2 not implemented', columns: [] },
    caveats: [],
  };
}

function absentExecution(): ExecutionAnalysis {
  return {
    accessPaths: [],
    joinStrategies: [],
    dominantCosts: [],
    memoryRisks: [],
    estimationRisks: [],
    scalability: { summary: 'Execution prediction is unavailable — the execution module (M3) is not implemented.' },
  };
}

export function analyze(sql: string, catalog: Catalog, modules: Modules = DEFAULT_MODULES): PipelineResult {
  const ir = bindQuery(sql, catalog);
  const missing: ModuleId[] = [];

  if (!modules.explainSemantics) missing.push('M2');
  if (!modules.predictExecution) missing.push('M3');
  if (!modules.detectAntiPatterns) missing.push('M4');
  if (!modules.recommendIndexes) missing.push('M5');
  if (!modules.proposeRewrites) missing.push('M6');

  const findings = modules.detectAntiPatterns?.(ir, catalog) ?? [];

  return {
    analysis: {
      sql,
      catalogName: catalog.tables[0]?.schema ?? 'unknown',
      ir,
      semantics: modules.explainSemantics?.(ir, catalog) ?? absentSemantics(),
      execution: modules.predictExecution?.(ir, catalog) ?? absentExecution(),
      findings,
      indexes: modules.recommendIndexes?.(ir, catalog, findings) ?? [],
      rewrites: modules.proposeRewrites?.(ir, catalog, findings) ?? [],
      // Carried inside the Analysis, not just alongside it, so a renderer handed only
      // the Analysis still knows the difference between "nothing wrong" and "nobody
      // looked". The cli.ts banner is a courtesy on top of this, not the mechanism.
      missingModules: missing.length ? [...missing] : undefined,
      blockedReasons: ir.statementType === 'select'
        ? undefined
        : [`only SELECT statements are supported; received ${ir.statementType}`],
    },
    missingModules: missing,
  };
}
