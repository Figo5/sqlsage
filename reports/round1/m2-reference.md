# M2 round 1 blind reference — plain-English query semantics

**Scope:** Phase 1 only. This is the independent yardstick for
`explainSemantics(ir): SemanticExplanation`. It was written from the SQL, schema,
catalog, refreshed ground truth, PostgreSQL 16 documentation, and a few read-only
checks against the live PostgreSQL 16.14 database. No M2 implementation, M2 output,
or builder reasoning was read.

## What this reference expects

M2 explains the query's **logical result**, not its access path. An ideal explanation
therefore follows the logical transformations—join, filter, group, aggregate,
deduplicate, sort, limit—and names the resulting row grain and every output column.
Plan facts belong in M3 except where a plan observation prevents a semantic
misstatement, as on q10. Correctness defects lead the explanation; they are not
presented as tuning opportunities.

The expected object for each query is written using the four fields of
`SemanticExplanation`. Wording may differ in a candidate output, but none of the
meaning below is optional.

## q01-nonsargable-date

### `headline`

Returns March 2024 complete-order counts and revenue by customer country, ranked from
highest to lowest revenue, where “March” is interpreted in the database session's
time zone.

### `steps`

1. **Match each order to its customer.** Join every order to the single customer whose
   `customer_id` matches the order's non-null foreign key.
   (`c.customer_id = o.customer_id`)
2. **Keep complete orders in the requested local month.** Retain an order only when its
   status is `complete` and truncating `created_at` to the start of its month produces
   the same instant as the `2024-03-01` timestamp-with-time-zone literal.
   (`date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'`)
3. **Summarize by country.** Put the remaining orders into one group per customer
   country code; count joined order rows and sum their non-null `total_cents` values.
4. **Rank the country summaries.** Sort the groups by summed revenue from largest to
   smallest.

### `resultShape`

- **Grain:** One row per country code having at least one matching complete order.
- **Columns:**
  - `country_code`: the matched customer's two-character country code.
  - `order_count`: the number of matching complete orders for that country, not the
    number of customers.
  - `revenue_cents`: the sum of those orders' `total_cents`, in cents.

### `caveats`

- **Session-time-zone boundary:** Both `date_trunc` on a `timestamptz` and the
  zone-less `TIMESTAMPTZ '2024-03-01'` literal use the current `TimeZone`. On the live
  fixture it is `Etc/UTC`, so the effective interval is March 1 00:00 UTC through just
  before April 1 00:00 UTC. Another session zone can include a different set of
  absolute instants.
- **No join multiplication:** `customers.customer_id` is unique and
  `orders.customer_id` is a non-null foreign key, so this join preserves one joined
  row per order. `count(*)` therefore really is an order count here.
- **Revenue ties are not fully ordered:** Countries with equal `revenue_cents` have no
  specified relative order because there is no secondary sort key.

## q02-leading-wildcard-or

### `headline`

Returns up to 50 most recently signed-up customers whose email ends in
`@example.com` or whose full name begins with `Customer 1`.

### `steps`

1. **Test each customer against either search condition.** A customer qualifies if
   the case-sensitive email pattern matches any prefix followed by the literal suffix
   `@example.com`, or if the case-sensitive full-name pattern starts with the literal
   text `Customer 1`. A customer satisfying both branches still contributes only one
   row.
2. **Put newest signups first.** Sort qualifying customer rows by `signup_date`
   descending.
3. **Take only the first 50 rows.** Return at most 50 rows from that ordering.

### `resultShape`

- **Grain:** One row per qualifying customer, capped at 50 rows.
- **Columns:**
  - `customer_id`: the customer's unique identifier.
  - `email`: the customer's email address.
  - `full_name`: the customer's full name.

### `caveats`

- **Pattern semantics:** PostgreSQL `LIKE` is case-sensitive. `%@example.com` means
  “ends with this suffix”; `Customer 1%` means “starts with this prefix.” These are
  string tests, not validated email-domain or person-name semantics.
- **OR does not duplicate rows:** This is one-table filtering, so overlap between the
  two predicates does not emit a customer twice.
