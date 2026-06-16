# GovNotice Posse Runtime Smoke Root Cause Report

Report date: 2026-06-15

Target runtime: `C:\development\claude\gov-notice`

Posse source inspected: `C:\development\claude\tools\posse`

## Scope

This report investigates runtime issues observed while running Posse work items WI#13 through WI#19 against `gov-notice`, with the main five-item batch being WI#15 through WI#19. A finding is included only when it is backed by at least one runtime artifact, database row, command result, or source-code trace. Unproven suspicions are listed separately as not established.

## Validation Summary

| Finding | Validated by |
| --- | --- |
| Sensitive stderr warning dump | Batch stderr log, redacted credential-pattern count, `codex.js`, `warnings.js` |
| Worktree cleanup residuals | Batch stdout, `git worktree list`, filesystem inspection, `prune --dry-run`, `worktree.js` |
| `--no-tui` still prompts for push | Batch stdout prompt, waiting human-input job #137, `git-workflows.js` |
| Native heartbeat failure during scheduler leasing | Runtime event stack, `native/invoke.js`, `file-locks.js`, `Scheduler.js` |
| Scheduler lock renewal starvation | Runtime event row, `Scheduler.js` |
| Misleading `attempt 2` restart logs | Batch stdout, `jobs` and `job_attempts` rows, developer/artificer role code |
| Queued ATLAS jobs after no active work items | `jobs` rows #135/#136, health/status output, `run-session.js`, queue behavior |
| Artifact-only reports could not verify runtime state | Artificer job payloads, generated reports, plan-compiler/artificer source |
| Transient `tsconfig.json` came from TypeScript SCIP staging | Scope-drift events, batch log, `scip-typescript` metadata, `stager.js`, `indexers.js`, `git-workflows.js` |
| Disk warning | Batch boot log, current C: drive free space, workspace health probe source |

## Findings

### 1. Sensitive stderr warning dump from Codex provider exit listeners

Severity: High

Validated root cause: Each Codex provider call installs a one-shot listener on the global `process` object:

- `lib/domains/providers/functions/codex.js:2677-2683` creates `cleanupRunTemps`, assigns it to `exitCleanup`, then calls `process.once("exit", exitCleanup)`.
- During the concurrent batch, enough Codex calls overlapped to add 11 `exit` listeners to `process`, exceeding Node's default listener warning threshold.
- Posse installs a warning listener in `lib/domains/cli/functions/warnings.js:10-12` that forwards warning objects to `console.warn(warning)`.
- Node's `MaxListenersExceededWarning` object included the `process` emitter. That emitter included `process.env`, so the warning dump printed credential-bearing environment variable names and values to stderr.

Runtime validation:

- `C:\development\claude\gov-notice\.posse\codex-batch-runtime-run-20260615-100828.err.log` begins with `MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 exit listeners added to [process]`.
- The stack points to `codex.js:2682`.
- A redacted scan found credential-pattern mentions for `CODEX_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, and `POSSE_KEY`.

Impact:

- The stderr log must be treated as sensitive.
- The issue is not only excess listeners. The larger problem is logging the raw warning object, because that object can serialize the global `process` emitter and its environment.

Recommended fix:

- Replace per-call `process.once("exit", cleanup)` with a shared process-exit cleanup registry, or raise/manage the listener limit only after proving cleanup correctness.
- Change the CLI warning filter to print a sanitized warning summary, for example `warning.name`, `warning.code`, `warning.message`, and a stack with secret redaction, instead of `console.warn(warning)`.

### 2. Worktree cleanup leaves non-worktree directories on Windows

Severity: High for operational hygiene, Medium for data integrity

Validated root cause: The cleanup path deregisters/removes the Git worktree but leaves a Posse runtime directory behind. After that point, the path is no longer a Git worktree, so later GC attempts report `fatal: ... is not a working tree` and cannot complete by using `git worktree remove`.

Runtime validation:

- Batch stdout logged cleanup failures for WI#16, WI#17, and WI#18:
  - `Failed to remove worktree after cleanup gate passed: Git native method git.worktree.remove failed: error: failed to delete ... Invalid argument`
  - `Worktree removal command completed but path still exists`
  - later GC: `fatal: '...\wi-16' is not a working tree`, similarly for WI#17 and WI#18.
- `git worktree list --porcelain` after the run listed only the main worktree.
- Filesystem inspection showed `.posse-worktrees\wi-16`, `.posse-worktrees\wi-17`, and `.posse-worktrees\wi-18` still existed, had no `.git`, and each root contained only `.posse`.
- Those `.posse` directories contained ATLAS SQLite files such as `view.db`, `view.db-shm`, and `view.db-wal`.
- `node orchestrator.js prune --dry-run` reported all three as complete and branch-cleared, and said it would remove them.

Source validation:

- `lib/domains/git/functions/worktree.js:1265-1298` and `1502-1537` call `removeWorktreePath` or `removeWorktreePathAsync`, report failures, then return `remove_incomplete` when the path still exists.
- `lib/domains/git/functions/worktree.js:1980-1991` later tries terminal GC through `gcSnapshotAndRemoveWorktreeAsync`; because the Git metadata is already gone, this path reports the directory is not a working tree.
- `lib/domains/git/classes/Worktree.js:121-132` routes async removal through the native `git.worktree.remove` method. The source-level fallback cleanup visible in the sync path is not visible in this caller after the async native remove leaves residual Posse runtime files.

Impact:

- Completed work items leave disk-consuming runtime directories.
- Repeated runs accumulate stale `.posse-worktrees` entries.
- The failure is reproducible on this Windows environment with ATLAS runtime files present inside the worktree.

Recommended fix:

- Keep worktree-local runtime files outside Git worktree roots, or close ATLAS resources before worktree deletion and then perform an explicit filesystem cleanup for residual Posse runtime directories after Git deregistration.
- Teach terminal cleanup to recognize a path that has no `.git` and only contains managed runtime residuals, then remove it with a safe managed-directory filesystem path rather than retrying `git worktree remove`.

### 3. `--no-tui` does not make push closeout non-interactive

Severity: Medium

Validated root cause: Push closeout uses `process.stdin.isTTY` as the only no-prompt guard. It does not check `--no-tui`, no-TUI mode, or a noninteractive run flag.

Runtime validation:

- Batch stdout ended with `Push to remote? [y/N]`.
- Health reported parked job `#137 WI#18 waiting_on_human human_input: Push 7 commit(s) to origin/master`.
- The DB row for job #137 has payload subtype `push_offer`, `ahead_count: 7`, and `created_by: run_wrapup`.

Source validation:

- `lib/domains/cli/functions/git-workflows.js:1299-1305` persists the push offer as a bridge gate.
- `lib/domains/cli/functions/git-workflows.js:1309-1315` avoids prompting only when `!process.stdin.isTTY`.
- `lib/domains/cli/functions/git-workflows.js:1317` prompts with `askSingleKeyYesNo("  Push to remote? [y/N] ", ...)`.
- `lib/domains/cli/functions/run-session.js:432` uses `--no-tui` only to determine display usage: `const useTui = !NO_TUI && process.stdout.isTTY`.

Impact:

- A hidden/background `--no-tui` run can still wait forever at push closeout if stdin looks like a TTY.
- The bridge gate is created correctly, but the terminal runner still blocks.

Recommended fix:

- Treat `--no-tui` as noninteractive for push prompts, or add an explicit `--no-prompt` / `--headless` option and have run closeout honor it.
- In noninteractive mode, create the push gate and print the manual/app action, then return without reading stdin.

### 4. Scheduler loop error was a native heartbeat failure during write-lock leasing

Severity: Medium

Validated root cause: The scheduler hit a transient failure while acquiring a job lease with write locks. The write-lock path parsed the job payload through the native Git commit-scope method `git.commitScope.fromPayload`, and that native method failed with `posse_key heartbeat failed`.

Runtime validation:

- Runtime event `scheduler.loop_error` at `2026-06-15T15:14:31.444Z` contains this stack:
  - `runGitNativeMethod` in `lib/domains/git/functions/native/invoke.js:175`
  - `CommitScope.fromPayload` in `lib/domains/git/classes/CommitScope.js:91`
  - `Scope.fromPayload` in `lib/shared/scope/classes/Scope.js:39`
  - `normalizeScopeFromPayload` in `lib/domains/queue/functions/file-locks.js:42`
  - `getJobWriteScope` in `lib/domains/queue/functions/file-locks.js:77`
  - `acquireLeaseWithWriteLocks` in `file-locks.js:412`
  - `Scheduler.runLoop` in `Scheduler.js:1946`

Source validation:

- `lib/domains/git/functions/native/invoke.js:151-175` builds the native request, attaches auth, runs the native binary, and throws `Git native method ... failed: ...` when the native call is not OK.
- `lib/domains/queue/functions/file-locks.js:76-82` computes the job write scope before lease acquisition.
- `lib/domains/scheduler/classes/Scheduler.js:1943-1946` calls `leaseManager.acquireWithLocks(...)`.

Impact:

- The scheduler continued after the tick failure, so this was not a terminal run failure.
- The immediate root cause is validated. The deeper cause of the heartbeat failure itself, such as remote auth service, network, or native daemon state, was not established from available local evidence.

Recommended fix:

- Add a Node fallback for commit-scope parsing when the native method fails due to heartbeat/auth transport, because scope parsing is required for scheduler liveness.
- Add a metric/event that distinguishes heartbeat/auth failure from ordinary Git/native parsing failure.

### 5. Scheduler lock renewal starvation is caused by same-process timer starvation

Severity: Medium

Validated root cause: Scheduler lock renewal runs on a Node timer in the same process as scheduler, provider, Git, and ATLAS orchestration work. During the batch, the timer did not run for about 64 seconds, exceeding the 45-second starvation threshold.

Runtime validation:

- Runtime event `scheduler.lock_starved` at `2026-06-15T15:17:15.410Z` recorded `elapsed_ms: 63414`, `threshold_ms: 45000`, `lock_renew_sec: 30`.
- Batch stdout logged `Scheduler lock renewal starved for 64s`.
- The scheduler recovered and completed the batch.

Source validation:

- `lib/domains/scheduler/classes/Scheduler.js:421` sets the starvation threshold to `LOCK_RENEW_SEC * 1500`, which is 45 seconds when `LOCK_RENEW_SEC` is 30.
- `lib/domains/scheduler/classes/Scheduler.js:661-680` logs `Scheduler lock renewal starved for ...` when elapsed time since the last renewal exceeds the threshold.
- `lib/domains/scheduler/classes/Scheduler.js:787-791` schedules renewal with `setInterval(..., LOCK_RENEW_SEC * 1000)`.

Impact:

- The scheduler lock can appear unhealthy under high local concurrency even when the scheduler eventually recovers.
- If starvation lasts past the lock-loss window, another scheduler could consider the lock stale.

Recommended fix:

- Move scheduler lock renewal to an isolated worker/thread or otherwise prevent synchronous provider/Git/ATLAS work from starving the renewal interval.
- Add per-phase event-loop delay telemetry around provider fanout, native Git calls, ATLAS embedding/index work, and closeout GC so the blocking source can be attributed in future incidents.

### 6. `attempt 2 - starting over` is misleading on first attempts

Severity: Low

Validated root cause: Developer and artificer roles treat the existence of the current attempt row as evidence of a retry. The worker creates the `job_attempts` row before role code runs, so `getAttempts(job.id).length > 0` is true on the first execution. The log then prints `attempt ${attempts.length + 1}`, resulting in `attempt 2` for a first attempt.

Runtime validation:

- Batch stdout printed `attempt 2 - starting over` for jobs #116, #117, #118, #119, and #120.
- DB validation showed each of those jobs had `attempt_count=1`.
- `job_attempts` showed exactly one attempt row for each of #116, #117, #118, #119, and #120, all `attempt_number=1`.

Source validation:

- `lib/domains/worker/classes/roles/developer.js:112-130` sets `isRetry = attempts.length > 0` and logs `attempt ${attempts.length + 1}`.
- `lib/domains/worker/classes/roles/artificer.js:149-158` uses the same pattern.

