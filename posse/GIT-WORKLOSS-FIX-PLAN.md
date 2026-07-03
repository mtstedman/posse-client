# Git work-loss review — synthesized fix plan (2026-07-02)

Method: 5-agent review (JS git domain, worker callers, Rust git_core/git_cli) followed by a
4-agent adversarial red team that tried to refute every finding, several empirically in scratch
repos (git 2.43.0.windows.1). This plan is the synthesis; only findings that survived the red
team are fixed. Refuted claims are recorded at the bottom so they don't get re-reported.

Severity after red team. Status: [ ] planned, [x] done, [P] parked with rationale.

## Phase 1 — confirmed work-loss paths (this pass)

- [x] **W1 (HIGH) Snapshot-failure fallbacks invert the refuse-to-reset guard.**
  Async preserve lane throws on stash-lock timeout (`worktree-snapshots.js:1053`) while the sync
  lane degrades to the directory fallback; 16MB exec cap kills capture exactly when diffs are big;
  seven worker call sites answer the throw with an unsnapshotted `checkout -- .` + `clean -fd`.
  Fix (red-team constraint: job setup must keep a progress guarantee, so make the snapshot lane
  unable to fail rather than merely deferring):
  a) async stash-lock timeout → degrade to `writeLegacyFallbackSnapshot` (match sync posture);
  b) diff capture robust to huge diffs (no 16MB abort on the preserve path);
  c) non-setup call sites: leave dirty + log instead of wipe (next-job setup already classifies
     and handles pre-existing dirt); setup site keeps wipe as last resort for progress.
- [x] **W2 (HIGH) Merge pre-flight destroys human merge state.** Posse only ever runs
  `merge --squash` (never writes MERGE_HEAD), so a MERGE_HEAD in the target is always foreign →
  refuse the merge instead of `merge --abort` (`workflow-merge.js:635`). Unmerged index entries
  without MERGE_HEAD have genuine Posse origins (crashed squash) → snapshot before
  `checkout HEAD -- <f>` heal; flat refusal would wedge auto-merge.
- [x] **W3 (HIGH) `ensureDetachedReadOnlyWorktreeAsync` can hard-reset the main repo.**
  `rev-parse --git-dir` resolves upward from a stale `.posse/resources/context/...` dir →
  destructive triple hits the main checkout. Fix: require `rev-parse --show-toplevel` ==
  targetDir (case-insensitive) before mutating; mismatch → existing suffix-rename path.
- [x] **W4 (HIGH) Stall stashes addressed by positional `stash@{N}` without the stash lock.**
  Empirically reproduced wrong-worktree pop. `refs/stash` is repo-shared; consumers
  (`stall-resume.js`, `human-input-job.js`) must take `gitStashLockPath` inside the worktree
  lock (same order as `stashPartialWorkForExtension`), resolve by message → `%H` SHA, apply by
  SHA, drop the positional entry re-verified against the SHA. Rust `find_stall_stash` stays
  (detection only).
- [x] **W5 (HIGH) Stall-resume drops the stash when nothing was applied.** Failed pop + failed
  apply (single stale index.lock suffices; no janitor exists) → empty snapshot → drop = only
  copy gone. Fix: drop only when the tree is dirty after the failed apply (evidence the content
  landed and was snapshotted); otherwise keep stash + stall flag.
- [x] **W6 (HIGH) Safe-remove gate lets a lossy snapshot authorize removal.** Empirically
  verified: `stash push -u` ignores a nested repo (captures nothing, exit 0), `clean -fd`
  refuses it, gate passes on snapshotSucceeded, `worktree remove --force` deletes the nested
  repo + history. Fix: when the post-snapshot verify RAN and reports dirt → refuse
  (`dirty_not_preserved`) regardless of snapshot; bypass stays only for verify-threw +
  snapshot-succeeded. Mirror in the worktree-reuse path (skip branch-mismatch removal when the
  reset reported remaining paths).
- [x] **W7 (HIGH) Directory-fallback snapshot loses tracked binary modifications.** Patches
  taken without `--binary`; one modified binary also blocks `git apply --3way` restore of the
  text patches. Fix: `--binary` on both diff captures.
- [x] **W8 (HIGH) Live-review GC resets running WIs' worktrees.** `runLiveReview` →
  `autoMergeCompletedWorkItems` with default `runGc:true` mid-run; GC's held path
  snapshot+hard-resets dirty worktrees of WIs with running jobs (agents don't hold the worktree
  lock during provider execution). Wrap-up/idle already pass `runGc:false` — live review is the
  oversight. Fix: `runGc:false` there + held-path reset skips WIs whose holding jobs are
  running/leased (not merely queued).
- [x] **W9 (HIGH) `discardWorktreeFiles` pathspec globbing.** Empirically verified collateral
  delete (`app/[id]/x` also removes `app/i/x`) plus an `isTracked` misroute that reverts a
  tracked sibling's modifications. Fix: `:(literal)` pathspecs in the clean leg, checkout leg,
  and `isTracked`.

## Phase 2 — confirmed medium (cheap ones done in this pass)

- [x] **M1 `cleanupWiBranch` removes worktrees unsnapshotted** (reject/delete + kill paths;
  committed work already safe via tip snapshots). Fix: snapshot-gate step 1 like its sibling
  `snapshotAndRemoveWorktreeOnly` (sync twin — runs on the workflow worker thread).
- [x] **M2 Blocked-attempt catch too wide** (one site, `PostExecutionCoordinator.js:202`) —
  narrow to the snapshot call, copying the commit-failed structure.
- [x] **M3 `stashTargetBranchChanges`**: take the repo stash lock; raise the 15s kill-timeout
  for stash push (verified: a SIGKILL never loses data, but leaves stranded stash + stale
  index.lock); SHA re-verify in `dropStashEntryByToken` before positional drop.
