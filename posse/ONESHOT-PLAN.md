# One-Shot Dev Fast Path — Plan v2 (pre-planner revision)

Status: planned, not started. v1 was red-teamed by three independent reviews and cut to a
deterministic-only local kernel. v2 (2026-07-02) revises v1 after a design review of the
scope/locking model: the routing brain is now the **existing `preflight` role** extended
into a pre-planner, which dissolves v1's most restrictive eligibility rule (the mandatory
single file mention) and opens the far larger "trivial but no file named" population. v2
also adds a **lock-verification guard inside the mutating tools** as defense in depth.
v1's red-team cuts remain in force except item 6, which is superseded in narrowed form
(see "Revision notes" below).

## Final shape in one paragraph

For trivial work items, skip the token guzzlers: mention-bearing trivial WIs
(deterministically recognized) spawn a `job_type:"dev"` job directly from intake; trivial-
*shaped* WIs without a resolvable file mention route through the existing cheap `preflight`
role, which proposes a route (`oneshot` with candidate files, `plan_direct`, or `solo`) that
a deterministic gate validates before anything is spawned. The LLM proposes; the gate
disposes; the assessor always runs. Everything else — worktrees, lease-time file locks,
scope enforcement, inline assessment, fix chains, BLOCKED→human recovery, needs_replan
loopback — is existing dev-job machinery and is deliberately untouched, now hardened by a
lock-assertion check baked into every mutating tool. Alongside (independent of the carve):
`task_mode:"db"` makes DB-only dev work expressible as a non-locking write scope. Savings
per eligible WI: one standard-tier plan call (arm A) or a research call *and* a plan call
(arm B), minus one cheap preflight call on arm B.

## Revision notes — what changed from v1 and why

1. **v1 cut item 6 ("Preflight LLM promotion — DELETED") is superseded in narrowed form.**
   The original cut rejected *paying an LLM call to gate the narrow one-shot carve* and
   *putting an unguarded probabilistic guess in front of a hard-scoped dev*. v2 differs on
   both counts:
   - Economics: the pre-planner routes the whole trivial-shaped stream, not just the regex
     carve. For no-mention trivial WIs (which today fall through `simpleNoResearch` — it
     requires exactly one file mention, routing.js:389 — into **solo research + plan**), a
     cheap preflight call replaces BOTH standard-tier calls. Break-even is roughly one
     avoided standard call per (standard/cheap ratio) preflight calls; Phase 0 measures the
     real hit rate.
   - Safety: the LLM output is sandwiched. A deterministic pre-filter decides whether
     preflight runs at all; the same deterministic demotion gate from v1 validates every
     file the LLM names before a dev job exists; the assessor is never skipped. The
     probabilistic step can only *fill in scope* or *demote* — it cannot bypass a
     deterministic check.
   - Mechanism: no new role. `preflight` already exists as a cheap, routing-only,
     no-write, maxTurns-2 role (worker/classes/roles/preflight.js:49-112) with a fail-open
     JSON consumer (pipeline-continuation.js:112-134: malformed or unknown `mode` → solo
     research). v1's item-2 deploy hazard (unknown role classes 400 at validation.rs, manual
     role_contracts insert) does not apply. What DOES apply: the preflight contract text
     lives in the remote prompt bundle (preflight.js:85-87 → getPromptBundleRolePrompt), so
     the new decision modes require a posse-remote **prompt content** update. Sequencing is
     graceful in both directions (see 1c) but v2 is honestly "one repo plus one remote
     prompt-bundle edit," not v1's "one repo, no deploy coupling."

2. **Considered and cut in v2 — claim-time scope + wait-on-lock tool.** Letting the dev
   establish scope/locks at first mutating tool call, with a wait tool to pause on lock
   conflicts, was examined and rejected:
   - Cross-WI file locks are merge-conflict prevention across branches, not mutual
     exclusion on a shared tree. WI-tier locks are held until the holder's branch merges
     (file-locks.js:20-22), so a conflicting one-shot's worktree is stale by exactly the
     change that mattered once the lock frees. Waiting in-call cannot fix that; only
     re-running in a fresh worktree can — which is what the scheduler's existing
     queue-level deferral already does, for free, before any provider spend
     (acquireLeaseWithWriteLocks returns null; JOB_WRITE_LOCK_BLOCKED logged once). The
     cross-WI sync divergence guard (test/test-cross-wi-sync-guard.test.js) is standing
     evidence that "resume after the lock frees" is the hard part, not the waiting.
   - Incremental acquisition + waiting reintroduces deadlock that all-or-nothing lease-time
     acquisition is immune to by construction, and converts every mitigation into a wasted
     paid dev call.
   - With the pre-planner resolving scope *before job creation*, one-shot jobs lease with
     known scope and locks exactly like every other dev job — mid-job lock discovery is
     structurally impossible, so the use case evaporates.
   Lock-conflict error copy in the tool guard (1f) explicitly instructs "report BLOCKED; do
   not retry or poll" so no future wait primitive gets repurposed for this.
   (A general background-task tool for long bash runs is a legitimate, separate workstream —
   it is not lock-related and is out of scope here.)

