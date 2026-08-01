# M7 report renderer — round-5 builder notes

## Round 8: PostgreSQL line-comment boundaries

The shared `recognizeCreateIndexDdl()` lexer now ends `--` comments at any
PostgreSQL line ending: LF, CRLF, or a bare carriage return. Previously it
searched only for LF, so executable text after a bare CR remained hidden as
comment text. A terminated `CREATE INDEX` followed by that payload could enter
the model, satisfy an exact-ID rewrite dependency, render as deployable DDL,
and receive regular-index locking guidance even though PostgreSQL exposed and
syntax-rejected the second statement. The repair is limited to the line-comment
scanner; string, dollar-quoted, and nested block-comment scanning is unchanged.

The focused suite now has 48 tests. The new table-driven boundary regression
accepts DDL followed only by a trailing comment at LF, CRLF, and bare-CR
endings; rejects executable text after each ending before index validation and
dependency formation; and proves comment-like bytes containing the same line
endings remain inert inside ordinary strings, dollar quotes, and block comments.
A separate stateful-input test proves the renderer independently revalidates
the bare-CR case after model construction and withholds the payload and locking
advice.

### Round-8 verification

`node --test src/report/report.test.ts` passes 48/48. The report dump and
12-query integration commands both exit 0, as do strip-types syntax checks for
the report sources/tests and eval entry points plus imports of the public report
and DDL-recognizer modules. The two saved Round-5 probes and the Round-4
determinism/generalization probe exit 0. The saved Round-4 regression and
coupling probes still stop at their documented stale pre-Round-6 and pre-Round-5
defect assertions (lines 234 and 168 respectively); this round does not change
those unrelated outcomes.

The Round-7 differential probe now completes its 100-case matrix with
`falseAccepts=0`, then exits 1 at line 298 because its stale defect assertion
expects the bare-CR payload to remain valid (`false !== true`). Its broad live
PostgreSQL controls pass, and it executes no `CONCURRENTLY` DDL. The Round-7
renderer probe passes its saved grammar and arbitrary-payload defenses, then
exits 1 at line 114 for the same stale `valid === true` expectation before its
old false-deployment assertions can run. The focused end-to-end regression now
covers their inverted model and render expectations.

For the disabled-fix proof, the repaired file hash was saved, the old LF-only
`indexOf('\\n')` scanner was temporarily restored, and the two new tests were
run by name. Both failed: the model-time test reaccepted the bare-CR executable
payload and the render-time test emitted the payload plus regular-index advice
instead of `DDL rejected`. Restoring the repair returned `index-ddl.ts` to the
same SHA-256 (`86aac2b2...7d892e`). The final read-only database query reports
exactly eight persistent `shop` indexes.

## Round 7: PostgreSQL 16 CREATE INDEX grammar soundness

The shared `recognizeCreateIndexDdl()` boundary now validates every clause that
is omitted from the bundled parser's compatibility core. The supported `WITH`
subset is intentionally explicit: one or more comma-separated, unqualified
`parameter = scalar-value` items, where the value is one word, an ordinary or
dollar-quoted string, or a well-formed decimal number. Expression-like token
runs, missing/extra equality operators, omitted values, and trailing tokens are
rejected. PostgreSQL supports a wider `reloption_elem` grammar, but accepting a
smaller exact subset is safer than substituting the index expression grammar.

`INCLUDE` accepts simple PostgreSQL `ColId` identifiers only, and `TABLESPACE`
accepts one PostgreSQL `name`/`ColId`. The embedded PostgreSQL 16 category-R and
category-T keyword set comes from `pg_get_keywords()`; those words cannot pass
unquoted in these name positions, while non-empty quoted forms remain allowed.
This also tightens index, table, access-method, and qualified-name components.
The recognizer rejects zero-length quoted identifiers and invalid UTF-16/NUL
input before normalization.

The bundled expression parser accepts an empty right side for `ANY ()` even
though PostgreSQL 16 does not. A token-level guard now rejects empty `ANY`,
`ALL`, and `SOME` constructs in both index keys and partial predicates while
retaining non-empty array quantifiers. PostgreSQL `U&` strings/identifiers and
`E` escape strings are conservatively outside this round's accepted subset:
their payload validity cannot be preserved by the parser normalization that is
needed for ordinary and dollar-quoted strings. This deliberately retains the
known safe false rejection of valid `U& ... UESCAPE` syntax. Operator-class
parameter syntax also remains conservatively rejected by the bundled parser.

The focused suite has 46 passing tests. Its new table-driven matrix
covers all eight saved PostgreSQL-invalid false accepts, surrounding valid
storage/identifier/quantifier controls, additional empty quantifiers, empty and
type-keyword identifiers, unsupported escape forms, exact-ID blocking, absence
of DDL/lock advice, and independent renderer revalidation. The untouched
Round-6 PostgreSQL differential probe now stops at its first stale assertion:
it expects malformed `WITH (fillfactor 80)` to remain accepted, while the fixed
recognizer returns `false`.

