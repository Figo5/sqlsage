# M7 Round-7 adversarial critique

## Protocol and independent baseline

This review follows the mandatory blind order. I read `docs/CRITIC-BRIEF.md` and
`docs/EXPERT-SOURCES.md` in full, then adopted the frozen
`reports/round1/m7-reference.md` before opening any current output or source. I
rechecked all corpus SQL, the raw schema and catalog, and all twelve ground-truth
plans. Those anchors still support the frozen reference: q05 and q06 are definite
wrong-result blockers, q07 is an intent blocker, q10 is the PostgreSQL 16 pushdown
trap, and M7 must preserve action dependencies and evidence calibration rather than
invent analysis.

The live PostgreSQL instance began this round with exactly eight indexes in `shop`:
the six primary keys plus `idx_order_items_order_id` and
`idx_orders_customer_id`. All live grammar probes in this round will use temporary
objects inside `BEGIN`/`ROLLBACK`, will not execute `CONCURRENTLY`, and will recheck
that count.

## Incremental findings

Current implementation and prior-round artifacts have not yet been opened at this
point. Findings and probe evidence will be appended below as the adversarial review
progresses.

### E1 — current artifact and preserved baseline

- `node --test src/report/report.test.ts`: **46 pass, 0 fail**.
- `node eval/dump-report.ts --first15`: all checks pass.
- `node eval/run.ts`: **12/12** compose and M2-M6 remain explicitly absent.
- Both Round-5 probes exit 0. Exact-ID chains, stars, multi-index components,
  mixed blockers, q01-like coupling, and the q07 target remain intact; their
  documented repeated-ID and unrelated-global-intent defects also remain.
- The Round-4 determinism/generalization probe exits 0: ANSI/plain parity,
  cross-process determinism, no mutation, schema rename, and no corpus/query
  special-casing all pass.
- The saved Round-6 differential and renderer probes now stop only at stale
  expectations that malformed `WITH (fillfactor 80)` remains accepted. Their
  earlier broad controls and basic/stateful defenses pass before those stale
  assertions.
- Report syntax checks pass. Executable renderer source contains no corpus ID,
  exact corpus SQL, or anchor phrase.

### E2 — first fresh PostgreSQL 16 differential tranche

`reports/round7/m7-ddl-pg16-differential-probe.ts` is the fresh live-server
matrix. Its first completed tranche exits 0:

- All **eight** saved Round-6 false accepts are individually re-run. M7 rejects
  every one, and PostgreSQL 16 independently rejects every one at syntax/lexical
  analysis. No early stale assertion hides the remaining cases.
- Nine broad ordinary forms both pass recognition and execute on transaction-local
  TEMP objects: named/unnamed, unique/`IF NOT EXISTS`, quoted identifiers,
  `ONLY`, `USING`, expression and decorated keys, `INCLUDE` including quoted
  reserved names, `NULLS NOT DISTINCT`, supported word/numeric/ordinary/dollar
  storage values, `TABLESPACE`, partial predicates, comments, arrays, JSON,
  and semicolons inside strings.
- `CONCURRENTLY` is derived only from its grammar position and is never executed.
  The persistent `shop` index count remains exactly **8**.

### E3 — fresh 100-case matrix finds one statement-boundary false accept

The expanded fresh probe runs all 100 neighbors before its aggregate assertion,
so the counterexample does not hide later cases. After classifying PostgreSQL's
unterminated-literal/comment diagnostics as lexical rejection, it records:
**1 false accept, 18 safe false rejects, 59 agreement rejects, and 22 recognizer
accepts that either execute or reach only semantic/catalog checks**.

The false accept is a bare-carriage-return line-comment boundary. Given one
ordinary `CREATE INDEX` terminated by `;`, then `-- comment`, then a bare `\r`
and a second executable token sequence, `lexCreateIndex()` treats everything
after `--` as a comment because it searches only for `\n`. PostgreSQL's scanner
ends the comment at `\r`, exposes the second statement, and reports its syntax
error. `recognizeCreateIndexDdl()` nevertheless returns `valid: true`, violating
its “one complete executable statement” contract and the preserved arbitrary
multi-statement boundary.

This is not an option-value, object, opclass, immutability, or access-method
capability error: the disagreement is at lexical statement identity before
catalog semantics. Every TEMP transaction rolled back and the persistent
`shop` index count remains exactly **8**.