Impact:

- Operators may infer a retry happened when it did not.
- The DB attempt state is correct; this is a log/UX bug.

Recommended fix:

- Pass the current attempt number into role code and log that value.
- Treat retry as `attemptCount > 1` or `previousAttempts.length > 0`, where `previousAttempts` excludes the current row.

### 7. Queued ATLAS jobs remain after all work items are complete, and `status --active` hides them

Severity: Medium

Validated root cause: `atlas_warm` jobs are non-completion-blocking. Work items can become `complete` while ATLAS cleanup/reindex jobs remain queued. `status --active` filters by active work items and therefore reports no active jobs, while `health` still reports queued jobs.

Runtime validation:

- Final `status --active --limit all` reported no active work items and no jobs.
- Final `health` reported `queued: 2`.
- Direct DB query identified:
  - `#135`, `work_item_id=17`, `atlas_warm`, `queued`, `ATLAS warm: WI cleanup view disposal`
  - `#136`, `work_item_id=NULL`, `atlas_warm`, `queued`, `ATLAS reindex: incremental main refresh`
- Job #135 had `ready_at=2026-06-15T15:30:56.973Z`, about 32.5 seconds after creation/update.

Source validation:

- `lib/domains/queue/functions/index.js:54` defines `NON_COMPLETION_BLOCKING_JOB_TYPES = new Set(["atlas_warm"])`.
- `lib/domains/cli/functions/run-session.js:625-705` drains queued ATLAS warm jobs during wrap-up, but stops when the earliest pending `ready_at` is more than `ATLAS_WRAPUP_DRAIN_MAX_READY_WAIT_MS`, which is 30 seconds.
- `lib/domains/atlas/classes/v2/PipelineHooks.js:99-105` maps cleanup and main-advanced events to `wi-cleanup` and `main-incremental` warm jobs.

Impact:

- There is an operator-facing inconsistency: health says queued jobs remain, but active status says none.
- The queued jobs are probably intentional best-effort follow-up work, but they are not clearly represented as background/non-blocking status.

Recommended fix:

- Add a `status --background` or include a background queue summary in `status --active`.
- In wrap-up, print the queued ATLAS job IDs and ready times when the drain leaves them for next boot.

### 8. Artifact-only runtime reports cannot validate runtime health by themselves

Severity: Medium for test design, Low for runtime safety

Validated root cause: The planner correctly scoped artifact/report tasks to their output roots. The artificer then ran inside that artifact output directory. Because deterministic tooling enforced that scope, the report jobs could not read the runtime DB, runtime logs, sibling artifacts, or planner context paths outside their output root.

Runtime validation:

- Artificer job #117 payload:
  - `output_root = C:/development/claude/gov-notice/.posse/resources/artifacts/wi-19/...`
  - `create_roots = [same output root]`
  - `files_to_create = [output root/report.md]`
- Artificer job #119 had the same shape for WI#15.
- The generated WI#15 report states `.posse/db/orchestrator.db`, `.posse/logs`, `.posse/resources/workspace`, sibling artifacts, and other paths were outside the allowed read scope and returned `Path escapes working directory`.
- The generated WI#19 report similarly states queued jobs, provider health, leftover worktrees, and closeout completeness were unverified due to scope limits.

Source validation:

- `lib/domains/worker/functions/helpers/plan-compiler.js:1132-1155` scopes artifact tasks to an output root, synthesizes report deliverables, and rebases `files_to_create` into `output_root`.
- `lib/domains/worker/classes/roles/artificer.js:131-139` resolves `output_root` and `create_roots`.
- `lib/domains/worker/classes/roles/artificer.js:212` instructs the agent to write deliverables into `output_root`.

Impact:

- Artifact-only smoke jobs can validate artifact creation and deterministic assessment, but cannot independently certify queue/provider/worktree health unless Posse attaches an explicit runtime summary or grants read-only diagnostic scope.

Recommended fix:

- For report-mode runtime health checks, attach a sanitized runtime snapshot artifact to the job context.
- Alternatively, allow a narrow read-only diagnostic scope for `.posse/db/orchestrator.db`, selected log summaries, and worktree inventory when the task is explicitly a runtime health report.