- **The chosen 50 are unstable at a tied boundary:** `signup_date` is not unique. If
  multiple qualifying customers tie at the cutoff date, no secondary key says which
  tied customers belong in the 50 or their order within that date.
- **No NULL ambiguity in this schema:** `email`, `full_name`, and `signup_date` are all
  non-null.

## q03-correlated-scalar-subquery

### `headline`

Lists every gold-tier customer with their total number of orders and most recent order
timestamp, sorted by order count from highest to lowest.

### `steps`

1. **Select gold customers.** Keep customer rows whose `loyalty_tier` is exactly
   `gold`.
2. **Count each customer's orders.** For each retained customer, the first correlated
   scalar subquery counts all orders with that `customer_id`; it does not filter by
   order status.
3. **Find each customer's latest order time.** For the same customer, the second
   correlated scalar subquery takes the maximum `created_at` across all their orders.
4. **Sort by the derived count.** Return the customer rows in descending
   `order_count` order.

### `resultShape`

- **Grain:** Exactly one row per gold-tier customer, including a gold customer with no
  orders.
- **Columns:**
  - `customer_id`: the gold customer's unique identifier.
  - `email`: the gold customer's email.
  - `order_count`: the number of that customer's orders across every status.
  - `last_order_at`: the greatest order `created_at` for that customer.

### `caveats`

- **Zero-order behavior must be explicit:** An aggregate scalar subquery without
  `GROUP BY` still returns one row on empty input. `count(*)` is `0`, while
  `max(created_at)` is SQL `NULL`. The outer customer is not removed.
- **Latest timestamp is not an order:** `max(created_at)` supplies only a timestamp;
  it does not identify which order had that timestamp, and ties are not represented
  separately.
- **Tied counts are not fully ordered:** Customers with equal `order_count` have no
  specified relative order.
- **No hidden status filter:** Cancelled, pending, shipped, and complete orders all
  contribute equally.

## q04-deep-offset-pagination

### `headline`

Returns complete orders ranked newest first, skips the first 100,000 in that ranking,
and emits the next 20 with each customer's email.

### `steps`

1. **Attach customer data to orders.** Join each order to its one matching customer.
2. **Keep complete orders.** Remove orders whose status is not `complete`.
3. **Create a total newest-first order.** Sort by `created_at` descending, then by the
   unique `order_id` descending when timestamps tie.
4. **Apply the page window.** Discard positions 1 through 100,000 and return up to the
   next 20 rows.

### `resultShape`

- **Grain:** One row per complete order at positions 100,001 through 100,020 of the
  requested ordering, if those positions exist.
- **Columns:**
  - `order_id`: the order's unique identifier.
  - `created_at`: the order timestamp used as the primary sort key.
  - `total_cents`: the order total in cents.
  - `email`: the email of the customer who owns the order.

### `caveats`

- **This is positional, not identity-based pagination:** Inserts, deletes, or status
  changes before a later execution can shift rows across the 100,000-row boundary,
  causing repeated or skipped business records across page requests.
- **This ordering is deterministic for a fixed snapshot:** `order_id` is unique, so
  `(created_at DESC, order_id DESC)` breaks timestamp ties completely.
- **No duplicate multiplication:** The non-null order foreign key joins to one unique
  customer, preserving one row per order.
- **Empty/short page behavior:** The query returns no rows if there are at most 100,000
  complete orders and fewer than 20 if fewer than 100,020 exist.

## q05-not-in-nullable

### `headline`

**Correctness defect:** although it appears to ask for customers with no checkout
events, this query returns zero rows on the current data because the checkout-ID
subquery contains NULL.

### `steps`

1. **Build the checkout-ID set.** The subquery returns `customer_id` from every
   `checkout` event. It can contain duplicate IDs and SQL NULLs because anonymous
   events are allowed.
2. **Evaluate three-valued `NOT IN` for each customer.** A customer with a matching
   non-null checkout ID gets `FALSE`. A customer without a matching ID gets `UNKNOWN`,
   not `TRUE`, when any subquery row is NULL.
