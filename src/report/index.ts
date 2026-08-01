/**
 * M7 — the report renderer.
 *
 * `renderReport(analysis)` is the only thing a human sees, so this module is
 * not a formatter: it decides what leads, what is grouped with what, what is
 * cut, and what is said plainly.
 *
 * The shape of the document, and why:
 *
 *   1. A verdict banner and a two-or-three sentence bottom line.
 *   2. "Do this first" — at most four imperative lines.
 *      (1 and 2 together are the first screenful. A staff engineer who reads
 *       only that far should know what to do Monday morning.)
 *   3. One numbered section per *issue*, ranked by impact. Each section carries
 *      its own evidence, its own DDL and its own rewritten SQL with the caveats
 *      attached to the code they qualify. There is no findings section followed
 *      by an index section followed by a rewrites section; a reader should never
 *      have to cross-reference three lists to assemble one problem.
 *   4. "Checked, no action needed" — the section that makes the tool
 *      trustworthy, because it is where the analyzer says the obvious advice
 *      does not apply here, and shows the numbers.
 *   5. Context that is only read on demand: what the query means, where the
 *      time goes, and how far to trust any of it.
 *
 * Pure: no I/O, no database, deterministic for a given input. The single
 * exception is ANSI colour capability detection, which reads NO_COLOR and
 * `stdout.isTTY`, is overridable via `opts.color`, and can never change a
 * character of content.
 */

import type { Analysis, Finding, IndexRecommendation, Rewrite, Severity } from '../types.ts';
import type { Block, ListItem, Tone } from './blocks.ts';
import { detectColor, renderMarkdown, renderTerminal } from './blocks.ts';
import { recognizeCreateIndexDdl } from './index-ddl.ts';
import { buildModel, fmtMs, fmtPct, severityRank } from './prioritize.ts';
import type { DependencyProblem, Issue, ReportModel, TimingValue } from './prioritize.ts';

export interface RenderOptions {
  format?: 'markdown' | 'terminal';
  /** Force ANSI on or off. Default: auto (NO_COLOR / FORCE_COLOR / TTY). */
  color?: boolean;
  /** Wrap width for the terminal format. Fixed at 80 by default, for reproducibility. */
  width?: number;
  /** How many actions the "Do this first" list may carry. Default 4. */
  maxActions?: number;
}

export function renderReport(analysis: Analysis, opts: RenderOptions = {}): string {
  const model = buildModel(analysis ?? ({} as Analysis));
  const requestedActions = opts.maxActions ?? 4;
  const maxActions = Number.isFinite(requestedActions) ? Math.max(0, Math.trunc(requestedActions)) : 4;
  const blocks = composeBlocks(model, analysis, maxActions);
  if (opts.format === 'terminal') {
    const color = opts.color ?? detectColor();
    return renderTerminal(blocks, color, opts.width ?? 80);
  }
  return renderMarkdown(blocks);
}

/** Exposed for tests and for callers that want the ranking without the prose. */
export { buildModel } from './prioritize.ts';
export type { Issue, ReportModel } from './prioritize.ts';

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

