import path from "path";
import crypto from "crypto";
import {
  completeAttempt,
  createJob,
  getAttempts,
  getDependents,
  getJob,
  getWorkItem,
  isLeaseValid,
  listActiveFileLocks,
  logEvent,
  rewireDependency,
  settleJobScopeExpansionAttempt,
  setAttemptCommitHash,
  setJobResult,
  storeArtifact,
} from "../../../queue/functions/index.js";
import { parseFileRequest, splitFileRequestsByRisk } from "../../../handoff/functions/index.js";
import { isArtifactMode } from "../../../artifacts/functions/index.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { isInsideRoot } from "../../../../shared/scope/functions/path.js";
import { runHookAsync } from "../../../git/functions/hooks.js";
import { recordObservation } from "../../../observability/functions/observations.js";
import {
  gitCurrentHashAsync,
  gitExecAsync,
  gitHasChangesAsync,
} from "../../../git/functions/utils.js";
import {
  gitCommitAllAsync as gitCommitAllAsyncFromModule,
} from "../../../git/functions/commit-scope.js";
import {
  snapshotAndResetDirtyWorktreeAsync as snapshotAndResetDirtyWorktreeAsyncFromModule,
} from "../../../git/functions/worktree.js";
import { ASSESSABLE_JOB_TYPES, MUTATING_JOB_TYPES } from "../../../../catalog/job.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";
import { HUMAN_INPUT_ACTION_ENUMS } from "../../../../catalog/human-input.js";
import {
  activeSiblingWriteLocks,
  findActiveSiblingLockForPath,
} from "../../../queue/functions/sibling-locks.js";
import {
  isTransientCommitInfraFailure,
} from "../../functions/helpers/commit-infra.js";
import {
  filterFileRequestsToOutOfScope,
  validateDeclaredOutputContract,
} from "../../functions/execution/declared-output-contract.js";
import {
  formatCommitFailureDetail,
  formatCommitFailureSummary,
  worktreeLockTimeoutInfoAsync,
} from "../../functions/execution/commit-diagnostics.js";
import { storePostAgentFailureCheckpoint } from "../../functions/execution/post-agent-checkpoint.js";
import {
  runPostExecutionAssessment as runPostExecutionAssessmentFromModule,
} from "../../functions/helpers/assessment-pipeline.js";
import {
  refreshAndExtractInsights as refreshAndExtractInsightsFromModule,
} from "../../functions/helpers/insights.js";
import {
  detectBranchNetDiffForNoWriteAsync as detectBranchNetDiffForNoWriteAsyncFromModule,
  finishNoWriteAttempt as finishNoWriteAttemptFromModule,
  shouldShortCircuitNoWriteAssessment as shouldShortCircuitNoWriteAssessmentFromModule,
} from "../../functions/helpers/no-write-retry.js";
import {
  isTransientMcpInfraBlock,
  MAX_MCP_INFRA_BLOCK_RETRIES,
  MCP_INFRA_BLOCK_BACKOFF_MS,
} from "../../functions/helpers/block-reason.js";
import {
  spawnDeadLetterRecoveryForDependents as spawnDeadLetterRecoveryForDependentsFromModule,
} from "../../functions/helpers/dead-letter.js";
import {
  parseAgentCompletionLog as parseAgentCompletionLogFromModule,
  scopedDeleteTargets as scopedDeleteTargetsFromModule,
  isDeleteNoopSatisfied as isDeleteNoopSatisfiedFromModule,
  isFilePlacementNoopSatisfied as isFilePlacementNoopSatisfiedFromModule,
} from "../../functions/helpers/mutation-guards.js";
import {
  requiresGitNoopCheck as requiresGitNoopCheckFromModule,
} from "../../../providers/functions/execution-routing.js";
import {
  assessmentRetryFallbackReads as _assessmentRetryFallbackReads,
  isAssessorParseRetryBudgetExceeded as _isAssessorParseRetryBudgetExceeded,
  shouldFastPassArtifactAssessment,
  shouldOverrideArtifactMissingFail,
} from "../../functions/execution/assessment-policy.js";
import {
  logBadInputFailure as _logBadInputFailure,
} from "../../functions/execution/bad-input.js";
import {
  isProviderError as _isProviderError,
} from "../../functions/execution/job-helpers.js";
import {
  shortJobTitle as shortJobTitleFromModule,
} from "../../../../shared/policies/functions/role-utils.js";
import {
  syncAssessorWorkerDisplay as syncAssessorWorkerDisplayFromModule,
} from "../../functions/execution/display-sync.js";

function _syncAssessorWorkerDisplay(display, job, {
  tier = "cheap",
  effort = "medium",
  attempt = 1,
} = {}) {
  syncAssessorWorkerDisplayFromModule(display, job, {
    shortJobTitle: shortJobTitleFromModule,
    tier,
    effort,
    attempt,
  });
}

export class PostExecutionCoordinator {
  constructor(worker) {
    this.worker = worker;
  }

  async handle(args = {}) {
    return await handlePostExecutionForWorker.call(this.worker, args);
  }
}

