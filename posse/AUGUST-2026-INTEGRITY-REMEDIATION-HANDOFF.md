# August 2026 Integrity Remediation Handoff

Status: implementation plan

Date: 2026-08-21

Audit baseline: `42f4640032f02d80e434ce0938b2b64bfcb17c8a`

Audited head: `8036d0e74107e6114ab07090b6a11343684aee9d`

Re-verified head: `1d05d27acc6e1c4917b7190df3055fffa1a83862`

File and line references in this handoff are cited against the re-verified head.

Scope: deterministic research MCP ownership, source-read admission and coverage,
ATLAS/SCIP exactness, provider accounting and assessor limits, clean-client
projection, and waiting-lane review/recovery/telemetry contracts

Before executing this plan, read and obey:

- `../../docs/rules/Agents.md`;
- `../../deployment/posse/README.md`;
- `../.github/workflows/ci.yml`;
- `../../deployment/posse/CI/sync-clean-client.mjs` for PUB-1;
- the current repository README and version-coupled design/deployment specs.

If the implementation base has moved past the audited head, rerun the focused
reproducers before editing and record which findings remain live. Do not assume
that passing newer tests disproves an integration failure without exercising
the failing transition.

## Outcome

This handoff converts the validated 2026-08-19 through 2026-08-21 bug hunt into
an implementation sequence that multiple agents can execute without silently
changing product policy or overlapping on shared control-plane files.

The remediation is complete only when:

1. Research novelty, closeout state, and notices cannot cross session
   boundaries in an owner-hot gateway.
2. Every model-visible source-read remediation is expressible through the
   issued schema and accepted by the owner runtime.
3. A partial source window cannot satisfy a later request for a wider window.
4. An exact ATLAS generation proves the bytes and symbol state actually served;
   external symlink targets and stale symbols cannot hide behind a Git OID.
5. SCIP receipts distinguish documents acknowledged by successful intake from
   documents that failed staging or recovery.
6. Complete provider aggregate token totals are not replaced by incomplete
   request-segment totals.
7. Assessor tool ceilings have identical semantics across MCP, OpenAI, and Grok
   transports while terminal handoff remains available.
8. Every npm command surviving clean-client projection has a shipped
   executable.
9. Non-completion-blocking waiting-lane preparation cannot turn successful
   foreground work into a failed review assessment.
10. Waiting-lane recovery and eviction remain complete after more than 1,000
    lifetime preparation rows, and all planner-boundary telemetry is recorded.
11. The carried-ML-label policy is decided explicitly and the implementation,
    readiness proof, tests, and documentation all express the same policy.

This is an integrity and contract-alignment correction. It is not a prompt-only
change, and green component tests are not sufficient proof.

## Audit record

The audit covered 88 commits and 312 changed files, with 44,392 additions and
3,976 deletions relative to the baseline immediately before the rolling
48-hour window.

Validation at the audited head:

- `npm test`: 5,093 passed, 12 skipped, 0 failed.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- Agent-tool, remote-agent-tool, and `posse-remote` contract checks: passed.
- Focused ATLAS/SCIP validation: 69 passed, 0 failed.
- Researcher MCP, owner, and deterministic MCP focused suites passed.
- The repository and `origin/main` both resolved to `8036d0e7`; the worktree was
  clean when the audit closed.

Re-verification at `1d05d27a`:

- All eleven confirmed findings and decision-gated ML-1 were independently
  re-checked at `1d05d27a`, one commit past the audited head, and every one is
  still live.
- `1d05d27a` changes only tool `description` strings in
  `lib/catalog/atlas-tools.js` (no `parameters` schema change),
  `lib/domains/handoff/functions/helpers/atlas-context.js`,
  `test/fixtures/agent-tool-contract.json`, and
  `ATLAS_AGENT_CODE_TRAVERSAL_SURFACE.md`.
- None of those is a finding touchpoint, so no finding is weakened and the
  audited reproducers remain valid without re-derivation.

The failures below were found at integration boundaries that those passing
suites do not currently exercise. One-off reproductions used temporary
directories or temporary databases and left no repository changes.

## Severity and disposition

### Release-blocking integrity findings

#### RS-1: Native research novelty crosses owner-hot sessions

`deterministic-mcp-server.js` stores research ledgers by runtime session key but
keeps `nativeExplorationNovelty` as one module-global tracker. Its signature is
only tool name plus serialized arguments; it does not include session identity,
repository identity, or result content.

Reproduced consequence: session A and session B used the same relative file
names in different working directories with different contents. Calls in A
made the corresponding calls in B appear stale, and B was forced into research
closeout after 12 calls.

The neighboring `researchNoticeFlags` object is also module-global. Its scope
bug predates the audit window, but current notice changes touch the same
boundary and a separate reproduction showed one session suppressing another
session's midpoint notice.

The durable ledger path is a second, independent identity split at the same
boundary; moving the module-global trackers under the session key does not fix
it. See D-7.

Primary touchpoints:

- `lib/domains/integrations/functions/deterministic-mcp-server.js`
- `lib/domains/integrations/functions/deterministic-mcp/research-synthesis.js`
- `test/core/suites/deterministic-mcp-server.test.js`
- `test/test-research-synthesis.test.js`

Introducing/touching commits: `4f6c99bb3`, `8036d0e7`.

#### RH-1: Near-tier source-read remediation is impossible

`admitSourceContextHeadroom` permits a near-tier source read only when the
request contains at least two `items`. `PersistentMcpOwner` rejects every
`code.window` request containing `items` before admission, and the provider
projection removes `items` from the schema. The blocked response still tells
the model to batch the request.

Parallel scalar calls are not a workaround: each call is admitted separately
and each lacks `items`, so each is blocked.

The blocked-response message is not the only model-visible text naming the
rejected call form, and admission has an unbounded reservation store behind it.
Both are enumerated under LB-2.

Primary touchpoints:

- `lib/domains/research/functions/context-headroom.js`
- `lib/domains/research/classes/ContextHeadroomReservationOwner.js`
- `lib/shared/tools/classes/PersistentMcpOwner.js`
- `lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js`
- `lib/catalog/atlas-tools.js`
- `lib/domains/atlas/functions/v2/retrieval/code.js`
- `test/core/suites/atlas137-accounting-coverage.test.js`
- `test/test-persistent-mcp-owner.test.js`

Introducing commits: `2dae15b5d`, `4c2ee6fb7`.

#### AX-1: Tracked source symlinks defeat exact-generation proof

The Git-backed warm walk uses following `stat()` semantics and the parser reads
the dereferenced target. Git exactness proves only the committed symlink text,
so an external target can change while the repository remains clean.

Reproduced consequence: a tracked `linked.js -> ../outside.js` changed the
bytes consumed by the walker after `outside.js` changed, while `git status`
remained empty. Publication or exact boot skip can therefore certify or reuse
bytes that Git never proved.

Primary touchpoints:

- `lib/domains/atlas/functions/v2/warm-walk.js`
- `lib/domains/atlas/classes/v2/ParseEngine.js`
- `lib/domains/integrations/functions/atlas.js`
- ATLAS warm-walk and exact-boot tests

Introducing commit: `620fb2464`.

#### AX-2: Indexed-to-excluded transitions retain stale symbols

`ATLAS_MAIN_GENERATION_ACCOUNTED_SKIP_REASONS`
(`lib/domains/atlas/functions/v2/contracts/jobs.js` ~line 154) has four members.
Only `generated_artifact_skip` removes prior contributions before skipping:
`lib/domains/atlas/classes/v2/ParseEngine.js` ~lines 2634-2663 appends
`op: "remove"`, calls `deletePathSourceStat`, and deletes the path from the
snapshot before `continue`. The `unsupported_lang` (~lines 2628 and 2697),
`size_exceeded` (~line 2720), and `minified_skip` (~lines 2733 and 2746)
branches all `continue` with no removal, so the new Git OID can be published
while the view still contains symbols and hashes from the prior version.