### E4 — the lexical false accept propagates end to end

`reports/round7/m7-ddl-renderer-e2e-probe.ts` exits 0 and exercises both normal
model construction and the renderer's lowest public path.

- All eight saved grammar failures are rejected before component formation;
  their exact-ID requirements become missing, the verdict is incomplete, and
  no DDL or locking advice renders.
- Ordinary `DROP TABLE`, comment-only, incomplete, and obvious second-statement
  payloads retain the same protection.
- The stateful getter defense still works: invalid text introduced after model
  construction is independently revalidated and receives neither DDL nor lock
  advice.
- The bare-CR false accept defeats all shared checks. It enters `model.indexes`,
  satisfies the exact-ID dependency, is called a coupled rewrite+index action,
  renders inside a SQL block (with the control byte made visible as `\\x0D`),
  and receives M7-authored regular-`CREATE INDEX` write-lock advice. The visible
  control escaping reduces copy/paste risk, but does not repair the false claim
  that the payload is one complete index statement or the false dependency and
operational classification.

The 18 conservative rejects include the already documented opclass-parameter,
valid `U& ... UESCAPE`, and `E` families, plus legitimate neighboring syntax the
notes do not enumerate: value-less storage options, signed/leading-decimal
values, no-whitespace dollar-quoted option/predicate/expression values, a bare
column-name keyword as an index key, a qualified option name, an extra empty
statement, and an INCLUDE expression that PostgreSQL parses before rejecting
semantically. Safe rejection is preferable to deployment falsehood, but it is
not free: missing-value options and arbitrary whitespace are ordinary grammar,
and the key/opclass cases can be M5-relevant.

The end-to-end probe also checks rejection language. `E`/`U&` cases are
calibrated as “outside the supported subset,” but legitimate opclass-parameter
syntax is reported as “not valid PostgreSQL syntax”; the ColId key and adjacent
dollar forms are called empty/incomplete. Those are inaccurate M7-authored
diagnostics for server-parsed grammar, even though the conservative block itself
is safe.

## Final adjudicated verdict

- Correctness: **31/40** — the saved Round-6 grammar false accepts, ordinary DDL
  controls, dependency handling, q10 trap, and structural safety gates all pass,
  but the bare-CR lexical disagreement admits a PostgreSQL-rejected second
  statement and turns it into deployable index advice. Malformed
  `missingModules`, optional validation noise, and implausible finite timing
  ratios also preserve factual overclaims under degraded input.
- Completeness: **23/30** — coupled actions and incomplete dependencies are
  substantially preserved, but valid grammar can disappear behind conservative
  rejection, and a supplied correctness remediation is hidden when
  `actionability: none`.
- Clarity: **16/20** — the report is ordered and actionable on supported inputs,
  yet several server-parsed forms receive inaccurate syntax diagnostics and the
  blocked-action line still has unmatched Markdown emphasis.
- Calibration: **5/10** — unsupported `E`/`U&` forms are labeled conservatively,
  but the CR-smuggled payload receives ordinary `CREATE INDEX` operational
  guidance and extreme finite ratios are still labeled measured speedups.
- Mandatory deduction: **-25 confident and wrong** — the renderer calls the
  bare-CR multi-statement payload a valid coupled index action and supplies
  lock/build guidance even though PostgreSQL 16 rejects it at statement parsing.
- Special-casing deduction: **0** — the saved audit found no corpus ID, exact SQL,
  or anchor-phrase branching.

SCORE: 50
CONVINCED: no
BIGGEST_GAP: In `src/report/index-ddl.ts`, make `--` comments terminate on every PostgreSQL line ending, including a bare carriage return, so a CR followed by a second statement is rejected before dependency formation or rendering.
GAP_DETAIL: The Round-7 differential probe shows `lexCreateIndex()` accepts a terminated `CREATE INDEX`, `-- comment`, bare `\r`, and a second executable token sequence, while PostgreSQL 16 ends the comment at `\r` and syntax-rejects the exposed second statement. The end-to-end probe shows that payload satisfying the rewrite dependency, rendering as a coupled action, and receiving regular-index lock guidance, which is a confident deployment falsehood. Fixed means LF, CRLF, and bare-CR comment boundaries all match PostgreSQL statement identity, with trailing-comment-only input still accepted and any executable text after the line ending rejected before model construction and again at render time.