- [x] **M4 Retention traps**: prune ages dedup-reused refs from original `captured_at` → age
  from `max(captured_at, seen_at)`; byte-cap sweep gets a 1h min-age guard.
- [x] **M5 Lock reclaim hardening**: honor `expectedStat` in the ownerToken branch of
  `removeLockIfOwner` immediately before `rmSync`.
- [x] **M6 Native remove fallback ordering** (JS-only): `removeWorktreePathAsync` first calls
  native remove with `fallbackRemove:false` (Rust then fails without touching the filesystem),
  defers on in-use, escalates to `fallbackRemove:true` only for non-in-use failures.
- [x] **M7 `gitWorktreeAddAsync` fail-open**: strict dirty probe (throw instead of
  false-on-error) for this caller; null-gate the corrupt-copy removal; snapshot-refusal errors
  rethrow instead of being reclassified as corrupt metadata.

## Implementation notes (where the fix differs from the sketch)

- `resetDirtyWorktreeFallbackAsync` was **deleted** (not just de-called): every caller used it
  to answer a snapshot failure with an unsnapshotted wipe. A tombstone comment in
  worktree-recovery.js says why. The one legitimate last-resort wipe (job-setup progress
  guarantee, worktree-lifecycle.js ~:805) is inline and untouched.
- The JS `findStallStash(Async)` native wrappers were deleted as caller-less; consumers now use
  `findStallStashEntry(Async)` (JS `stash list --format=%H%x00%gd%x00%s`, matching guards
  mirrored from the Rust matcher) + `dropStashByHash(Async)`. The Rust `git.findStallStash`
  method still exists but nothing calls it. Stall-stash drops take the repo stash lock only
  around the hash→position resolve + drop (apply-by-SHA is shift-immune; the snapshot machinery
  takes the same lock internally, so wrapping more would self-deadlock into 3-min stalls).
- W1b is implemented as capture-tolerance, not a bigger buffer: patch capture failure (16MB cap)
  no longer aborts the preserve — the stash path proceeds without patches, dedup is disabled for
  that capture, and the directory fallback refuses to vouch for tracked dirt it has no patches
  for (returns null → callers defer).
- Retention (M4): prune keeps preferring `note.captured_at`, so the fix refreshes `captured_at`
  on dedup reuse and preserves the original in `first_captured_at` — works identically for the
  native and node list lanes with no Rust change.
- M6 is JS-side two-phase: native remove with `fallback_remove:false` first (Rust returns Err
  without touching the filesystem), rethrow in-use errors for the deferral machinery, escalate
  to the fs fallback only for non-in-use failures.
- W8 also skips GC's held-path dirty reset whenever the WI has a leased/running/awaiting-
  assessment job (ACTIVE_LEASE_STATUSES), not just at the live-review call site.

## Parked (rationale)

- [P] **Boot-race lease before startup GC** — two near-simultaneous boots can both run startup
  GC before the scheduler lease is taken. Structural; needs a lease-acquire (or block-message
  re-check) in RunSession before `startupWorktreeCleanup`. Low frequency; W8's held-path guard
  removes the destructive half. Follow-up.
- [P] **Merge-lock lease (600s, unrenewed) can lapse mid-sweep; `mergeIterativePassToTarget`
  takes no merge lock** — corrupts merge bookkeeping, no committed-work loss. Needs lease
  renewal plumbing. Follow-up.
- [P] **`sweepOrphanedInferTsconfig` deletes a user tsconfig matching the generated signature**
  (`{}` / allowJs-only). Right fix is a generation-time marker so the sweep matches only its own
  file — paired change with the generator. Follow-up.
- [P] **GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE not scrubbed** in Node exec or Rust daemon env —
  hook-spawned posse would poison every git call. No confirmed mutating path today. Follow-up:
  scrub in `Repo` exec env + Rust `run_git_command`.
- [P] **Dead `autoStash` lifecycle in workflow-merge** (never assigned; unlocked drop path if
  resurrected) — delete per phase-out-dead-code rule. Follow-up cleanup.
- [P] **Stale `ROUTING INVARIANT` comment / dead `nativeParity.disabled` flag at dispatch** —
  comment-only today; align when the native invoke layer is next touched.
- [P] **`preserveCorruptWorktreeContents` lossy-copy hardening** (record skipped files in the
  manifest; correlated-failure risk with AV locks) — best-effort layer; W6/M7 close the
  unconditional-removal edges around it.

## Refuted by red team (do not re-report)

- "No single-instance lock": the `scheduler_locks` `main` lease (30s renew / 60s TTL) gates
  go/review/merge/maintenance; two-orchestrator GC is blocked outside the boot race.
- SIGKILL mid-`stash push` loses data: git writes the stash ref before resetting the tree; no
  kill point loses content (stranded stash + stale index.lock instead).
- `logEvent`/sibling-lock DB throws wiping siblings at 7 sites: 6 of 7 already have the narrow
  structure; `logEvent` is buffered + fully guarded; sqlite reads are WAL + busy_timeout.
- Lock-reclaim cascade as originally described: `removeLockIfOwner` re-reads metadata at call
  time; residual window is sub-ms (M5 still closes it).
- `contains_job_needle` matching job #1 vs #12: whitespace-before + non-digit-after guards.
- `safeGitAdd` glob over-staging: post-staging audit + expected-staged abort make it fail-safe.
- Rust `worktree_remove` fallback as a novel data-loss class: everything it shreds is
  snapshot-gated or branch-recoverable; plain `git worktree remove --force` deletes the same
  blind spots with exit 0 (M6 still fixes the deferral ordering).
