/** Round-2 reproduction suite, written by the critic. */
import { q05Analysis, q07Analysis, clone, show } from './adv-m7.ts';
import type { Analysis } from '../../src/types.ts';

// --- Realistic baselines first -------------------------------------------
show('R1. q05 realistic — NULL-poisoned NOT IN (well formed)', q05Analysis, 22);
show('R2. q07 realistic — LEFT JOIN demoted (well formed)', q07Analysis, 22);

// --- Round-2 failure 1: hard binding error + correctness finding ----------
const a1 = clone(q05Analysis) as Analysis;
a1.ir.bindingErrors = [
  { message: 'Relation "shop.evnets" is not in the catalog', sqlFragment: 'FROM shop.evnets e', severity: 'error' },
];
show('A1. hard binding ERROR + confident correctness finding', a1, 12);

const a1b = clone(q05Analysis) as Analysis;
a1b.ir.bindingErrors = [
  { message: 'Parameter $1 has no declared type', sqlFragment: 'x = $1', severity: 'warn' },
];
show('A1b. binding WARN only + correctness finding (should stay WRONG RESULTS)', a1b, 12);

// --- Round-2 failure 2: blank / whitespace-only required fields ------------
const blanks: Array<[string, (a: Analysis) => void]> = [
  ['analysis.sql blank + ir.originalSql blank', (a) => { a.sql = '   \n\t '; a.ir.originalSql = '  '; }],
  ['finding.evidence.sqlFragment whitespace', (a) => { a.findings[0].evidence.sqlFragment = '   '; }],
  ['finding.impact whitespace', (a) => { a.findings[0].impact = '\t\n '; }],
  ['finding.remediation whitespace', (a) => { a.findings[0].remediation = ' '; }],
  ['rewrite.sql whitespace', (a) => { a.rewrites[0].sql = '   '; }],
  ['index.ddl whitespace', (a) => { a.indexes[0].ddl = '  \n '; }],
];
for (const [name, mutate] of blanks) {
  const a = clone(q05Analysis) as Analysis;
  mutate(a);
  show('A2. blank required field — ' + name, a, 10);
}

// --- Round-2 failure 3: invalid required index satisfying a dependency -----
const a3 = clone(q05Analysis) as Analysis;
a3.rewrites[0].requiresIndexes = ['idx_events_checkout_customer'];
a3.indexes[0].ddl = '';
show('A3. exact-ID required index with EMPTY ddl', a3, 14);

const a3b = clone(q05Analysis) as Analysis;
a3b.rewrites[0].requiresIndexes = ['idx_events_checkout_customer'];
a3b.indexes[0].ddl = '-- TODO: write the DDL';
show('A3b. exact-ID required index with NON-EMPTY but NON-DDL text', a3b, 14);

const a3c = clone(q05Analysis) as Analysis;
a3c.rewrites[0].requiresIndexes = ['idx_events_checkout_customer'];
a3c.indexes[0].ddl = 'DROP TABLE shop.events;';
show('A3c. exact-ID required index whose "ddl" is a DROP TABLE', a3c, 14);

// --- Round-2 failure 4: required index id matching nothing -----------------
const a4 = clone(q05Analysis) as Analysis;
a4.rewrites[0].requiresIndexes = ['idx_that_does_not_exist'];
show('A4. required index id matches nothing', a4, 14);

// --- Round-2 failure 5: actionability none + arbitrary remediation prose ----
const a5 = clone(q05Analysis) as Analysis;
a5.findings = [{
  id: 'sort-volume-observation',
  title: 'The result set is sorted after aggregation',
  severity: 'medium',
  category: 'performance',
  actionability: 'none',
  evidence: { sqlFragment: 'ORDER BY revenue_cents DESC' },
  impact: 'A top-N heapsort over 36 kB. Nothing here is worth changing.',
  remediation: 'Immediately drop every index and rewrite the application layer.',
  confidence: 'high',
}];
a5.indexes = [];
a5.rewrites = [];
a5.verification = undefined;
a5.semantics.caveats = [];
show('A5. performance finding actionability=none + alarming remediation prose', a5, 20);

const a5b = clone(a5) as Analysis;
a5b.findings[0].category = 'correctness';
show('A5b. CORRECTNESS finding actionability=none + alarming remediation prose', a5b, 20);

const a5c = clone(a5) as Analysis;
a5c.findings[0].category = 'intent';
a5c.findings[0].severity = 'high';
show('A5c. INTENT finding actionability=none + alarming remediation prose', a5c, 20);