3. **Keep only TRUE predicates.** A `WHERE` clause removes both `FALSE` and `UNKNOWN`,
   so no customer survives in this fixture.

### `resultShape`

- **Grain:** One row per customer for whom `customer_id NOT IN (subquery)` evaluates
  to TRUE; under the current data this is an empty result, not the intended
  no-checkout customer set.
- **Columns:**
  - `customer_id`: the customer's unique, non-null identifier.
  - `email`: that customer's email.

### `caveats`

- **NULL poisoning is the primary finding:** The live data has 100,000 checkout
  events, including 14,285 with `customer_id IS NULL`. One such NULL is sufficient.
  The observed result is 0 rows, while the NULL-safe `NOT EXISTS` meaning produces
  196,000 customers.
- **This is wrong-answer behavior, not a performance caveat:** If the business request
  is “customers for whom no checkout event with the same customer ID exists,”
  correlated `NOT EXISTS` expresses that meaning. It ignores anonymous checkout rows
  because they cannot equal a non-null customer ID.
- **Duplicates do not change membership:** Repeating a non-null checkout ID only
  repeats the same comparison; NULL presence, not duplicate presence, changes the
  surprising outcome.
- **No ordering is promised:** There is no `ORDER BY`, even in a dataset where rows
  would survive.

## q06-fanout-double-count

### `headline`

**Correctness defect:** ranks 100 customers by a join-multiplied “revenue” that repeats
each complete order total once per item; `item_count` counts item rows, not orders or
units.

### `steps`

1. **Join customers to complete orders.** Match customers to their orders and retain
   only orders whose status is `complete`.
2. **Expand every order to its item rows.** Join each retained order to
   `order_items`. An order with N item rows now appears N times; a complete order with
   no item rows disappears because this is an inner join.
3. **Aggregate the expanded rows per customer.** Group by customer ID and email.
   `sum(o.total_cents)` adds the same order total once for every joined item row, while
   `count(*)` counts the joined item rows.
4. **Rank and cap.** Sort the customer groups by the multiplied sum descending and
   return at most 100.

### `resultShape`

- **Grain:** One row per customer having at least one item row on at least one complete
  order, limited to the first 100 by the computed (inflated) revenue value.
- **Columns:**
  - `customer_id`: the customer's unique identifier.
  - `email`: that customer's email.
  - `revenue_cents`: as written, the sum of each complete order's total repeated once
    per item row; it is not true customer revenue.
  - `item_count`: the number of `order_items` rows across the customer's complete
    orders.

### `caveats`

- **Revenue is silently over-counted:** On the live fixture each order has exactly
  three item rows, so the query reports 1,280,102,100,000 cents instead of the correct
  426,700,700,000 cents—exactly 3.0000×. Runtime is secondary to this wrong answer.
- **The multiplication factor is data-dependent in general:** If item counts vary,
  both the amount and the top-100 ranking become biased toward customers whose orders
  have more item rows. Uniform three-item orders preserve this fixture's relative
  ranking but do not make the totals correct.
- **`item_count` is a row count:** It is not an order count and does not sum
  `order_items.quantity`; a line with quantity 5 still contributes one.
- **Boundary ties are unspecified:** Equal computed revenues have no secondary sort
  key, so order—and potentially membership at the 100-row cutoff—is not deterministic.

## q07-left-join-demoted

### `headline`

**Correctness/intent defect:** despite spelling a left join, the query returns only
customers signed up on or after January 1, 2024 who have complete orders, with one row
per complete order; customers without one are removed.

### `steps`

1. **Start with customers and left-match their orders.** The left join initially
   creates one row per matching order and a NULL-filled order side for a customer with
   no orders.
2. **Apply both WHERE conditions after the join.** Keep customers whose signup date is
   at least January 1, 2024 and rows whose order status equals `complete`.
3. **Discard NULL-extended rows.** For a customer with no matching order—or no complete
   order—`o.status = 'complete'` is NULL/unknown on the NULL-filled row, and `WHERE`
   removes it. Multiple complete orders remain as multiple rows.

### `resultShape`