Builder-authored live verification against PostgreSQL 16.14 created a TEMP
table and executed 12 ordinary indexes inside `BEGIN`/`ROLLBACK`: unnamed and
named basics, `UNIQUE IF NOT EXISTS`, quoted names, `ONLY`, `USING`, multiple
and expression keys, array/JSON expressions, collation/opclass/order/null
decorations, `INCLUDE` (including a quoted reserved column), `NULLS NOT
DISTINCT`, both supported storage parameters, `TABLESPACE pg_default`, a
partial predicate, interleaved comments, and ordinary/dollar strings containing
semicolons. Every statement executed, the transaction rolled back, and the
persistent `shop` index count remained eight. `CONCURRENTLY` was tested only as
a position-sensitive recognizer signal and was never executed.

### Round-7 disabled-fix proof

Fixed files were saved under `/tmp/sqlsage-m7-round7.ZYuIIP/`. Four guards were
independently disabled and restored with `apply_patch`:

- replacing the storage-parameter validator with the old expression-list check
  reaccepted `WITH (fillfactor 80)`;
- restoring permissive word-as-identifier behavior reaccepted unquoted
  `INCLUDE (select)`;
- disabling the empty-quantifier check reaccepted `WHERE flag = ANY ()`;
- restoring normalization for `U&` strings reaccepted the invalid unpaired
  surrogate payload.

For each mutant, both the focused recognizer matrix and the end-to-end
dependency/rendering regression failed: the invalid recommendation entered the
model instead of producing `ANALYSIS INCOMPLETE`. After restoration,
`index-ddl.ts` and `report.test.ts` matched their fixed backups byte-for-byte
(SHA-256 `467d8b53...5535` and `b29ac317...7f7`).

## Round 6: executable index-DDL boundary

`IndexRecommendation.ddl` is now recognized at runtime by one shared,
lexer-backed boundary in `index-ddl.ts`. The lexer distinguishes executable
tokens from whitespace, nested block comments, line comments, quoted
identifiers, ordinary/escape/Unicode string literals, and dollar-quoted text.
It therefore treats only an executable semicolon as a statement boundary and
rejects any non-comment payload after the optional final semicolon. The same
recognizer is used when validating recommendations, resolving exact-ID
dependencies, extracting display names, and selecting renderer-authored index
build advice. Invalid recommendations are rejected visibly, dependent rewrites
remain blocked, and rejected text is never presented as deployable DDL.

After the statement skeleton is recognized, `pgsql-ast-parser` checks a
parser-compatible core containing the complete key expressions and partial
predicate. `INCLUDE`, `NULLS [NOT] DISTINCT`, and `ONLY` are checked by the
recognizer and omitted/normalized only for that secondary parse because version
12.0.2 does not implement those PostgreSQL grammar branches. Dollar-quoted and
Unicode-escape token payloads are likewise normalized after the lexer proves
their boundaries, so parser limitations cannot turn a valid semicolon inside a
literal into a second statement.

The accepted subset covers the PostgreSQL forms SQLSage emits: regular or
`CONCURRENTLY`, optional `UNIQUE` and `IF NOT EXISTS`, quoted and qualified
identifiers, optional `ONLY` and `USING`, expression/multicolumn keys with key
decorations, `INCLUDE`, `NULLS [NOT] DISTINCT`, storage parameters,
`TABLESPACE`, partial `WHERE` predicates, multiline formatting, and an optional
final semicolon followed only by whitespace/comments. This deliberately does
not delegate solely to `pgsql-ast-parser`: the installed parser rejects valid
PostgreSQL `INCLUDE` syntax used by current fixtures.

This is a conservative recognizer, not a full PostgreSQL grammar or catalog
lookup. It does not prove that an operator class exists, an expression is
immutable, a storage parameter is supported by the chosen access method, or a
referenced relation/column exists. PostgreSQL remains the authority for those
semantic checks. Conversely, uncommon future PostgreSQL `CREATE INDEX` syntax
outside the documented clause skeleton will be rejected visibly until the
recognizer is extended; that failure mode blocks deployment rather than
misclassifying arbitrary SQL as an index build.

### Disabled-fix proof

Before the final verification, the fixed files were copied under
`/tmp/sqlsage-m7-round6.oGSoBD/` and three mutations were applied and restored
with `apply_patch` (no repository reset/checkout was used):

- Disabling only the secondary expression/predicate parser made the rejected
  matrix fail on `WHERE flag AND OR other_flag` (`true !== false`).