`unsupported_lang` is not a hypothetical third case. It becomes reachable for a
previously indexed path whenever parser language support changes between
generations, and it is an accounted skip on the same publication path.

This was reproduced with SCIP disabled. The early skip behavior predates the
audit baseline; the exactness regression became observable when those skips
were allowed to publish an exact generation.

Primary touchpoints:

- `lib/domains/atlas/classes/v2/ParseEngine.js`
- `lib/domains/atlas/functions/v2/contracts/jobs.js`
- `lib/domains/atlas/functions/v2/main-generation.js`
- ATLAS warmer, readiness, and exact-boot tests

Regression commit: `82a0045e8`.

#### SCIP-1: Recovery receipts overclaim failed isolated documents

SCIP recovery may return `ok: true` after at least one recovered output, while
permanently failed isolated documents remain in `unavailableDocuments`. Receipt
construction records the full manifest rather than only documents acknowledged
through successful ledger intake. Exact boot can then treat a failed document
as examined and suppress a required retry.

Red-team result: complementary tree-sitter coverage does not validate the
current receipt under the written contract. Complementary coverage is valid
after a successful SCIP batch examined the exact source and omitted a document,
not after that document failed staging.

Primary touchpoints:

- `lib/domains/atlas/functions/v2/scip/stager.js`
- `lib/domains/atlas/functions/v2/scip/batch-coverage.js`
- `lib/domains/integrations/functions/atlas.js`
- `test/test-atlas-v2-scip-batch-coverage.test.js`
- `test/test-atlas-v2-scip-stager-registry-2.test.js`

Introducing commit: `dd3a96061`; receipt/exactness dependencies include
`c30aee4c8` and `ce87e8354`.

SCIP-1 is specifically a mixed-outcome defect, and that governs its urgency.
`stageScipBatchWithRecovery` ends at `const ok = recovered.outputs.length > 0`
(~line 1111), so a bisected batch is `ok: true` whenever at least one document
staged. A batch in which *every* document fails yields empty `outputs`,
correctly returns `ok: false`, and lands in `failedBatches`, which makes intake
`partial` and never trips this bug. Only a batch that partly succeeds writes
failed documents into the receipt as examined.

That matters for exposure, but not in the direction a sequencing argument
would suggest. SCIP-1 is standing and live today for typescript and php, not a
future risk. `writeBatchProjectMetadata` (~line 1130) already scopes those
batches correctly: typescript receives a `tsconfig.json` whose `files` is
exactly `batch.paths`, and php receives a `composer.json` classmap over the
same list. Those batches therefore stage successfully, bisected recovery
produces ordinary partial successes, and every such partial success has been
able to write failed documents into the coverage receipt as examined.

Python is the exception, and only python. Its view copies the repository's own
`pyproject.toml`, whose `[tool.pyright] include` describes the real tree rather
than the isolated view, and the `scip-pyrightconfig.json` pin that would
override it is applied only when the batch contains a hidden dot-path
(~line 1162). Combined with an indexer default that derives
`--project-version` from a git revision the bare view does not have, python
batches have failed wholly, taken the safe all-fail path, and never reached
this bug.

A concurrent, separately owned change to the python staging path is in flight
in this checkout and fixes both of those. Its effect on SCIP-1 is to add python
to an existing exposure, not to create one. Do not treat LA-3 as gated on that
change landing: the receipt has been overclaiming for typescript and php
repositories already, so LA-3 is corrective work on live behavior and should be
prioritized as such.

LA-3 is unblocked and owned by this remediation. The earlier concurrency hold
on `lib/domains/atlas/functions/v2/scip/**` was released once the index build
running against it completed.

One reconciliation debt outlives that hold and must not be lost. A separate,
uncommitted change to `stager.js` (49 insertions, 20 deletions) exists in the
shared working checkout: it pins scip-python's `--project-version` from a
`batchProjectVersion` captured once before the batch loop, and makes the
`scip-pyrightconfig.json` pin in `writeBatchProjectMetadata` unconditional
instead of gating it on a hidden dot-path. It does not touch the coverage
write, `state.failedBatches`, or `state.unavailableDocuments`, so its
relationship to LA-3 is adjacency rather than conflict.

That change has no owner intent to commit and may remain uncommitted
indefinitely. **Do not sequence LA-3 on it.** Integrate LA-3 on its own merits
against `248b57f7` and leave the reconciliation to whoever takes up the
staging change. An integrator who finds `stager.js` unexpectedly dirty should
read this paragraph rather than assume a lane exceeded its scope.

### Confirmed correctness and contract findings

#### SC-1: Partial `code.window` coverage blocks a wider retry

`sourceSelectorFingerprint` omits `maxTokens`, even though `code.window` uses it
as an independent output cap. A truncated request with `maxTokens: 200` and an
otherwise identical retry with `maxTokens: 1200` share a fingerprint. The owner
returns the smaller stored region as `covered` without executing the wider
request.

Cross-window-size reuse is valid only for the separate verified
complete-symbol fingerprint. That fingerprint is currently populated on the
prefetch path alone, so live-delivered windows have no reuse path to fall back
on once `maxTokens` enters partial selector identity. See D-8.

Primary touchpoints:

- `lib/domains/research/classes/SourceCoverageOwner.js`
- `lib/domains/research/functions/owner-source-admission.js`
- `lib/domains/handoff/functions/helpers/lifecycle-prefetch.js`
- `lib/domains/atlas/functions/v2/retrieval/code.js`
- `test/core/suites/atlas137-accounting-coverage.test.js`

Introducing commit: `2dae15b5d`.

#### ACC-1: Incomplete segments replace authoritative aggregate token totals

When any usage segment exists, `resolveCanonicalCallAccounting` returns segment
token sums even if segment precision is `incomplete` because the sums disagree
with the complete provider aggregate stored on `agent_calls`.

Reproduced consequence: a complete aggregate of 300 input/30 output tokens and
one captured segment of 100/10 is reported as 100/10. Unknown exact price is an
appropriate fail-closed result; replacing known additive raw totals is not.

Two neighboring cases in the same return are currently undefined and must be
decided by the fix rather than fall out of it:

- `resolveCanonicalCallAccounting`
  (`lib/domains/billing/functions/usage-segments.js` ~line 266) takes the
  segment branch at ~line 291 whenever `segments.requestCount > 0`, including
  when precision is `incomplete` and `hasAggregateUsage(call)` (~line 242) is
  false. There is no aggregate to prefer in that case, so the fix must keep
  segment sums, keep precision `incomplete`, and keep billable and cost `null`
  rather than regress calls that only ever had segments.
- `longContextTierInputTokens` (~line 319) is segment-derived. A row corrected
  to aggregate input/output counters would otherwise carry a segment-scoped
  long-context counter beside them, so the field's identity must be chosen
  explicitly and stated.

Primary touchpoints:

- `lib/domains/billing/functions/usage-segments.js`
- `lib/domains/worker/classes/TrackedProviderClient.js`
- accounting timeline, review, approval, and UI consumers
- `test/core/suites/atlas137-accounting-coverage.test.js`

Introducing commit: `2dae15b5d`; later touched by `d9ecc19ca`.

#### ASR-1: `assessor_max_tool_calls` is transport-dependent