3. **skip_assessment is never LLM-decided. Hard line, unchanged from v1.** The dominant
   misclassification is a confidently-wrong dev, and the assessor is the net. Letting the
   same probabilistic judgment that routed a job also remove that job's net is a correlated
   failure: the WIs preflight misjudges as trivial are the ones it will misjudge as not
   needing assessment. If assessment savings are wanted later, the deferred path is a
   deterministic post-hoc downgrade (tiny single-file diff, no logic-shaped tokens →
   cheap-tier assess), which keeps the net and captures most of the dollars.

4. **New in v2: `task_mode:"db"` — a DB-only qualifier treated as a non-locking write
   scope (1h).** Dev tasks whose entire work product is database mutations (via the
   `project_db_query` tool and its operator-granted permissions) currently cannot be
   expressed: empty file scope throws (developer.js:98-103) and, if it didn't, the
   unknown-scope promotion would take a whole-repo lock (file-locks.js:83-86) — total
   pipeline serialization for a job that touches zero files. File locks exist to prevent
   cross-branch merge conflicts; DB writes don't merge through git, so the lock model
   simply doesn't apply to them. Precedent already in the catalog: `artificer` is mutating
   but non-locking and worktree-free (catalog/job.js:157-201).

## v1 red-team cuts still in force

Unchanged from v1 (see git history for the full rationale): ESCALATE status (cut — assessor
+ BLOCKED→human + needs_replan already cover both directions; a failed unparented one-shot
bricks the WI); new dev role class on posse-remote (cut — payload `task_spec` channel
carries the framing; `packet.recipient` stays `"dev"` for ATLAS prefetch); rename
eligibility (cut — delete+create can't be modify-scope; symbol renames have multi-file
blast radius); cheap tier for one-shot devs (cut — fix jobs inherit tier,
verdicts/fail.js:599); ONESHOT_ROUTED/ESCALATED events (cut — RESEARCH_ROUTING already
records routing). The typo_fix intent remains dead code (no `typo_fix` in VALID_INTENTS,
intake/functions/hints.js:4-13; routing.js:408 is unreachable).

## Phase 0 — Evidence gate (mandatory, before any code)

Same discipline as v1, with the populations split. One-off analysis script over real
project DBs (`.posse/db/orchestrator.db` per active repo):

- **Population A** — WIs that match the v1 carve (trivial regex + exactly one file mention
  + <200 chars + not COMPLEX_RE + no protected mention). Counterfactual saving: one
  standard plan call each (they already skip research via `simpleNoResearch`).
- **Population B** — WIs that match the trivial-shaped pre-filter but have zero resolvable
  file mentions (today these fall to solo research → plan). Counterfactual saving: one
  research call + one plan call, minus one cheap preflight call.
- For both: fraction whose historical plan emitted exactly one dev task; downstream
  fix/replan/blocked rates vs baseline.

Kill thresholds (tune before running): proceed with arm A if A-volume ≳15 WIs/month and
≥80% single-dev-task; proceed with arm B (the preflight extension) only if B-volume clears
the same bar AND the projected preflight hit rate (fraction of B the gate would accept)
makes cheap-call tax < avoided standard calls. If only A clears, build arms A-only and skip
1c. If neither clears, ship the consolation win and stop:

> `createPlanAfterSkippedResearch` (intake-routing.js:135-146): drop `model_tier` from
> `"standard"` to `"cheap"` for skipped-research plan jobs. ~5 lines + test.