- Reverting validation and exact-ID resolution to the old nonblank-DDL check
  made the blocked-dependency regression fail: comments-only DDL produced
  `needs-work` instead of `incomplete`. With the renderer guard still active,
  the malformed recommendation entered the model (`indexes:1`,
  `dependencies:0`) but the DROP payload and locking advice remained absent and
  a defensive `DDL rejected` note appeared.
- Disabling that renderer guard too made the same `DROP TABLE` payload render
  and restored the false regular-`CREATE INDEX` locking advice.

After restoration, SHA-256 hashes for `index-ddl.ts`, `prioritize.ts`,
`index.ts`, and `report.test.ts` matched their fixed backups byte-for-byte.
The untouched Round-4 regression probe now exits at its stale malformed-DDL
acceptance assertion (line 234): it expects zero dependency blockers, while the
fixed model produces one. That inversion is expected evidence of this repair;
the probe itself was not edited.

## Approach

`buildModel()` remains the editorial layer between independent analyzer stages
and the two renderers. It produces one issue model, so Markdown and terminal
output share the same verdict, ordering, evidence, actions, SQL/DDL, caveats,
verification state, and warnings.

Round 5 makes exact-ID dependency components first-class before any
recommendation-to-finding affinity runs. Every valid, uniquely resolved
`Rewrite.requiresIndexes` edge joins a rewrite and index into a connected
change set; a set may contain several rewrites and several indexes. Affinity is
then evaluated for the whole set, and every equally strongest relationship is
retained, so a multi-finding set renders once with all of its findings and
members rather than selecting an owner by severity or input order. Missing,
blank, and duplicate IDs create no edge and remain explicit dependency
blockers. Required-index prose is derived from membership in the rendered issue,
not merely from the absence of a blocker.

A zero-affinity result-changing proposal remains a separate change set. When a
structural intent finding exists elsewhere, it is presented as a lower-ranked
intent-confirmation branch under `INTENT REQUIRED`; it is not promoted into a
synthetic correctness headline and is not claimed to lack any relevant finding.
This uses only `Finding.category` and recommendation structure, never prose.

Round 2 removes the load-bearing prose inference identified by the critic:

- `Finding.category` is the only source of
  `correctness | intent | performance`. Titles, ids, impact, remediation, and
  caveats cannot promote or demote a finding. A missing/invalid category makes
  the analysis visibly partial instead of falling back to language matching.
- Correctness leads every performance finding. A high/critical intent finding
  leads performance under `INTENT REQUIRED`; lower-severity intent caveats stay
  visible without displacing a stronger performance action.
- `Rewrite.requiresIndexes` resolves only by exact
  `IndexRecommendation.id`. DDL substrings, index-name prefixes, and column
  overlap never satisfy a declared dependency. Missing and duplicate ids create
  an explicit blocker in the lede, action list, issue detail, and limits.

Timing now has a validated comparison model:

- both endpoints must be positive and finite before a ratio is computed;
- a change of at least 15% is labeled improvement or regression, while the
  middle band is called a noise-range comparison;
- every paired comparison includes the before/after values plus absolute and
  percentage delta;
- zero, negative, non-finite, and missing endpoints make the comparison
  unavailable; a measured regression cannot receive a healthy verdict.

Verification is field-level rather than all-or-nothing. The report separately
states baseline timing, optimized timing, result checking, baseline plan capture,
and optimized plan capture. Matching results are limited to the tested dataset.
A result mismatch for a correctness repair or intent branch is not automatically
called failure, but still requires validation against business intent or an
independent oracle. Opaque captured plans are reported as captured without
inventing a structural plan delta. M3 access paths, row counts, cost shares, and
scaling claims are labeled as predictions.

The renderer boundary validates required nested fields in findings, indexes,
rewrites, semantics, and execution entries. Invalid entries are rejected with a
visible partial-analysis warning; they never produce `undefined`, `NaN`, or
`[object Object]`. C0/C1 control bytes from SQL, catalog names, and analyzer text
are escaped before trusted ANSI styling is applied, including with `color: false`.

The executive summary now carries result grain. Original SQL is rendered once
after the lede/action list. Index relationships use explicit labels:

- `required dependency` for an exact `requiresIndexes` match;
- `alternative` only when redundancy metadata names the competing index;
- `supplement` for independent supporting work.

This preserves the strong Round-1 anchors: the fan-out report leads with wrong
results, the non-sargable range rewrite and exact-id covering index remain one
deployable action with the partial index labeled as an alternative, and the
already-pushed-down HAVING fixture remains a no-performance-action result.

## Deliberately not handled

- M7 does not parse SQL, inspect a catalog, validate an upstream PostgreSQL
  claim, or prove rewrite equivalence. It exposes missing evidence and internal
  contradictions; M1–M6 still own the facts.