- **Grain:** One row per complete order belonging to a customer whose signup date is
  on or after January 1, 2024; not one row per customer.
- **Columns:**
  - `customer_id`: the qualifying customer's identifier.
  - `email`: that customer's email.
  - `order_id`: a complete order's identifier.
  - `total_cents`: that complete order's total in cents.

### `caveats`

- **The outer-row guarantee is lost:** Placing the right-table status test in `WHERE`
  makes the result equivalent to an inner join for this predicate. If the intended
  result includes recent-signup customers with no complete orders, the status test
  belongs in `ON`; those customers would then appear with NULL order columns.
- **If only matched orders are intended, say so:** Then an explicit inner join has the
  same logical result and communicates intent accurately. The current left-join
  spelling is not a way to preserve customers.
- **Returned order fields cannot be NULL here:** Although the syntax is a left join,
  the status filter ensures every surviving row has an actual order; `order_id` and
  `total_cents` are non-null in the schema as well.
- **No output ordering is promised:** There is no `ORDER BY`.

## q08-distinct-hides-fanout

### `headline`

Returns each unique customer who has at least one order of any status dated on or
after January 1, 2024 containing an item whose product is in category 42.

### `steps`

1. **Follow the purchase-path joins.** Join customers to their orders, orders to every
   item row, and each item to its product.
2. **Keep qualifying order-item paths.** Retain joined rows where the product's
   `category_id` is 42 and the order timestamp is at or after the stated boundary.
3. **Project customer identity and attributes.** Select only customer ID, email, and
   loyalty tier. One customer can still have many identical projected rows because
   several qualifying items or orders create several join paths.
4. **Remove duplicate projected rows.** `SELECT DISTINCT` collapses equal triples.
   Since `customer_id` is a primary key and determines the other two values, the final
   result has at most one row per customer.

### `resultShape`

- **Grain:** One row per unique customer having at least one qualifying
  customer→order→item→product path.
- **Columns:**
  - `customer_id`: the qualifying customer's unique identifier.
  - `email`: that customer's email.
  - `loyalty_tier`: that customer's current loyalty tier.

### `caveats`

- **Fan-out is real before DISTINCT:** Multiple matching item rows and multiple orders
  multiply intermediate rows. `DISTINCT` changes only the final projected result; it
  does not mean there was one logical join row per customer.
- **No completed-order requirement:** The query includes pending, cancelled, shipped,
  and complete orders alike because it has no `status` predicate. Describing these
  customers simply as purchasers would overstate the SQL.
- **The timestamp literal uses the session zone:** Because the zone-less text is cast
  to `timestamptz`, January 1 midnight is interpreted in the current `TimeZone`
  (`Etc/UTC` in the fixture).
- **No ordering is promised:** `DISTINCT` does not sort the result contractually, and
  there is no `ORDER BY`.

## q09-cast-on-column

### `headline`

Counts all orders by session-local calendar day from June 1 through June 30, 2024,
inclusive, and returns only days that have orders.

### `steps`

1. **Convert each order instant to a local date.** Cast `created_at` from
   timestamp-with-time-zone to `date` using the current session `TimeZone`.
2. **Keep dates in the inclusive June range.** `BETWEEN DATE '2024-06-01' AND DATE
   '2024-06-30'` includes both boundary dates.
3. **Count orders per derived date.** Group by the same date expression and count all
   order rows in each group, regardless of status.
4. **Return dates chronologically.** Sort the date groups ascending.

### `resultShape`

- **Grain:** One row per session-local calendar date in the requested range that has
  at least one order; dates with zero orders do not appear.
- **Columns:**
  - `day`: the session-local date derived from `created_at`.
  - `orders`: the number of orders whose derived date equals that day.

### `caveats`

- **Day boundaries depend on `TimeZone`:** The same stored instant can fall on a
  different date in another session. The live fixture uses `Etc/UTC`; without fixing
  a business zone, this query's membership and labels are session-dependent.
- **June 30 is fully included under the written cast:** The predicate compares dates,
  not timestamps, so every instant mapping to local June 30 qualifies. Any equivalent
  raw-timestamp expression must preserve the half-open upper boundary at local July 1.