function oneLine(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function grainSentence(value: unknown): string {
  const grain = oneLine(value).replace(/[.]+$/, '');
  if (!grain) return '';
  if (/^(?:one|at most one|exactly one|zero or one|one or more)\s+rows?\b/i.test(grain)) {
    return `${grain[0]!.toUpperCase()}${grain.slice(1)}.`;
  }
  return `One row per ${grain}.`;
}

function clip(s: unknown, max: number): string {
  const t = oneLine(s);
  return t.length <= max ? t : t.slice(0, max - 1).replace(/[\s,;:(]+\S*$/, '') + '…';
}

function firstSentence(s: unknown, max = 160): string {
  const t = oneLine(s);
  if (!t) return '';
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  return clip(m ? m[0] : t, max);
}

function toneFor(issue: Issue): Tone {
  if (issue.kind === 'correctness') return 'critical';
  if (issue.kind === 'intent') return 'warn';
  if (severityRank(issue.effectiveSeverity) <= severityRank('high')) return 'warn';
  return 'muted';
}

function badgesFor(issue: Issue): string[] {
  const b: string[] = [];
  if (issue.kind !== 'performance') b.push(issue.kind);
  b.push(issue.severity);
  b.push(`${issue.confidence} confidence`);
  return b;
}

/** `CREATE INDEX CONCURRENTLY idx_foo ON ...` -> `idx_foo`. */
function indexName(idx: IndexRecommendation): string | undefined {
  const ddl = recognizeCreateIndexDdl(idx.ddl);
  return ddl.valid ? ddl.indexName : undefined;
}

function indexLabel(idx: IndexRecommendation): string {
  const cols = (idx.columns ?? []).join(', ');
  const include = idx.includeColumns?.length ? ` INCLUDE (${idx.includeColumns.join(', ')})` : '';
  const partial = idx.where ? ` WHERE ${clip(idx.where, 50)}` : '';
  const method = idx.method && idx.method !== 'btree' ? ` ${idx.method.toUpperCase()}` : '';
  return `${idx.table} (${cols})${include}${partial}${method}`;
}

const EQUIVALENCE_TAG: Record<Rewrite['equivalence'], string> = {
  exact: 'same results',
  conditional: 'conditionally equivalent',
  'different-semantics': 'changes results',
};

/**
 * Safety caveats the renderer adds itself. M5 owns the DDL; M7 owns the promise
 * that nobody pastes a blocking `CREATE INDEX` into a live system because the
 * warning was three sections away.
 */
function lockingNote(idx: IndexRecommendation): { label: string; text: string; tone: Tone } | undefined {
  const ddl = recognizeCreateIndexDdl(idx.ddl);
  if (!ddl.valid) return undefined;
  if (ddl.concurrently) {
    return {
      label: 'Before you run it',
      tone: 'warn',
      text:
        `\`CONCURRENTLY\` cannot run inside a transaction block (no \`BEGIN\`, and many migration tools wrap ` +
        `statements by default). It performs two table scans, can wait on old transactions, and if it fails it leaves an ` +
        `\`INVALID\` index behind that you must \`DROP INDEX\` before retrying.`,
    };
  }
  return {
    label: 'Before you run it',
    tone: 'warn',
    text:
      `A regular \`CREATE INDEX\` lets reads continue but blocks inserts, updates, and deletes on \`${idx.table}\` ` +
      `until the build finishes. For a live table, schedule a write pause or use \`CREATE INDEX CONCURRENTLY\`; ` +
      `a planned maintenance window may favor the faster regular build.`,
  };
}

// ---------------------------------------------------------------------------
// The "Do this first" line for one issue
// ---------------------------------------------------------------------------

interface Fix {
  priority: number;
  rewrite?: Rewrite;
  index?: IndexRecommendation;
}

/** Rewrites are immediately followed by exact-ID dependencies, then supplements. */
function fixesOf(issue: Issue): Fix[] {
  const rewrites = issue.rewrites
    .map((value, order) => ({ value, order }))
    .sort((a, b) => (a.value.priority ?? 3) - (b.value.priority ?? 3) || a.order - b.order);
  const indexes = issue.indexes
    .map((value, order) => ({ value, order }))
    .sort((a, b) => (a.value.priority ?? 3) - (b.value.priority ?? 3) || a.order - b.order);
  const used = new Set<IndexRecommendation>();
  const fixes: Fix[] = [];
  for (const { value: rewrite } of rewrites) {
    fixes.push({ priority: rewrite.priority ?? 3, rewrite });
    for (const required of rewrite.requiresIndexes ?? []) {
      const exact = indexes.filter(({ value }) => matchesRequiredIndex(value, required));
      if (exact.length !== 1 || used.has(exact[0].value)) continue;
      used.add(exact[0].value);
      fixes.push({ priority: exact[0].value.priority ?? 3, index: exact[0].value });
    }
  }
  for (const { value: index } of indexes) {
    if (!used.has(index)) fixes.push({ priority: index.priority ?? 3, index });
  }
  return fixes;
}

function indexIdentities(idx: IndexRecommendation): Set<string> {
  return new Set([idx.id, indexName(idx)].filter((value): value is string => !!value));
}

function isExplicitAlternative(candidate: IndexRecommendation, primary: IndexRecommendation): boolean {
  const candidateRefs = new Set(candidate.redundantWith ?? []);
  const primaryRefs = new Set(primary.redundantWith ?? []);
  return [...indexIdentities(primary)].some((id) => candidateRefs.has(id)) ||
    [...indexIdentities(candidate)].some((id) => primaryRefs.has(id));
}

function indexRole(issue: Issue, idx: IndexRecommendation): 'required dependency' | 'alternative' | 'supplement' {
  if (issue.rewrites.some((rw) => (rw.requiresIndexes ?? []).includes(idx.id))) return 'required dependency';
  const required = issue.indexes.filter((candidate) =>
    issue.rewrites.some((rw) => (rw.requiresIndexes ?? []).includes(candidate.id)),
  );
  const earlier = issue.indexes.filter((candidate) => candidate !== idx && (candidate.priority ?? 3) <= (idx.priority ?? 3));
  if ([...required, ...earlier].some((primary) => isExplicitAlternative(idx, primary))) return 'alternative';
  return 'supplement';
}

function matchesRequiredIndex(idx: IndexRecommendation, requirement: string): boolean {
  return oneLine(requirement).length > 0 && oneLine(idx.id).length > 0 &&
    recognizeCreateIndexDdl(idx.ddl).valid && idx.id === requirement;
}

function isActionable(issue: Issue): boolean {
  return issue.actionability === 'required';
}

function actionItem(issue: Issue, section: number): ListItem {
  const fixes = fixesOf(issue);
  const lead = issue.findings[0];
  let text: string;
  let tag: string;
  let representedRewrite: Rewrite | undefined;
  let representedIndex: IndexRecommendation | undefined;

  const orderedRewrites = [...issue.rewrites].sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));
  const blockedRewrite = orderedRewrites.find((rw) =>
    issue.dependencyProblems.some((problem) => problem.rewriteId === rw.id),
  );

  const coupledRewrite = orderedRewrites
    .map((rw) => ({
      rw,
      idx: (rw.requiresIndexes ?? [])
        .flatMap((required) => issue.indexes.filter((idx) => matchesRequiredIndex(idx, required)))
        .sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3))[0],
    }))
    .find((pair) => pair.idx);

  if (blockedRewrite) {
    const missing = issue.dependencyProblems
      .filter((problem) => problem.rewriteId === blockedRewrite.id)
      .map((problem) => `\`${problem.requiredIndexId}\``)
      .join(', ');
    text = `**BLOCKED — supply exactly one recommendation for ${missing} before ${oneLine(blockedRewrite.title)}**`;
    tag = 'unresolved index dependency';
    representedRewrite = blockedRewrite;
  } else if (coupledRewrite?.idx) {
    const { rw, idx } = coupledRewrite;
    const name = indexName(idx);
    text = `**${oneLine(rw.title)} and create ${name ? `\`${name}\`` : `the required index`}**`;
    const eq = EQUIVALENCE_TAG[rw.equivalence] ?? 'equivalence unstated';
    tag = `coupled rewrite + index · ${eq}`;
    representedRewrite = rw;
    representedIndex = idx;
  } else if (fixes[0]?.rewrite) {
    const rw = fixes[0].rewrite;
    text = `**${oneLine(rw.title)}**`;
    const eq = EQUIVALENCE_TAG[rw.equivalence] ?? 'equivalence unstated';
    tag =
      rw.equivalence === 'different-semantics' && issue.semanticChangeJustified
        ? 'rewrite · changes results, which is the point'
        : `rewrite · ${eq}`;
    representedRewrite = rw;
  } else if (fixes[0]?.index) {
    const idx = fixes[0].index;
    const name = indexName(idx);
    text = `**Create ${name ? `\`${name}\`` : 'an index'}** on \`${indexLabel(idx)}\``;
    tag = `index · ${clip(idx.cost?.estimatedSizeNote ?? 'size not estimated', 40)}`;
    representedIndex = idx;
  } else if (lead?.remediation) {
    text = `**${oneLine(lead.remediation)}**`;
    tag = 'code change';
  } else {
    text = `**Resolve ${oneLine(issue.title)}**`;
    tag = issue.kind === 'correctness' ? 'correctness · no safe automated fix' : 'no concrete fix proposed';
  }

  const why = firstSentence(lead?.impact, 120);
  const remaining = fixes.filter((fix) => fix.rewrite !== representedRewrite && fix.index !== representedIndex);
  const roles = { alternative: 0, supplement: 0, dependency: 0, additional: 0 };
  for (const fix of remaining) {
    if (fix.index) {
      const role = indexRole(issue, fix.index);
      if (role === 'required dependency') roles.dependency++;
      else roles[role]++;
    } else {
      roles.additional++;
    }
  }
  const relationBits = [
    roles.dependency ? `${roles.dependency} dependenc${roles.dependency === 1 ? 'y' : 'ies'}` : '',
    roles.alternative ? `${roles.alternative} alternative${roles.alternative === 1 ? '' : 's'}` : '',
    roles.supplement ? `${roles.supplement} supplement${roles.supplement === 1 ? '' : 's'}` : '',
    roles.additional ? `${roles.additional} additional recommendation${roles.additional === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  const extra = relationBits.length ? `, +${relationBits.join(', +')} in §${section}` : '';
  return {
    text: `${text}${why ? ` — ${why}` : ''} *(${tag}${extra})*`,
    tone: toneFor(issue),
  };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function composeBlocks(m: ReportModel, analysis: Analysis | undefined, maxActions: number): Block[] {
  const out: Block[] = [];
  const push = (b: Block | undefined) => {
    if (b) out.push(b);
  };

  // --- 1. Verdict -----------------------------------------------------------
  push({ kind: 'title', text: m.title, subtitle: m.subtitle });
  push({
    kind: 'banner',
    tone: bannerTone(m),
    label: m.verdict.label,
    text: m.verdict.banner,
  });
  for (const p of m.bottomLine) push({ kind: 'para', text: p });

  // --- 2. Do this first -----------------------------------------------------
  const actions = m.issues
    .map((issue, i) => ({ issue, section: i + 1 }))
    .filter(({ issue }) => isActionable(issue));
  if (actions.length && maxActions > 0) {
    push({ kind: 'heading', level: 2, text: 'Do this first' });
    if (m.verdict.kind === 'incomplete') {
      push({
        kind: 'note',
        tone: 'warn',
        label: 'Provisional actions',
        text: 'Resolve the binding, validation, and dependency blockers before applying these candidate changes.',
      });
    }
    const shown = actions.slice(0, maxActions);
    push({ kind: 'list', ordered: true, items: shown.map(({ issue, section }) => actionItem(issue, section)) });
    if (actions.length > shown.length) {
      const rest = actions.length - shown.length;
      push({
        kind: 'para',
        text: `_${rest} lower-priority action${rest === 1 ? '' : 's'} follow${rest === 1 ? 's' : ''} below._`,
      });
    }
  }

  push({ kind: 'rule' });

  // The report must independently establish which statement it analyzed.
  push({ kind: 'heading', level: 2, text: 'Original SQL' });
  if (m.originalSql) {
    push({ kind: 'code', lang: 'sql', code: m.originalSql });
  } else {
    push({
      kind: 'note',
      tone: 'warn',
      label: 'SQL unavailable',
      text: 'No non-empty original SQL string was supplied; recommendations cannot be tied back to a complete statement.',
    });
  }

  push({ kind: 'rule' });

  // --- 3. One section per issue --------------------------------------------
  m.issues.forEach((issue, i) => issueBlocks(issue, i + 1).forEach(push));

  // --- 4. Checked, no action needed ----------------------------------------
  if (m.cleared.length) {
    push({ kind: 'heading', level: 2, text: 'Checked, no action needed' });
    push({
      kind: 'list',
      items: m.cleared.map(({ finding, followUps }) => ({
        text: `**${oneLine(finding.title)}** — ${oneLine(finding.impact)}`,
        sub: [
          ...(finding.caveat ? [`Would change if: ${oneLine(finding.caveat)}`] : []),
          ...(finding.evidence?.sqlFragment ? [`\`${clip(finding.evidence.sqlFragment, 100)}\``] : []),
          ...followUps.map((t) => `Optional change below: ${t}.`),
        ],
        tone: 'good',
      })),
    });
  }

  // --- 4b. Optional changes (never in the lede) ----------------------------
  if (m.optional.length) {
    push({ kind: 'heading', level: 2, text: 'Optional, low-priority changes' });
    push({
      kind: 'para',
      text: '_These are not part of the recommended fix. Adopt them only if their local readability or maintenance benefit is worth the stated trade-off._',
    });
    for (const issue of m.optional) {
      push({ kind: 'heading', level: 3, text: oneLine(issue.title) });
      const lead = issue.findings[0];
      if (lead?.impact) push({ kind: 'para', text: oneLine(lead.impact) });
      fixBlocks(issue, true).forEach(push);
      if (!issue.rewrites.length && !issue.indexes.length && lead?.remediation) {
        push({ kind: 'note', tone: 'info', label: 'Optional cleanup', text: oneLine(lead.remediation) });
      }
    }
  }

  // --- 4c. Considered and not pursued --------------------------------------
  if (m.deferred.length) {
    push({ kind: 'heading', level: 2, text: 'Considered, not pursued' });
    push({
      kind: 'para',
      text: '_Low confidence and low impact. Named so you know they were looked at, not argued because the evidence is thin._',
    });
    push({
      kind: 'list',
      items: m.deferred.map((f) => ({
        text: `${oneLine(f.title)} — ${clip(f.impact, 180)}`,
        tone: 'muted',
      })),
    });
  }

  // --- 5. What the query means ---------------------------------------------
  semanticsBlocks(m).forEach(push);

  // --- 6. Where the time goes ----------------------------------------------
  executionBlocks(m).forEach(push);

  // --- 7. Provenance and limits --------------------------------------------
  provenanceBlocks(m, analysis).forEach(push);

  return out.filter(Boolean);
}