export async function handlePostExecutionForWorker({
  attempt,
  attemptCount,
  branchName,
  effectiveTier,
  executionProvider,
  imageRoute,
  job,
  leaseToken,
  modelName,
  output = "",
  preManifestState = null,
  provider,
  providerResolution = {},
  resolveTierModel,
  role,
  startTime,
  wrappedJob,
  wtPath = null,
} = {}) {
        // Store output artifact
        storeArtifact({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.id,
          artifact_type: "response",
          content_long: output,
        });

        // NOTE: Do NOT completeAttempt here — we don't know the final status yet.
        // The attempt status depends on git commit, scope validation, no-op guard,
        // pre-assessment hook, and assessment result. Marking it "succeeded" before
        // those checks corrupts retry history.

        // -- Layer 1b: Parse file-request (follow-ups spawned after success) --
        let pendingFileRequests = null;
        if (MUTATING_JOB_TYPES.has(job.job_type) && output) {
          let fileRequests = parseFileRequest(output);
          if (fileRequests) {
            // Filter out files already in the job's scope — no follow-up needed
            const jobPayloadScope = this.parsePayload(job);
            const allowedDeleteScope = scopedDeleteTargetsFromModule(job, jobPayloadScope);
            const cwd = job._worktreePath || this.projectDir;
            fileRequests = filterFileRequestsToOutOfScope(fileRequests, jobPayloadScope, allowedDeleteScope, cwd);
            if (fileRequests.length === 0) fileRequests = null;
          }
          if (fileRequests) {
            pendingFileRequests = splitFileRequestsByRisk(fileRequests);
            const allFiles = fileRequests.map(r => `${r.path} (${r.risk})`).join(", ");
            this.emit(job.id, `${C.cyan}[file-request]${C.reset} WI#${job.work_item_id} job #${job.id}: ${fileRequests.length} file(s) requested: ${allFiles}`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_FILE_REQUEST_PARSED,
              actor_type: EVENT_ACTORS.WORKER,
              message: `File creation requested: ${allFiles}`,
              event_json: JSON.stringify({ files: fileRequests }),
            });
          }
        }

        // -- Layer 2: Git scope enforcement + commit (mutating jobs only) --
        const hasPendingFileRequests = () => {
          if (!pendingFileRequests) return false;
          const total = (pendingFileRequests.autoApproved?.length || 0)
            + (pendingFileRequests.needsApproval?.length || 0);
          return total > 0;
        };
        const scopePauseJob = getJob(job.id);
        const scopePausePayload = scopePauseJob ? this.parsePayload(scopePauseJob) : {};
        const pendingScopeRequest = scopePausePayload?._pending_scope_request;
        if (
          scopePauseJob?.status === "waiting_on_human"
          && pendingScopeRequest
          && (!pendingScopeRequest.attempt_id || Number(pendingScopeRequest.attempt_id) === Number(attempt.id))
        ) {
          if (wtPath) {
            try {
              if (await gitHasChangesAsync(wtPath)) {
                const siblingLocks = activeSiblingWriteLocks(job);
                if (siblingLocks.length === 0) {
                  await snapshotAndResetDirtyWorktreeAsyncFromModule(wtPath, this.projectDir, {
                    reason: `scope-request-job-${job.id}`,
                    branchName: getWorkItem(job.work_item_id)?.branch_name || null,
                    wiId: job.work_item_id,
                  });
                }
              }
            } catch (resetErr) {
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
                actor_type: EVENT_ACTORS.WORKER,
                message: `Scope-request pause left dirty state for setup recovery: ${resetErr?.message || String(resetErr)}`,
              });
            }
          }
          completeAttempt(attempt.id, {
            status: "interrupted",
            duration_ms: Date.now() - startTime,
            error_text: `Paused for scope approval: ${pendingScopeRequest.path}`,
          });
          const settled = settleJobScopeExpansionAttempt({ jobId: job.id, attemptId: attempt.id });
          this.emit(
            job.id,
            `${C.yellow}[scope] WI#${job.work_item_id} job #${job.id}: provider call paused for ${pendingScopeRequest.path}${settled.finalized ? `; human decision ${settled.decision}` : "; awaiting human decision"}${C.reset}`,
          );
          refreshAndExtractInsightsFromModule(job.work_item_id);
          this._cleanupWorktreeIfDone(job.work_item_id);
          return;
        }
        const agentCompletionLog = MUTATING_JOB_TYPES.has(job.job_type)
          ? parseAgentCompletionLogFromModule(output)
          : { found: false, status: null, body: "", blockReason: null, verifiedNoChange: false };

        if (agentCompletionLog.status === "BLOCKED" && MUTATING_JOB_TYPES.has(job.job_type)) {
          const blockReason = agentCompletionLog.blockReason || "Agent reported BLOCKED";
          const blockMsg = `Agent BLOCKED: ${blockReason}`;
          this.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id}: ${blockMsg}${C.reset}`);

          if (wtPath) {
            try {
              if (await gitHasChangesAsync(wtPath)) {
                const siblingLocks = activeSiblingWriteLocks(job);
                if (siblingLocks.length > 0) {
                  logEvent({
                    work_item_id: job.work_item_id,
                    job_id: job.id,
                    attempt_id: attempt.id,
                    event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
                    actor_type: EVENT_ACTORS.WORKER,
                    message: `Deferred blocked-attempt dirty cleanup; ${siblingLocks.length} same-WI job lock(s) still active`,
                    event_json: JSON.stringify({ locks: siblingLocks.slice(0, 20) }),
                  });
                } else {
                  try {
                    await snapshotAndResetDirtyWorktreeAsyncFromModule(wtPath, this.projectDir, {
                      reason: `blocked-job-${job.id}`,
                      branchName: getWorkItem(job.work_item_id)?.branch_name || null,
                      wiId: job.work_item_id,
                    });
                  } catch (resetErr) {
                    // Snapshot refused or failed — leave the dirt in place for
                    // the next job's setup recovery. An unsnapshotted wipe here
                    // is the one response the snapshot layer forbids.
                    logEvent({
                      work_item_id: job.work_item_id,
                      job_id: job.id,
                      attempt_id: attempt.id,
                      event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
                      actor_type: EVENT_ACTORS.WORKER,
                      message: `Left blocked-attempt dirty state in place; snapshot/reset failed: ${resetErr?.message || String(resetErr)}`,
                      event_json: JSON.stringify({ reason: `blocked-job-${job.id}` }),
                    });
                  }
                }
              }
            } catch { /* dirty probe failed — leave the worktree alone; setup recovery handles pre-existing dirt */ }
          }

          const allAttempts = getAttempts(job.id);
          const blockedCount = allAttempts.filter(a => a.status === "blocked").length;
          completeAttempt(attempt.id, {
            status: "blocked",
            duration_ms: Date.now() - startTime,
            error_text: blockMsg,
          });
          logEvent({
            work_item_id: job.work_item_id,
            job_id: job.id,
            attempt_id: attempt.id,
            event_type: EVENT_TYPES.JOB_BLOCKED,
            actor_type: EVENT_ACTORS.WORKER,
            message: blockMsg,
          });
          await wrappedJob.setError(blockMsg);

          // Transient MCP-gateway attach failures are infrastructure, not a real
          // block: the agent ran without its write tools because the CLI couldn't
          // attach the stdio gateway under load. Auto-requeue with backoff instead
          // of escalating to a human (capped, so a persistently broken gateway
          // still escalates).
          if (isTransientMcpInfraBlock(blockReason)) {
            this._invalidatePendingSessionRecycleForMcpInfra(job, "mcp_infra_block");
            const infraRetries = allAttempts.filter(
              (a) => a.status === "blocked" && isTransientMcpInfraBlock(a.error_text),
            ).length;
            if (infraRetries < MAX_MCP_INFRA_BLOCK_RETRIES) {
              const delayMs = MCP_INFRA_BLOCK_BACKOFF_MS[
                Math.min(infraRetries, MCP_INFRA_BLOCK_BACKOFF_MS.length - 1)
              ];
              const readyAt = new Date(Date.now() + delayMs).toISOString();
              this.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id}: transient MCP gateway attach failure — auto-requeueing (retry ${infraRetries + 1}/${MAX_MCP_INFRA_BLOCK_RETRIES}) in ${Math.round(delayMs / 1000)}s${C.reset}`);
              this._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt });
              refreshAndExtractInsightsFromModule(job.work_item_id);
              this._cleanupWorktreeIfDone(job.work_item_id);
              return;
            }
            this.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} job #${job.id}: MCP gateway attach failed ${infraRetries} time(s) — escalating to human${C.reset}`);
          }

          const blockedPayload = {
            original_job_id: job.id,
            review_type: "blocked_recovery",
            choices: HUMAN_INPUT_ACTION_ENUMS.blocked_recovery,
            questions: [`Agent was blocked on job #${job.id}. What should be done?`],
            context: [
              `Task: ${job.title}`,
              `Block reason: ${blockReason}`,
              "",
              agentCompletionLog.body || output,
            ].join("\n"),
          };
          if (hasPendingFileRequests()) {
            const allRequested = [
              ...(pendingFileRequests.autoApproved || []),
              ...(pendingFileRequests.needsApproval || []),
            ];
            blockedPayload.file_requests = allRequested;
            blockedPayload.context = [
              blockedPayload.context,
              "",
              `The agent also requested creation of ${allRequested.length} file(s):`,
              ...allRequested.map(r => `  - ${r.path} (${r.risk}) — ${r.reason || "no reason given"}`),
            ].join("\n");
          }

          if (blockedCount >= 2) {
            this.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} job #${job.id}: blocked ${blockedCount + 1} times — dead-lettering${C.reset}`);
            this._releaseWithoutAttemptPenalty(job, leaseToken, "dead_letter");
          } else {
            createJob({
              work_item_id: job.work_item_id,
              job_type: "human_input",
              title: `Blocked: ${job.title.slice(0, 80)}`,
              parent_job_id: job.id,
              priority: "high",
              payload_json: JSON.stringify(blockedPayload),
            });
            this._releaseWithoutAttemptPenalty(job, leaseToken, "waiting_on_human");
          }
          refreshAndExtractInsightsFromModule(job.work_item_id);
          this._cleanupWorktreeIfDone(job.work_item_id);
          return;
        }

        let hasFileChanges = false;
        let satisfiedNoop = false;
        let verifiedNoChange = false;
        let filesReverted = [];
        let filesCommitted = [];
        let filesCommittedUnknown = false;
        let filesCommittedError = null;
        let committedHash = null;
        let branchNetDiff = null;
        let skippedStaleModifyFiles = [];
        let preAssessAlreadyVerified = false;
        if (wtPath) {
          if (!isLeaseValid(job.id, leaseToken)) {
            this.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} — lease lost before commit${C.reset}`);
            try {
              if (await gitHasChangesAsync(wtPath)) {
                const siblingLocks = activeSiblingWriteLocks(job);
                if (siblingLocks.length > 0) {
                  logEvent({
                    work_item_id: job.work_item_id,
                    job_id: job.id,
                    attempt_id: attempt.id,
                    event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
                    actor_type: EVENT_ACTORS.WORKER,
                    message: `Deferred stale-lease dirty cleanup; ${siblingLocks.length} same-WI job lock(s) still active`,
                    event_json: JSON.stringify({ locks: siblingLocks.slice(0, 20) }),
                  });
                } else {
                  await snapshotAndResetDirtyWorktreeAsyncFromModule(wtPath, this.projectDir, {
                    reason: `stale-lease-job-${job.id}`,
                    branchName: getWorkItem(job.work_item_id)?.branch_name || null,
                    wiId: job.work_item_id,
                  });
                }
              }
            } catch { /* best effort */ }
            completeAttempt(attempt.id, {
              status: "failed",
              duration_ms: Date.now() - startTime,
              error_text: "Lease expired before commit",
            });
            refreshAndExtractInsightsFromModule(job.work_item_id);
            this._cleanupWorktreeIfDone(job.work_item_id);
            return;
          }
          const preCommitPayload = this.parsePayload(job);
          if (
            requiresGitNoopCheckFromModule(job, preCommitPayload)
            && isDeleteNoopSatisfiedFromModule(job, preCommitPayload, wtPath)
          ) {
            const noopDeleteMsg = `Cleanup task already satisfied before commit — scoped files absent, skipping gitCommitAll`;
            this.emit(job.id, `${C.cyan}[worker] WI#${job.work_item_id} job #${job.id}: ${noopDeleteMsg}${C.reset}`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_DELETE_NOOP_SATISFIED_PRECOMMIT,
              actor_type: EVENT_ACTORS.WORKER,
              message: noopDeleteMsg,
            });
            hasFileChanges = true;
            satisfiedNoop = true;
          } else if ((preCommitPayload?.task_mode || "code") === "db") {
            // DB-only job: nothing to commit by design — the write surface is
            // the project database and the file tools run read-only. Skip the
            // commit machinery entirely (its unscoped-add assert would throw on
            // an empty scope) and defensively reset any stray worktree changes
            // so they cannot leak into the next job on this branch. Flow
            // continues with hasFileChanges=false: requiresGitNoopCheck exempts
            // db mode from the no-op guard and the assessor still runs.
            try {
              if (await gitHasChangesAsync(wtPath)) {
                const discardMsg = `db-mode job left unexpected worktree changes — snapshotting and resetting`;
                this.emit(job.id, `${C.yellow}[scope] WI#${job.work_item_id} job #${job.id}: ${discardMsg}${C.reset}`);
                logEvent({
                  work_item_id: job.work_item_id,
                  job_id: job.id,
                  attempt_id: attempt.id,
                  event_type: EVENT_TYPES.WORKTREE_EXTERNAL_DRIFT_DETECTED,
                  actor_type: EVENT_ACTORS.WORKER,
                  message: discardMsg,
                });
                await snapshotAndResetDirtyWorktreeAsyncFromModule(wtPath, this.projectDir, {
                  reason: `db-mode-noop-job-${job.id}`,
                  branchName: getWorkItem(job.work_item_id)?.branch_name || null,
                  wiId: job.work_item_id,
                });
              }
            } catch { /* best effort — the reset is defensive, not load-bearing */ }
          } else {
          try {
            const jobPayload = preCommitPayload;
            const activeLocksForCommit = listActiveFileLocks();
            try {
              const caseFoldScopePath = (file) => {
                const normalized = String(file || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
                return process.platform === "win32" ? normalized.toLowerCase() : normalized;
              };
              const scopeSet = new Set([
                ...(jobPayload.files_to_modify || []),
                ...(jobPayload.files_to_create || []),
                ...(jobPayload.files_to_delete || []),
              ].map(caseFoldScopePath).filter(Boolean));
              const roots = (jobPayload.create_roots || []).filter(Boolean).map(caseFoldScopePath);
              const preCommit = await gitExecAsync(["status", "--porcelain"], wtPath);
              const changedPaths = String(preCommit || "")
                .split("\n")
                .map((line) => line)
                .filter(Boolean)
                .map((line) => {
                  const normalized = line.replace(/\\/g, "/");
                  if (normalized.length >= 4 && normalized[2] === " ") return normalized.slice(3).trim();
                  return normalized.trim().replace(/^[ MADRCU?!]{1,2}\s+/, "").trim();
                })
                .filter(Boolean);
              let nestedRepoPrefix = null;
              try {
                const repoRoot = path.resolve(await gitExecAsync(["rev-parse", "--show-toplevel"], wtPath));
                const rel = path.relative(repoRoot, path.resolve(wtPath)).replace(/\\/g, "/").replace(/\/+$/, "");
                if (rel && rel !== "." && isInsideRoot(path.resolve(wtPath), repoRoot, { allowEqual: false, followSymlinks: false })) nestedRepoPrefix = rel;
              } catch {
                nestedRepoPrefix = null;
              }
              const normalizedChangedPaths = changedPaths.map((file) => {
                const normalized = String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
                const scoped = (() => {
                  if (!nestedRepoPrefix) return normalized;
                  const prefix = `${nestedRepoPrefix}/`;
                  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
                })();
                return caseFoldScopePath(scoped);
              });
              const outside = normalizedChangedPaths.filter((file) => {
                if (scopeSet.has(file)) return false;
                for (const root of roots) {
                  if (!root || root === ".") continue;
                  if (file === root || file.startsWith(`${root}/`)) return false;
                }
                if (findActiveSiblingLockForPath(file, job, { locks: activeLocksForCommit })) return false;
                return true;
              });
              if (outside.length > 0) {
                logEvent({
                  work_item_id: job.work_item_id,
                  job_id: job.id,
                  attempt_id: attempt.id,
                  event_type: EVENT_TYPES.WORKTREE_EXTERNAL_DRIFT_DETECTED,
                  actor_type: EVENT_ACTORS.WORKER,
                  message: `Pre-commit telemetry detected ${outside.length} change(s) outside declared scope`,
                  event_json: JSON.stringify({ files: outside.slice(0, 50) }),
                });
              }
            } catch {
              // Telemetry-only; never fail the job.
            }
            const headBefore = await gitCurrentHashAsync(wtPath);
            const commitMsg = `posse: ${job.job_type} job #${job.id} - ${job.title}`;
            // Retry the commit step in place when the failure is a transient
            // identity/heartbeat fault. The agent's work is already correct;
            // failing the whole attempt would discard it and re-run the
            // provider call just to reproduce the same tree.
            let commitResult = null;
            for (let commitInfraRetries = 0; ; commitInfraRetries += 1) {
              try {
                commitResult = await gitCommitAllAsyncFromModule(commitMsg, wtPath, {
                  // must_modify paths are writable scope even when the planner
                  // didn't duplicate them into files_to_modify.
                  modifyFiles: [...new Set([
                    ...(Array.isArray(jobPayload.files_to_modify) ? jobPayload.files_to_modify : []),
                    ...(Array.isArray(jobPayload.must_modify) ? jobPayload.must_modify : []),
                  ])],
                  createFiles: jobPayload.files_to_create || [],
                  deleteFiles: jobPayload.files_to_delete || [],
                  createRoots: jobPayload.create_roots || [],
                }, {
                  projectDir: this.projectDir,
                  wiId: job.work_item_id,
                  branchName: getWorkItem(job.work_item_id)?.branch_name || null,
                  snapshotReason: `dev-scope-enforcement-job-${job.id}`,
                  taskMode: jobPayload.task_mode || "code",
                  jobId: job.id,
                  activeFileLocks: activeLocksForCommit,
                });
                break;
              } catch (commitErr) {
                if (commitInfraRetries >= 2 || !isTransientCommitInfraFailure(commitErr)) throw commitErr;
                const retryMsg = `Commit hit transient infra fault (${formatCommitFailureSummary(commitErr)}) — retrying commit in place (${commitInfraRetries + 1}/2)`;
                this.emit(job.id, `${C.yellow}[git] WI#${job.work_item_id} job #${job.id}: ${retryMsg}${C.reset}`);
                logEvent({
                  work_item_id: job.work_item_id,
                  job_id: job.id,
                  attempt_id: attempt.id,
                  event_type: EVENT_TYPES.JOB_COMMIT_INFRA_RETRY,
                  actor_type: EVENT_ACTORS.WORKER,
                  message: retryMsg,
                  event_json: JSON.stringify({
                    retry: commitInfraRetries + 1,
                    error: formatCommitFailureSummary(commitErr).slice(0, 500),
                  }),
                });
                await new Promise((resolve) => setTimeout(resolve, (commitInfraRetries + 1) * 2000));
              }
            }
            const {
              hash: commitHash,
              reverted,
              createdViaModifyScope,
              createdOutOfScope,
              skippedIgnoredCreateFiles,
              skippedIgnoredModifyFiles,
              skippedStaleModifyFiles: skippedStaleModifyFilesFromCommit,
              outOfScopeDirtySkipped,
              outOfScopeStagingSkipped,
              gitAddWarnings,
              scopeCleanedNoOp,
              mergeCompleted,
              outOfScopeMergeFiles,
              mergeAuditFailed,
              mergeAuditError,
              siblingDirtySkipped,
              siblingUntrackedSkipped,
              siblingStagingSkipped,
            } = commitResult;

            filesReverted = reverted;
            skippedStaleModifyFiles = skippedStaleModifyFilesFromCommit || [];

            if (mergeCompleted) {
              this.emit(job.id, `${C.dim}[git] WI#${job.work_item_id} job #${job.id}: merge completed by dev${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_MERGE_COMPLETED,
                actor_type: EVENT_ACTORS.WORKER,
                message: `Dev resolved pending merge and committed`,
              });
            }

            if (outOfScopeMergeFiles && outOfScopeMergeFiles.length > 0) {
              const auditMsg = `Merge commit touched ${outOfScopeMergeFiles.length} file(s) outside task scope and outside merge diff: ${outOfScopeMergeFiles.slice(0, 5).join(", ")}`;
              this.emit(job.id, `${C.yellow}[scope] WI#${job.work_item_id} job #${job.id}: ${auditMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_MERGE_SCOPE_AUDIT,
                actor_type: EVENT_ACTORS.WORKER,
                message: auditMsg,
                event_json: JSON.stringify({ files: outOfScopeMergeFiles }),
              });
            }

            if (mergeAuditFailed) {
              const auditFailMsg = `Post-merge scope audit failed: ${mergeAuditError || "unknown error"}`;
              this.emit(job.id, `${C.yellow}[scope] WI#${job.work_item_id} job #${job.id}: ${auditFailMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_MERGE_SCOPE_AUDIT_FAILED,
                actor_type: EVENT_ACTORS.WORKER,
                message: auditFailMsg,
                event_json: JSON.stringify({ error: mergeAuditError || null }),
              });
            }

            // Log scope violations
            if (reverted.length > 0) {
              const scopeMsg = `Reverted ${reverted.length} out-of-scope file(s): ${reverted.slice(0, 5).join(", ")}`;
              this.emit(job.id, `${C.yellow}[scope] WI#${job.work_item_id} job #${job.id}: ${scopeMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_VIOLATION,
                actor_type: EVENT_ACTORS.WORKER,
                message: scopeMsg,
              });
            }

            // Log planner scope bugs: new files created via files_to_modify
            if (createdViaModifyScope.length > 0) {
              const compatMsg = `Planner scope bug: ${createdViaModifyScope.length} new file(s) created via files_to_modify (should be files_to_create): ${createdViaModifyScope.join(", ")}`;
              this.emit(job.id, `${C.yellow}[scope-compat] WI#${job.work_item_id} job #${job.id}: ${compatMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_COMPAT_CREATE_VIA_MODIFY,
                actor_type: EVENT_ACTORS.WORKER,
                message: compatMsg,
                event_json: JSON.stringify({ files: createdViaModifyScope }),
              });
            }

            // Log residual untracked files outside scope. They are deliberately
            // left on disk and ignored until WI merge cleanup.
            if (createdOutOfScope && createdOutOfScope.length > 0) {
              const oosMsg = `Left ${createdOutOfScope.length} out-of-scope untracked file(s) for WI merge cleanup: ${createdOutOfScope.slice(0, 10).join(", ")}`;
              this.emit(job.id, `${C.yellow}[scope-compat] WI#${job.work_item_id} job #${job.id}: ${oosMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_COMPAT_UNTRACKED_OUT_OF_SCOPE,
                actor_type: EVENT_ACTORS.WORKER,
                message: oosMsg,
                event_json: JSON.stringify({ files: createdOutOfScope }),
              });
            }

            if ((outOfScopeDirtySkipped?.length || 0) > 0 || (outOfScopeStagingSkipped?.length || 0) > 0) {
              const deferredDirty = outOfScopeDirtySkipped || [];
              const preservedStaged = outOfScopeStagingSkipped || [];
              const deferredMsg = `Left ${deferredDirty.length} out-of-scope dirty path(s) and preserved ${preservedStaged.length} out-of-scope staged path(s) for WI merge cleanup`;
              this.emit(job.id, `${C.yellow}[scope-compat] WI#${job.work_item_id} job #${job.id}: ${deferredMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
                actor_type: EVENT_ACTORS.WORKER,
                message: deferredMsg,
                event_json: JSON.stringify({
                  dirty: deferredDirty.slice(0, 50),
                  unstaged: preservedStaged.slice(0, 50),
                }),
              });
            }

            if (gitAddWarnings && gitAddWarnings.length > 0) {
              const addWarnMsg = `Git add reported ${gitAddWarnings.length} non-fatal staging warning(s): ${gitAddWarnings.slice(0, 3).map((w) => `${w.context}:${w.file}`).join(", ")}`;
              this.emit(job.id, `${C.yellow}[scope-runtime] WI#${job.work_item_id} job #${job.id}: ${addWarnMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_GIT_ADD_WARNING,
                actor_type: EVENT_ACTORS.WORKER,
                message: addWarnMsg,
                event_json: JSON.stringify({ warnings: gitAddWarnings.slice(0, 20) }),
              });
            }

            if (skippedIgnoredCreateFiles && skippedIgnoredCreateFiles.length > 0) {
              const ignoredMsg = `Skipped ${skippedIgnoredCreateFiles.length} ignored createFiles path(s) during commit staging: ${skippedIgnoredCreateFiles.slice(0, 10).join(", ")}`;
              this.emit(job.id, `${C.yellow}[scope-runtime] WI#${job.work_item_id} job #${job.id}: ${ignoredMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_IGNORED_CREATEFILES_SKIPPED,
                actor_type: EVENT_ACTORS.WORKER,
                message: ignoredMsg,
                event_json: JSON.stringify({ files: skippedIgnoredCreateFiles }),
              });
            }

            if (skippedIgnoredModifyFiles && skippedIgnoredModifyFiles.length > 0) {
              const ignoredModifyMsg = `Skipped ${skippedIgnoredModifyFiles.length} ignored modifyFiles path(s) during commit staging: ${skippedIgnoredModifyFiles.slice(0, 10).join(", ")}`;
              this.emit(job.id, `${C.yellow}[scope-runtime] WI#${job.work_item_id} job #${job.id}: ${ignoredModifyMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_IGNORED_MODIFYFILES_SKIPPED,
                actor_type: EVENT_ACTORS.WORKER,
                message: ignoredModifyMsg,
                event_json: JSON.stringify({ files: skippedIgnoredModifyFiles }),
              });
            }

            if (skippedStaleModifyFiles && skippedStaleModifyFiles.length > 0) {
              const staleMsg = `Skipped ${skippedStaleModifyFiles.length} stale modifyFiles path(s) during commit staging: ${skippedStaleModifyFiles.slice(0, 10).join(", ")}`;
              this.emit(job.id, `${C.yellow}[scope-runtime] WI#${job.work_item_id} job #${job.id}: ${staleMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_STALE_MODIFYFILES_SKIPPED,
                actor_type: EVENT_ACTORS.WORKER,
                message: staleMsg,
                event_json: JSON.stringify({ files: skippedStaleModifyFiles }),
              });
            }

            const siblingSkipped = [
              ...(siblingDirtySkipped || []),
              ...(siblingUntrackedSkipped || []),
              ...(siblingStagingSkipped || []),
            ];
            if (siblingSkipped.length > 0) {
              const siblingMsg = `Left ${siblingSkipped.length} sibling-owned dirty path(s) uncommitted: ${siblingSkipped.slice(0, 5).map((entry) => `${entry.file} by #${entry.job_id || "?"}`).join(", ")}`;
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_SIBLING_DIRTY_SKIPPED,
                actor_type: EVENT_ACTORS.WORKER,
                message: siblingMsg,
                event_json: JSON.stringify({
                  visible: false,
                  dirty: siblingDirtySkipped || [],
                  untracked: siblingUntrackedSkipped || [],
                  staging: siblingStagingSkipped || [],
                }),
              });
            }

            if (commitHash !== headBefore) {
              hasFileChanges = true;
              committedHash = commitHash;
              setAttemptCommitHash(attempt.id, commitHash);
              // Capture what was actually committed (ground truth for assessor)
              try {
                filesCommitted = (await gitExecAsync(["diff", "--no-renames", "--name-only", "--relative", headBefore, commitHash], wtPath))
                  .split("\n")
                  .map((line) => String(line || "").replace(/\\/g, "/").trim())
                  .filter(Boolean);
                filesCommittedUnknown = false;
                filesCommittedError = null;
              } catch (err) {
                filesCommitted = [];
                filesCommittedUnknown = true;
                filesCommittedError = err?.message || String(err);
              }
              recordObservation({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                observation_type: "git.commit",
                summary: filesCommittedUnknown
                  ? `Committed ${commitHash.slice(0, 8)} but could not verify committed file list`
                  : `Committed ${filesCommitted.length} file(s) at ${commitHash.slice(0, 8)}`,
                detail: {
                  cwd: wtPath,
                  commit_hash: commitHash,
                  files_committed: filesCommitted,
                  files_committed_unknown: filesCommittedUnknown,
                  files_committed_error: filesCommittedError,
                  files_reverted: filesReverted,
                  created_via_modify_scope: createdViaModifyScope,
                  skipped_ignored_modify_files: skippedIgnoredModifyFiles || [],
                  skipped_stale_modify_files: skippedStaleModifyFiles || [],
                  out_of_scope_dirty_skipped: outOfScopeDirtySkipped || [],
                  out_of_scope_staging_skipped: outOfScopeStagingSkipped || [],
                  scope_cleaned_noop: scopeCleanedNoOp,
                  sibling_dirty_skipped: siblingSkipped,
                },
              });
              this.emit(job.id, `${C.dim}[system] WI#${job.work_item_id} ${branchName}: ${commitHash.slice(0, 8)} — ${shortJobTitleFromModule(job).slice(0, 40)}${C.reset}`);
              void this._kickAtlasReindex(job, commitHash);

              const outputContract = filesCommittedUnknown
                ? { ok: true }
                : await validateDeclaredOutputContract({
                    job,
                    payload: jobPayload,
                    filesCommitted,
                    cwd: wtPath,
                  });
              if (!outputContract.ok) {
                const contractMsg = [
                  "Declared output contract failed after commit",
                  outputContract.missingCreates?.length ? `missing creates: ${outputContract.missingCreates.slice(0, 10).join(", ")}` : null,
                  outputContract.missingModifies?.length ? `missing modifies: ${outputContract.missingModifies.slice(0, 10).join(", ")}` : null,
                  outputContract.untouchedCreates?.length ? `creates not committed: ${outputContract.untouchedCreates.slice(0, 10).join(", ")}` : null,
                  outputContract.untouchedModifies?.length ? `modifies not committed: ${outputContract.untouchedModifies.slice(0, 10).join(", ")}` : null,
                ].filter(Boolean).join(" — ");
                this.emit(job.id, `${C.red}[contract] WI#${job.work_item_id} job #${job.id}: ${contractMsg}${C.reset}`);
                logEvent({
                  work_item_id: job.work_item_id,
                  job_id: job.id,
                  attempt_id: attempt.id,
                  event_type: EVENT_TYPES.JOB_OUTPUT_CONTRACT_FAILED,
                  actor_type: EVENT_ACTORS.WORKER,
                  message: contractMsg,
                  event_json: JSON.stringify({
                    files_committed: filesCommitted,
                    missing_creates: outputContract.missingCreates || [],
                    missing_modifies: outputContract.missingModifies || [],
                    untouched_creates: outputContract.untouchedCreates || [],
                    untouched_modifies: outputContract.untouchedModifies || [],
                  }),
                });
                await wrappedJob.setError(contractMsg);
                {
                  const freshForPartial = getJob(job.id) || job;
                  const finalAttempt = Number(freshForPartial.attempt_count || attemptCount || 0) >= Number(freshForPartial.max_attempts || job.max_attempts || 3);
                  if (finalAttempt && committedHash) {
                    const partialOutput = [
                      output || "",
                      "",
                      "PARTIAL WORK NOTE:",
                      contractMsg,
                      "The worker committed the in-scope partial output so the assessor can decide whether a fix job is needed.",
                    ].filter(Boolean).join("\n");
                    setJobResult(job.id, {
                      partial_work: true,
                      output_length: partialOutput.length,
                      commit_hash: committedHash,
                      files_committed: filesCommitted,
                      reason: contractMsg,
                    });
                    await runPostExecutionAssessmentFromModule(this, {
                      attempt,
                      committedHash,
                      filesCommitted,
                      filesCommittedUnknown,
                      filesCommittedError,
                      filesReverted,
                      hasFileChanges: true,
                      job,
                      leaseToken,
                      output: partialOutput,
                      pendingFileRequests: null,
                      preAssessAlreadyVerified: true,
                      preManifestState,
                      satisfiedNoop: false,
                      startTime,
                      wtPath,
                    }, {
                      assessmentRetryFallbackReads: _assessmentRetryFallbackReads,
                      isAssessorParseRetryBudgetExceeded: _isAssessorParseRetryBudgetExceeded,
                      isProviderError: _isProviderError,
                      logBadInputFailure: _logBadInputFailure,
                      shouldFastPassArtifactAssessment,
                      shouldOverrideArtifactMissingFail,
                      shortJobTitle: shortJobTitleFromModule,
                      syncAssessorWorkerDisplay: _syncAssessorWorkerDisplay,
                    });
                    return;
                  }
                }
                storePostAgentFailureCheckpoint({
                  job,
                  attemptId: attempt.id,
                  output,
                  failureNote: contractMsg,
                });
                completeAttempt(attempt.id, {
                  status: "failed",
                  duration_ms: Date.now() - startTime,
                  error_text: contractMsg,
                });
                this._retryOrFail(job, leaseToken, contractMsg);
                return;
              }
              if (outputContract.unmodifiedDeclaredScope?.length > 0) {
                // Declared-but-unmodified scope passes the contract (scope is
                // an allowance, not a work order); record it so the assessor
                // and operators can see the dev's no-change judgment call.
                const unusedMsg = `Declared modify scope left unmodified (allowed): ${outputContract.unmodifiedDeclaredScope.slice(0, 10).join(", ")}`;
                this.emit(job.id, `${C.dim}[contract] WI#${job.work_item_id} job #${job.id}: ${unusedMsg}${C.reset}`);
                logEvent({
                  work_item_id: job.work_item_id,
                  job_id: job.id,
                  attempt_id: attempt.id,
                  event_type: EVENT_TYPES.JOB_OUTPUT_CONTRACT_SCOPE_UNUSED,
                  actor_type: EVENT_ACTORS.WORKER,
                  message: unusedMsg,
                  event_json: JSON.stringify({
                    visible: false,
                    files_committed: filesCommitted,
                    unmodified_declared_scope: outputContract.unmodifiedDeclaredScope,
                  }),
                });
              }

              // -- Deterministic hook: post-dev build/lint verification --
              const verifyResult = await runHookAsync("post_dev_verify", { cwd: wtPath });
              if (!verifyResult.ok) {
                const verifyMsg = `Build/lint verification failed after commit — ${verifyResult.output.slice(0, 500)}`;
                this.emit(job.id, `${C.red}[hook] WI#${job.work_item_id} job #${job.id}: post-dev-verify BLOCKED${C.reset}`);
                logEvent({
                  work_item_id: job.work_item_id,
                  job_id: job.id,
                  attempt_id: attempt.id,
                  event_type: EVENT_TYPES.JOB_HOOK_VERIFY_FAILED,
                  actor_type: EVENT_ACTORS.WORKER,
                  message: verifyMsg,
                });
                // Fail the job with the build error — skip assessment since code doesn't build
                await wrappedJob.setError(verifyMsg);
                {
                  const freshForPartial = getJob(job.id) || job;
                  const finalAttempt = Number(freshForPartial.attempt_count || attemptCount || 0) >= Number(freshForPartial.max_attempts || job.max_attempts || 3);
                  if (finalAttempt && committedHash) {
                    const partialOutput = [
                      output || "",
                      "",
                      "PARTIAL WORK NOTE:",
                      verifyMsg,
                      "The worker committed the in-scope partial output so the assessor can decide whether a fix job is needed.",
                    ].filter(Boolean).join("\n");
                    setJobResult(job.id, {
                      partial_work: true,
                      output_length: partialOutput.length,
                      commit_hash: committedHash,
                      files_committed: filesCommitted,
                      reason: verifyMsg,
                    });
                    await runPostExecutionAssessmentFromModule(this, {
                      attempt,
                      committedHash,
                      filesCommitted,
                      filesCommittedUnknown,
                      filesCommittedError,
                      filesReverted,
                      hasFileChanges: true,
                      job,
                      leaseToken,
                      output: partialOutput,
                      pendingFileRequests: null,
                      preAssessAlreadyVerified: true,
                      preManifestState,
                      satisfiedNoop: false,
                      startTime,
                      wtPath,
                    }, {
                      assessmentRetryFallbackReads: _assessmentRetryFallbackReads,
                      isAssessorParseRetryBudgetExceeded: _isAssessorParseRetryBudgetExceeded,
                      isProviderError: _isProviderError,
                      logBadInputFailure: _logBadInputFailure,
                      shouldFastPassArtifactAssessment,
                      shouldOverrideArtifactMissingFail,
                      shortJobTitle: shortJobTitleFromModule,
                      syncAssessorWorkerDisplay: _syncAssessorWorkerDisplay,
                    });
                    return;
                  }
                }
                storePostAgentFailureCheckpoint({
                  job,
                  attemptId: attempt.id,
                  output,
                  failureNote: verifyMsg,
                });
                completeAttempt(attempt.id, {
                  status: "failed",
                  duration_ms: Date.now() - startTime,
                  error_text: verifyMsg,
                });
                this._retryOrFail(job, leaseToken, verifyMsg);
                return;
              }
              preAssessAlreadyVerified = true;
            } else if (scopeCleanedNoOp) {
              // Dev produced changes, but ALL were out-of-scope and got reverted.
              // This is distinct from "dev made no changes" — it means the dev
              // worked on the wrong files entirely. Surface it as a specific failure.
              const cleanMsg = `All changes were out-of-scope and reverted — dev worked on wrong files`;
              this.emit(job.id, `${C.red}[scope] WI#${job.work_item_id} job #${job.id}: ${cleanMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_CLEANED_NOOP,
                actor_type: EVENT_ACTORS.WORKER,
                message: cleanMsg,
              });
              await wrappedJob.setError(cleanMsg);
              completeAttempt(attempt.id, {
                status: "failed",
                duration_ms: Date.now() - startTime,
                error_text: cleanMsg,
              });
              this._retryOrFail(job, leaseToken, cleanMsg);
              return;
            } else {
              this.emit(job.id, `${C.dim}[system] WI#${job.work_item_id} ${branchName}: no changes to commit${C.reset}`);
            }
          } catch (gitErr) {
            // Git failures must fail the attempt with the real reason,
            // not silently continue to the no-op guard for a generic retry.
            const hookOutput = String(gitErr.hookOutput || "").trim();
            const gitFailureDetail = formatCommitFailureDetail(gitErr);
            const gitFailureSummary = formatCommitFailureSummary(gitErr);
            const lockTimeout = await worktreeLockTimeoutInfoAsync(gitErr, gitFailureDetail);
            this.emit(job.id, `${C.dim}[system] WI#${job.work_item_id} ${branchName}: commit failed — ${gitFailureSummary}${C.reset}`);
            if (hookOutput) {
              this.emit(job.id, `${C.red}[hook] WI#${job.work_item_id} job #${job.id}: ${hookOutput.split("\n").slice(0, 8).join(" | ")}${C.reset}`);
            }
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: lockTimeout.timeout ? EVENT_TYPES.JOB_WORKTREE_LOCK_TIMEOUT : EVENT_TYPES.JOB_COMMIT_FAILED,
              actor_type: EVENT_ACTORS.WORKER,
              message: lockTimeout.timeout
                ? `Git commit blocked by worktree lock timeout: ${gitFailureSummary}`
                : `Git commit failed: ${gitFailureSummary}`,
              event_json: JSON.stringify({
                ...(hookOutput ? { hook_output: hookOutput } : {}),
                ...(isTransientCommitInfraFailure(gitErr) ? { transient_infra: true, infra_retries_exhausted: true } : {}),
                ...(gitErr.stderr ? { stderr: String(gitErr.stderr).slice(0, 4000) } : {}),
                ...(gitErr.stdout ? { stdout: String(gitErr.stdout).slice(0, 4000) } : {}),
                ...(gitErr.code ? { code: gitErr.code } : {}),
                ...(gitErr.signal ? { signal: gitErr.signal } : {}),
                ...(gitErr.gitCommitTimedOut ? {
                  git_commit_timed_out: true,
                  git_commit_timeout_budget: gitErr.gitCommitTimeoutBudget || null,
                } : {}),
                ...(lockTimeout.timeout ? {
                  lock_path: lockTimeout.lockPath,
                  lock_stat: lockTimeout.lockStat,
                } : {}),
              }),
            });
            if (Array.isArray(gitErr.createdOutOfScope) && gitErr.createdOutOfScope.length > 0) {
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_UNTRACKED_OUT_OF_SCOPE_BLOCKED,
                actor_type: EVENT_ACTORS.WORKER,
                message: `Blocked commit with ${gitErr.createdOutOfScope.length} out-of-scope untracked file(s): ${gitErr.createdOutOfScope.slice(0, 10).join(", ")}`,
                event_json: JSON.stringify({ files: gitErr.createdOutOfScope.slice(0, 50) }),
              });
            }
            await wrappedJob.setError(lockTimeout.timeout
              ? `Git commit blocked by worktree lock timeout: ${gitFailureDetail}`
              : `Git commit failed: ${gitFailureDetail}`);
            // Preserve the failed attempt's dirty state to .recovery/ and
            // reset the worktree so the retry starts clean. Snapshots are
            // forensic; orphan stashes otherwise accumulate across failures.
            if (wtPath) {
              try {
                if (await gitHasChangesAsync(wtPath)) {
                  const siblingLocks = activeSiblingWriteLocks(job);
                  if (siblingLocks.length > 0) {
                    logEvent({
                      work_item_id: job.work_item_id,
                      job_id: job.id,
                      attempt_id: attempt.id,
                      event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
                      actor_type: EVENT_ACTORS.WORKER,
                      message: `Deferred commit-failure dirty cleanup; ${siblingLocks.length} same-WI job lock(s) still active`,
                      event_json: JSON.stringify({ locks: siblingLocks.slice(0, 20) }),
                    });
                  } else {
                    try {
                      await snapshotAndResetDirtyWorktreeAsyncFromModule(wtPath, this.projectDir, {
                        reason: `commit-failed-job-${job.id}`,
                        branchName: getWorkItem(job.work_item_id)?.branch_name || null,
                        wiId: job.work_item_id,
                      });
                    } catch (resetErr) {
                      // Snapshot refused or failed — leave the dirt for the
                      // next job's setup recovery rather than wiping the only
                      // copy of the failed attempt's work.
                      logEvent({
                        work_item_id: job.work_item_id,
                        job_id: job.id,
                        attempt_id: attempt.id,
                        event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
                        actor_type: EVENT_ACTORS.WORKER,
                        message: `Left commit-failure dirty state in place; snapshot/reset failed: ${resetErr?.message || String(resetErr)}`,
                        event_json: JSON.stringify({ reason: `commit-failed-job-${job.id}` }),
                      });
                    }
                  }
                }
              } catch { /* ignore */ }
            }
            storeArtifact({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              artifact_type: "log",
              content_long: `${lockTimeout.timeout ? "Git commit blocked by worktree lock timeout" : "Git commit failed"} (job #${job.id}, attempt ${attemptCount}): ${gitFailureDetail}`,
            });
            storePostAgentFailureCheckpoint({
              job,
              attemptId: attempt.id,
              output,
              failureNote: `Git commit failed: ${gitFailureSummary}`,
            });
            completeAttempt(attempt.id, {
              status: lockTimeout.timeout ? "interrupted" : "failed",
              duration_ms: Date.now() - startTime,
              error_text: lockTimeout.timeout
                ? `Git commit blocked by worktree lock timeout: ${gitFailureDetail}`
                : `Git commit failed: ${gitFailureDetail}`,
            });
            if (lockTimeout.timeout) {
              const readyAt = new Date(Date.now() + 5000).toISOString();
              this._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt });
              return;
            }
            this._retryOrFail(job, leaseToken, `Git commit failed: ${gitFailureDetail}`);
            return;
          }
          }
        }

        // -- Idempotency check --
        const outputHash = crypto.createHash("sha256").update(output).digest("hex").slice(0, 16);
        const prevResultJson = job.result_json;
        await wrappedJob.setResult({ output_length: output.length, attempt: attemptCount, output_hash: outputHash });

        if (attemptCount > 1 && prevResultJson) {
          // Narrow the try to JSON.parse only. Wrapping the whole dead-letter
          // block meant a synchronous DB throw after completeAttempt() skipped
          // the `return` and fell through to a full (duplicate) assessment,
          // letting a later completeAttempt overwrite the "failed" status. (B8)
          let prevResult = null;
          try {
            prevResult = JSON.parse(prevResultJson);
          } catch { prevResult = null; }
          if (prevResult) {
            if (prevResult.output_hash === outputHash) {
              // Don't dead-letter if file requests are pending — the output is
              // deterministically the same because the task genuinely needs those
              // files, not because the model is stuck.
              if (hasPendingFileRequests()) {
                this.emit(job.id, `${C.yellow}[idempotency] WI#${job.work_item_id} job #${job.id}: identical output, but file requests pending — allowing through${C.reset}`);
                // Fall through to no-op guard / assessment with file-request spawning
              } else {
              // Don't dead-letter if the next attempt would escalate to a stronger
              // model — the different model may produce different output. Only
              // dead-letter when escalation can't help (same tier next time or
              // no attempts remaining).
              const maxAttempts = job.max_attempts || 3;
              const nextTier = attemptCount < maxAttempts
                ? provider.escalateTier(job.model_tier, attemptCount + 1, { resolveModel: resolveTierModel })
                : effectiveTier;
              if (nextTier !== effectiveTier) {
                this.emit(job.id, `${C.yellow}[idempotency] WI#${job.work_item_id} job #${job.id}: identical output, but next attempt escalates ${effectiveTier} ? ${nextTier} — allowing retry${C.reset}`);
                // Fall through to no-op guard / assessment instead of dead-lettering
              } else {
                this.emit(job.id, `${C.red}[idempotency] WI#${job.work_item_id} job #${job.id}: identical output (same tier next) — dead-lettering${C.reset}`);
                completeAttempt(attempt.id, {
                  status: "failed",
                  duration_ms: Date.now() - startTime,
                  error_text: "Identical output on retry — dead-lettered",
                });
                spawnDeadLetterRecoveryForDependentsFromModule(this, job, getJob(job.id) || job, {
                  reasonText: "produced identical output on retry and could not escalate to a different model, so it was dead-lettered",
                  context: "This job produced identical retry output with no pending file request and no stronger model path available. Its downstream dependent(s) are temporarily gated on this recovery job so a human can choose a retry, simplification, or explicit skip.",
                });
                this._releaseLease(job, leaseToken, "dead_letter");
                refreshAndExtractInsightsFromModule(job.work_item_id);
                this._cleanupWorktreeIfDone(job.work_item_id);
                return;
              }
              } // end else (no pending file requests)
            }
          } // end if (prevResult)
        }

        // -- No-op guard (git-based — code tasks only; artifact tasks use manifest check) --
        const noOpPayload = this.parsePayload(job);
        if (
          wtPath
          && MUTATING_JOB_TYPES.has(job.job_type)
          && requiresGitNoopCheckFromModule(job, noOpPayload)
          && !committedHash
        ) {
          const branchDiffScopePaths = [
            ...(noOpPayload.files_to_modify || []),
            ...(noOpPayload.files_to_create || []),
            ...scopedDeleteTargetsFromModule(job, noOpPayload),
            ...skippedStaleModifyFiles,
          ].filter(Boolean);
          const netDiff = await detectBranchNetDiffForNoWriteAsyncFromModule({
            wtPath,
            projectDir: this.projectDir,
            scopePaths: branchDiffScopePaths,
            scopeRoots: noOpPayload.create_roots || [],
          });
          if (netDiff?.hasDiff) {
            branchNetDiff = netDiff;
            hasFileChanges = true;
            satisfiedNoop = false;
            filesCommitted = netDiff.files || [];
            filesCommittedUnknown = false;
            filesCommittedError = null;
            committedHash = netDiff.head || null;
            const msg = `Zero-commit attempt found existing branch diff vs ${netDiff.targetBranch || "target"} (${filesCommitted.length} file(s)); routing branch state to assessment`;
            this.emit(job.id, `${C.yellow}[assessor] WI#${job.work_item_id} job #${job.id}: ${msg}${C.reset}`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_NOOP_BRANCH_DIFF_DETECTED,
              actor_type: EVENT_ACTORS.WORKER,
              message: msg,
              event_json: JSON.stringify({
                target_branch: netDiff.targetBranch || null,
                merge_base: netDiff.mergeBase || null,
                head: netDiff.head || null,
                files: filesCommitted.slice(0, 50),
              }),
            });
          } else if (netDiff && netDiff.ok === false) {
            const msg = `Could not prove branch has no committed diff before no-op handling: ${netDiff.reason || "unknown git error"}`;
            this.emit(job.id, `${C.yellow}[assessor] WI#${job.work_item_id} job #${job.id}: ${msg}${C.reset}`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_NOOP_BRANCH_DIFF_DETECTED,
              actor_type: EVENT_ACTORS.WORKER,
              message: msg,
              event_json: JSON.stringify({
                target_branch: netDiff.targetBranch || null,
                reason: netDiff.reason || null,
              }),
            });
          }
        }
        if (!hasFileChanges && requiresGitNoopCheckFromModule(job, noOpPayload)) {
          // Parse dev/artificer log status — BLOCKED is handled before commit.
          const devLogMatch = agentCompletionLog.found ? { 1: agentCompletionLog.body } : null;
          const devStatus = agentCompletionLog.status || null;

          if (devStatus === "BLOCKED") {
            // Dev correctly identified it can't proceed — escalate to human immediately
            const blockReason = agentCompletionLog.blockReason
              || "Dev reported BLOCKED with no file changes";
            const blockMsg = `Dev BLOCKED: ${blockReason}`;
            this.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id}: ${blockMsg}${C.reset}`);

            // -- BLOCKED cycle cap: prevent infinite block?human?block loops --
            const MAX_BLOCKED_CYCLES = 2;
            const allAttempts = getAttempts(job.id);
            const blockedCount = allAttempts.filter(a => a.status === "blocked").length;

            completeAttempt(attempt.id, {
              status: "blocked",
              duration_ms: Date.now() - startTime,
              error_text: blockMsg,
            });
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_BLOCKED,
              actor_type: EVENT_ACTORS.WORKER,
              message: blockMsg,
            });
            await wrappedJob.setError(blockMsg);

            // Transient MCP-gateway attach failures are infrastructure, not a real
            // block — auto-requeue with backoff instead of escalating to a human
            // (capped, so a persistently broken gateway still escalates).
            if (isTransientMcpInfraBlock(blockReason)) {
              this._invalidatePendingSessionRecycleForMcpInfra(job, "mcp_infra_block");
              const infraRetries = allAttempts.filter(
                (a) => a.status === "blocked" && isTransientMcpInfraBlock(a.error_text),
              ).length;
              if (infraRetries < MAX_MCP_INFRA_BLOCK_RETRIES) {
                const delayMs = MCP_INFRA_BLOCK_BACKOFF_MS[
                  Math.min(infraRetries, MCP_INFRA_BLOCK_BACKOFF_MS.length - 1)
                ];
                const readyAt = new Date(Date.now() + delayMs).toISOString();
                this.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id}: transient MCP gateway attach failure — auto-requeueing (retry ${infraRetries + 1}/${MAX_MCP_INFRA_BLOCK_RETRIES}) in ${Math.round(delayMs / 1000)}s${C.reset}`);
                this._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt });
                refreshAndExtractInsightsFromModule(job.work_item_id);
                this._cleanupWorktreeIfDone(job.work_item_id);
                return;
              }
              this.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} job #${job.id}: MCP gateway attach failed ${infraRetries} time(s) — escalating to human${C.reset}`);
            }

            // Don't consume the attempt — BLOCKED is a correct diagnosis, not a
            // failure. The human needs to provide guidance (expand scope, etc.)
            // and the job should retain its retry budget for after the human helps.

            if (blockedCount >= MAX_BLOCKED_CYCLES) {
              // Same block keeps recurring — dead-letter instead of looping
              this.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} job #${job.id}: blocked ${blockedCount + 1} times — dead-lettering${C.reset}`);
              this._releaseWithoutAttemptPenalty(job, leaseToken, "dead_letter");

              // Spawn recovery human_input with full context
              const dependents = getDependents(job.id);
              if (dependents.length > 0) {
                const recoveryJob = createJob({
                  work_item_id: job.work_item_id,
                  job_type: "human_input",
                  title: `Blocked ${blockedCount + 1}x: ${job.title.slice(0, 70)}`,
                  parent_job_id: job.id,
                  priority: "urgent",
                  model_tier: "cheap",
                  payload_json: JSON.stringify({
                    original_job_id: job.id,
                    review_type: "blocked_recovery",
                    choices: HUMAN_INPUT_ACTION_ENUMS.blocked_recovery,
                    questions: [
                      `Job #${job.id} "${job.title}" has been blocked ${blockedCount + 1} times with the same issue. How should we proceed?`,
                    ],
                    context: [
                      `Block reason: ${blockReason}`,
                      "",
                      devLogMatch[1].trim(),
                    ].join("\n"),
                  }),
                });
                for (const dep of dependents) {
                  rewireDependency(dep.job_id, job.id, recoveryJob.id, dep.dependency_kind);
                }
                this.emit(job.id, `${C.yellow}[recovery] WI#${job.work_item_id} spawned human_input #${recoveryJob.id} — ${dependents.length} dep(s) rewired${C.reset}`);
              }

              refreshAndExtractInsightsFromModule(job.work_item_id);
              this._cleanupWorktreeIfDone(job.work_item_id);
              return;
            }

            // Create human_input job — include file requests if present
            const blockedPayload = {
              original_job_id: job.id,
              review_type: "blocked_recovery",
              choices: HUMAN_INPUT_ACTION_ENUMS.blocked_recovery,
              questions: [`Dev was blocked on job #${job.id}. What should be done?`],
              context: [
                `Task: ${job.title}`,
                `Block reason: ${blockReason}`,
                "",
                devLogMatch[1].trim(),
              ].join("\n"),
            };
            if (hasPendingFileRequests()) {
              const allRequested = [
                ...(pendingFileRequests.autoApproved || []),
                ...(pendingFileRequests.needsApproval || []),
              ];
              blockedPayload.file_requests = allRequested;
              blockedPayload.context = [
                blockedPayload.context,
                "",
                `The dev also requested creation of ${allRequested.length} file(s):`,
                ...allRequested.map(r => `  - ${r.path} (${r.risk}) — ${r.reason || "no reason given"}`),
              ].join("\n");
            }
            createJob({
              work_item_id: job.work_item_id,
              job_type: "human_input",
              title: `Blocked: ${job.title.slice(0, 80)}`,
              parent_job_id: job.id,
              priority: "high",
              payload_json: JSON.stringify(blockedPayload),
            });
            this._releaseWithoutAttemptPenalty(job, leaseToken, "waiting_on_human");
            refreshAndExtractInsightsFromModule(job.work_item_id);
            return;
          }

          if (skippedStaleModifyFiles.length > 0) {
            const staleMsg = [
              `Declared modifyFiles path(s) were stale during commit staging: ${skippedStaleModifyFiles.slice(0, 10).join(", ")}`,
              `No scoped commit was produced. This usually means the target file was missing from the worktree or the planner scope was wrong.`,
              `Recover the target file/scope before treating this job as complete.`,
            ].join("\n");
            finishNoWriteAttemptFromModule(this, {
              attempt,
              attemptCount,
              job,
              leaseToken,
              message: staleMsg,
              startTime,
            });
            return;
          }

          // File-request bypass: no file changes, but valid file requests pending.
          // The dev discovered what files are needed — this is a legitimate outcome.
          // Fall through to skip-assessment success path to spawn follow-ups.
          if (hasPendingFileRequests()) {
            const totalRequested = (pendingFileRequests.autoApproved?.length || 0)
              + (pendingFileRequests.needsApproval?.length || 0);
            this.emit(job.id, `${C.cyan}[file-request]${C.reset} WI#${job.work_item_id} job #${job.id}: no in-scope changes, but ${totalRequested} file(s) requested — bypassing no-op guard`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_NOOP_BYPASS_FILE_REQUEST,
              actor_type: EVENT_ACTORS.WORKER,
              message: `No-op guard bypassed: ${totalRequested} file request(s) pending`,
            });
            // Fall through to assessment / success
          } else if (agentCompletionLog.verifiedNoChange) {
            const verifiedMsg = `Agent reported VERIFIED_NO_CHANGE; routing current scoped files to assessment instead of forcing a decorative diff`;
            this.emit(job.id, `${C.cyan}[worker] WI#${job.work_item_id} job #${job.id}: ${verifiedMsg}${C.reset}`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_VERIFIED_NO_CHANGE,
              actor_type: EVENT_ACTORS.WORKER,
              message: verifiedMsg,
            });
            verifiedNoChange = true;
          } else if (isDeleteNoopSatisfiedFromModule(job, this.parsePayload(job), wtPath || job._worktreePath || this.projectDir)) {
            const noopDeleteMsg = `Cleanup task already satisfied — scoped files are absent, so there was nothing left to delete`;
            this.emit(job.id, `${C.cyan}[worker] WI#${job.work_item_id} job #${job.id}: ${noopDeleteMsg}${C.reset}`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_DELETE_NOOP_SATISFIED,
              actor_type: EVENT_ACTORS.WORKER,
              message: noopDeleteMsg,
            });
            hasFileChanges = true;
            satisfiedNoop = true;
          } else if (devStatus === "COMPLETE" && isFilePlacementNoopSatisfiedFromModule(job, this.parsePayload(job), wtPath || job._worktreePath || this.projectDir, output)) {
            const noopPlacementMsg = `File placement task already satisfied — destination file(s) already exist, so there was nothing left to move or copy`;
            this.emit(job.id, `${C.cyan}[worker] WI#${job.work_item_id} job #${job.id}: ${noopPlacementMsg}${C.reset}`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_FILE_PLACEMENT_NOOP_SATISFIED,
              actor_type: EVENT_ACTORS.WORKER,
              message: noopPlacementMsg,
            });
            hasFileChanges = true;
            satisfiedNoop = true;
          } else {
            // True no-op: no file changes and no file requests. Early attempts
            // requeue without assessment; the final budgeted attempt fails.
            // Build a diagnostic message so the retry knows what went wrong and
            // which files are actually in scope.
            const noopPayload = this.parsePayload(job);
            const scopeFiles = scopedDeleteTargetsFromModule(job, noopPayload);
            const scopeCreate = noopPayload.files_to_create || [];
            let noopMsg = `Dev produced no file changes - nothing to assess`;
            if (filesReverted.length > 0) {
              noopMsg += `\nReverted ${filesReverted.length} out-of-scope file(s): ${filesReverted.slice(0, 8).join(", ")}`;
            }
            if (skippedStaleModifyFiles.length > 0) {
              noopMsg += `\nStale modifyFiles path(s): ${skippedStaleModifyFiles.slice(0, 8).join(", ")}`;
            }
            if (scopeFiles.length > 0 || scopeCreate.length > 0) {
              const allScope = [...scopeFiles, ...scopeCreate.map(f => `${f} (new)`)];
              noopMsg += `\nAllowed scope: ${allScope.slice(0, 10).join(", ")}`;
            }
            noopMsg += `\nEither modify files within the allowed scope, request missing context/scope, or return status VERIFIED_NO_CHANGE with concrete evidence that the requested end state is already present.`;
            finishNoWriteAttemptFromModule(this, {
              attempt,
              attemptCount,
              job,
              leaseToken,
              message: noopMsg,
              startTime,
            });
            return;
          }
        }

        if (shouldShortCircuitNoWriteAssessmentFromModule({
          job,
          hasFileChanges,
          pendingFileRequests,
          satisfiedNoop,
          verifiedNoChange,
        })) {
          const noopPayload = this.parsePayload(job);
          const scopeFiles = scopedDeleteTargetsFromModule(job, noopPayload);
          const scopeCreate = noopPayload.files_to_create || [];
          let noopMsg = `Dev produced no file changes - nothing to assess`;
          if (filesReverted.length > 0) {
            noopMsg += `\nReverted ${filesReverted.length} out-of-scope file(s): ${filesReverted.slice(0, 8).join(", ")}`;
          }
          if (skippedStaleModifyFiles.length > 0) {
            noopMsg += `\nStale modifyFiles path(s): ${skippedStaleModifyFiles.slice(0, 8).join(", ")}`;
          }
          if (scopeFiles.length > 0 || scopeCreate.length > 0) {
            const allScope = [...scopeFiles, ...scopeCreate.map(f => `${f} (new)`)];
            noopMsg += `\nAllowed scope: ${allScope.slice(0, 10).join(", ")}`;
          }
          noopMsg += `\nEither modify files within the allowed scope, request missing context/scope, or return status VERIFIED_NO_CHANGE with concrete evidence that the requested end state is already present.`;
          finishNoWriteAttemptFromModule(this, {
            attempt,
            attemptCount,
            job,
            leaseToken,
            message: noopMsg,
            startTime,
          });
          return;
        }

        await runPostExecutionAssessmentFromModule(this, {
          attempt,
          committedHash,
          filesCommitted,
          filesCommittedUnknown,
          filesCommittedError,
          filesReverted,
          hasFileChanges,
          job,
          leaseToken,
          output,
          pendingFileRequests,
          preAssessAlreadyVerified,
          preManifestState,
          branchNetDiff,
          satisfiedNoop,
          verifiedNoChange,
          startTime,
          wtPath,
        }, {
          assessmentRetryFallbackReads: _assessmentRetryFallbackReads,
          isAssessorParseRetryBudgetExceeded: _isAssessorParseRetryBudgetExceeded,
          isProviderError: _isProviderError,
          logBadInputFailure: _logBadInputFailure,
          shouldFastPassArtifactAssessment,
          shouldOverrideArtifactMissingFail,
          shortJobTitle: shortJobTitleFromModule,
          syncAssessorWorkerDisplay: _syncAssessorWorkerDisplay,
        });
        const postAssessmentJob = getJob(job.id);
        if (postAssessmentJob?.status === "succeeded") {
          this._finalizeSessionRecycleForJob(job, attempt);
        } else {
          this._releasePendingSessionRecycleForJob(job.id);
        }
}