The tier drop is worth doing regardless (it covers the no_research remainder one-shot
doesn't take, and it makes arm-B demotions cheap).

**The lock guard (1f) and the db task mode (1h) are independent of all thresholds and
ship regardless** — both are pipeline infrastructure, not one-shot features.

## Phase 1 — The kernel

Land 1a + 1b + the dispatch arm in ONE change (a classifier emitting `oneshot` before the
dispatch branch exists falls through to the default research spawn at
intake-routing.js:264 — a regression vs. today's plan path for those WIs). 1c can land
separately after (its absence just means arm B stays dormant).

### 1a. Classifier — lib/domains/research/functions/routing.js
Two new arms placed immediately before the `simpleNoResearch → no_research` arm
(routing.js:412):

- **Arm A (direct):** `ONESHOT_SIMPLE_RE` (the typo/spelling/comment/docs/whitespace/
  copy-edit subset of `SIMPLE_NO_RESEARCH_RE`, explicitly EXCLUDING rename terms and
  `formatting`) + exactly one file mention + <200 chars + !COMPLEX_RE +
  !protectedFileMention → `{ bucket:"oneshot", reason, budget:"low",
  candidate_files: fileMentions }`.
- **Arm B (pre-planner candidate):** same `ONESHOT_SIMPLE_RE` + **zero** file mentions +
  <200 chars + !COMPLEX_RE + not question mode → `{ bucket:"oneshot_candidate", reason,
  budget:"low" }`. WIs with 2+ mentions do NOT get an arm — multi-file is not one-shot.
- Everything else unchanged: question-mode arms stay first; promote and non-matching
  simpleNoResearch stay `no_research`; `renameMultiNoResearch` stays `no_research`.
- `buildSyntheticResearchBrief`: populate `key_files` from candidate_files for the oneshot
  bucket (assessor/replan context parity), and from the preflight-resolved files for arm B.

### 1b. Shared gate + job factory — lib/domains/research/functions/intake-routing.js
`createOneshotDevJob(workItem, { routing, source, projectDir, candidateFiles, parentJob })`
— called from two sites: the `bucket === "oneshot"` dispatch arm in
`createInitialResearchOrPlanJob` (arm A, no parent), and the preflight consumer (arm B,
`parent_job_id` = the preflight job).

Demotion gate — ANY failure demotes to `createPlanAfterSkippedResearch` with an
`ONESHOT_DEMOTED` event carrying per-file gate results and
`demotion_source: "intake_gate" | "preflight_gate"`:
1. `validateScopedPath` per candidate (lib/shared/scope/functions/validation.js:11-28 —
   absolute paths, `..` traversal, protected paths). The mention regex admits `../`
   prefixes (routing.js:57-60); fs.stat alone would follow them outside the repo.
2. Containment: `path.resolve(projectDir, candidate)` stays under projectDir.
3. Git-tracked: batch `git ls-files` — rejects ignored/generated files (guaranteed
   no-op→dead-letter loop otherwise) and canonicalizes casing.
4. `isHighRiskPath` (handoff/functions/helpers/file-request.js:130-138) → demote.
5. `isPlanApprovalEnabled()` → demote (bypassing the planner must not bypass
   sign-off-before-writes, plan-compiler.js:1884-1889).
6. `redTeamPlan` requested → demote.
7. Candidate count must be exactly 1 (cap is the blast-radius bound; preflight emitting
   more than one file is an automatic demote, not a truncate).

On pass — parity bookkeeping with the no_research path (`updateWorkItemResearchSkip`,
synthetic brief, `refreshWorkItemStatus`), then `createJob`:
- `job_type:"dev"`, title `One-shot: <wi title>` (operator's mid-flight route signal in the
  TUI), priority = WI priority, `model_tier:"standard"`, `reasoning_effort:"low"`.
- payload (mirrors plan-compiler.js:1515-1550 shape):
  - `task_spec`: WI title + description **verbatim**, then one framing sentence: the task
    was machine-derived from the work item with no planner; the work item text is the
    authoritative statement of intent; make the smallest change that fully satisfies it.
    (The assessor's TASK SPECIFICATION is exactly `payload.task_spec`,
    assessment-pipeline.js:820-839 — verbatim WI text keeps inline assessment strong.)
  - `success_criteria`: restate the requested edit as a checkable condition + "the change
    is internally consistent (nothing the request implies was left un-updated)". NOT "no
    changes outside the requested edit" — that rewards under-scoped edits.
  - `files_to_modify`: the gate-resolved candidate. `files_to_create/delete`,
    `create_roots`, `must_modify`: empty. (Non-empty modify scope is load-bearing:
    developer.js:98-103 throws on empty writable scope; empty scope means a whole-repo
    lock via the unknown-scope promotion, file-locks.js:83-86.)
  - `task_mode:"code"`; `dev_mode:"cleanup"`; `risk:1`; `oneshot:true`;
    `_oneshot_reason: routing.reason`; `_oneshot_source:"intake"|"preflight"`;
    `_assess_model_tier:"standard"`.
  - `skip_assessment`: never set.

Locks and leases are exactly the standard path: scope is known at job creation, locks
acquire all-or-nothing at lease (acquireLeaseWithWriteLocks, file-locks.js:417-493), and a
conflicted one-shot waits in the queue — when it finally leases, its worktree is created
fresh off post-merge main. No new concurrency semantics.

### 1c. Pre-planner — extend the existing preflight role (arm B)
- **Dispatch:** `bucket === "oneshot_candidate"` → `createPreflightResearchJob`
  (intake-routing.js:164-195) with a payload directive (e.g.
  `preflight_objective:"oneshot_scope"`). `assembleContext` (preflight.js:54-83) already
  renders WI text, intake hints, the deterministic routing result, and the project map —
  the directive adds a short framing block asking it to resolve the single target file if
  one exists.
- **Contract (remote prompt bundle, role `preflight`):** extend the decision schema —
  `mode ∈ { "oneshot", "plan_direct", "solo", "fanout_clear" }`, plus
  `candidate_files: [<repo-relative path>]` (required for `oneshot`, max 1) and the
  existing `budget`/`reason`/`branches`. Output stays strict tiny JSON; the role keeps
  `allowWrite:false`, cheap tier, low effort, maxTurns 2. It has no skip-assessment
  vocabulary at all.
- **Consumer (pipeline-continuation.js):** `parsePreflightRoutingDecision` (112-134) gains
  the two modes; `spawnResearchAfterPreflight` (380+) gains two arms:
  - `oneshot` → run the 1b gate on `candidate_files`; pass → `createOneshotDevJob`
    parented to the preflight job; fail → ONESHOT_DEMOTED(preflight_gate) →
    `createPlanAfterSkippedResearch`.
  - `plan_direct` → `createPlanAfterSkippedResearch` (research skipped; captures the
    research-skip saving on trivial-ish items that aren't one-shot-safe).
  - `solo`/`fanout_clear`/malformed/unknown → existing behavior, unchanged.
- **Deploy sequencing (graceful both ways):** old bundle + new local → preflight never
  emits the new modes; arm B degrades to solo research (today's behavior plus one cheap
  call). New bundle + old local → `PREFLIGHT_MODES` rejects unknown modes → solo fallback
  (verified at pipeline-continuation.js:125). Ship local first, then the bundle edit.
- **Contract creep guard:** the role's output schema is the whole interface. Additions
  (success criteria, tier picks, task specs) are rejected by default — each one walks
  preflight toward being the planner it exists to skip. Any widening needs Phase-0-style
  evidence.

### 1d. Dead-letter recovery arm — lib/domains/worker/functions/helpers/dead-letter.js
Unchanged from v1: a dead-lettered leaf dev with no dependents spawns nothing and the WI
goes terminally `failed` with no human gate (dead-letter.js:519-589 +
queue/functions/index.js:562-570). One-shot makes dev a pipeline head (arm A has no parent
at all), so extend the leaf-recovery arm: `payload.oneshot === true` → spawn the same
urgent `human_input` recovery as the research arm, leaving the WI `waiting_on_human`.

### 1e. FILE_REQUEST hardening — where file-request approval is decided
Unchanged from v1: for `payload.oneshot` origin jobs, route ALL file requests through the
human-gated path (never auto-approve mid-risk creations, file-request.js:16-32, 259-267).
Honest invariant: the one-shot's own commit cannot create files; creations require a human
gate.

### 1f. Lock-verification guard in mutating tools (defense in depth — ships regardless)
**Status: SHIPPED 2026-07-02.** Implementation deltas from the sketch below: the guard
lives in the shared toolkit executors (`guardToolWriteLock` →
`verifyOrAcquireJobWriteLockForPath` in file-locks.js), which covers the embedded
runtime, the MCP subprocess (ambient job via per-message observation context), and
ToolExecutor from one choke point — write_file/edit_file/image-mutation family, plus
explicit guards at the move_file/copy_file sites (ToolExecutor + MCP server local
handlers). make_dir is exempt (empty dirs aren't content). No per-(job,path) cache — one
indexed SQLite lookup per write is cheap and always correct, where a cache could go stale
on mid-job path handoffs. Guard fails open on internal error (scope predicates remain the
primary barrier).
Today locks are inserted at lease from payload scope (file-locks.js:348-376) and trusted
thereafter; the mutating tools check scope predicates (tool-runtime.js:334-353) but never
verify the job actually *holds* a lock covering the path. Any drift between scope and
locks — explicit-scope leases narrower than payload, `skipConflictCheck` callers,
FILE_REQUEST-approved mid-job scope additions whose lock rows were never inserted, future
bugs — currently writes unguarded. One-shot raises the stakes (scope is machine-derived),
so close the gap for everyone:

- New helper in file-locks.js: `jobHoldsWriteLockForPath(jobId, path)` — normalizeLockPath
  + file-exact or under-root match against the job's unreleased `job_file_locks` rows
  (same semantics as lockRowsTouchPath, file-locks.js:115-124).
- New guard called by every mutating tool handler (`write_file`, `edit_file`, and the
  image-mutation family) after the existing scope-predicate checks: resolve the ambient
  job via `getObservationContext()` (already used by agent_feedback in the same file); no
  ambient job (ad-hoc CLI/test usage) → skip, this is job-context defense only. Cache
  positive results per (job, path) for the attempt.
- On miss: **acquire-or-refuse**, transactionally. Run the single-path conflict check
  (findWriteLockConflict with a one-file scope) inside `runImmediateTransaction`; no
  conflict → insert the job+WI lock rows (reuse insertJobLocks/insertMissingWiLocks) and
  log JOB_WRITE_LOCKS_ACQUIRED with `event_json.source:"tool_guard"`; conflict → return a
  tool error to the model: the path is locked by WI#n/job#n, **"report BLOCKED with the
  lock holder in the reason; do not retry or poll."** Log JOB_WRITE_LOCK_BLOCKED with
  `source:"tool_guard"`. No new event types.
- Non-goals: this guard never *widens* scope (the scope predicates already ran and stay
  authoritative); it only guarantees lock rows exist for what scope already allows, and
  refuses writes whose lock another WI holds.

### 1g. Events — catalog/event.js + observability/functions/event-types.js
`ONESHOT_DEMOTED` only (per-file gate results + demotion_source). Routing lands in
RESEARCH_ROUTING for free (intake-routing.js:74-89); preflight decisions land in the
existing preflight event trail; the lock guard reuses JOB_WRITE_LOCKS_ACQUIRED /
JOB_WRITE_LOCK_BLOCKED with a source marker.

### 1h. DB-only task mode — `task_mode:"db"` as a non-locking write scope
**Status: SHIPPED 2026-07-02.** Implementation notes beyond the sketch: the write-lane
decoupling is a `projectDbWrite` capability override threaded end-to-end (developer
buildOpts → embedded declaredScope for openai/grok → CLI boot payload + OAuth claims →
MCP server `projectDbCapability()`; contract gate honors it for tool presence). The dev
role's previously-degenerate read lane is now the db-mode tool surface (read/inspect +
bash + project_db_query, no file mutation tools) — this was required because the MCP
path's toolkit scope checks are hasScope-conditional, so "empty scope + write tools"
would have been unscoped writes; allowWrite:false makes every existing write-assumption
fall into its safe branch. The MCP boot allowWrite override can only narrow (ANDed with
the role capability). PostExecutionCoordinator skips the commit machinery for db mode
(the unscoped-add assert would throw) with a defensive dirty-reset. Zero-commit db WIs
land in pending_review exactly like VERIFIED_NO_CHANGE WIs today. Worktree skip deferred
as planned. Planner adoption shipped locally (no remote bundle needed):
`buildProjectDbRoutingLines` (planner-helpers.js) appends a project-db block to the
planner's PIPELINE ROUTING CONTEXT that is EMPTY for unconfigured repos — write-capable
grants get db-task emission guidance, read-only grants get an inspection-only advisory —
and db-mode dev jobs get matching local run instructions in their prompt.
Independent of the one-shot carve (like 1f): general pipeline infrastructure whose primary
consumer is the planner (which today has no legitimate shape for "update rows in the
project DB" and is pushed to invent migration files). Design:

- **Catalog:** add `db` to `TASK_MODES` (catalog/artifact.js:29-38 — needsInputs/
  needsWorkspace/needsArtifacts all false). NOT in `UNSCOPED_GIT_ADD_TASK_MODES` (nothing
  to stage). Job type stays `dev`; the qualifier is payload-level.
- **DB-only means DB-only:** at job creation and again in developer.js, `task_mode:"db"`
  requires empty file scope (files_to_modify/create/delete, create_roots all empty). A
  task needing both file and DB writes is a normal `code` job and locks normally. The
  developer empty-scope throw (developer.js:98-103) gets a db-mode carve-out; the role
  runs with `allowWrite:false` — its only write surface is `project_db_query`, which is
  independently gated by the operator's grant (statement-level authorization: verb
  allowlist, single-statement guard, permission gate — toolkit/project-db/permissions.js).
  A db-mode job whose project has no write-capable grant is rejected at the job factory
  with a clear error, not at runtime.
- **Non-locking:** `jobNeedsWriteLocks` (file-locks.js:73-75) becomes payload-aware —
  return false for `task_mode:"db"`, exactly the existing `_assess_only` pattern in the
  same function. That single choke point removes both hazards at once: no lock rows, no
  conflict check at lease, AND the unknown-scope→`roots:["*"]` promotion never fires
  (getJobWriteScope guards on jobNeedsWriteLocks, file-locks.js:83-86). db jobs drop out
  of the lock views cleanly and run fully concurrent with file jobs.
- **Concurrency caveat, stated honestly:** the DB engine serializes writes; two db jobs
  logically conflicting on the same rows is an application-level hazard the lock system
  never protected anyway (row conflicts don't map to paths). Accepted by design. If it
  ever bites, the re-entry is a coarse per-WI "db" lock kind — not path locks.
- **Immediate-effect semantics, stated honestly:** DB writes are live the moment they
  execute — no branch, no merge gate, no worktree reset can revert them
  (snapshotAndResetDirtyWorktreeAsync resets files only). A failed/partial db job leaves
  real state; recovery is the assessor + corrective jobs, not a revert. This is the
  strongest argument for the next point.
- **Assessment runs, and it can verify:** `dev` stays in ASSESSABLE_JOB_TYPES. The
  PostExecutionCoordinator's no-change handling must treat db-mode COMPLETE-with-zero-diff
  as legitimate success (evidence = dev-log criteria_check + query outcomes), not convert
  it to a no-op failure or VERIFIED_NO_CHANGE. The assessor gets read-grant
  `project_db_query` access, so it can SELECT to confirm the claimed end state — a
  stronger net than diff review.
- **Worktree:** db jobs don't need one. WORKTREE_JOB_TYPES is job-type-keyed
  (catalog/job.js:201); a payload-aware skip is a small optimization — take it if cheap,
  defer if it ripples.
- **One-shot interplay:** deferred (see Deferred). One-shot v2 stays file-only; routing
  db-shaped trivial WIs (via preflight emitting a db mode) needs the grant check as a gate
  condition and its own Phase-0 evidence.

## Recovery model (all existing machinery — verify, don't build)

- Dev self-reports BLOCKED → human_input with blocked_recovery choices incl. "replan"
  (PostExecutionCoordinator.js:197-313) — the human pre-emptive escape, now also the
  instructed terminal for tool-guard lock refusals.
- Assessor fail → fix chain at standard tier (verdicts/fail.js).
- Assessor needs_replan → research loopback, correctly parented, replan-capped
  (verdicts/needs_replan.js:51-170) — the automatic post-hoc escape.
- Preflight malformed/unknown output → solo research fallback
  (pipeline-continuation.js:112-134) — the arm-B escape.
- Stall-exhausted → existing capped human recovery (dead-letter.js:543-589).
- `research_skipped` self-heals if a later researcher runs (pipeline-continuation.js:556-557).

## Testing

- routing.test: arm A matches the trivial phrasings; rename/formatting do NOT match; 2+
  mentions, ≥200 chars, COMPLEX_RE, protected paths, question mode excluded; arm B fires
  only on zero-mention trivial text; non-matching simpleNoResearch still routes
  no_research (no behavior change).
- intake-routing.test: each demotion reason (traversal mention, untracked file, ignored
  file, high-risk path, plan-approval on, redTeamPlan, >1 candidate) → plan path +
  ONESHOT_DEMOTED with per-file results + demotion_source; pass case → payload shape
  assertions (single-file modify scope, no create scope, verbatim WI text, standard tier,
  no skip_assessment).
- pipeline-continuation.test: parsePreflightRoutingDecision accepts oneshot/plan_direct,
  clamps candidate_files, falls back to solo on unknown mode/malformed JSON (old-bundle
  simulation); spawnResearchAfterPreflight oneshot arm → gate → dev job parented to
  preflight; gate-fail → demoted plan job.
- file-locks.test: jobHoldsWriteLockForPath (file hit, root hit, released rows, casing on
  win32).
- tool-runtime.test: guard passes when lock held; auto-acquires when scope-allowed but
  lock missing (rows inserted, event logged); refuses with BLOCKED-instruction copy when a
  sibling WI holds the path; skips when no ambient job.
- dead-letter.test: force-dead-letter a oneshot leaf → human_input recovery, WI
  waiting_on_human, NOT failed.
- file-request.test: oneshot origin + mid-risk creation request → human gate, not
  auto-approve.
- db-mode tests: jobNeedsWriteLocks false for task_mode:"db" (and unaffected for code
  jobs); db job leases with zero lock rows and no conflict check while a same-path file
  job is running; unknown-scope promotion does not fire; job factory rejects db mode with
  non-empty file scope and rejects when no write-capable grant exists; developer carve-out
  (no empty-scope throw, allowWrite false, edit_file/write_file blocked, project_db_query
  available); PostExecution treats db-mode COMPLETE with zero diff as success (no no-op
  dead-letter, no VERIFIED_NO_CHANGE coercion).
- e2e (fast suite): inject "fix typo in README.md" → exactly one dev job, no
  research/plan jobs, inline assess runs, WI completes; "fix the typo on the pricing page"
  (no mention) → preflight → dev, both guzzlers skipped; two same-file oneshot WIs assert
  queue-level file-lock serialization and fresh-worktree ordering.

## Deferred (with re-entry conditions)

- Deterministic assessment downgrade (tiny single-file diff, no logic tokens → cheap-tier
  assess): build only with Phase-1 telemetry showing one-shot assess costs dominate and
  false-COMPLETE rate is ~0. Never an LLM/preflight decision.
- BLOCKED `SCOPE:`-prefix auto-replan routing: only if telemetry shows humans repeatedly
  clicking "replan" on one-shot BLOCKED recoveries.
- Carve widening (multi-file, creations, config edits; preflight schema growth): only with
  Phase-0-style evidence per candidate class; creations need a scope-contract answer first.
- posse-remote oneshot dev contract: only if payload-channel framing measurably
  underperforms. The (role,class_name) mechanism remains right if ever needed (manual
  role_contracts insert, rust routes.rs:123-132; local DeveloperRole.buildContract status
  list changes in the same release).
- One-shot db routing: preflight emitting a db-shaped oneshot (`mode:"oneshot_db"` or a
  `write_surface` field) only after 1h ships, with the write-capable grant as a hard gate
  condition and Phase-0-style evidence that db-trivial WIs exist in volume.
- Background-task tool runtime (async bash, bounded waits): separate workstream; explicitly
  not a lock primitive.
- Fan-out research quality (structured briefs with file:line anchors instead of prose
  summaries feeding synthesis; preflight already routes `fanout_clear`): separate plan doc.

## Cost/benefit after revision

Adds: one regex + two classifier arms, one shared gate+factory, two preflight consumer
arms + a prompt-bundle contract edit, one dead-letter arm, one file-request branch, one
lock-guard helper + guard calls, one task mode + payload-aware lock predicate, one event
type, tests. One repo plus one remote prompt-content deploy (gracefully sequenced both
directions). Saves per eligible WI: arm A one standard plan call and 1–2 queue hops; arm B
one research call + one plan call, minus one cheap preflight call and one queue hop.
Bounded downside: a misrouted one-shot burns one standard dev call + one assessment, then
fails into exactly the recovery lattice the full pipeline uses; a wrong preflight demotion
costs one cheap call on top of today's path. The lock guard is pure hardening with
per-call cost of one indexed SQLite lookup. The db task mode removes a false serialization
(whole-repo lock on scope-less jobs) and gives the planner a legitimate shape for DB work,
at the cost of accepting engine-level (not path-level) concurrency semantics for DB
writes.
