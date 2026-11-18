import catalogJson from '../corpus/catalog.json';
import { CORPUS } from '../corpus/queries.ts';
import { detectAntiPatterns } from '../src/antipatterns/index.ts';
import { bindQuery } from '../src/ir/index.ts';
import type { Catalog, Finding, Severity } from '../src/types.ts';

const catalog = catalogJson as unknown as Catalog;

const DEMO_ID = 'q05-not-in-nullable';

const sqlInput = document.getElementById('sql') as HTMLTextAreaElement;
const exampleSelect = document.getElementById('example') as HTMLSelectElement;
const analyzeButton = document.getElementById('analyze') as HTMLButtonElement;
const summary = document.getElementById('summary') as HTMLParagraphElement;
const messages = document.getElementById('messages') as HTMLDivElement;
const findingsRoot = document.getElementById('findings') as HTMLDivElement;
const schemaRoot = document.getElementById('schema') as HTMLDivElement;

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
};

const numberFormat = new Intl.NumberFormat('en-US');

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

function populateExamples(): void {
  for (const query of CORPUS) {
    const option = document.createElement('option');
    option.value = query.id;
    option.textContent = `${query.id} — ${query.title}`;
    exampleSelect.append(option);
  }

  const initial = CORPUS.find((query) => query.id === DEMO_ID) ?? CORPUS[0];
  if (initial) {
    exampleSelect.value = initial.id;
    sqlInput.value = initial.sql;
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function clearMessages(): void {
  messages.replaceChildren();
}

function addMessage(kind: 'error' | 'warn' | 'info', text: string, fragment?: string): void {
  const box = element('div', `message ${kind}`);
  box.append(element('p', undefined, text));

  if (fragment) {
    const detail = element('span', 'fragment', 'In: ');
    const code = element('code', undefined, fragment);
    detail.append(code);
    box.append(detail);
  }

  messages.append(box);
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function findingCard(finding: Finding): HTMLElement {
  const article = element('article', `finding severity-${finding.severity}`);
  article.dataset.severity = finding.severity;

  const head = element('div', 'finding-head');
  head.append(
    element('span', 'badge', SEVERITY_LABEL[finding.severity]),
    element(
      'span',
      'meta',
      [finding.category, `${finding.confidence} confidence`, finding.actionability].join(' · '),
    ),
    element('h3', undefined, finding.title),
  );
  article.append(head);

  const details = element('dl');

  const addRow = (label: string, value: string, className?: string) => {
    const row = element('div', className);
    row.append(element('dt', undefined, label), element('dd', undefined, value));
    details.append(row);
  };

  addRow('Impact', finding.impact);
  addRow('Remediation', finding.remediation);
  addRow('Caveat', finding.caveat ?? 'None recorded for this finding.');
  article.append(details);

  const evidence = element('p', 'evidence', 'Evidence: ');
  evidence.append(element('code', undefined, finding.evidence.sqlFragment));
  article.append(evidence);

  return article;
}

function renderFindings(findings: Finding[], blocked: boolean): void {
  findingsRoot.replaceChildren();

  if (findings.length === 0) {
    const empty = element(
      'p',
      'empty',
      blocked
        ? 'No findings were established from the parts of the query that could be bound. Resolve the binding messages above to analyze the whole statement.'
        : 'No findings from the bundled antipattern detector for this query. That is not a proof that the query is optimal.',
    );
    findingsRoot.append(empty);
    return;
  }

  for (const finding of findings) findingsRoot.append(findingCard(finding));
}

function renderSummary(findings: Finding[]): void {
  if (findings.length === 0) {
    summary.textContent = 'No findings';
    return;
  }

  const counts = new Map<Severity, number>();
  for (const finding of findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  const detail = (['critical', 'high', 'medium', 'low', 'info'] as Severity[])
    .filter((severity) => counts.has(severity))
    .map((severity) => `${counts.get(severity)} ${severity}`)
    .join(' · ');

  summary.textContent = `${findings.length} finding${findings.length === 1 ? '' : 's'} — ${detail}`;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function schemaTable(table: Catalog['tables'][number]): HTMLElement {
  const section = element('section', 'schema-table');

  const heading = element('h3', undefined, `${table.schema}.${table.name}`);
  section.append(heading);

  const meta: string[] = [`${table.columns.length} columns`];
  if (table.rowCount !== undefined) meta.push(`~${numberFormat.format(table.rowCount)} estimated rows`);
  if (table.primaryKey?.length) meta.push(`primary key (${table.primaryKey.join(', ')})`);
  section.append(element('p', 'schema-meta', meta.join(' · ')));

  const scroll = element('div', 'table-scroll');
  const grid = element('table');

  const thead = element('thead');
  const headRow = element('tr');
  for (const label of ['Column', 'Type', 'Nullable']) {
    headRow.append(element('th', undefined, label));
  }
  thead.append(headRow);
  grid.append(thead);

  const tbody = element('tbody');
  const primaryKey = new Set(table.primaryKey ?? []);
  for (const column of table.columns) {
    const row = element('tr');
    const name = element('td');
    name.append(element('span', 'column-name', column.name));
    if (primaryKey.has(column.name)) name.append(element('span', 'pk', 'PK'));

    row.append(
      name,
      element('td', 'type', column.dataType),
      element('td', undefined, column.nullable ? 'yes' : 'no'),
    );
    tbody.append(row);
  }
  grid.append(tbody);
  scroll.append(grid);
  section.append(scroll);

  return section;
}

function renderSchema(): void {
  schemaRoot.replaceChildren();
  for (const table of catalog.tables) schemaRoot.append(schemaTable(table));
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function runAnalysis(): void {
  clearMessages();
  summary.textContent = '';
  findingsRoot.replaceChildren();

  const sql = sqlInput.value.trim();
  if (!sql) {
    addMessage('error', 'Enter a SQL query to analyze.');
    summary.textContent = 'Waiting for a query';
    return;
  }

  let ir: ReturnType<typeof bindQuery>;
  let findings: Finding[];
  try {
    ir = bindQuery(sql, catalog);
    findings = detectAntiPatterns(ir, catalog);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    addMessage('error', `Analysis failed unexpectedly: ${text}`);
    summary.textContent = 'Analysis failed';
    return;
  }

  const bindingErrors = ir.bindingErrors;
  const hardErrors = bindingErrors.filter((error) => error.severity === 'error');

  if (ir.statementType !== 'select') {
    addMessage(
      'error',
      `Only SELECT statements are supported; received ${ir.statementType}.`,
    );
  }

  for (const error of bindingErrors) {
    addMessage(
      error.severity === 'error' ? 'error' : 'warn',
      `${error.severity === 'error' ? 'Binding error' : 'Binding warning'}: ${error.message}`,
      error.sqlFragment,
    );
  }

  if (hardErrors.length > 0) {
    // Findings can still be useful for the part that bound, but they must not
    // look like a complete verdict over a query the binder could not read.
    addMessage(
      'warn',
      `Analysis is incomplete: ${hardErrors.length} binding error${hardErrors.length === 1 ? '' : 's'} prevented the whole statement from being resolved.`,
    );
  }

  renderSummary(findings);
  renderFindings(findings, hardErrors.length > 0 || ir.statementType !== 'select');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

exampleSelect.addEventListener('change', () => {
  const query = CORPUS.find((candidate) => candidate.id === exampleSelect.value);
  if (!query) return;
  sqlInput.value = query.sql;
  runAnalysis();
});

analyzeButton.addEventListener('click', runAnalysis);

sqlInput.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    runAnalysis();
  }
});

populateExamples();
renderSchema();
runAnalysis();