- **No status filter:** Every order status contributes.
- **No synthetic zero rows:** Grouping source rows cannot create a calendar day that
  has no matching order.

## q10-having-instead-of-where

### `headline`

Returns order count and total revenue for each customer ID below 1000 that has at
least six orders, counting orders of every status.

### `steps`

1. **Group orders by customer ID.** Form one group for each `orders.customer_id`.
2. **Compute both aggregates.** Count all order rows in the group and sum their
   non-null `total_cents` values.
3. **Keep only qualifying groups.** The `HAVING` clause retains groups whose count is
   greater than 5 and whose grouped customer ID is less than 1000.
4. **Project each surviving summary.** Return the group key and its two aggregate
   values; no final row order is requested.

### `resultShape`

- **Grain:** One row per `customer_id < 1000` having six or more orders.
- **Columns:**
  - `customer_id`: the grouped order customer identifier.
  - `order_count`: the number of that customer's orders across all statuses.
  - `revenue`: the sum of those orders' `total_cents`, in cents.

### `caveats`

- **Grouped-key HAVING is semantically valid:** `customer_id` is the grouping key, so
  it has one value per group. Testing it in `HAVING` has the same result as filtering
  `customer_id < 1000` in `WHERE`; `count(*) > 5`, by contrast, is an aggregate
  condition that genuinely applies to completed groups.
- **Do not confuse logical order with physical execution:** Logically both written
  conditions filter groups. The PostgreSQL 16.14 plan safely pushes the grouped-key
  condition into the index scan and reads only 9,990 orders before aggregation. It is
  therefore wrong to claim this spelling necessarily aggregates all two million
  orders or that moving the key predicate to `WHERE` promises a speedup; here that is
  at most a clarity rewrite with essentially the same plan.
- **No customer-table attributes are read:** This groups `orders` directly. The schema
  foreign key guarantees referenced customers today, but the result itself contains
  only order-derived data.
- **No ordering is promised:** There is no `ORDER BY`.

## q11-top-n-per-group

### `headline`

Returns every order tied for the latest timestamp within its customer, so the result
can contain more than one row per customer.

### `steps`

1. **Consider every order as an outer candidate.** There is no status or date filter.
2. **Find that candidate's customer maximum.** For each outer order, the correlated
   scalar subquery computes the maximum `created_at` across all orders having the same
   `customer_id`.
3. **Keep equality ties.** Retain the outer order when its `created_at` equals that
   maximum. Every order sharing the maximum timestamp satisfies the equality.
4. **Sort by customer.** Order the retained rows by `customer_id` ascending.

### `resultShape`

- **Grain:** One row per latest-tied order for each customer represented in `orders`,
  not guaranteed to be one row per customer.
- **Columns:**
  - `customer_id`: the order owner's identifier.
  - `order_id`: the identifier of a latest-tied order.
  - `created_at`: that order's timestamp, equal to the customer's maximum.
  - `total_cents`: that latest-tied order's total in cents.

### `caveats`

- **Ties are preserved, not broken:** If two orders for a customer share the greatest
  timestamp, both are returned. Any explanation saying “exactly one latest order per
  customer” is wrong unless uniqueness of `(customer_id, created_at)` is separately
  guaranteed; it is not here.
- **Order within a tied customer is unspecified:** The final sort names only
  `customer_id`, so multiple latest-tied rows for that customer have no stated
  `order_id` order.
- **Customers with no orders cannot appear:** `customers` is not an input; the outer
  relation is `orders`.
- **Current cardinality is not a semantic guarantee:** The fixture returns 200,000
  rows—one per represented customer—but future timestamp ties can increase that count.

## q12-jsonb-and-unbounded-sort

### `headline`

Returns at most one `email`-source summary for add-to-cart and checkout events since
June 1, 2024: total qualifying event rows and distinct known customers.

### `steps`

1. **Extract the campaign source as text.** For each event, `payload->>'utm_source'`
   reads the top-level JSON value as SQL text.
