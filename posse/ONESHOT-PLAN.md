# One-Shot Dev Fast Path — Final Plan (post-red-team)

Status: planned, not started. Draft v1 was red-teamed by three independent reviews
(integration correctness, design value, operational failure modes); this document is the
synthesis. The draft's Phase 2 (ESCALATE status) and Phase 3 (posse-remote role class) are
**cut**; what remains is a local-only kernel in tools/posse plus a mandatory Phase-0
evidence gate.

## Final shape in one paragraph

For a deterministically-recognized sliver of trivial work items (single-file, no-logic text
edits), skip research AND planning: spawn a `job_type:"dev"` job directly from intake with a
machine-compiled task payload. Everything else — worktrees, file locks, scope enforcement,
inline assessment, fix chains, BLOCKED→human recovery, needs_replan loopback — is existing
dev-job machinery and is deliberately untouched. No new job type, no new dev-log status, no
posse-remote changes, no new settings. Savings per eligible WI: one standard-tier plan call
plus 1–2 scheduling hops.

## What the red team cut from the draft, and why

1. **ESCALATE status + escalation chain — CUT.** Five independent reasons:
   - It defends the wrong failure mode: the dominant misclassification is a dev that
     confidently completes an under-scoped edit (ESCALATE never fires); the net that catches
     that is the assessor, which the draft was simultaneously weakening with generic
     success criteria.
   - As drafted it **bricked the WI**: a `failed` one-shot only stops blocking completion if
     it has a succeeded descendant via `parent_job_id` (queue/functions/index.js:617-641),
     and the draft's spawn path (`createInitialResearchOrPlanJob`) sets no parent. WI status
     `failed` is terminal and non-recoverable (index.js:318-340, catalog/work-item.js:54-58).
   - Commits survive the proposed worktree reset (`snapshotAndResetDirtyWorktreeAsync`
     resets only uncommitted state; commit runs before contract checks in
     PostExecutionCoordinator.js:441-507), so "escalation is always clean" was false.
   - The status contract exists in TWO places that both forbid a fifth status: remote
     `prompts/contracts/dev-log.md` ("any other status causes a parse error") and the local
     twin `DeveloperRole.buildContract` (developer.js:192-201). A model told ESCALATE breaks
     the parser under-triggers the hatch.
   - Existing machinery already covers both directions: pre-emptive → BLOCKED→human_input
     whose `blocked_recovery` choices already include "replan"
     (PostExecutionCoordinator.js:273); post-hoc → assessor `needs_replan` spawns a
     correctly-parented research loopback with zero new code (verdicts/needs_replan.js:51-170).
   - If a machine-readable pre-emptive hatch is ever proven necessary: reuse BLOCKED with a
     `SCOPE:` blockReason prefix routed to the replan path — local-only, no enum change.

