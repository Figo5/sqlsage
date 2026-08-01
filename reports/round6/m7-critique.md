# M7 Round 6 independent critique

## Protocol and frozen yardstick

This review follows the blind protocol in `docs/CRITIC-BRIEF.md`. I read that brief
and `docs/EXPERT-SOURCES.md` in full, then adopted the frozen
`reports/round1/m7-reference.md` before reading any current report output or source.
I rechecked its anchors against `corpus/queries.ts`, `corpus/schema.sql`, the complete
`corpus/catalog.json`, and all twelve raw `groundtruth/*.txt` plans. Before current
inspection, the live `shop` schema had exactly eight indexes: the six primary-key
indexes plus `idx_order_items_order_id` and `idx_orders_customer_id`.

The frozen yardstick remains sound. In particular, the raw evidence confirms q05's
NULL-poisoned zero-row result, q06's 5.1M joined rows feeding aggregation for 1.7M
complete orders, q07's ordinary nested-loop result after outer-join demotion, q10's
bitmap index condition on `customer_id < 1000`, and q11's two million correlated
subplan executions. Current-round claims have not yet been inspected at this point.

## Incremental evidence log

### E0 — blind baseline

- PostgreSQL reports version 16.14 in the frozen catalog.
- Live `shop` index count before probes: **8**.
- No implementation, current output, current tests, prior critique, or handoff had
  been read before the observations above were recorded.

<!-- Further evidence is appended during the review. -->

### E1 — current artifact and inherited baseline

- PostgreSQL 16.14's own `\h CREATE INDEX` grammar permits optional `UNIQUE`,
  `CONCURRENTLY`, `IF NOT EXISTS`, an optional index name, `ONLY`, `USING`, key
  expressions and decorations, `INCLUDE`, `NULLS [NOT] DISTINCT`, `WITH`,
  `TABLESPACE`, and a partial `WHERE` predicate. This server grammar is the
  authority used below.
- `node --test src/report/report.test.ts`: **43 pass, 0 fail**.
- `node eval/dump-report.ts --first15`: all checks passed.
- `node eval/run.ts`: **12/12** compose and explicitly declare M2-M6 absent.
- Source inspection confirms one shared `recognizeCreateIndexDdl()` call path in
  recommendation validation, exact-ID dependency resolution, index-name display,
  same-issue matching, and locking advice. Rejected recommendations are removed
  before components form; `fixBlocks()` independently suppresses DDL and lock prose
  if an invalid recommendation nevertheless reaches an `Issue`.
- No executable runtime branch on a corpus query id or exact corpus SQL has been
  found. The pre-existing exact-ID component architecture is unchanged.

### E2 — known non-DDL gaps retained for later scoring

The current notes explicitly leave the prior critic's non-DDL findings open:
recovered optional validation noise still gates the whole verdict;
correctness plus `actionability: 'none'` still hides its supplied remediation;
absurd finite timing ratios still become measured claims; malformed
`missingModules` can assert completeness; the blocked action line still has an
unmatched `**`; repeated exact IDs still duplicate companion notes; and q07's
global unrelated-intent fallback still invents a relationship. These remain
unwaived even if the DDL boundary passes.

### E3 — PostgreSQL 16 differential probe finds a soundness failure

`reports/round6/m7-ddl-pg16-adversarial-probe.ts` now runs every ordinary
statement against a throwaway TEMP table inside `BEGIN`/`ROLLBACK` and asserts
the persistent `shop` index count is eight before and after. It exits 0 while
asserting the observed defect neighborhood.

- **Pass:** six broad regular forms execute on PG16 and pass M7: unnamed index,
  `UNIQUE`, `IF NOT EXISTS`, quoted identifiers, `ONLY`, `USING`, multiple and
  expression keys, array/JSON expressions, collation/opclass/order decorations,
  `INCLUDE`, `NULLS NOT DISTINCT`, valid `WITH`, `TABLESPACE`, partial `WHERE`,
  keyword-interleaved comments, and semicolons inside strings/dollar quotes.
