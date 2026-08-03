# Limitations and known gaps

Where SQLSage's advice is weak, what it does not model, and where it has actually been
wrong.

[Supported constructs](SUPPORTED.md) answers a different question — *will my input
parse?* This page answers *should I trust what comes back?*

Everything here is measured or was observed in a real failure. Nothing is a hypothetical
caveat added for safety.

## Times SQLSage has been confidently wrong

The most useful thing a tool can tell you is where it has already misled someone.

### `doctor` blamed the user's install for its own bug

On the first Windows install, `demo`, `doctor` and every bundled-corpus query failed with
`ENOENT ... 'C:\C:\...\corpus\catalog.json'` — a doubled drive letter. `doctor` reported:

```
FAIL  Bundled example catalog
      the packaged catalog could not be read: ENOENT ...
      fix: npm install --global sqlsage    # reinstall; the package appears to be incomplete
```

The package was complete and correctly installed. The path was built from a URL's
`pathname`, which keeps the leading slash on a drive-letter path. Reinstalling could
never have helped, and produced byte-identical output the second time.

Fixed in 0.2.1. Windows now runs in CI. But the shape of the failure is worth keeping in
mind: **a check that reports a failure it cannot distinguish from its own defect will
blame you.** If a `doctor` fix does not change anything, suspect `doctor`.

### An index recommendation that measured slower on its own

On the corpus q01 case, the recommended index applied *without* the accompanying rewrite
measures **111.5 ms against a 111.5 ms baseline** — no improvement — and the planner
never uses it, because `date_trunc()` hides the column. Only the coupled pair reaches
20.4 ms.

SQLSage now renders a rewrite and the index it requires as a single step for this reason.
The general lesson stands: **a change set is not a menu.** Applying half of one can be
worth nothing, and occasionally worse than nothing.

## Advice quality

### Query parameters weaken everything downstream

`$1` and `$2` bind without error and produce a full report. But a placeholder carries no
value, so selectivity for a predicate on it falls back to defaults rather than your data —
and selectivity is what drives index choice, column order, and cost ranking.

**Work around it** by substituting a representative literal before analyzing. A value
typical of production gives materially better advice than a placeholder.

### Offline selectivity is an estimate about an estimate

Without `--database-url` or `--plan`, execution behaviour is *predicted*. Every such claim
is labelled `Offline prediction` or `Predicted/unverified` in the report — that labelling
is load-bearing, not decoration.

What happens without statistics depends on the predicate, and the distinction matters:

- **Equality** (`status = 'complete'`) falls back to the uniform `1/n_distinct`
  assumption when the value is not in the catalog's most-common-values list — the same
  assumption PostgreSQL makes.
- **Ranges, pattern matches, expressions, JSON extraction and correlated subqueries
  decline entirely.** They need histogram or multivariate statistics an exported catalog
  does not carry, so SQLSage returns no estimate rather than inventing one, and the report
  says the predicate *"lacks a complete selectivity estimate in the exported catalog"*.

So a missing estimate is reported as missing. It is the equality fallback, not the
declined ones, that can quietly be wrong — a uniform assumption on a skewed column is a
plausible number rather than an absent one.

**Work around it** by supplying a real plan. `--plan` with `EXPLAIN (ANALYZE, FORMAT JSON)`
replaces prediction with observation, and is what surfaces where the planner itself was
wrong.

### Index sizes and costs are never measured

Every `CREATE INDEX` recommendation states that its size is unmeasured. SQLSage does not
build candidate indexes and does not time them. Write amplification is described
qualitatively, not quantified.

**Work around it** by testing inside a transaction you roll back — see
[tutorial 2](tutorials/02-non-sargable-date.md).

## What the analysis does not model

| Not modelled | Consequence |
|---|---|
| `CHECK` constraint predicates | Accepted, then ignored. A `CHECK` cannot change columns, keys, indexes or nullability, so nothing downstream reads it. |
| Partition bounds and pruning | A partitioned table is understood structurally, but SQLSage will not tell you a query prunes to one partition. |
| View definitions beyond column resolution | A view's columns resolve; the cost of its underlying query does not fold into the analysis. |
| Parallelism, cache state, `work_mem` tuning | Hash-spill risk is flagged from catalog sizes, but degree of parallelism and buffer behaviour are not predicted. |
| Trigger, rule, and function side effects | SQL bodies are skipped entirely. A `SELECT` calling a volatile function is analyzed as if it were pure. |
| Cross-query index consolidation | Each query is analyzed alone, so two analyses can suggest overlapping indexes. |

## Where conservatism costs precision

These are deliberate trades. In each case SQLSage prefers a noisier answer to a missed
correctness signal — which means false positives you should expect.

**`fanOut` is noisier than it looks.** It means "this join multiplies *either* input". A
plain lookup onto a primary key reports `true` whenever the left input is not unique. That
is literally correct, but reading the bare boolean as "something is wrong" over-fires;
the finding logic keys off which relations are multiplied *and* whether an aggregate
touches them.

**Uniqueness that cannot be proven is assumed absent.** If a relation's uniqueness is not
provable from the catalog, SQLSage treats it as non-unique. A derived table without a
provable unique output key will over-report multiplication.

**View column nullability is inherited only for a single-source direct projection.** Across
a join, every view column is reported nullable, because an outer join, aggregate or `CASE`
can introduce NULLs the source column's declaration does not show. Over-claiming `NOT NULL`
would corrupt the null-rejection analysis; under-claiming only weakens a verdict.

**Correlated `LATERAL` shapes fall back to pessimism.** A correlation through an
expression, reaching two levels out, or into a lateral block that joins several relations
is treated as keyless.

## Scope boundaries

- **PostgreSQL only.** No MySQL, SQLite, or others, and none are planned.
- **One `SELECT` at a time.** `INSERT`/`UPDATE`/`DELETE` are recognized and refused.
  `WITH RECURSIVE`, `GROUPING SETS`, `CUBE` and `ROLLUP` are binding errors.
- **SQLSage never executes a recommendation.** Rewrites and index DDL are yours to run.
  `--analyze` runs *your query*, once, inside a read-only transaction — and read-only
  cannot stop side effects inside an unfamiliar volatile function.
- **A single capture is not a benchmark.** `compare` says so beside every timing verdict
  and refuses to call anything an improvement below 1.2x.

## Reporting a gap

The most valuable report is a **false positive** — advice that was confidently wrong on a
real query. A sanitized query plus its schema is enough; a plan captured with
`EXPLAIN (FORMAT JSON)` is better.

<https://github.com/Figo5/sqlsage/issues>

## Related

- [Supported constructs](SUPPORTED.md) — what parses and what is rejected, measured by
  `eval/scope-probe.ts`
- [Usage and inputs](USAGE.md) — the full input contract
- [Architecture](ARCHITECTURE.md) — the analysis pipeline