function bannerTone(m: ReportModel): Tone {
  switch (m.verdict.kind) {
    case 'wrong-results':
      return 'critical';
    case 'possible-wrong-results':
    case 'intent-required':
    case 'incomplete':
      return 'warn';
    case 'needs-work':
      return 'warn';
    case 'clean':
      return 'good';
    default:
      return 'muted';
  }
}

function issueBlocks(issue: Issue, n: number): Block[] {
  const out: Block[] = [];
  const lead = issue.findings[0];

  out.push({ kind: 'heading', level: 2, text: `${n}. ${oneLine(issue.title)}`, badges: badgesFor(issue) });

  // Evidence first: the reader should see the offending SQL before the argument.
  const frag = oneLine(lead?.evidence?.sqlFragment);
  if (frag) {
    const where = [lead?.evidence?.relation, lead?.evidence?.column].filter(Boolean).join('.');
    if (frag.length > 88) {
      out.push({ kind: 'code', lang: 'sql', code: lead!.evidence!.sqlFragment.trim() });
      if (where) out.push({ kind: 'para', text: `_in \`${where}\`_` });
    } else {
      out.push({ kind: 'para', text: `\`${frag}\`${where ? `  —  \`${where}\`` : ''}` });
    }
  }

  if (lead?.impact) out.push({ kind: 'para', text: oneLine(lead.impact) });

  if (issue.confidence === 'low') {
    out.push({
      kind: 'note',
      tone: 'warn',
      label: 'Low confidence',
      text: 'This rests on inference the analyzer could not confirm. Verify it before acting.',
    });
  }
  if (lead?.caveat) {
    out.push({ kind: 'note', tone: 'muted', label: 'Does not apply if', text: oneLine(lead.caveat) });
  }

  // Corroborating findings in the same cluster.
  const others = issue.findings.slice(1);
  if (others.length) {
    out.push({
      kind: 'list',
      items: others.map((f) => ({
        text: `**${oneLine(f.title)}** (${f.severity}, ${f.confidence} confidence) — ${oneLine(f.impact)}`,
        sub: [
          ...(f.evidence?.sqlFragment ? [`\`${clip(f.evidence.sqlFragment, 100)}\``] : []),
          ...(f.caveat ? [`Does not apply if: ${oneLine(f.caveat)}`] : []),
        ],
      })),
    });
  }

  // Runtime evidence for this specific issue.
  for (const c of issue.costs) {
    const share = fmtPct(c.estimatedShare);
    out.push({
      kind: 'note',
      tone: 'muted',
      label: share ? `Predicted runtime share (${share})` : 'Predicted cost driver',
      text: `${oneLine(c.what)} — ${oneLine(c.why)}`,
    });
  }

  fixBlocks(issue, false).forEach((b) => out.push(b));

  if (!issue.rewrites.length && !issue.indexes.length && lead?.remediation && lead.actionability !== 'none') {
    out.push({
      kind: 'note',
      tone: 'info',
      label: lead.actionability === 'optional' ? 'Optional cleanup' : 'What to do',
      text: oneLine(lead.remediation),
    });
  }
  return out;
}