- Opaque `baselinePlan` / `optimizedPlan` values are not parsed. The current
  shared contract does not associate M3 claims with particular observed plan
  nodes, so M7 reports capture state and explicitly says a structural delta was
  not supplied.
- The ±15% timing band is an editorial threshold, not a statistical confidence
  interval. A production harness should supply repeated-run dispersion if it
  wants a workload-specific noise judgment.
- SQL and DDL lines are not hard-wrapped in terminal output because inserting
  line breaks would damage copy/paste. Prose is clamped to 40–120 columns.
- There is no HTML, localization, or interactive-collapse format.
- Runtime files import no fixtures and contain no query ids, SQL fingerprints,
  corpus SQL, or correctness phrase dictionary.
- This round deliberately does not address recovered validation noise,
  `actionability: none` correctness remediation, implausible
  finite timing ratios, the blocked-line Markdown delimiter, or malformed
  `missingModules`; those are separate critic findings and remain known limits.

## Weakest remaining area

Recommendation-to-finding affinity is still heuristic when upstream supplies no
explicit relationship. It uses bound schema identifiers, exact evidence
fragments, and slug overlap. Severity ranks the resulting issue but no longer
selects a component owner; equal strongest affinity retains every tied finding.
This prevents a change set from splitting, but it can conservatively group two
findings when their structural affinity scores tie. An additive
`addressesFindingIds` field on rewrites/index recommendations would remove that
remaining ambiguity. The weakest new path is the deliberately unattached
intent-confirmation branch: M7 can prove that intent is unsettled elsewhere, but
without an explicit finding ID it cannot prove that the proposed branch addresses
that particular finding, so it keeps the branch separate and asks for confirmation.

The shared verification contract is the other limit: plan payloads are `unknown`
and carry no normalized observed-node summary. A structured before/after plan
delta would let M7 name actual scan/join/buffer changes instead of correctly
stopping at capture provenance.

## Validation

Run from the SQLSage root:

```bash
node -e "import('./src/report/index.ts').then(m=>console.log(Object.keys(m)))"
node --experimental-strip-types --check src/report/index-ddl.ts
node --experimental-strip-types --check src/report/blocks.ts
node --experimental-strip-types --check src/report/prioritize.ts
node --experimental-strip-types --check src/report/index.ts
node --experimental-strip-types --check src/report/fixtures.ts
node --experimental-strip-types --check src/report/report.test.ts
node --experimental-strip-types --check eval/dump-report.ts
node --test src/report/report.test.ts
node eval/dump-report.ts --first15
```

Round-2 builder result before handoff: import exports `buildModel` and
`renderReport`; 26/26 focused tests pass; both-format dump checks pass, including
paraphrased correctness/intent, negated performance prose, regression/zero
timings, exact dependency ids, malformed entries, control-byte escaping,
self-contained SQL/grain, determinism, ANSI/plain parity, and empty input.

Round-5 builder result (UNREVIEWED): 39/39 focused tests pass. New generic
regressions cover two orphan rewrites sharing an index, one rewrite requiring
indexes related to different findings (including severity ties), mixed valid +
missing + blank + duplicate IDs, false-adjacency prevention, and a zero-affinity
result-changing intent branch. The tests were proved load-bearing by saving the
fixed files under a `mktemp` scratch directory, temporarily disabling exact-ID
edges and structural intent-elsewhere handling with `apply_patch`, observing all
four regression families fail, and restoring with `apply_patch`; the restored
source hash matched the saved fixed copy before the final category-severity
refinement.

Round-6 builder result (UNREVIEWED): 43/43 focused tests pass. The new matrix
covers the accepted PostgreSQL subset and current fixture DDL, non-index and
incomplete statements, lexical/statement smuggling, unterminated constructs,
dependency blocking, rejected-payload visibility, and regular versus
`CONCURRENTLY` advice without comment/string/identifier leakage. Final runs of
`eval/dump-report.ts --first15`, `eval/run.ts`, both Round-5 adversarial probes,
and the Round-4 determinism/generalization probe exit 0; strip-type syntax
checks pass, and the read-only database count remains exactly eight `shop`
indexes. This is builder verification, not critic approval.

The untouched Round-4 coupling probe now exits at its first intentional defect
assertion: its line 168 expects the second shared-index rewrite to lack the
index, but the fixed component contains it (`true !== false`). Its later
split-target, mixed, and q07 assertions encode the same old defect state and are
covered by the new builder-authored regressions rather than by editing critic
evidence. Final verification: `node --test src/report/report.test.ts`,
`node eval/dump-report.ts --first15`, `node eval/run.ts`, and the Round-4
determinism/generalization probe all exit 0; the database still lists exactly
eight `shop` indexes.