2. **Remote role class / oneshot.md / PROMPT_VERSION bump — CUT.** dev.md rule 1 already
   licenses gap-filling ("infer the simplest correct implementation consistent with existing
   codebase patterns"), and the pipeline already runs machine-composed task_specs against
   unmodified dev.md in two shipped paths (FILE_REQUEST follow-up specs,
   pipeline-continuation.js:212-274; assessor-composed fix specs, verdicts/fail.js:593-621).
   The framing sentence one-shot needs rides the payload `task_spec` channel the local
   client already owns (developer.js:188). Cutting this also removes a real deploy hazard:
   an old remote 400s unknown roles (validation.rs:32-37) and the local composer throws
   POSSE_REMOTE_REQUIRED with no retry (handoff/functions/index.js:1776-1787) — the draft's
   "optional local fallback" did not exist. Also `packet.recipient` must stay `"dev"`
   regardless: ATLAS dev-grow prefetch keys on it (atlas-context.js:249-259).

3. **Rename eligibility — CUT.** A file rename is delete+create, which a modify-only scope
   structurally cannot perform (every honest attempt detours through FILE_REQUEST or gets
   reverted at commit). A symbol rename ("rename User to Account in models.py") passes the
   trivial regexes but has multi-file blast radius; hard-scoping it to the mentioned file
   ships broken call sites with a COMPLETE status — worse than today's plan path.

4. **typo_fix trigger — DEAD CODE (two reviews independently).** `VALID_INTENTS` contains no
   `typo_fix` (intake/functions/hints.js:4-13) and every intake path normalizes intents, so
   routing.js:408 is unreachable today. The carve below is built on `simpleNoResearch` only.
   (Optional separate fix: add typo_fix to intents — out of scope here.)

5. **Cheap tier for one-shots — CUT.** Fix jobs inherit the failed job's tier
   (verdicts/fail.js:599), so one cheap-tier failure costs dev+assess+fix+assess and
   possibly human attention — several multiples of the saved plan call. All one-shots run
   standard tier / low effort.

6. **Preflight LLM promotion to one-shot (v2 idea) — DELETED, not deferred.** Paying an LLM
   call to avoid an LLM call, and putting a probabilistic guess in front of a hard-scoped
   dev, is the configuration the rename analysis shows is dangerous. Deterministic-only is
   the design, not a compromise.

7. **ONESHOT_ROUTED / ONESHOT_ESCALATED events — CUT.** The `RESEARCH_ROUTING` event already
   records bucket/reason/candidates for free (intake-routing.js:74-89). Only
   `ONESHOT_DEMOTED` is new (the one decision otherwise invisible), and it must carry the
   per-file gate results.

## Phase 0 — Evidence gate (mandatory, before any code)

The business case is unproven: this session's repo DB has ~no routing history, so evidence
must come from real project DBs (`.posse/db/orchestrator.db` per active repo). Write a
one-off analysis script (scratchpad or scripts/, not shipped) that:
- counts WIs routed `no_research` per month, and how many would pass the Phase-1 carve;
- joins their plan jobs' outputs: fraction emitting exactly one dev task;
- measures downstream fix/replan/blocked rates for those WIs.

Kill thresholds (tune before running): proceed only if eligible volume is meaningful
(≳15 WIs/month across active projects) AND ≥80% of carve-passing WIs produced exactly one
dev task AND their fix/replan rate is not materially worse than baseline. **If the data is
thin, do NOT build the kernel.** Ship the consolation win instead and stop:

> `createPlanAfterSkippedResearch` (intake-routing.js:135-146): drop `model_tier` from
> `"standard"` to `"cheap"` for skipped-research plan jobs. ~5 lines + test, captures most
> of the dollar savings on trivial items with zero new failure modes.

The tier drop is worth doing even if the kernel proceeds (it covers the no_research
remainder that one-shot doesn't).

## Phase 1 — The kernel (tools/posse only)

Land 1a+1b in ONE change: a classifier emitting `oneshot` before the dispatch branch exists
would fall through to a research job — a regression vs. today's plan job.

### 1a. Classifier — lib/domains/research/functions/routing.js
- New `ONESHOT_SIMPLE_RE`: the typo/spelling/comment/docs/whitespace/copy-edit subset of
  `SIMPLE_NO_RESEARCH_RE`, explicitly EXCLUDING rename terms and `formatting` ("fix currency
  formatting in invoice.js" is a logic bug wearing trivial clothing).
- New arm placed immediately before the current `simpleNoResearch → no_research` arm
  (routing.js:412): `ONESHOT_SIMPLE_RE` + exactly one file mention + <200 chars + not
  COMPLEX_RE + not protectedFileMention → `{ bucket:"oneshot", reason, budget:"low",
  candidate_files: fileMentions }`.
- Everything else unchanged: question-mode arms stay first (question WIs can never reach
  oneshot); promote and non-matching simpleNoResearch stay `no_research`;
  `renameMultiNoResearch` stays `no_research`.
- `buildSyntheticResearchBrief`: populate `key_files` from candidate_files for the oneshot
  bucket (assessor/replan context parity with the no_research path).

### 1b. Live gate + job factory — lib/domains/research/functions/intake-routing.js
New `createOneshotDevJob(workItem, { routing, source, projectDir })`, dispatched from
`createInitialResearchOrPlanJob` on `bucket === "oneshot"`.

Demotion gate — ANY failure demotes to the existing `createPlanAfterSkippedResearch` path
with an `ONESHOT_DEMOTED` event carrying per-file results:
1. `validateScopedPath` per candidate (lib/shared/scope/functions/validation.js:11-28 —
   rejects absolute paths, `..` traversal, protected paths). The mention regex explicitly
   admits `../` prefixes (routing.js:57-60); fs.stat alone would follow them outside the
   repo.
2. Containment: `path.resolve(projectDir, candidate)` must stay under projectDir.
3. Git-tracked: batch `git ls-files` — this simultaneously rejects ignored/generated files
   (which pass stat but can never commit, producing a guaranteed no-op→dead-letter loop)
   and canonicalizes casing for case-insensitive filesystems.
4. `isHighRiskPath` (handoff/functions/helpers/file-request.js:130-138 — .github/,
   package.json, lockfiles, Dockerfiles, etc.): high-risk mention → demote. Reuses the
   existing risk policy; no new denylist to maintain.
5. `isPlanApprovalEnabled()` → demote. The plan-approval human gate is created inside the
   plan compiler (plan-compiler.js:1884-1889); bypassing the planner must not bypass
   sign-off-before-writes.
6. `redTeamPlan` requested → demote (asking for red-team planning is asking for rigor).

On pass — parity bookkeeping with the no_research path (`updateWorkItemResearchSkip`, store
synthetic brief, `refreshWorkItemStatus`), then `createJob`:
- `job_type:"dev"`, title `One-shot: <wi title>` (the title prefix is the operator's
  mid-flight route signal in the TUI), priority = WI priority,
  `model_tier:"standard"`, `reasoning_effort:"low"`.
- payload (mirrors plan-compiler.js:1515-1550 shape):
  - `task_spec`: WI title + description **verbatim**, then one framing sentence: the task
    was machine-derived from the work item with no planner; the work item text is the
    authoritative statement of intent; make the smallest change that fully satisfies it.
    (The assessor's TASK SPECIFICATION is exactly `payload.task_spec`,
    assessment-pipeline.js:820-839 — verbatim WI text is what keeps inline assessment
    strong. This was the draft's biggest quality gap.)
  - `success_criteria`: derived from the WI text (restate the requested edit as a checkable
    condition) + "the change is internally consistent (nothing the request implies was left
    un-updated)". NOT the draft's "no changes outside the requested edit" — that criterion
    rewards under-scoped edits.
  - `files_to_modify`: the gate-resolved candidates. `files_to_create/delete`,
    `create_roots`, `must_modify`: empty. (Non-empty modify scope is load-bearing:
    developer.js:98-103 throws on empty writable scope; empty scope also means a whole-repo
    lock, file-locks.js:83-84.)
  - `task_mode:"code"`; `dev_mode:"cleanup"`; `risk:1`; `oneshot:true`;
    `_oneshot_reason: routing.reason`; `_assess_model_tier:"standard"`.
  - `skip_assessment`: never set. Assessment is the primary net for misclassification.

Verified non-issues (integration sweep): locks derive from payload scope regardless of
provenance; ATLAS dev prefetch seeds from `files_to_modify`, needs no research artifacts;
all parent_job_id derefs are null-safe; every intake entry point (`go`/`plan`/`inject`/
`ask`/TUI) funnels through `createInitialResearchOrPlanJob`, so one dispatch branch covers
them all; the delegator bypass is real but acceptable (it only optimizes planner output).

### 1c. Dead-letter recovery arm — lib/domains/worker/functions/helpers/dead-letter.js
Today only research heads and stall-exhausted jobs get leaf recovery; a dead-lettered leaf
dev with no dependents spawns nothing and the WI goes terminally `failed` with no human
gate (dead-letter.js:519-589 + queue/functions/index.js:562-570). One-shot makes dev the
pipeline head, so extend the leaf-recovery arm: `payload.oneshot === true` → spawn the same
urgent `human_input` recovery (attempt history + provider diagnostics) as the research arm,
leaving the WI in `waiting_on_human` instead of silently failed.

### 1d. FILE_REQUEST hardening — where file-request approval is decided
For `payload.oneshot` origin jobs, route ALL file requests through the human-gated path
(never auto-approve). Otherwise mid-risk auto-approval (.md/.yml/.json…,
file-request.js:16-32, 259-267) quietly repeals the "one-shot never creates files"
invariant — and the origin job's assessment is skipped entirely when it made no changes but
filed requests (assessment-pipeline.js:1519-1520). Honest invariant: the one-shot's own
commit cannot create files; creations require a human gate.

### 1e. Events — catalog/event.js + observability/functions/event-types.js
`ONESHOT_DEMOTED` only, with per-file gate results (which check failed per candidate).
Bucket/reason/candidates already land in `RESEARCH_ROUTING`.

## Recovery model (all existing machinery — verify, don't build)

- Dev self-reports BLOCKED → human_input with blocked_recovery choices incl. "replan"
  (PostExecutionCoordinator.js:197-313) — the human pre-emptive escape.
- Assessor fail → fix chain at standard tier (verdicts/fail.js).
- Assessor needs_replan → research loopback, correctly parented, replan-capped
  (verdicts/needs_replan.js:51-170) — the automatic post-hoc escape.
- Stall-exhausted → existing capped human recovery (dead-letter.js:543-589).
- `research_skipped` self-heals if a later researcher runs (pipeline-continuation.js:556-557).

## Testing

- routing.test: oneshot arm — matching phrasings; rename/formatting phrasings do NOT match;
  >1 file mention, ≥200 chars, COMPLEX_RE, protected paths, question mode all excluded;
  non-matching simpleNoResearch still routes no_research (no behavior change).
- intake-routing.test: each demotion reason (traversal mention, untracked file, ignored
  file, high-risk path, plan-approval on, redTeamPlan) → plan path + ONESHOT_DEMOTED with
  per-file results; pass case → payload shape assertions (non-empty modify scope, no create
  scope, verbatim WI text in task_spec, standard tier, no skip_assessment).
- dead-letter.test: force-dead-letter a oneshot leaf → human_input recovery exists, WI is
  waiting_on_human, NOT failed.
- file-request.test: oneshot origin + mid-risk creation request → human gate, not
  auto-approve.
- e2e (fast suite): inject "fix typo in README.md" (verified: matches the simple-edit regex
  empirically) → exactly one dev job, no research/plan jobs, inline assess runs, WI
  completes; second e2e with two same-file oneshot WIs asserting file-lock serialization.

## Deferred (with re-entry conditions)

- BLOCKED `SCOPE:`-prefix auto-replan routing: build only if Phase-1 telemetry shows humans
  repeatedly clicking "replan" on one-shot BLOCKED recoveries.
- Carve widening (multi-file, creations, config edits): only with Phase-0-style evidence per
  candidate class, and creations need a scope-contract answer first.
- posse-remote oneshot contract: only if payload-channel framing measurably underperforms
  (e.g. one-shot devs over-expanding scope). The (role,class_name) role-class approach
  remains the right mechanism if ever needed — note the bundle route requires a manual
  `role_contracts.insert` mirroring the "fix" line (rust routes.rs:123-132), and the local
  DeveloperRole.buildContract status list must change in the same release.

## Cost/benefit after synthesis

Adds: one regex + one classifier arm, one gate+factory function, one dead-letter arm, one
file-request branch, one event type, tests. One repo, no deploy coupling, no settings, no
prompt changes. Saves per eligible WI: one standard-tier plan call and 1–2 queue hops.
Bounded downside: worst case a misrouted one-shot burns one standard dev call + one
assessment, then fails into exactly the recovery lattice the full pipeline uses.