The assessment pipeline passes the configured ceiling and persistent MCP
enforces it. The OpenAI and Grok embedded tool loops do not accept or enforce
the option and execute every function call in a provider batch. `maxTurns`
limits rounds, not the number of calls in one round.

Primary touchpoints:

- `lib/domains/worker/functions/helpers/assessment-pipeline.js`
- `lib/shared/tools/classes/PersistentMcpOwner.js`
- `lib/domains/providers/functions/openai/index.js`
- `lib/domains/providers/functions/grok/index.js`
- provider and persistent-owner assessor tests

Introducing commit: `5b062c3b4`.

#### PUB-1: Clean-client projection publishes commands without executables

The central clean-client sync removes script files but leaves the package
entries that invoke them. The synced public client fails with `MODULE_NOT_FOUND`
when a published command is invoked.

The real projection rules are `STRIP_DIR = "posse/scripts"` minus
`KEEP_SCRIPTS`, plus deletion of package entries matching
`PACKAGE_TEST_SCRIPT_RE = /^(?:pretest|test(?::|$))/`. Applied to the current
`posse/package.json` they leave thirteen surviving script entries whose target
file is stripped, not five:

```
benchmark:atlas:comprehensive, benchmark:atlas:quality,
benchmark:atlas:quality:streaming, contract:agent-tools:check,
contract:agent-tools:write, contract:remote-agent-tools:check,
contract:remote-agent-tools:write, contract:posse-remote:check,
check:log-secrets, compile:native:encoder, compile:native:vector,
rebuild:rust-binaries, rebuild:rust-binaries:all
```

The five `contract:*` entries are new in the audit window. The other eight (the
three `benchmark:atlas:*` entries, `check:log-secrets`, the two
`compile:native:*` entries, and the two `rebuild:rust-binaries*` entries) are
already present at the audit baseline `42f46400` and pre-date the window. They
are the same defect and the fix must cover them: a generic projection check
that cleared only the five audited entries would still fail on the other eight.

This finding crosses repository ownership. The authoritative projection logic
is `../../deployment/posse/CI/sync-clean-client.mjs`; a complete fix requires a
coordinated deployment-repository change or an explicit decision to ship the
currently internal scripts.

Primary touchpoints:

- `package.json`
- `../../deployment/posse/CI/sync-clean-client.mjs`
- clean-client projection verification

Introducing commit: `f55c1fea5`.

#### WL-1: Optional waiting-lane preparation produces false review failure

`waiting_lane_prepare` is canonically non-completion-blocking, but review
visibility excludes only `atlas_warm`. A failed optional preparation can make
`finalAssessmentFor` return `FAIL` even when foreground work succeeds.

Primary touchpoints:

- `lib/catalog/job.js`
- `lib/domains/ui/functions/display/helpers/job-status.js`
- `lib/domains/cli/functions/review-report.js`
- waiting-lane and review-report tests

Introducing commit: `e164ae52`.

#### WL-2: Oldest-first 1,000-row cap hides newer prepared residents

Durable preparation enumeration clamps to the oldest 1,000 lifetime rows.
Eviction, scheduler startup reconciliation, and filesystem startup recovery all
consume that truncated set. After sufficient terminal history, a newer stale
`ready` resident can become invisible, retain its worktree, occupy capacity,
and suppress future speculative preparation.

Reproduced consequence: 1,000 retired/no-asset rows followed by one stale ready
resident produced zero eviction candidates.

The cap is not a call-site default. `listWaitingLanePreparations`
(`lib/domains/queue/functions/waiting-lane-preparations.js` ~line 235)
hard-clamps every caller with `Math.min(limit, MAX_LIST_LIMIT)` against
`MAX_LIST_LIMIT = 1000` (~line 28), so no consumer can page past it by passing
a larger limit. The fix is therefore an API change, not only call-site changes.

The existing `ORDER BY updated_at ASC, work_item_id ASC` (~line 262) is already
a total order, because `work_item_id` is the table's `INTEGER PRIMARY KEY`
(`lib/shared/storage/functions/index.js` ~line 335). What is missing is a
cursor: the query issues a bare `LIMIT ?` and the function accepts only
`states`, `targetBranch`, and `limit`, so there is no way to resume after a
page. Complete enumeration needs a compound `(updated_at, work_item_id)` keyset
cursor in the API; offset paging would skip or repeat rows under concurrent
inserts.

Primary touchpoints:

- `lib/domains/queue/functions/waiting-lane-preparations.js`
- `lib/domains/scheduler/functions/waiting-lane-coordinator.js`
- `lib/domains/git/functions/workflow-startup-guard.js`
- `lib/domains/git/functions/worktree-gc.js`
- waiting-lane startup, eviction, and recovery tests

Introducing commits include `196837b6`, `6393e6f4`, and `409955e1`.

#### WL-3: Planner-boundary telemetry is silently discarded

The planner emits `planner_reserved`, `planner_deferred`, and
`planner_fallback`, but the waiting-lane telemetry allowlist contains none of
those names. The record builder returns `null`, and the recorder silently
no-ops for every outcome at the new planner-consumer boundary.

Primary touchpoints:

- `lib/domains/worker/functions/helpers/waiting-lane-planner-readiness.js`
- `lib/domains/observability/functions/waiting-lane-telemetry.js`
- `test/test-waiting-lane-telemetry.test.js`

Introducing commit: `3a94b737`; incompatible allowlist originated in
`409955e1`.

### Decision-gated risk

#### ML-1: Exact boot can preserve carried ML labels beyond the next boot

The current policy says carried labels last "until next boot." A full rebuild
can import an old snapshot and stamp it as a fresh successful ML surface. A
restart at the same Git OID can exact-skip the boot worker, so the promised
reseed never occurs.

This is product-intent-dependent. The implementation must not change until the
owner chooses one of these contracts:

1. **Recommended:** next process boot means reseed or reconcile ML labels even
   when source exactness permits the parse/index worker to skip.
2. Carried labels may persist across exact boots; update policy wording,
   readiness semantics, telemetry, and tests to state that explicitly.

Primary touchpoints:

- `lib/domains/atlas/functions/v2/tree-compression-policy.js`
- `lib/domains/atlas/classes/v2/ParseEngine.js`
- `lib/domains/atlas/functions/v2/tree-compression.js`
- `lib/domains/atlas/functions/v2/view-health.js`
- `test/test-atlas-boot-exact-skip.test.js`
- `test/test-atlas-v2-readiness.test.js`

Exact-boot interaction begins in `2962922be`; later interactions include
`21ca0a1e7` and `82a0045e8`.

## Non-negotiable invariants

### Session and research-control invariants

- Every mutable novelty, notice, closeout, and fetch-gate datum has an explicit
  session owner.
- Switching owner-hot runtime boot configuration cannot inherit mutable
  research state from another session, repository, job, or attempt.
- Identical arguments in different sessions are independent evidence events.
- Changed result content in the same session is not classified as an exact
  repeat merely because tool arguments match.
- Session eviction and gateway restart fail toward allowing evidence, not
  premature closeout.

### Source-read invariants

- Model-visible remediation text names only schemas and call forms that are
  currently issued and accepted.
- Headroom admission, provider schema, owner dispatch, and native execution
  implement one scalar-or-batch contract.
- `maxTokens` participates in partial selector identity.
- Cross-window-size reuse requires proof that the complete requested symbol was
  delivered.
- Truncated or output-truncated evidence never masquerades as complete.

### Exact-generation invariants

- Exact source proof covers every byte used to derive the published view.
- Paths whose content cannot be proven by the repository OID are excluded or
  make the generation inexact.
- A file excluded at generation N contributes no rows from generation N-1 to
  an exact current view.
