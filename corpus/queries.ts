/**
 * The judgment corpus.
 *
 * Every query here is one a real team has shipped and later had to fix. Each
 * carries a distinct, expert-known failure mode. `whatExpertsSay` is NOT the
 * answer key used by the acceptance suite — it is the axis that checks coverage
 * along, and it deliberately understates the full expert analysis.
 */

export interface CorpusQuery {
  id: string;
  title: string;
  sql: string;
  /** The headline defect that the acceptance suite must detect. */
  primaryIssue: string;
  /** Secondary issues an expert would also raise. */
  secondaryIssues: string[];
  /** True when the query returns WRONG RESULTS, not merely slow ones. */
  correctnessBug: boolean;
  difficulty: 1 | 2 | 3;
}

export const CORPUS: CorpusQuery[] = [
  {
    id: 'q01-nonsargable-date',
    title: 'Monthly revenue via date_trunc on the filtered column',
    sql: `SELECT c.country_code,
       count(*) AS order_count,
       sum(o.total_cents) AS revenue_cents
FROM shop.orders o
JOIN shop.customers c ON c.customer_id = o.customer_id
WHERE date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'
  AND o.status = 'complete'
GROUP BY c.country_code
ORDER BY revenue_cents DESC;`,
    primaryIssue:
      'date_trunc() wraps the indexed column, so no btree index on created_at can be used; must be rewritten as a half-open range.',
    secondaryIssues: [
      'Half-open range [2024-03-01, 2024-04-01) is the correct rewrite, not BETWEEN with an inclusive upper bound.',
      'A partial or composite index on (status, created_at) serves both predicates; column order matters.',
      'status = complete is 85% of rows, but equality still belongs before the created_at range in the composite btree; this ordering was verified on the live corpus.',
      'timestamptz vs timestamp comparison makes the boundary session-timezone dependent.',
    ],
    correctnessBug: false,
    difficulty: 1,
  },
  {
    id: 'q02-leading-wildcard-or',
    title: 'Customer search with leading wildcard and OR across columns',
    sql: `SELECT customer_id, email, full_name
FROM shop.customers
WHERE email LIKE '%@example.com'
   OR full_name LIKE 'Customer 1%'
ORDER BY signup_date DESC
LIMIT 50;`,
    primaryIssue:
      'Leading wildcard defeats btree entirely; the OR across two columns prevents a single index from serving both branches.',
    secondaryIssues: [
      'OR can be split into a UNION of two index-backed branches, but only the second branch is indexable at all.',
      'text_pattern_ops is required for LIKE prefix matching under a non-C collation.',
      'A trigram (pg_trgm GIN) index is the real fix for infix matching.',
      'ORDER BY ... LIMIT on an unrelated column forces a full sort of all matches.',
    ],
    correctnessBug: false,
    difficulty: 2,
  },
  {
    id: 'q03-correlated-scalar-subquery',
    title: 'Per-customer order counts via correlated scalar subqueries',
    sql: `SELECT c.customer_id,
       c.email,
       (SELECT count(*) FROM shop.orders o WHERE o.customer_id = c.customer_id) AS order_count,
       (SELECT max(o2.created_at) FROM shop.orders o2 WHERE o2.customer_id = c.customer_id) AS last_order_at
FROM shop.customers c
WHERE c.loyalty_tier = 'gold'
ORDER BY order_count DESC;`,
    primaryIssue:
      'Two correlated scalar subqueries each re-scan orders per customer row; they should collapse into one grouped join or LATERAL.',
    secondaryIssues: [
      'The two subqueries scan the same rows twice — a single aggregate does both.',
      'LEFT JOIN LATERAL preserves customers with zero orders; an inner join would silently drop them.',
      'count(*) returns 0 but max() returns NULL for customers with no orders — the join rewrite must preserve that.',
      'loyalty_tier = gold is 1% of 200k rows, so an index on it is worthwhile and changes the driving side.',
    ],
    correctnessBug: false,
    difficulty: 2,
  },
  {
    id: 'q04-deep-offset-pagination',
    title: 'Deep OFFSET pagination over the orders feed',
    sql: `SELECT o.order_id, o.created_at, o.total_cents, c.email
FROM shop.orders o
JOIN shop.customers c ON c.customer_id = o.customer_id
WHERE o.status = 'complete'
ORDER BY o.created_at DESC, o.order_id DESC
LIMIT 20 OFFSET 100000;`,
    primaryIssue:
      'OFFSET 100000 makes the engine produce and discard 100k rows; cost grows linearly with page depth.',
    secondaryIssues: [
      'Keyset (seek) pagination on the (created_at, order_id) tuple is the fix and is O(1) per page.',
      'The composite ORDER BY needs a matching composite index with matching direction to avoid a sort.',
      'Row-value comparison (created_at, order_id) < (?, ?) is the correct keyset predicate, not separate ANDed comparisons.',
      'Keyset pagination cannot jump to an arbitrary page number — a real product constraint, not just a code change.',
    ],
    correctnessBug: false,
    difficulty: 2,
  },
  {
    id: 'q05-not-in-nullable',
    title: 'Customers with no events, via NOT IN on a nullable column',
    sql: `SELECT c.customer_id, c.email
FROM shop.customers c
WHERE c.customer_id NOT IN (
    SELECT e.customer_id FROM shop.events e WHERE e.event_type = 'checkout'
);`,
    primaryIssue:
      'events.customer_id is nullable; a single NULL in the subquery makes NOT IN return zero rows. This is a correctness bug, not a performance one.',
    secondaryIssues: [
      'NOT EXISTS is the correct rewrite and also enables an anti-join plan.',
      'NOT IN forces a materialized hashed subplan that cannot short-circuit.',
      'Adding WHERE customer_id IS NOT NULL to the subquery fixes correctness but keeps the worse plan.',
      'LEFT JOIN ... WHERE right IS NULL is a third form, equivalent here but easier to get wrong.',
    ],
    correctnessBug: true,
    difficulty: 2,
  },
  {
    id: 'q06-fanout-double-count',
    title: 'Revenue per customer joined through order_items',
    sql: `SELECT c.customer_id,
       c.email,
       sum(o.total_cents) AS revenue_cents,
       count(*) AS item_count
FROM shop.customers c
JOIN shop.orders o ON o.customer_id = c.customer_id
JOIN shop.order_items oi ON oi.order_id = o.order_id
WHERE o.status = 'complete'
GROUP BY c.customer_id, c.email
ORDER BY revenue_cents DESC
LIMIT 100;`,
    primaryIssue:
      'The join to order_items multiplies each order row by its item count, so sum(o.total_cents) over-counts revenue by roughly 3x.',
    secondaryIssues: [
      'Correct forms: aggregate order_items in a subquery first, or sum(DISTINCT) only if order totals are distinct (they are not, reliably).',
      'count(*) counts items, not orders — probably not what the column name promises.',
      'The over-counting is silent and proportional to items per order, so it is invisible in spot checks.',
      'Pre-aggregating before the join also shrinks the row count feeding the group/sort.',
    ],
    correctnessBug: true,
    difficulty: 3,
  },
  {
    id: 'q07-left-join-demoted',
    title: 'Customers and their complete orders, filtered in WHERE',
    sql: `SELECT c.customer_id, c.email, o.order_id, o.total_cents
FROM shop.customers c
LEFT JOIN shop.orders o ON o.customer_id = c.customer_id
WHERE o.status = 'complete'
  AND c.signup_date >= DATE '2024-01-01';`,
    primaryIssue:
      'The WHERE clause on the outer-joined table filters out the NULL-extended rows, silently turning the LEFT JOIN into an INNER JOIN.',
    secondaryIssues: [
      'If the intent was to keep customers with no complete orders, the predicate must move into the ON clause.',
      'If the intent was an inner join, writing LEFT JOIN misleads every future reader and blocks join reordering reasoning.',
      'The planner does recognize and demote this, so the plan is not slower — the defect is intent, not cost.',
      'signup_date >= 2024-01-01 is the selective predicate and should drive the scan.',
    ],
    correctnessBug: true,
    difficulty: 2,
  },
  {
    id: 'q08-distinct-hides-fanout',
    title: 'DISTINCT used to undo a join fan-out',
    sql: `SELECT DISTINCT c.customer_id, c.email, c.loyalty_tier
FROM shop.customers c
JOIN shop.orders o ON o.customer_id = c.customer_id
JOIN shop.order_items oi ON oi.order_id = o.order_id
JOIN shop.products p ON p.product_id = oi.product_id
WHERE p.category_id = 42
  AND o.created_at >= TIMESTAMPTZ '2024-01-01';`,
    primaryIssue:
      'DISTINCT is being used to collapse duplicates the joins created; EXISTS expresses the intent directly and lets the planner stop at the first match.',
    secondaryIssues: [
      'The join materializes every matching item before deduplicating — work proportional to items, not customers.',
      'A semi-join via EXISTS short-circuits per customer.',
      'DISTINCT over a wide row list forces a sort or hash-aggregate on all output columns.',
      'Nested EXISTS or a single EXISTS with the joins inside are both valid; the inner form matters for index use.',
    ],
    correctnessBug: false,
    difficulty: 2,
  },
  {
    id: 'q09-cast-on-column',
    title: 'Daily order counts with a cast applied to the indexed column',
    sql: `SELECT o.created_at::date AS day, count(*) AS orders
FROM shop.orders o
WHERE o.created_at::date BETWEEN DATE '2024-06-01' AND DATE '2024-06-30'
GROUP BY o.created_at::date
ORDER BY day;`,
    primaryIssue:
      'Casting created_at to date in the predicate blocks any btree index on created_at; the range must be expressed on the raw column.',
    secondaryIssues: [
      'timestamptz::date is not immutable (it depends on TimeZone), so it cannot even be indexed as an expression without a fixed zone.',
      'BETWEEN on dates includes all of 2024-06-30 only because of the cast; the raw-column rewrite needs a half-open upper bound of 2024-07-01.',
      'The GROUP BY may keep the cast; only the WHERE predicate needs rewriting.',
      'An expression index on (created_at AT TIME ZONE UTC)::date is the immutable form if the cast must stay.',
    ],
    correctnessBug: false,
    difficulty: 3,
  },
  {
    id: 'q10-having-instead-of-where',
    title: 'Aggregate with a row filter placed in HAVING',
    sql: `SELECT o.customer_id, count(*) AS order_count, sum(o.total_cents) AS revenue
FROM shop.orders o
GROUP BY o.customer_id
HAVING count(*) > 5
   AND o.customer_id < 1000;`,
    primaryIssue:
      'FALSE-POSITIVE TRAP. The folk rule says "a non-aggregate filter in HAVING scans everything, move it to WHERE." ' +
      'Verified against the real plan: Postgres 16 already pushes customer_id < 1000 down to a Bitmap Index Scan ' +
      '(Index Cond, 9990 rows read out of 2M) and the query runs in ~6 ms. The correct expert answer is that moving ' +
      'the predicate to WHERE is a readability improvement worth ~0 ms, NOT a performance fix. An analyzer that ' +
      'promises a speedup here is wrong, and confidently wrong is worse than silent.',
    secondaryIssues: [
      'count(*) > 5 legitimately belongs in HAVING — the two conditions are genuinely different in kind.',
      'The pushdown is legal because customer_id is a grouping key; it would NOT be pushed down for a non-grouped column.',
      'That distinction — grouping key vs not — is the actual expert insight, and it is what the folk rule flattens.',
      'Stating the rewrite as "clearer, same plan" is the honest framing; verify with EXPLAIN rather than asserting.',
    ],
    correctnessBug: false,
    difficulty: 3,
  },
  {
    id: 'q11-top-n-per-group',
    title: 'Most recent order per customer via a correlated max()',
    sql: `SELECT o.customer_id, o.order_id, o.created_at, o.total_cents
FROM shop.orders o
WHERE o.created_at = (
    SELECT max(o2.created_at) FROM shop.orders o2 WHERE o2.customer_id = o.customer_id
)
ORDER BY o.customer_id;`,
    primaryIssue:
      'Correlated max() re-scans orders per row; DISTINCT ON or a window function computes the same answer in one pass.',
    secondaryIssues: [
      'Ties on created_at return multiple rows per customer — DISTINCT ON silently picks one, changing results.',
      'DISTINCT ON (customer_id) ... ORDER BY customer_id, created_at DESC is the Postgres-idiomatic form.',
      'row_number() OVER (PARTITION BY customer_id ORDER BY created_at DESC) is portable and makes tie-breaking explicit.',
      'An index on (customer_id, created_at DESC) can supply the required order and avoid a separate sort, but PostgreSQL 16 still scans all index entries; btree skip scan arrives in PostgreSQL 18.',
    ],
    correctnessBug: false,
    difficulty: 3,
  },
  {
    id: 'q12-jsonb-and-unbounded-sort',
    title: 'Event funnel filtered on a jsonb attribute',
    sql: `SELECT e.payload->>'utm_source' AS source,
       count(*) AS events,
       count(DISTINCT e.customer_id) AS customers
FROM shop.events e
WHERE e.payload->>'utm_source' = 'email'
  AND e.occurred_at >= TIMESTAMPTZ '2024-06-01'
  AND e.event_type IN ('add_to_cart', 'checkout')
GROUP BY 1
ORDER BY events DESC;`,
    primaryIssue:
      'The jsonb extraction in WHERE has no supporting index; an expression btree on (payload->>\'utm_source\') or a GIN index is needed.',
    secondaryIssues: [
      'A composite btree on (event_type, occurred_at) plus the expression is likely better than GIN for this equality-on-one-key shape.',
      'count(DISTINCT ...) forces a sort or hashed distinct per group and is the usual hidden cost in funnel queries.',
      'GROUP BY 1 groups by the same expression already filtered to a single value — the group key is constant, so the GROUP BY is redundant.',
      'jsonb ->> returns text; comparisons and any expression index must agree on the type.',
    ],
    correctnessBug: false,
    difficulty: 3,
  },
];