/** Rewrites and index DDL, each with its caveats attached to the code itself. */
function fixBlocks(issue: Issue, compact: boolean): Block[] {
  const out: Block[] = [];
  for (const fix of fixesOf(issue)) {
    if (fix.rewrite) {
      const rw = fix.rewrite;
      if (!compact) {
        out.push({
          kind: 'heading',
          level: 3,
          text: `Fix — ${oneLine(rw.title)}`,
          badges: [EQUIVALENCE_TAG[rw.equivalence] ?? 'equivalence unstated', `priority ${rw.priority ?? 3}`],
        });
      }
      if (rw.rationale) out.push({ kind: 'para', text: oneLine(rw.rationale) });
      if (rw.sql) out.push({ kind: 'code', lang: 'sql', code: rw.sql.trim() });

      if (rw.equivalence === 'conditional') {
        out.push({
          kind: 'note',
          tone: 'warn',
          label: 'Equivalent only if',
          text: oneLine(rw.equivalenceNotes) || 'the assumption was not stated — do not ship this without checking.',
        });
      } else if (rw.equivalence === 'different-semantics') {
        const justified = issue.semanticChangeJustified === true;
        const elsewhere = issue.semanticRiskElsewhere;
        const justifiedText = issue.kind === 'intent'
          ? ' This is an intent branch, not an automatic repair; confirm which population the product should return.'
          : ' An attached correctness finding explains why changing the current rows is the repair; validate the repaired rows against business intent or an independent oracle.';
        const elsewhereText = elsewhere?.kind === 'intent'
          ? ' A material intent finding elsewhere establishes that the population is unsettled. This is an intent-confirmation branch, not an automatic repair; confirm which population the product should return.'
          : elsewhere?.kind === 'correctness'
            ? ' A correctness finding elsewhere establishes query risk, but this proposal is not attached to it. Confirm that this branch addresses that defect before applying it.'
            : '';
        out.push({
          kind: 'note',
          tone: justified || elsewhere ? 'info' : 'critical',
          label: 'Returns different rows',
          text:
            (oneLine(rw.equivalenceNotes) || 'no explanation was given for the difference.') +
            (justified
              ? justifiedText
              : elsewhere
                ? elsewhereText
                : ' No attached correctness finding justifies that change; do not apply this rewrite yet.'),
        });
      } else if (rw.equivalenceNotes) {
        out.push({ kind: 'note', tone: 'muted', label: 'Equivalence', text: oneLine(rw.equivalenceNotes) });
      }

      if (rw.expectedSpeedup) {
        out.push({ kind: 'note', tone: 'muted', label: 'Expected effect (upstream)', text: oneLine(rw.expectedSpeedup) });
      }
      if (rw.requiresIndexes?.length) {
        for (const required of rw.requiresIndexes) {
          const problem = issue.dependencyProblems.find(
            (candidate) => candidate.rewriteId === rw.id && candidate.requiredIndexId === required,
          );
          const supplied = issue.indexes.some((idx) => matchesRequiredIndex(idx, required));
          out.push(
            problem
              ? {
                  kind: 'note',
                  tone: 'critical',
                  label: problem.reason === 'missing' ? 'Required index missing' : 'Required index ID ambiguous',
                  text:
                    `\`${required}\` must resolve to exactly one IndexRecommendation.id. ` +
                    `${problem.reason === 'missing' ? 'No matching recommendation was supplied.' : 'More than one recommendation uses this ID.'} ` +
                    'This action is incomplete; do not assume a similarly named index or DDL substring is the dependency.',
                }
              : supplied
                ? {
                  kind: 'note',
                  tone: 'warn',
                  label: 'Required companion index',
                  text: `\`${required}\` is present in this change set. Deploy and verify the complete set; no component inherits a measured benefit on its own.`,
                }
                : {
                  kind: 'note',
                  tone: 'critical',
                  label: 'Required index not adjacent',
                  text: `\`${required}\` is not present in this issue/change set. Do not apply this rewrite until the exact-ID recommendation is rendered beside it.`,
                },
          );
        }
      }
    }

    if (fix.index) {
      const idx = fix.index;
      if (!compact) {
        const role = indexRole(issue, idx);
        out.push({
          kind: 'heading',
          level: 3,
          text: `Index (${role}) — ${indexLabel(idx)}`,
          badges: [role, `id ${idx.id}`, `priority ${idx.priority ?? 3}`, `${idx.confidence ?? 'medium'} confidence`],
        });
      }
      if (idx.expectedEffect) out.push({ kind: 'para', text: oneLine(idx.expectedEffect) });
      const ddl = recognizeCreateIndexDdl(idx.ddl);
      if (ddl.valid) {
        out.push({ kind: 'code', lang: 'sql', code: idx.ddl.trim() });
        const lock = lockingNote(idx);
        if (lock) out.push({ kind: 'note', tone: lock.tone, label: lock.label, text: lock.text });
      } else {
        out.push({
          kind: 'note',
          tone: 'critical',
          label: 'DDL rejected',
          text: `No complete executable PostgreSQL CREATE INDEX statement was supplied (${ddl.reason}). Do not infer one from the prose.`,
        });
      }

      if (idx.columnOrderRationale) {
        out.push({ kind: 'note', tone: 'muted', label: 'Why this column order', text: oneLine(idx.columnOrderRationale) });
      }
      const cost = [idx.cost?.estimatedSizeNote, idx.cost?.writeImpact].map(oneLine).filter(Boolean).join(' ');
      if (cost) out.push({ kind: 'note', tone: 'muted', label: 'What it costs', text: cost });
      if (idx.serves?.length) {
        out.push({ kind: 'note', tone: 'muted', label: 'Serves', text: idx.serves.map(oneLine).join('; ') });
      }
      if (idx.supersedes?.length) {
        out.push({
          kind: 'note',
          tone: 'info',
          label: 'Drop afterwards',
          text: `${idx.supersedes.join(', ')} — fully covered by this one.`,
        });
      }
      if (idx.redundantWith?.length) {
        out.push({
          kind: 'note',
          tone: 'warn',
          label: 'Overlaps',
          text: `${idx.redundantWith.join(', ')}. Adding both pays the write cost twice; pick one.`,
        });
      }
    }
  }
  return out;
}