- An acknowledged SCIP receipt row represents successful intake of that exact
  document/hash, not an attempted or failed stage.
- Accounted unavailability, if adopted later, has a distinct typed disposition
  and cannot reuse an acknowledgement field.

### Accounting and provider invariants

- Complete aggregate raw token counters remain authoritative when request
  segments are incomplete.
- Incomplete segments can make exact price and billable-token derivation
  unknown without erasing known aggregate counters.
- Every physical assessor tool call consumes the same budget across transports.
- Reaching the normal assessor tool ceiling cannot hide or block terminal
  `agent_handoff`.

### Projection and waiting-lane invariants

- Every surviving public package script resolves to a shipped file.
- Projection tests validate package-script targets after stripping.
- Review visibility is derived from canonical job completion semantics rather
  than an independent partial allowlist.
- Startup recovery and eviction are complete over all relevant durable rows;
  lifetime terminal history cannot starve active residents from enumeration.
- Every emitted waiting-lane telemetry event is accepted by the canonical event
  registry and is asserted in tests.

## Required policy decisions before implementation

The integrator records these decisions in the first implementation PR or its
linked design note. Agents must not infer a different contract locally.

### D-1: Tracked source symlinks

Recommended decision: exclude symlinks from exact source indexing and record a
typed, observable skip. Do not hash a dereferenced external target and call it
Git-exact. If repository-internal symlinks are later supported, the proof must
bind both the link object and resolved tracked target without allowing a path
escape.

Supporting evidence: the two walks already disagree. The Git-backed walk uses
`fs.promises.stat` (`lib/domains/atlas/functions/v2/warm-walk.js` ~line 71),
which follows symlinks; the filesystem fallback walk uses `Dirent.isFile()`
(~line 100), which has `lstat` semantics and therefore already excludes them.
Excluding symlinks from exact indexing restores consistency between the two
walks rather than removing a supported capability.

### D-2: Indexed files that become oversized or minified

Recommended decision: remove prior contributions and publish the new exact
generation with that file represented as an accounted exclusion. If retaining
old symbols is desired as degraded fallback, the view must be marked degraded
or inexact and must not satisfy exact boot proof.

### D-3: `code.window` scalar versus multi-selection contract

Recommended decision: preserve the deliberate scalar-only public contract.
Change headroom admission and its remediation so bounded scalar selections are
executable, and account for concurrently pending scalar-result reservations.
Restoring `items` is acceptable only if schema, owner, native executor,
coverage, accounting, and tests all support it end to end.

### D-4: Failed SCIP document disposition

Recommended decision: only successfully acknowledged outputs enter the receipt.
Failed documents remain retryable and prevent an exact boot proof unless a new,
explicit accounted-unavailable contract is designed and approved.

### D-5: Clean-client contract scripts

Recommended decision: keep the generator/verifier implementations internal and
remove their npm entries during clean projection. Add a generic projection
check so future stripped scripts cannot leave dangling commands. Shipping the
implementations publicly requires a separate security/content review.

The decision covers all thirteen entries enumerated under PUB-1, not the five
audited `contract:*` entries. The generic check and the entry removal must land
together; a check added over the current eight pre-existing entries turns CI
red on its first run.

The Posse-repository production diff for this finding is empty. All thirteen
entries stay in the source `package.json` and are removed at projection time in
the deployment repository. Deleting them from source would break this handoff's
own required baseline sequence, which runs `contract:agent-tools:check`,
`contract:remote-agent-tools:check`, and `contract:posse-remote:check`.

### D-6: Carried ML labels

Owner decision required. The recommended next-boot reseed contract is described
under ML-1. This decision is independent of source exactness and must have its
own readiness signal.

### D-7: Research-ledger durable identity

`runtimeSessionKey`
(`lib/domains/integrations/functions/deterministic-mcp-server.js` ~line 2493)
keys sessions on OAuth token or owner session, job, work item, attempt, agent
call, role, cwd, and gateway binding epoch. `researchStatePathForCurrentBoot`
(~line 1817) derives the on-disk ledger path as only
`.posse/research-state/job-<jobId>-attempt-<attemptId>.json` under the current
`workspaceCwd`. Two sessions differing only by agent call, binding epoch, role,
or token identity therefore hold separate in-memory ledgers that write the same
file: one session's `save()` clobbers the other, and a gateway restart reloads
the wrong state into whichever session boots first. (A cwd difference does not
collide, because `workspaceCwd` is part of the path.)

Recommended decision: give the durable path the same identity as the in-memory
key. The alternative, coarsening `runtimeSessionKey` to job plus attempt, must
be justified line by line against the session and research-control invariants
before it is adopted.

Fixing RS-1's module-global novelty and notice trackers does not fix this. The
RS-1 acceptance criterion "session-map eviction and gateway restart do not
produce premature closeout" cannot be satisfied while the split identity
stands.

### D-8: Complete-symbol coverage on live delivery

`materializeSourceCoverage`
(`lib/domains/research/functions/owner-source-admission.js` ~line 53) forwards
only `{ origin }` and never passes `completeSymbolSelector`. The single caller
that does is
`lib/domains/handoff/functions/helpers/lifecycle-prefetch.js` (~line 169).
`complete_symbol_selector_fingerprint` is therefore always NULL for
live-delivered `code.window` results, and the complete-symbol reuse path exists
only for prefetched bodies.

Recommended decision: populate the complete-symbol fingerprint on live delivery
when the delivered result is verifiably complete, meaning not `truncated`, not
`selectionBounded`, and not `outputTruncated`.

This is a prerequisite of LB-3. Without it, adding `maxTokens` to partial
selector identity removes cross-window reuse for every live source read,
including complete untruncated ones.

## Multi-agent execution model

Use isolated branches/worktrees. Do not allow two implementation agents to edit
the same owned file concurrently. Keep one integration owner active and run at
most three implementation lanes beside that owner.

Every implementation-agent handoff must include:

- base SHA and head SHA;
- finding IDs addressed;
- exact files changed;
- invariant and policy decision implemented;
- focused commands and results;
- new regression test names;
- unresolved risks or intentional follow-ups;
- confirmation that no push or deployment occurred.

Each intended repository change must be committed before integration or push,
per the repository deployment rules. Agents must not deploy, push, rewrite
unrelated history, or clean unrelated worktrees as part of these packages.

### Integration owner: contract and merge authority

Owns:

- decisions D-1 through D-8;
- this handoff and any follow-up design note;
- dependency order and commit integration;
- package IO-1, the shared assessor tool-call ceiling extraction;
- package IO-2, the red baseline repair at `1d05d27a`;
- central deployment-repository coordination for PUB-1;
- final cross-lane tests and red-team review;
- release decision.

The integration owner should avoid production edits assigned to another lane.
If an integration correction is necessary, return it to the owning lane or
record the ownership transfer before editing.

Required implementation packages:

1. IO-1: extract the canonical assessor tool-call ceiling decision into a
   shared, stateless module that imports nothing from the owner, the gateway,
   or any provider. Each caller keeps its own counter storage: the owner uses
   `session._assessorToolCallCount`, the gateway uses its scope state's
   `assessorToolCallCount`, and the future provider-loop caller has no MCP
   session at all. The helper takes the current count, the configured cap, the
   role, and the requested tool name, and returns the same decision the two
   existing sites compute today.

IO-1 is a behavior-preserving refactor. The two enforcement sites already share
identical semantics: assessor-role gating, `agent_handoff` exemption, default
cap 12, a `Math.max(1, ...)` floor on the configured value, and a
post-increment `count > cap` boundary. They are
`lib/shared/tools/classes/PersistentMcpOwner.js` (~line 3059) and
`assessorToolBudgetDecision` in
`lib/domains/integrations/functions/deterministic-mcp-server.js` (~line 518).
The gateway function also carries an assessor fallback-read sublimit; that
sublimit stays where it is and is not part of IO-1.

