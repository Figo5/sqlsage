# Bundled Examples

SQLSage ships a demonstration catalog and twelve realistic queries. They cover the
correctness and performance problems the tool is designed to catch, and none of them
touch your data:

```bash
sqlsage list
sqlsage analyze --corpus q05 --format text
```

| ID | Title | The problem it shows |
|---|---|---|
| `q01-nonsargable-date` | Monthly revenue via `date_trunc` on the filtered column | An index the planner cannot use. |
| `q02-leading-wildcard-or` | Customer search with leading wildcard and `OR` across columns | Non-sargable `LIKE` and `OR`. |
| `q03-correlated-scalar-subquery` | Per-customer order counts via correlated scalar subqueries | Correlated work. |
| `q04-deep-offset-pagination` | Deep `OFFSET` pagination over the orders feed | The cost of skipping rows. |
| `q05-not-in-nullable` | Customers with no events, via `NOT IN` on a nullable column | A query that returns the **wrong answer**. |
| `q06-fanout-double-count` | Revenue per customer joined through `order_items` | Join fan-out double counting. |
| `q07-left-join-demoted` | Customers and their complete orders, filtered in `WHERE` | Demotion of an outer join. |
| `q08-distinct-hides-fanout` | `DISTINCT` used to undo a join fan-out | Fan-out hidden behind `DISTINCT`. |
| `q09-cast-on-column` | Daily order counts with a cast applied to the indexed column | A cast that defeats the index. |
| `q10-having-instead-of-where` | Aggregate with a row filter placed in `HAVING` | Row filter misplaced in `HAVING`. |
| `q11-top-n-per-group` | Most recent order per customer via a correlated `max()` | Per-group top-N. |
| `q12-jsonb-and-unbounded-sort` | Event funnel filtered on a `jsonb` attribute | `jsonb` filtering and a full sort. |

## Start with the wrong answer

`q05` is the demo query — a nullable `NOT IN` that can silently return zero rows
instead of 196,000:

```bash
sqlsage analyze --corpus q05 --format text
```

```text
WRONG RESULTS
This query returns wrong answers today. Fix that before you spend a minute on
its speed.
```

It is the best first example because it shows the product's strongest claim: SQLSage
tells you a query is *wrong* before it tells you it is slow.

## Run them all

```bash
for q in $(sqlsage list | awk '{print $1}'); do
  echo "== $q =="
  sqlsage analyze --corpus "$q" --format markdown
done
```

Each example is also a regression case: the analysis runs in CI on every commit, and
the `--check` IR assertions pin the project's real regression history.