### 9. Transient `tsconfig.json` came from TypeScript SCIP staging

Severity: Low for run outcome, Medium for operator noise

Validated root cause: The transient `tsconfig.json` observed during WI#18 was produced by the TypeScript SCIP indexing path, not by the dev task. Posse's TypeScript SCIP stager intentionally writes a generated `tsconfig.json` into the configured `repoRoot`/`cwd` when a repo has JavaScript/TypeScript sources but no tracked config, so `scip-typescript --infer-tsconfig` indexes `.js/.jsx` with `allowJs`. The file is meant to be removed in a `finally` cleanup, but because it is written into a live Git root instead of an isolated staging directory, ordinary scope and dirty-tree checks can observe it if they run before cleanup or after an interrupted cleanup.

Runtime validation:

- `gov-notice` has no tracked or current root `tsconfig.json`; `git ls-files -- tsconfig.json` and `git status --short -- tsconfig.json` both returned no rows after the run.
- Batch stdout logged `[scope-compat] WI#18 job #116: Left 1 out-of-scope untracked file(s) for terminal cleanup: tsconfig.json`.
- Runtime event `worktree.external_drift_detected` for WI#18 job #116 recorded `files: ["docs","tsconfig.json"]`.
- Runtime event `job.scope_compat_untracked_out_of_scope` for WI#18 job #116 recorded `files: ["tsconfig.json"]`.
- Dev job #118, running in another worktree during the same batch, reported that an existing untracked `tsconfig.json` was present but not touched by its README task.
- `.posse/atlas/scip/typescript.meta.json` records the TypeScript SCIP producer as `scip-typescript` from Posse's managed `scip/node` install.

Source validation:

- `lib/domains/atlas/functions/v2/scip/indexers.js:55-63` registers the TypeScript SCIP indexer with `markers: ["tsconfig.json", "package.json"]`, JavaScript/TypeScript extensions, and args `["index", "--infer-tsconfig", "--output", "{output}"]`.
- `lib/domains/atlas/functions/v2/scip/stager.js:123-159` resolves `repoRoot` and builds stage plans for that root.
- `lib/domains/atlas/functions/v2/scip/stager.js:273-275` passes that root as the `cwd` used by the staging gate.
- `lib/domains/atlas/functions/v2/scip/stager.js:753-771` detects the inferred config target and writes `cwd/tsconfig.json` when none existed before the run.
- `lib/domains/atlas/functions/v2/scip/stager.js:804-807` attempts cleanup in a `finally` block.
- `lib/domains/atlas/functions/v2/scip/stager.js:1068-1095` limits the behavior to TypeScript plans using `--infer-tsconfig` and removes only generated configs.
- `lib/domains/cli/functions/git-workflows.js:442-519` independently documents and sweeps orphaned SCIP infer-tsconfig placeholders on startup/merge paths.

Impact:

- The dev agent did not create or intentionally edit `tsconfig.json`, but scope telemetry still saw it as external drift.
- The run outcome was not blocked, but the event adds noise and can look like a dev scope escape.
- If the process is interrupted before cleanup, the placeholder can survive until startup/merge sweep removes it.

Recommended fix:

- Stage TypeScript SCIP from a temporary copy or pass an explicit temporary config path if the indexer supports it, so generated config files never appear in the live repo/worktree root.
- Otherwise, tag generated SCIP placeholder creation and cleanup with telemetry so scope-compat can classify the file as managed runtime noise instead of unexplained drift.

### 10. Disk warning is environmental and currently valid

Severity: Medium

Validated root cause: The C: volume is low enough to trigger Posse's workspace health warning.

Runtime validation:

- Batch boot log: `Boot: workspace health: disk warning (5.0 GB free)`.
- Current `Get-PSDrive -Name C` showed approximately `5.00 GB` free out of `236.88 GB`.

Source validation:

- `lib/domains/system/functions/preflight-probes.js:57-67` computes free disk bytes and warning/critical status.
- `lib/domains/system/functions/preflight-probes.js:298-301` formats the workspace health line as `disk <status> (<GB> GB free)`.
- `lib/domains/scheduler/classes/Scheduler.js:1204` logs the formatted workspace health probe during boot.