function semanticsBlocks(m: ReportModel): Block[] {
  const s = m.semantics;
  const out: Block[] = [];
  const steps = s?.steps ?? [];
  const grain = oneLine(s?.resultShape?.grain);
  const cols = s?.resultShape?.columns ?? [];
  if (!steps.length && !grain && !cols.length && !m.uncoveredCaveats.length) return out;

  out.push({ kind: 'heading', level: 2, text: 'What this query does' });
  if (grain) out.push({ kind: 'para', text: grainSentence(grain) });
  if (steps.length) {
    out.push({
      kind: 'list',
      items: steps.map((st) => ({
        text: `**${oneLine(st.title)}** — ${oneLine(st.detail)}`,
        sub: st.sqlFragment ? [`\`${clip(st.sqlFragment, 100)}\``] : undefined,
      })),
    });
  }
  if (cols.length) {
    out.push({
      kind: 'list',
      items: cols.map((c) => ({ text: `\`${c.name}\` — ${oneLine(c.meaning)}` })),
    });
  }
  // Only the semantic traps no finding above already argued.
  for (const c of m.uncoveredCaveats) {
    out.push({
      kind: 'note',
      tone: 'warn',
      label: oneLine(c.issue),
      text: oneLine(c.why) + (c.sqlFragment ? `  \`${clip(c.sqlFragment, 80)}\`` : ''),
    });
  }
  return out;
}