Both sites live in files assigned to Lane B: the gateway exclusively, and
`PersistentMcpOwner.js` for its source-read sections, with Lane C forbidden the
file outright. Lane C's only unaided move would therefore be a third divergent
implementation in the provider loops, which the rejection criteria reject. That
is why IO-1 lands in Wave 0, before Lane B and Lane C branch. The ownership
transfer for those two blocks is recorded here; no lane edits them until IO-1
has landed.

2. IO-2: restore a green baseline before any lane branches. At the re-verified
   head `1d05d27a` the repository does not pass its own required baseline:
   `test/test-agent-tool-contract.test.js` fails the
   `keeps agent definition prose positive and tool-local` assertion, which
   forbids `do not`, `never`, and `instead of` in any issued tool description.

`1d05d27a` introduced three violations in `lib/catalog/atlas-tools.js`:
`symbol.search` ("never construct or guess a symbol ID"), `code.survey`
("instead of guessing a narrow path"), and `code.window` ("Never guess a path or
symbol ID"). The suite reports only the first, because the assertion throws on
the earliest offending tool; all three must be repaired together or the baseline
fails again on the next run.

This is a regression, not a pre-existing condition. The same test passes at the
audited head `8036d0e7` and fails at `1d05d27a`, and `git log -S` attributes
each of the three strings to that commit. The audit record's `npm test` result
was therefore accurate when captured.

The repair rephrases the three descriptions positively and preserves the
retrieval-routing intent of `1d05d27a`; it does not relax the assertion, which
encodes a deliberate prose policy. Because both
`test/fixtures/agent-tool-contract.json` and
`ATLAS_AGENT_CODE_TRAVERSAL_SURFACE.md` are generated from the catalog, IO-2
regenerates them through `npm run contract:agent-tools:write` and
`npm run contract:remote-agent-tools:write` rather than editing them by hand.

Every lane branches from the commit containing IO-1 and IO-2. A lane that
branches from a red baseline cannot distinguish its own breakage from the
inherited failure, and the completion criteria require a full green suite after
integration.

### Lane A: ATLAS and SCIP exactness

Finding IDs: AX-1, AX-2, SCIP-1, and ML-1 only after D-6.

Exclusive production ownership:

- `lib/domains/atlas/functions/v2/warm-walk.js`
- relevant exactness paths in `lib/domains/atlas/classes/v2/ParseEngine.js`
- `lib/domains/atlas/functions/v2/main-generation.js`
- `lib/domains/atlas/functions/v2/contracts/jobs.js`
- `lib/domains/atlas/functions/v2/scip/**`
- ATLAS proof checks in `lib/domains/integrations/functions/atlas.js`
- ML policy/readiness files if D-6 authorizes work

Required implementation packages:

1. LA-1: exclude or prove tracked symlinks according to D-1.
2. LA-2: remove prior contributions before publishing accounted file
   exclusions. This covers all three unremoved accounted skips
   (`unsupported_lang`, `size_exceeded`, `minified_skip`) at every branch
   enumerated under AX-2, not oversized and minified alone. The
   `generated_artifact_skip` block in
   `lib/domains/atlas/classes/v2/ParseEngine.js` (~lines 2634-2663) is the
   in-repo reference implementation: remove-op append, `deletePathSourceStat`,
   snapshot delete, then `continue`.
3. LA-3: construct SCIP receipts from acknowledged successful documents only.
4. LA-4: implement the selected ML boot/reseed contract separately from
   LA-1 through LA-3.

Keep LA-4 in a separate commit so it can be withheld if D-6 remains unresolved.

### Lane B: Research session ownership and source-read contracts

Finding IDs: RS-1, RH-1, SC-1.

Exclusive production ownership:

- `lib/domains/integrations/functions/deterministic-mcp-server.js`
- `lib/domains/integrations/functions/deterministic-mcp/research-synthesis.js`
- `lib/domains/research/classes/SourceCoverageOwner.js`
- `lib/domains/research/functions/context-headroom.js`
- `lib/domains/research/functions/owner-source-admission.js`
- source-read sections of `lib/shared/tools/classes/PersistentMcpOwner.js`
- deterministic MCP source-read schema projection

Required implementation packages:

1. LB-1: move novelty and notice state under the keyed runtime research-session
   owner; include repository/session identity where necessary. Give the durable
   ledger path the identity D-7 selects, so the in-memory key and the on-disk
   file cannot diverge.
2. LB-2: align headroom admission, remediation text, schema, and owner dispatch
   with D-3.
3. LB-3: include normalized `maxTokens` in partial selector identity and
   preserve the separate verified-complete-symbol reuse path. Implement D-8
   first: populate `complete_symbol_selector_fingerprint` on live delivery for
   verifiably complete results. Landing the `maxTokens` change without it
   removes cross-window reuse from every live source read.

LB-2 has two obligations beyond the blocked-response message:

- Model-visible guidance. The survey-aware `code.skeleton` redirect in
  `lib/shared/tools/classes/PersistentMcpOwner.js` (~line 1186) issues a
  `nextAction.instruction` telling the model to "batch 2-4 known targets in
  items". That field is rejected by the owner (~line 3652), absent from the
  canonical `code.window` schema in `lib/catalog/atlas-tools.js` (~line 846),
  whose `additionalProperties: false` would reject it outright, defensively
  stripped by the provider projection in
  `lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js`
  (~line 1063), and rejected by the native executor with `batching_disabled` in
  `lib/domains/atlas/functions/v2/retrieval/code.js` (~line 279). LB-2 sweeps
  the repository for model-visible guidance naming rejected call forms; fixing
  the one blocked-response message is not sufficient.
- Reservation lifetime. `ContextHeadroomReservationOwner`
  (`lib/domains/research/classes/ContextHeadroomReservationOwner.js`) is a
  process-global `Map` with no TTL and no eviction, keyed by attempt and
  provider session. `admitSourceContextHeadroom` reserves on the allowed path
  (`lib/domains/research/functions/context-headroom.js` ~line 66) and only the
  owner releases, at four sites in
  `lib/shared/tools/classes/PersistentMcpOwner.js` (~lines 3973, 4010, 4076,
  and 4146). The last is the `finally` at ~line 4142; of the other three, only
  the ~line 4010 site clears
  `contextHeadroomReservation` afterwards, so the stale-binding discard and the
  `catch` path release the same tokens twice and under-count pending
  reservations. Making scalar reads admissible at the near tier sharply
  increases reservation traffic through all of these paths. LB-2 must give the
  reservation an exactly-once release guarantee plus a TTL or scope eviction,
  so that neither a leak (permanently inflating `predicted` and recreating the
  unrecoverable block RH-1 exists to remove) nor a double release (deflating it
  and over-admitting) is reachable.

LB-1, LB-2, and LB-3 should be separate commits because their rollback and risk
surfaces differ.

### Lane C: Accounting, assessor transport, and public projection

Finding IDs: ACC-1, ASR-1, PUB-1.

Exclusive production ownership:

- `lib/domains/billing/functions/usage-segments.js`
- `lib/domains/worker/classes/TrackedProviderClient.js`
- assessor option plumbing in the assessment pipeline
- OpenAI and Grok embedded tool loops
- `package.json` only if the selected PUB-1 design requires a source change;
  under the recommended D-5 it does not, and the file stays untouched
- the coordinated clean-client sync change under `../../deployment/posse`

Do not modify `PersistentMcpOwner.js` or the deterministic MCP gateway; their
existing MCP behavior is the reference contract, Lane B owns those files during
this remediation, and the integration owner has already extracted the shared
assessor decision as IO-1.

Required implementation packages:

1. LC-1: use complete aggregate raw totals when segment precision is
   incomplete;
   keep exact pricing unknown unless exact segment data supports it. Define the
   two cases ACC-1 records as undefined: segments present with no aggregate at
   all, and the identity of `longContextTierInputTokens` on a corrected row.
   The first must keep segment sums, precision `incomplete`, and null billable
   and cost; it must not be regressed into an aggregate-preferring path that
   has no aggregate to prefer.
2. LC-2: consume the IO-1 helper in the OpenAI and Grok embedded tool loops so
   the same physical assessor call count is enforced there, while preserving
   terminal handoff availability. A local reimplementation of the ceiling
   decision in either provider loop is forbidden; if IO-1 does not expose what
   the loops need, extend IO-1 through the integration owner rather than
   forking the logic.
3. LC-3: implement D-5 and add post-projection executable validation. Cover all
   thirteen entries enumerated under PUB-1.

The deployment-repository portion of LC-3 must be reviewed and committed in its
own repository. Do not represent a Posse-only commit as a complete PUB-1 fix.

### Lane D: Waiting-lane review, enumeration, and telemetry

Finding IDs: WL-1, WL-2, WL-3.

Exclusive production ownership:

- `lib/catalog/job.js` only as required for canonical helper exposure
- `lib/domains/ui/functions/display/helpers/job-status.js`
- `lib/domains/cli/functions/review-report.js`
- `lib/domains/queue/functions/waiting-lane-preparations.js`
- `lib/domains/scheduler/functions/waiting-lane-coordinator.js`
- `lib/domains/git/functions/workflow-startup-guard.js`
- `lib/domains/observability/functions/waiting-lane-telemetry.js`
- planner readiness telemetry emission sites

Required implementation packages:

1. LD-1: derive review/background visibility from the canonical
   non-completion-blocking contract and test every registered member.
2. LD-2: replace the oldest-first lifetime cap with filtered queries or complete
   pagination for each consumer. Eviction should query relevant residents;
   startup reconciliation must page until exhaustion. This requires an API
   change, not only call-site changes: `listWaitingLanePreparations` hard-clamps
   every caller at `MAX_LIST_LIMIT = 1000`
   (`lib/domains/queue/functions/waiting-lane-preparations.js` ~lines 28 and
   235), so no consumer can page past it from the outside. Add a compound
   `(updated_at, work_item_id)` keyset cursor to the API; the existing
   `ORDER BY updated_at ASC, work_item_id ASC` (~line 262) is already a total
   order because `work_item_id` is the table's `INTEGER PRIMARY KEY`, so the
   ordering itself does not need to change. Do not page by offset.
3. LD-3: register all planner events and assert that every emitted event builds
   a non-null record.

Integration follow-up left open by LD-1, deliberately and correctly. Three
display surfaces outside Lane D's ownership — `status-command.js`,
`ReviewSession.js`, and `orchestrator-app.js` — build their "background"
progress bucket from the atlas-warm display selector alone. Once review
visibility derives from the canonical non-completion-blocking contract, a
`waiting_lane_prepare` job falls into neither the foreground nor the background
progress count, though it still renders as an ordinary job row. Excluding
optional accelerators from progress is consistent with the contract, so this is
a presentation decision rather than a correctness defect. The integration owner
decides whether those three sites adopt the derived predicate; it is a one-line
swap per site.

Do not solve WL-2 by increasing 1,000 to a larger fixed lifetime cap.

## VER-1: Re-warm only when the persisted encoding changes

Operator requirement, recorded 2026-08-21. **As long as the ledger encoding
version has not changed, a new ATLAS version must not force the databases to be
re-warmed.** Reuse is the default; invalidation must be earned.

### Current behaviour

Two independent versions can invalidate stored work, and only one of them is an
encoding version.

`ATLAS_DATA_SCHEMA_VERSION` (`contracts/ddl/index.js`, currently `3`) is the
true encoding version. It backs both `LEDGER_SCHEMA_VERSION` and
`VIEW_SCHEMA_VERSION`, and its own comment states the contract: bumped whenever
rebuildable data or index *layout* changes, with a ledger mismatch used as the
cold-boot generation marker that recreates every rebuildable store together.
That behaviour is correct and stays.

`ATLAS_PARSER_SPEC_VERSION` (`parser/version.js`, currently
`"edge-coverage-v5"`) is not an encoding version, but it invalidates as if it
were. `hasCurrentParsedBlob` and `hasCurrentTreeSitterLayer`
(`ledger/BlobStore.js` ~673 and ~686) both require an exact match against it, and
`ledgerHasCurrentParsedBlob` (`ParseEngine.js` ~191) is what
`#discoverBootFreshnessPaths` consults to decide whether a stat-matched file
still needs parsing. A bump therefore re-parses every blob in the repository
even when the persisted row shape is byte-identical.

Its own changelog shows the two meanings already conflated: `edge-coverage-v2`
records a genuine change in what `to_name` *means*, which must invalidate, while
`edge-coverage-v3/v4` are described only as "native parser coverage revisions"
and `edge-coverage-v5` says outright that it "forces existing blobs through the
corrected native parser". Those are implementation revisions. Under this
requirement they must not trigger a re-warm.

### Required contract

Separate the two axes and gate reuse on the encoding axis only.

- An **encoding change** — the shape, columns, or meaning of persisted symbol,
  edge, or layer rows — invalidates stored work. Keep the existing behaviour.
- A **parser build or coverage revision** — the same output contract produced by
  a different implementation — must not invalidate anything. Stored rows remain
  reusable and no re-warm is scheduled.
- The producing parser revision should still be recorded on the blob or layer so
  that provenance and telemetry can answer "which build produced this row", but
  **that recorded value must not participate in the currency test.** Recording it
  and gating on it are different things; only the second is forbidden.
- A deliberate re-parse must remain expressible. Removing the implicit trigger
  should not remove the operator's ability to force one, so provide an explicit
  path (a maintenance action or an encoding-version bump) rather than relying on
  a version string bump as the de facto mechanism.

### Notes for the implementer

The change is a policy split, not a rename. Verify every consumer of
`ATLAS_PARSER_SPEC_VERSION` before narrowing it — `hasCurrentParsedBlob`,
`hasCurrentTreeSitterLayer`, the `blobs` insert, the layer uniqueness key
`(content_hash, source, tool_version, parser_spec_version, config_hash,
deps_hash, fileset_hash)`, and `reconcileScipCoveredParseGaps` all reference it,
and they do not all want the same treatment. The layer uniqueness key in
particular may legitimately need to keep distinguishing producers even once the
currency test stops doing so.

SCIP layers key on `tool_version: indexerVersion` (`scip/ingester.js` ~547),
which is the external indexer's version rather than the ATLAS build. That axis
is out of scope here: a genuinely different `scip-typescript` can produce
different symbols from identical bytes, so it is not the case this requirement
describes.

Acceptance: with the encoding version unchanged, a parser-revision bump leaves
every stored blob current, `#discoverBootFreshnessPaths` reports no changed
paths for unmodified files, and no warm job is scheduled. With the encoding
version bumped, the existing cold-boot rebuild still occurs. Provenance for the
producing revision remains queryable in both cases.

## Dependency and integration order

### Wave 0: Lock contracts and baselines

Integration owner:

1. Record D-1 through D-5, D-7, and D-8, and either resolve or explicitly defer
   D-6.
2. Land IO-2 and confirm the full required baseline is green. No lane branches
   from a red baseline.
3. Land IO-1. It must be in place before Lane B and Lane C branch, because both
   assessor enforcement sites are in Lane B's exclusively owned files.
4. Capture the audited reproducers as permanent failing tests before production
   changes where practical.
5. Confirm the central CI mirror and clean-client pipeline have not moved since
   the audit.
6. Allocate isolated worktrees and file ownership.

### Wave 1: Parallel high-risk fixes

Run in parallel:

- Lane A: LA-1 through LA-3.
- Lane B: LB-1 through LB-3.
- Lane D: LD-1 through LD-3.

The integration owner reviews tests and invariants but does not merge partial
packages that weaken exactness or merely suppress an error message.

### Wave 2: Accounting, transports, and projection

Run Lane C after the Wave 1 branch tips are stable. LC-2's dependency is IO-1,
not Wave 1 branch stability: once the canonical assessor decision is a shared
module, LC-2 is a consumer change in the provider loops and needs nothing from
Lane B's owner file. LC-3 may proceed only with explicit authorization for the
central deployment repository.

If D-6 is resolved, Lane A implements LA-4 in this wave as an independent
commit.

### Wave 3: Adversarial integration

Use a fresh agent that did not author the fixes to challenge the merged result:

1. Interleave owner-hot research sessions with identical selectors and distinct
   repositories/content.
2. Exercise source reads just below, at, and above the exact headroom boundary.
3. Retry a truncated selector with a larger `maxTokens` and verify native
   execution occurs.
4. Mutate a dereferenced symlink target while Git remains clean. Where symlink
   creation is unprivileged, do this against a real tracked symlink. Where it
   is not (Windows without developer mode, restricted CI), fall back to driving
   the same walk with an injected symlink entry so the typed disposition and
   the exactness outcome are still asserted, and record which form was used.
   This mirrors the AX-1 acceptance constraint; an unexecuted step 4 is not a
   pass.
5. Transition an indexed file to minified, oversized, and unsupported-language
   forms with SCIP on and off.
6. Inject one permanently failing document into a partially successful SCIP
   recovery batch and restart at the same OID.
7. Drop a middle usage segment while retaining a complete aggregate.
8. Return more than the assessor tool cap in one OpenAI/Grok parallel batch.
9. Project the clean client and invoke or mechanically resolve every surviving
   local script target.
10. Seed more than 1,000 retired waiting-lane rows before newer active and stale
    residents, then run startup recovery and eviction.

The red-team agent reports counterexamples; it does not silently patch the
authoring agents' files.

### Wave 4: Final integration and documentation

1. Resolve red-team failures through the owning lane.
2. Run focused suites, then the complete repository verification sequence.
3. Run clean-client projection verification in the central deployment checkout.
4. Update version-coupled local design/deployment documentation if behavior or
   schemas changed.
5. Confirm all intended changes are committed, the worktree is clean, and no
   deployment or push occurred without explicit authorization.

## Finding-specific acceptance tests

### RS-1 acceptance

- Two owner-hot sessions using identical tool arguments in distinct working
  directories both receive independent novelty credit.
- Different result content for the same selector is not an exact repeat.
- Session A's midpoint, final-window, extension, or closeout flags do not
  suppress or trigger notices in session B.
- Interleaving and concurrent scheduling produce the same per-session ledgers
  as serial execution.
- Session-map eviction and gateway restart do not produce premature closeout.
  This requires D-7: two sessions sharing job, attempt, and cwd but differing in
  agent call, binding epoch, role, or token must not read or overwrite each
  other's durable ledger file.

### RH-1 acceptance

- The issued `code.window` schema, model-visible remediation, owner admission,
  and native executor all express the same call shape.
- A fresh source request at the near-tier threshold has at least one executable
  remediation path.
- Concurrent scalar reservations cannot over-admit the next context request.
- An executor throw leaks no reservation tokens: after the failure the scope's
  reserved total is back to its pre-admission value, neither retained nor
  released twice. The stale-binding discard path has the same assertion.
- No model-visible text anywhere in the repository names a call form the owner,
  the schema, or the native executor rejects.
- Covered-ref reuse and delegated evidence retain their intended bypass rules.
- The former contradictory helper and owner tests are replaced or joined by an
  end-to-end test.

### SC-1 acceptance

- Partial requests differing only in `maxTokens` do not share exact selector
  coverage.
- A larger retry executes and can return additional content.
- Verified complete-symbol coverage still supports safe window-size reuse, and
  the two live-delivery cases are distinguished explicitly: a complete,
  untruncated live window followed by a different-`maxTokens` retry still
  reuses; a truncated live window followed by the same retry does not.
- `truncated`, `selectionBounded`, and `outputTruncated` combinations have
  explicit reuse tests.
- The complete-symbol assertions run against the live-delivery origin. The
  current suite's complete-symbol test uses `origin: "prefetch"` only, so it
  cannot catch this regression and does not count as coverage for it.

### AX-1 acceptance

- A tracked symlink that escapes the repository is excluded or prevents exact
  publication according to D-1.
- Mutating its target cannot change bytes served under an unchanged exact proof.
- Ordinary tracked files and supported internal paths remain indexable.
- Windows/no-symlink environments exercise the same typed disposition without
  requiring privileged symlink creation.

### AX-2 acceptance

- Ordinary -> oversized removes prior symbols before exact publication.
- Ordinary -> minified removes prior symbols before exact publication.
- Ordinary -> unsupported language removes prior symbols before exact
  publication, exercised as a parser-support change across generations rather
  than a renamed file.
- The same transitions are tested with SCIP enabled, disabled, and non-covering.
- Restarting at the new exact OID never resurrects the prior symbols.
- If a degraded-retention mode is chosen instead, exact proof is rejected and
  the degraded state is visible.

### SCIP-1 acceptance

- A permanently failed isolated document is absent from acknowledged receipt
  rows.
- Partial batch success cannot mark the failed document intake-complete.
- Same-OID restart retries or rejects exact boot for the failed document.
- Successful indexer omission plus complementary tree-sitter coverage continues
  to satisfy the documented exactness rule.
- Failure, omission, and acknowledged success are distinct in telemetry and
  durable state.

### ACC-1 acceptance

- Incomplete segment sums plus complete aggregates report aggregate input and
  output counters.
- Exact price and billable counters remain `null` or unknown when segment data
  cannot support them.
- Complete matching segments retain current exact pricing behavior.
- Incomplete segments with no aggregate at all keep their segment sums,
  precision `incomplete`, and null billable and cost counters.
- `longContextTierInputTokens` carries the decided identity on a corrected row
  and is asserted against it, rather than silently staying segment-scoped
  beside aggregate input and output counters.
- Aggregate-only and no-usage cases remain unchanged.
- Timeline, approval, review, and UI consumers display the same canonical raw
  totals.

### ASR-1 acceptance

- MCP, OpenAI, and Grok count each physical assessor function call identically,
  and all three reach that count through the IO-1 helper rather than through
  three implementations.
- One provider turn containing more than the limit cannot execute excess calls.
- Calls already in an over-limit parallel batch have a deterministic blocked
  result and do not reach executors.
- Terminal `agent_handoff` remains callable after the normal tool ceiling.
- Read-file sublimits and generic total limits compose without double counting.

### PUB-1 acceptance

- After clean projection, every surviving `package.json` script that references
  a repository-local file resolves to an existing shipped file.
- All thirteen dangling commands enumerated under PUB-1 are either removed or
  executable according to D-5, including the eight that pre-date the audit
  window. Clearing only the five audited `contract:*` entries satisfies no
  version of this criterion: the generic check above would still fail on the
  other eight, and turning it on in that state turns CI red.
- Main-only internal contract checks continue to run in the source repository,
  which requires the entries to remain in the source `package.json` and be
  removed at projection time.
- Projection verification fails on a newly introduced dangling script target.

### WL-1 acceptance

- A failed `waiting_lane_prepare` plus successful foreground work does not
  produce review `FAIL`.
- Every current and future member of the canonical non-completion-blocking set
  is included automatically.
- Foreground failures remain review-visible.

### WL-2 acceptance

- More than 1,000 older terminal rows cannot hide a newer stale ready resident
  from eviction.
- Startup reconciliation examines all relevant durable and filesystem rows.
- Active/non-retired prepared worktrees remain protected from generic GC until
  the waiting-lane policy selects them.
- Query and pagination behavior is deterministic under concurrent inserts. The
  existing `ORDER BY` is already a total order, so this is satisfied by a
  compound `(updated_at, work_item_id)` keyset cursor that resumes exactly
  after the last returned row, not by offset paging and not by the current
  cursor-less `LIMIT`.
- No consumer is clamped by a lifetime row cap it cannot page past.
- Tests include no-asset terminal history, resident assets, TTL eviction, cap
  eviction, and recovery after process restart.

### WL-3 acceptance

- `planner_reserved`, `planner_deferred`, and `planner_fallback` each build and
  persist a telemetry record.
- A contract test enumerates planner emission names and proves every name is
  registered.
- Unknown names continue to fail closed or return `null` according to the
  observability API contract.

### ML-1 acceptance

If D-6 chooses next-boot reseed:

- build labels at commit A, rebuild at commit B after changing/deleting seed
  inputs, restart unchanged at B, and prove labels are reconciled before ready;
- exact source boot skip remains available independently of ML reseed work;
- readiness cannot treat an unreconciled imported snapshot as a fresh success.

If D-6 chooses persistent carry-forward:

- policy text and readiness explicitly permit carry across exact boots;
- telemetry identifies carried versus reseeded labels;
- stale labels cannot claim a source-generation identity they do not match.

## Verification commands

Run commands from `posse/` unless a package script states otherwise. Confirm the
current repository README and `package.json` before execution if commands move.

Required baseline:

```sh
npm run lint
npm run typecheck
npm run contract:agent-tools:check
npm run contract:remote-agent-tools:check
npm run contract:posse-remote:check
npm test
```

Required focused families:

```sh
node --test test/core/suites/deterministic-mcp-server.test.js
node --test test/core/suites/atlas137-accounting-coverage.test.js
node --test \
  test/test-atlas-boot-exact-skip.test.js \
  test/test-atlas-v2-scip-batch-coverage.test.js \
  test/test-atlas-v2-scip-stager-registry-2.test.js \
  test/test-atlas-v2-readiness.test.js \
  test/test-atlas-v2-warmer-2.test.js
```

Also run the focused owner, researcher synthesis, provider, review-report,
waiting-lane, startup-guard, and clean-projection suites changed by each lane.
Test filenames should be reported in each agent handoff rather than inferred by
the integrator.

Final repository checks:

```sh
git diff --check
git diff --cached --check
git status --short --branch
```

The central clean-client projection must be run and verified from the
authoritative deployment checkout. Do not substitute the sibling generated
client checkout for the central pipeline test.

### Isolated worktrees cannot produce the required baseline

The execution model assigns every lane an isolated worktree, and the completion
criteria require a full green suite. Those two requirements conflict: five test
files cannot pass in a linked worktree for environmental reasons, and none of
the five indicates a real defect. Measured at clean `1d05d27a` in a detached
worktree, with 781 of 786 files passing:

- `test/test-atlas-complete-tool-parity.test.js`,
  `test/test-atlas-v2-retrieval.test.js`,
  `test/test-atlas-v2-scip-stager-registry-1.test.js`, and
  `test/test-atlas-v2-scip-stager-registry-2.test.js` fail with
  `indexer_unavailable` where they expect `already_staged`.

  The dominant cause is the **native binary tree**, not SCIP indexer
  resolution. A linked worktree has no `posse/lib/bin/posse-atlas/...`, so batch
  staging fails at `ATLAS native method unavailable: scip-sanitize` before any
  indexer is consulted. Pointing `POSSE_NATIVE_BIN_ROOT` at the main checkout's
  `lib/bin` takes registry-2 from 15 failures to 1 — measured both ways at a
  clean base. Set that variable in any worktree that must exercise SCIP
  staging; the single residual failure is a genuine indexer-resolution case.
- `test/test-test-git-isolation.test.js` fails with
  `ENOTDIR ... .git/config`, because a linked worktree's `.git` is a file
  rather than a directory and the test opens it as a directory.

Two further environment traps affect the required baseline itself:
`contract:remote-agent-tools:check` and `contract:posse-remote:check` both read
`../posse-remote/rust/catalog/tool_suite.rs` as a sibling of the checkout, so
they fail with `ENOENT` in any worktree that is not placed beside
`~/repos/posse-remote`.

Therefore: run focused suites in the lane worktree, but run the required
baseline in a checkout that has the SCIP indexers installed, a real `.git`
directory, and the `posse-remote` sibling present. A lane that runs `npm test`
in its own worktree and reports five failures has reported nothing, and a lane
that learns to ignore five standing failures will eventually ignore a sixth
that matters. The integration owner records the current worktree-baseline
exception list and re-measures it whenever the environment changes.

## Red-team rejection criteria

A fix is rejected if it does any of the following:

- replaces one process-global research object with a differently named global;
- keys state only by relative path or provider role rather than session owner;
- fixes headroom by suppressing the warning while the source read remains
  impossible;
- increases a fixed enumeration limit instead of making relevant-row discovery
  complete;
- keeps stale symbols while continuing to call the generation exact;
- records a failed SCIP document as acknowledged under a new boolean alias;
- restores aggregate cost estimation when segment precision cannot support it;
- counts provider turns instead of physical assessor tool calls;
- implements assessor budget logic a third time in a provider loop instead of
  consuming the canonical IO-1 helper;
- adds `maxTokens` to partial selector identity without restoring
  complete-symbol reuse for live delivery;
- fixes only the five originally audited dangling commands and leaves the eight
  pre-existing ones;
- ships internal clean-client scripts without the required publication review;
- adds isolated unit tests for both sides of a contradiction without an
  end-to-end assertion;
- changes the carried-ML behavior without recording D-6.

## Completion criteria

This remediation is complete only when:

1. Every confirmed finding has a regression test that fails at the lane base
   `248b57f7` and passes with the fix, or the handoff records why a direct
   historical failure fixture is impossible. `248b57f7` is the Wave 0 head:
   `1d05d27a` plus IO-2 (`edafb190`) and IO-1 (`248b57f7`). Do not measure
   fail-at-base against `1d05d27a` — it is the red baseline IO-2 repaired, and
   a lane sitting on it inherits a failing
   `test/test-agent-tool-contract.test.js` that belongs to no lane.
2. D-1 through D-5, D-7, and D-8 are recorded; D-6 is implemented or explicitly
   deferred with no behavior change.
3. The adversarial integration pass produces no cross-session state leak,
   impossible remediation, stale exact view, invalid receipt, accounting
   undercount, transport budget bypass, dangling public command, or waiting-lane
   starvation.
4. Main and central clean-client projection validation pass.
5. Full lint, typecheck, contract, and test suites pass after integration.
6. All intended changes are committed, the final worktrees are clean, and
   commit handoffs preserve finding IDs and test evidence.
7. No push or deployment occurs without explicit operator authorization.