- **Pass:** a schema-qualified index name is rejected by both PG16 and M7.
- **Pass:** `CONCURRENTLY` is reported only in its grammar position, never from a
  comment, string, or quoted identifier; no concurrent DDL was executed.
- **Confident-wrong boundary:** M7 accepts all of these as complete executable
  indexes while PG16 reports syntax errors: `WITH (fillfactor 80)`,
  `WITH (fillfactor = 80 extra)`, `WITH (fillfactor == 80)`,
  `WHERE status = ANY ()`, `INCLUDE (select)`, and `TABLESPACE select`.
  The first three isolate the design omission: the normalized parser core drops
  `WITH`, while `expressionList()` is not the PostgreSQL storage-parameter grammar.
- **Unicode soundness:** invalid unpaired-surrogate U& string and identifier
  escapes are normalized into acceptance even though PG16 rejects them before a
  catalog/object check.
- **Completeness:** PG16 parses documented opclass-parameter syntax and reaches an
  opclass capability error, but M7 rejects it as syntax. A fully executable
  `U&"..." UESCAPE '!'` identifier index likewise runs on PG16 and is rejected by
  M7. These are safe deployment failures but contradict broad completeness; the
  opclass case is directly relevant to access methods such as GiST/trigram where
  M5 may legitimately emit parameters.

The malformed `WITH` case is the required decisive counterexample: it contains
one statement identity, no catalog/object/immutability issue, passes recognition,
and fails PostgreSQL grammar solely because a normalized-away clause is checked
by a looser substitute grammar. Therefore the claim “one complete executable
PostgreSQL CREATE INDEX statement” is false.

### E4 — validation and rendering defense are real, but share the false accept

`reports/round6/m7-ddl-renderer-defense-probe.ts` exits 0 and directly exercises
the lowest public paths, `buildModel()` and `renderReport()`.

- **Pass:** `DROP TABLE`, comment-only, incomplete CREATE, and a second-statement
  payload are dropped from `model.indexes`; exact-ID resolution reports the
  dependency missing; the report is incomplete; the rejection reason is visible;
  and neither the payload nor lock advice is rendered.