function hasObservedExecution(m: ReportModel): boolean {
  const execution = m.execution;
  if (!execution) return false;
  return execution.accessPaths.some((path) => /^Observed\b/i.test(oneLine(path.reason))) ||
    execution.joinStrategies.some((join) => /^Observed\b/i.test(oneLine(join.reason))) ||
    execution.dominantCosts.some((cost) => /^Observed\b/i.test(oneLine(cost.what)));
}

function executionBlocks(m: ReportModel): Block[] {
  const e = m.execution;
  const out: Block[] = [];
  if (!e) return out;
  const observed = hasObservedExecution(m);
  const evidenceLabel = observed ? 'Observed' : 'Predicted';
  const mem = e.memoryRisks ?? [];
  const est = e.estimationRisks ?? [];
  const scal = oneLine(e.scalability?.summary);
  if (!m.residualCosts.length && !mem.length && !est.length && !scal && !m.planShape) return out;

  out.push({
    kind: 'heading',
    level: 2,
    text: observed ? 'Observed plan and predicted scaling' : 'Predicted execution and scaling',
  });
  if (m.planShape) out.push({ kind: 'para', text: `**${evidenceLabel} plan shape.** ${m.planShape}` });

  if (m.residualCosts.length) {
    out.push({
      kind: 'list',
      items: m.residualCosts.map((c) => {
        const share = fmtPct(c.estimatedShare);
        return { text: `${share ? `**${evidenceLabel} ${share} share** — ` : `**${evidenceLabel} cost driver** — `}${oneLine(c.what)}: ${oneLine(c.why)}` };
      }),
    });
  }
  if (scal) {
    const cx = oneLine(e.scalability?.complexity);
    out.push({ kind: 'para', text: `**Scaling.** ${scal}${cx ? ` (${cx})` : ''}` });
  }
  for (const r of mem) {
    out.push({ kind: 'note', tone: 'warn', label: `Spill risk — ${oneLine(r.operation)}`, text: oneLine(r.why) });
  }
  if (est.length) {
    out.push({
      kind: 'list',
      items: est.map((r) => ({
        text: `Row estimate at ${oneLine(r.where)} is likely **${r.direction === 'unknown' ? 'unreliable' : r.direction + '-estimated'}** — ${oneLine(r.why)}`,
        tone: 'muted',
      })),
    });
  }
  return out;
}

