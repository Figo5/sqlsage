# Tutorial 1 — catching a query that returns the wrong answer

**Time:** about two minutes. **You need:** SQLSage. No database, no files.

Most query tools tell you a query is slow. This one starts by telling you it is
*wrong* — and this tutorial walks through a query that silently returns nothing.

## Run it

```bash
sqlsage analyze --corpus q05
```

`--corpus` runs against a bundled example schema, so nothing here touches your data.

## What you get

```text
WRONG RESULTS
This query returns wrong answers today. Fix that before you spend a minute on
its speed.

Nullable NOT IN subquery can invalidate anti-membership. SQL NOT IN becomes
UNKNOWN for every otherwise-unmatched outer row if this subquery emits even one
NULL.
```

The query under analysis looks entirely reasonable:

```sql
SELECT c.customer_id, c.email
FROM shop.customers c
WHERE c.customer_id NOT IN (
    SELECT e.customer_id FROM shop.events e WHERE e.event_type = 'checkout'
);
```

"Customers who never checked out." It reads correctly and it runs without error.

## Why it is wrong

`NOT IN` against a subquery that can produce `NULL` is a three-valued-logic trap.
If the subquery emits even one `NULL`, then for every outer row that does not match,
the comparison evaluates to `UNKNOWN` rather than `TRUE` — and `UNKNOWN` rows are not
returned. The result set collapses.

SQLSage names the specific column and quantifies the exposure from catalog statistics
rather than asserting it in the abstract:

```text
Catalog statistics report 14.5% NULL overall (about 725,170 of 5,000,022 rows)
for events.customer_id.
```

### Proving it

On the reference database this query returns **zero rows**, and the repair returns
**196,000**:

| query | rows returned |
|---|---:|
| `NOT IN` (original) | **0** |
| `NOT EXISTS` (SQLSage's rewrite) | **196,000** |

There are 14,285 `checkout` events with a `NULL` customer_id. One would have been
enough.

A query returning zero rows is the lucky case, because somebody notices. The same bug
against a subquery that is *usually* non-NULL returns plausible-looking output that is
quietly missing rows.

## The fix SQLSage proposes

```sql
SELECT c.customer_id, c.email
FROM "shop"."customers" AS "c"
WHERE (NOT EXISTS (
  SELECT 1 FROM "shop"."events" AS "e"
  WHERE e.event_type = 'checkout' AND "e"."customer_id" = "c"."customer_id"
));
```

`NOT EXISTS` tests actual equality per row and is not poisoned by unrelated `NULL`s
elsewhere in the subquery output.

## The part worth reading twice

SQLSage labels this rewrite **`changes results`**, and says so plainly:

```text
Returns different rows: This intentionally repairs the original wrong-result
behavior when the subquery can emit NULL; it can return outer rows that NOT IN
incorrectly suppresses. Review that corrected population as a correctness change.
```

That label is not hedging. A rewrite that changes what your query returns is a
decision only you can sign off, even when the new answer is the correct one — some
system downstream may have been built around the broken output. SQLSage will not
quietly "fix" your results without telling you it did.

## Next

- Tutorial 2 shows a performance fix, and why an index on its own can be worthless:
  [02-non-sargable-date.md](02-non-sargable-date.md)
- Run it against a query of your own:
  ```bash
  sqlsage analyze --query yours.sql --schema schema.sql
  ```