2. **Apply all three filters.** Keep rows whose extracted source equals `email`, whose
   timestamp is at or after the timestamp-with-time-zone boundary, and whose type is
   either `add_to_cart` or `checkout`.
3. **Group by the extracted source.** `GROUP BY 1` refers to the first select-list
   expression. Because the filter fixes that expression to `email`, all qualifying
   rows form one group.
4. **Compute two different counts.** `count(*)` counts every qualifying event row;
   `count(DISTINCT customer_id)` counts unique non-null customer IDs only.
5. **Sort group summaries by event count.** With the current constant filter there is
   at most one group, so this ordering cannot change the result.

### `resultShape`

- **Grain:** At most one row: the `email` source group if at least one event qualifies.
  If no rows qualify, `GROUP BY` emits zero rows rather than a row containing zeroes.
- **Columns:**
  - `source`: the extracted text value; necessarily `email` for every emitted row.
  - `events`: the number of qualifying event rows, including rows with NULL
    `customer_id`.
  - `customers`: the number of distinct non-null customer IDs among those rows.

### `caveats`

- **Anonymous events affect the two counts differently:** `events.customer_id` is
  nullable. A qualifying anonymous event increases `events` but is ignored by
  `count(DISTINCT customer_id)`; repeated known-customer events count once in
  `customers`. The refreshed fixture has 111,589 qualifying events and 20,000 distinct
  known customers (and happens to have no anonymous row within this particular
  filtered slice).
- **Missing or nonmatching JSON structure is excluded:** `->>` returns SQL NULL when
  the requested field/path is absent or structurally unavailable; JSON null also
  yields no text value. `NULL = 'email'` is unknown, and `WHERE` removes the row.
- **The lower-bound instant uses the session zone:** The zone-less
  `TIMESTAMPTZ '2024-06-01'` literal is interpreted in the current `TimeZone`; on this
  fixture it means `2024-06-01 00:00:00+00` and the comparison is inclusive.
- **`GROUP BY 1` is positional:** It currently means the source expression. Reordering
  the select list without updating the ordinal can silently change or invalidate the
  grouping intent.

## Semantic rules and fixture checks used

- PostgreSQL 16 documents the decisive `NOT IN` rule: if no equal row is found but at
  least one subquery row is NULL, the result is NULL rather than TRUE:
  <https://www.postgresql.org/docs/16/functions-subquery.html#FUNCTIONS-SUBQUERY-NOTIN>.
- `count(*)` counts input rows, `count(expression)` counts non-null inputs, and
  aggregates other than `count` return NULL for empty input:
  <https://www.postgresql.org/docs/16/functions-aggregate.html>.
- A `timestamptz` passed to `date_trunc` is truncated in the current `TimeZone` unless
  an explicit zone is supplied:
  <https://www.postgresql.org/docs/16/functions-datetime.html#FUNCTIONS-DATETIME-TRUNC>.
- A right-side predicate in `WHERE` is applied after a left join and can remove the
  NULL-extended rows; putting the same restriction in `ON` has different semantics:
  <https://www.postgresql.org/docs/16/queries-table-expressions.html>.
- `DISTINCT` removes duplicate projected rows, while lack of a sufficient `ORDER BY`
  leaves relative order unspecified:
  <https://www.postgresql.org/docs/16/queries-select-lists.html#QUERIES-DISTINCT> and
  <https://www.postgresql.org/docs/16/queries-order.html>.
- JSON extraction returns SQL NULL when the requested structure/key is absent:
  <https://www.postgresql.org/docs/16/functions-json.html>.

Read-only live checks confirmed `TimeZone = Etc/UTC`, q05's 14,285 NULL checkout IDs
and 0-vs-196,000 result split, and q12's 111,589 event rows / 20,000 distinct known
customers. Ground-truth plans supplied the remaining fixture observations, including
q06's exact 3.0000× multiplication and q10's grouped-key predicate pushdown.

---

**Phase 1 boundary:** no candidate M2 output or M2 source has been inspected. This
reference intentionally contains no comparison, score, conviction decision, or
verdict block.