function provenanceBlocks(m: ReportModel, analysis: Analysis | undefined): Block[] {
  const items: ListItem[] = [];
  const cat = typeof analysis?.catalogName === 'string' ? oneLine(analysis.catalogName) : '';
  if (cat) items.push({ text: `Schema and statistics from \`${cat}\`.` });

  const v = m.verification;
  if (!v) {
    items.push({
      text: 'Live verification was not supplied/run: plan changes, speedups, and result equivalence are unverified.',
      tone: 'muted',
    });
  } else {
    items.push(timingProvenanceItem('Baseline timing', m.timing.baseline));
    items.push(timingProvenanceItem('Optimized timing', m.timing.optimized));
    items.push({
      text:
        v.resultsMatch === true
          ? 'Result check: the tested result sets matched on this dataset; this does not prove logical equivalence for every input.'
          : v.resultsMatch === false
            ? 'Result check: the tested result sets differed; interpret that beside each rewrite’s equivalence class and business intent.'
            : 'Result check: not supplied/not checked.',
      tone: v.resultsMatch === false ? 'critical' : v.resultsMatch === true ? 'good' : 'muted',
    });
    const baselinePlan = v.baselinePlan !== undefined && v.baselinePlan !== null;
    const optimizedPlan = v.optimizedPlan !== undefined && v.optimizedPlan !== null;
    items.push({
      text: `Plan capture: baseline ${baselinePlan ? 'captured' : 'not captured'}; optimized ${optimizedPlan ? 'captured' : 'not captured'}.`,
      tone: baselinePlan && optimizedPlan ? 'good' : 'muted',
    });
    if (baselinePlan && optimizedPlan) {
      items.push({
        text: 'Plan delta: both opaque plan payloads were supplied, but no structured comparison was associated with them; this renderer does not infer a node change from capture alone.',
        tone: 'muted',
      });
    } else if (baselinePlan || optimizedPlan) {
      items.push({
        text: 'Plan delta unavailable: a before/after comparison requires both captured plans.',
        tone: 'muted',
      });
    }
  }
  if (m.execution && hasObservedExecution(m)) {
    items.push({
      text: 'Access paths and cost drivers come from the captured baseline plan. Scaling at other data volumes and the effect of proposed changes remain predicted and unverified.',
      tone: 'muted',
    });
  } else if (m.execution) {
    items.push({
      text: 'Execution paths, row counts, runtime shares, and scaling notes in this report are analyzer predictions unless a finding explicitly cites observed plan evidence.',
      tone: 'muted',
    });
  }
  for (const l of m.limits) items.push({ text: l, tone: 'muted' });

  if (!items.length) return [];
  return [{ kind: 'heading', level: 2, text: 'How far to trust this' }, { kind: 'list', items }];
}

function timingProvenanceItem(label: string, value: TimingValue): ListItem {
  if (value.state === 'measured') {
    return { text: `${label}: measured at ${fmtMs(value.value)}.`, tone: 'good' };
  }
  if (value.state === 'invalid') {
    return { text: `${label}: supplied value rejected (${value.detail}); comparison unavailable.`, tone: 'warn' };
  }
  return { text: `${label}: not measured/supplied.`, tone: 'muted' };
}

// Re-exported for consumers that want the severity ordering used here.
export type { Severity, Finding };