- **Pass:** a stateful runtime getter made DDL valid through model construction and
  changed it to `DROP TABLE` before block rendering. This puts invalid text in an
  `Issue` without source edits. The renderer's independent guard emits `DDL
  rejected` and suppresses both the payload and locking advice.
- **Fail:** the PG-invalid `WITH (fillfactor 80)` payload is accepted by the shared
  recognizer, so every layer agrees on the wrong answer: the exact-ID dependency
  is satisfied, the action is called a coupled rewrite+index, the malformed DDL is
  rendered as executable code, and M7 authors the regular-`CREATE INDEX` write-lock
  paragraph. Shared validation is architecturally consistent, but its single
  recognizer is now a single point of confident wrongness.

## Executive assessment

M7 is not ready for a database team to trust. The prior arbitrary-payload repair is
real: validation is shared, exact-ID component formation honors rejection, and the
renderer independently suppresses invalid DDL and its locking prose. But E3/E4 establish
a higher-value current defect: PostgreSQL-invalid index-definition grammar can still be
accepted, satisfy a component dependency, reach deployable rendering, and receive
M7-authored operational advice. That is a confident-wrong claim under the rubric, so the
verdict cannot be convinced.

## Ranked findings

1. **Accepted-language soundness remains broken.** The recognizer diverges from
   PostgreSQL 16 grammar in clauses that its normalization removes or validates through
   looser substitute rules. E3 establishes server rejection on grammar alone, and E4
   shows the same false acceptance propagating through model construction, exact-ID
   resolution, rendering, and operational prose. Fixed means grammar-equivalent
   validation for every accepted clause or conservative rejection, while retaining all
   established exact-ID component and renderer-defense behavior.
2. **Documented valid grammar is also rejected.** E3 records safe false rejects for
   supported identifier and operator-class forms. These prevent deployment and weaken
   completeness, but they rank below a malformed definition presented as executable.
3. **Verdict and action calibration still discard or overstate material information.**
   E2 retains whole-verdict gating by recovered optional validation noise, suppression of
   supplied remediation on a correctness issue marked as requiring no action, and finite
   but absurd timing ratios presented as measured claims.
4. **Composition integrity remains too trusting.** E2 records malformed module-presence
   metadata asserting completeness, duplicate companion notes from repeated exact IDs,
   and an unrelated-intent fallback inventing a relationship. These are consequential
   integrity and relevance gaps, though none outranks the deployable false acceptance.
5. **A presentation defect remains.** The blocked action line still contains unmatched
   emphasis markup. It is visible but cosmetic relative to the semantic failures above.

## Preserved gates

- The prior arbitrary-payload repair is substantiated: non-index, comment-only,
  incomplete, and multi-statement recommendations are rejected before component
  formation; the exact-ID dependency becomes missing; incompleteness and the rejection
  reason remain visible; and locking advice is suppressed.
- The independent renderer defense remains effective when recommendation text changes
  after model construction, suppressing both invalid text and associated lock guidance.
- The shared recognizer path, exact-ID dependency behavior, component architecture, and
  renderer defense are genuine safeguards. No executable corpus-ID or exact-corpus-text
  special-casing was found in the recorded inspection.
- E3's broad ordinary-form coverage and position-sensitive concurrency classification
  remain preserved. The decisive defect does not erase those passes; it establishes that
  their boundary is not grammar-equivalent.

## Score rationale

- **Correctness: 24/40.** The arbitrary-payload and renderer defenses are materially
  correct, but the accepted-language soundness failure produces deployable, operationally
  annotated advice that PostgreSQL 16 rejects. The retained timing and relationship
  defects add further factual risk.
- **Completeness: 20/30.** Broad ordinary forms and all twelve compositions are covered,
  yet documented valid forms are rejected and several retained composition/actionability
  gaps leave useful expert output unavailable or incomplete.
- **Clarity: 15/20.** Rejection reasons and incompleteness are visible, and actions are
  generally composed coherently, but duplicated notes, invented relationships, and the
  unmatched markup reduce precision.
- **Calibration: 5/10.** Independent suppression shows appropriate caution for recognized
  invalid input, but that caution fails at the grammar boundary and elsewhere converts
  weak evidence into measured or complete-sounding claims.

The weighted axis total is 64/100. Applying the rubric's mandatory 25-point deduction
for a confident-wrong claim yields **39/100**. Safe false rejects and cosmetic defects do
not offset or outrank that deduction.

## Final verification

This synthesis uses only the already-recorded results. E1 records 43 passing report
tests, a passing first-fifteen report dump, 12/12 successful compositions with the
expected module-absence declarations, one shared validation path, and no detected corpus
special-casing. E3 records a successful PostgreSQL 16 differential probe with the live
index count preserved at eight before and after; E4 records a successful renderer-defense
probe that both confirms the defenses and reproduces the shared false acceptance. No new
probe or implementation inspection is needed to resolve the verdict.

SCORE: 39
CONVINCED: no
BIGGEST_GAP: The recognizer falsely accepts PostgreSQL-invalid index-definition grammar and carries it into deployable rendering and M7-authored operational advice.
GAP_DETAIL: The saved E3/E4 results show that normalization removes clauses whose grammar is then checked by looser substitute rules, allowing server-rejected text to satisfy dependencies and reach the final report. The prior arbitrary-payload repair is real, and exact-ID component behavior and independent renderer defense are preserved, but those layers share this false acceptance. Fixed means grammar-equivalent validation for every accepted clause or conservative rejection, while retaining all established exact-ID component and renderer-defense behavior.