Impact:

- Low disk increases the chance of failed artifact generation, SQLite WAL growth issues, incomplete worktree cleanup, and slow filesystem operations.

Recommended fix:

- Free disk before further stress testing.
- Add runtime size accounting for `.posse`, `.posse-worktrees`, ATLAS views, logs, and recovery snapshots so the warning points to actionable cleanup targets.

## Not Established As Findings

The following observations were not included as validated findings because the available evidence does not establish a root cause:

- Exact low-level Windows reason for `error: failed to delete ... Invalid argument`. The validated state is that only `.posse` runtime files remained and Git no longer considered the path a worktree. Whether the low-level deletion failure was caused by an open SQLite handle, antivirus/indexing, a native fallback limitation, or another Windows filesystem condition was not proven.
- Initial one-off `status --active` timeout before the five-item batch. It was observed during monitoring but was not reproduced or traced to a source path during this investigation.

## Validation Commands Used

Representative commands used to validate the findings:

```powershell
Set-Location C:\development\claude\gov-notice
node C:\development\claude\tools\posse\orchestrator.js health
node C:\development\claude\tools\posse\orchestrator.js status --active --limit all
node C:\development\claude\tools\posse\orchestrator.js prune --dry-run
git status --short --branch
git worktree list --porcelain
git ls-files -- tsconfig.json
git status --short -- tsconfig.json
Get-Content -Raw .posse\atlas\scip\typescript.meta.json
sqlite3 .posse/db/orchestrator.db "select id, work_item_id, job_type, status, title from jobs where status in ('queued','waiting_on_human','failed') order by id;"
sqlite3 .posse/db/orchestrator.db "select job_id, attempt_number, status from job_attempts where job_id in (116,117,118,119,120) order by job_id, attempt_number;"
rg -n "MaxListenersExceededWarning|codex.js:2682|OPENAI_API_KEY|CODEX_API_KEY|XAI_API_KEY|POSSE_KEY" .posse\codex-batch-runtime-run-20260615-100828.err.log
rg -n "Failed to remove worktree|not a working tree|Push to remote|Scheduler lock renewal starved|posse_key heartbeat failed|attempt 2 - starting over" .posse\codex-batch-runtime-run-20260615-100828.out.log .posse\logs
rg -n "scope-compat.*tsconfig|worktree.external_drift_detected|job.scope_compat_untracked_out_of_scope|typescript\.scip|SCIP restage" .posse\codex-batch-runtime-run-20260615-100828.out.log .posse\logs\runs\2026-06-15T15-08-32-988Z-pid13480-a56cc795
Get-PSDrive -Name C
```

```powershell
Set-Location C:\development\claude\tools\posse
rg -n "process.once(\"" lib/domains/providers/functions/codex.js
rg -n "console.warn\\(warning\\)|installCliWarningFilter" lib/domains/cli/functions/warnings.js
rg -n "removeWorktreePath|Worktree removal command completed|terminal worktree" lib/domains/git/functions/worktree.js lib/domains/git/classes/Worktree.js
rg -n "Push to remote|stdin.isTTY|upsertPushOfferGate" lib/domains/cli/functions/git-workflows.js
rg -n "Scheduler lock renewal starved|setInterval|LOCK_RENEW_SEC" lib/domains/scheduler/classes/Scheduler.js
rg -n "attempt \\$\\{attempts.length \\+ 1\\}" lib/domains/worker/classes/roles/developer.js lib/domains/worker/classes/roles/artificer.js
rg -n "NON_COMPLETION_BLOCKING_JOB_TYPES|drainPendingAtlasWarmJobs|ATLAS_WRAPUP_DRAIN_MAX_READY_WAIT_MS" lib/domains/queue/functions/index.js lib/domains/cli/functions/run-session.js
rg -n "scip-typescript|--infer-tsconfig|tsconfig" lib/domains/atlas/functions/v2/scip/indexers.js lib/domains/atlas/functions/v2/scip/stager.js lib/domains/cli/functions/git-workflows.js
```
