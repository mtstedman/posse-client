import { installCliWarningFilter } from "./warnings.js";

installCliWarningFilter();

// orchestrator.js v4 — SQLite-backed job queue orchestrator
//
// Commands:
//   add <description>   Add a work item
//   queue               Show work items
//   plan                Research + plan queued items into jobs
//   run                 Execute pending jobs
//   go                  plan + run in one shot
//   status              Show job status
//   serve               Start local bridge API/WS server
//   health              Show failure/stuck-job health signals
//   dashboard           Visual job board
//   review              Final report + approve/reject
//   update              Pull latest Posse client + refresh dependencies
//   inject <desc>       Quick-add a work item (also works mid-run)
//   image <prompt>      Generate an image directly (skips research/plan)
//   admin               Stats, session history, and settings management
//     admin worktrees   List recovered dirty-worktree snapshots with age
//   purge               Delete all posse/* branches + worktrees (asks first)
//   clear               Reset everything
//   events [jobId]      Show event log
//   timeline <wiId>     Full execution chain for a work item (jobs, attempts, verdicts)
//   sessions [wiId]     Show session-recycling lanes and savings
//   cost [wiId]         Per-WI cost attribution; manage pricing overrides
//   replay <callId>     Build a compressed replay packet for an agent call
//   fanout              Research fanout quality/readiness report
//   plan review/approve/reject <wiId>  Review a plan before execution (with --approve-plan)
//   audit [jobId|wiId]  Show recent handoff/provider audit trail
//   codex-models        Validate/list codex model compatibility
//   local-models        List and download signed local model bundles
//   windows-events      Probe Windows System/Application crash events into the run dir
//
// Flags:
//   --auto-approve      Dev skips tool permission prompts
//   --auto-merge        Merge completed WI branches at end-of-run
//   --no-auto-merge     Disable auto-merge for this run, even if enabled in settings
//   --approve-plan      After planning, pause for human review before dev/fix run
//   --auto-approve-plan Disable plan-approval gates for this run
//   --deepthink         Raise planner/research turn budget for this work item
//   --deepthink-budget  Set planner/research budget: low, normal, high, xhigh
//   --input-contexts    Comma list of resources/inputs dirs (name, index, or 'all')
//   --files             Optional comma list of hinted files
//   --constraints       Optional comma list of intake constraints
//   --red-team-plan     Run primary planner -> red-team planner -> synthesis planner before writing
//   --iterate-red-team  Persist red-team planning across --iterate follow-up rounds
//   --stall-timeout N   Seconds before killing stalled process (default: 600)
//
// No SDK. No API key. Just `claude` on your PATH.

import fs from "fs";
import os from "os";
import path from "path";
import { getDb, closeDb } from "../../../shared/storage/functions/index.js";
import { flushEventsNow } from "../../queue/functions/events.js";
import { execFile, spawnSync } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { editorCommandLabel, parseEditorCommand, resolveEditorCommand } from "./editor.js";
import { initArtifactRootsAsync, ensureArtifactDirs, wiScopeId, contextDir, isArtifactMode, getArtifactProtocol, getResolvedImageProtocol, artifactsDir, pruneEmptyArtifactDirsAsync } from "../../artifacts/functions/index.js";
import {
  createWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItemStatus,
  updateWorkItemMetadata,
  updateWorkItemResearchSkip,
  setMergeState,
  listJobs,
  listJobsByWorkItem,
  getJob,
  getWorkItemJobStats,
  createJob,
  getEvents,
  getEventsByWorkItem,
  getArtifacts,
  getArtifactsByWorkItem,
  storeArtifact,
  logEvent,
  findRunnableJob,
  getAgentCallStats,
  listAgentCalls,
  getAgentCallsByWorkItem,
  getDependencies,
  cancelWorkItemJobs,
  addDependency,
  skipJob,
  refreshWorkItemStatus,
  updateJobPayload,
  cleanupRunningAgentCalls,
  getSetting,
  setSetting,
  listSettings,
  requeueWaitingHumanInputJobs,
  findWriteLockConflict,
  getJobWriteScope,
  listActiveFileLocks,
  requeueWorkItemAfterRejection,
  getLiveSchedulerBlockMessage,
} from "../../queue/functions/index.js";
import { withMergeLock } from "../../queue/functions/locks.js";
import { ACTIVE_LEASE_STATUSES } from "../../queue/functions/common.js";
import { shouldIncludeWorkItemInApprovalQueue } from "../../queue/functions/reviewable.js";
import { jobLabel } from "../../ui/functions/display/helpers/job-status.js";
import { modelTierColor, statusColor, statusIcon } from "../../ui/functions/display/status-palette.js";
import { computeJobProgressStats } from "../../ui/functions/display/helpers/job-status.js";
import { roleBrandColor } from "../../ui/functions/display/helpers/brand.js";
import { getCatalogRuntimeFallbackInt } from "../../settings/functions/catalog.js";
import { C } from "../../../shared/format/functions/colors.js";
import { getDefaultTierModel } from "../../providers/functions/model-catalog.js";
import { NO_IMAGE_PROVIDERS_AVAILABLE, resolveImageExecutionProvider } from "../../providers/functions/execution-routing.js";
import { providerRoleForJobType } from "../../providers/functions/roles.js";
import {
  getCommandBootstrapPolicy,
  isHelpCommand,
  normalizeCommandName,
  shouldRefreshContextAfterCommand,
} from "./command-bootstrap-policy.js";
import { dispatchCommand } from "./dispatch.js";
import { assertGitIdentityChecks } from "./git-readiness.js";
import {
  getCommandPositionalArgs,
  hasArgFlag,
  hasIntakeHintFlags,
  parseAutoMerge,
  parseConcurrency,
  parseFlagValue,
  parseIntakeHintsFromArgv,
  parseModeFlagFromArgv,
  parseResearchBudgetFromArgv,
  parseSessionRecycleFlagFromArgv,
  parseStallTimeout,
  parseTierFlagFromArgv,
  parseWorkItemIdsFlagFromArgv,
  rejectUnknownFlags,
  resolveResearchBudgetForDeepthink,
} from "./flags.js";
import {
  defaultOutputModeForMode,
  normalizeIterativeWorkflowModeChoice,
} from "../../intake/functions/choices.js";
import {
  mergeSuspectedDirsWithInputContexts,
} from "../../intake/functions/input-contexts.js";
import { inferWiMode } from "../../intake/functions/mode-inference.js";
import { researchBudgetMetadata, researchPayload } from "../../research/functions/payload.js";
import { atlasV2UsageSummary } from "./atlas-v2-help.js";
import { buildRuntimeEnv, getRuntimeDbPath } from "../../runtime/functions/paths.js";
import { clearColdIndex as clearColdIndexImpl } from "./cold-index.js";
import {
  createReviewSession as createReviewSessionImpl,
  createReviewSessionDeps as createReviewSessionDepsImpl,
  createRunSessionDeps as createRunSessionDepsImpl,
} from "./session-factories.js";
import {
  classifyResearchForRouting as classifyResearchForRoutingImpl,
  createInitialResearchOrPlanJob as createInitialResearchOrPlanJobImpl,
} from "../../research/functions/intake-routing.js";
import {
  applyIterativeWorkflowProfile as applyIterativeWorkflowProfileImpl,
  shouldUseRedTeamPlanForWorkItem as shouldUseRedTeamPlanForWorkItemImpl,
  shouldPersistIterativeRedTeamPlan as shouldPersistIterativeRedTeamPlanImpl,
  persistIterativeRedTeamPlanIfRequested as persistIterativeRedTeamPlanIfRequestedImpl,
  spawnIterativeNextPass as spawnIterativeNextPassImpl,
  processIterativeWrapUp as processIterativeWrapUpImpl,
} from "../../planning/functions/orchestration.js";
import {
  ITERATIVE_WORKFLOW_PROFILES,
  ITERATIVE_RELOOP_PROMPTS,
  getIterativeWorkflowProfile,
  getIterativeReloopPrompt,
  parseWorkItemMetadata,
  metadataRedTeamPlanningEnabled,
  getIterativeState,
  persistIterativeState,
  isIterativeWorkItemActive,
  isIterativeAwaitingLoopResolution,
  isIterativeFinalized,
  shouldAutoApproveIterativeWorkItem,
  hasMergedHistory,
  summarizeIterativeReasons,
  iterativeFollowUpJobsAfter,
  markIterativeFinished,
} from "../../planning/functions/state.js";
import {
  ensurePosseRuntimeIgnoresAsync,
  stagePosseRuntimeGitignoreForInitialCommit,
} from "../../runtime/functions/ignore.js";
import { runHook } from "../../git/functions/hooks.js";
import { refreshProjectContextAsync } from "../../project/functions/context.js";
import { ensureProjectMapAsync, ensureProjectMapRebuildHookAsync, getCachedProjectMap } from "../../project/functions/map.js";
import { buildSyntheticResearchBrief, classifyResearchTask } from "../../research/functions/routing.js";
import {
  createResearchFanoutJobs,
  getResearchFanoutMode,
  logFanoutSkipped,
} from "../../research/functions/fanout.js";
import { closeLog, log } from "../../../shared/telemetry/functions/logging/logger.js";
import { closeObservationLog, getRecentToolInvocations, getToolInvocationCountsByJob } from "../../observability/functions/observations.js";
import { closePromptLog, readRecentPrompts } from "../../../shared/telemetry/functions/logging/prompt-log.js";
import { loadRemotePromptBundle } from "../../remote/functions/prompt-bundle.js";
import { jobsNeedGitWorktree } from "../../git/functions/policy.js";
import {
  adminDeleteBranchPreservingTip,
  adminGitExec,
  adminGitExecAsync,
  adminPreserveDirtyWorktreeSnapshot,
  adminWorktreePath,
  adminWorktreeRoot,
  findAdminLegacyWorktree,
} from "../../git/functions/admin-git.js";
import { resolveTargetBranch, resolveTargetBranchForAdmin } from "../../git/functions/target-branch.js";
import { GIT_OPERATION_TIMEOUT_MS, gitExecAsync, isGitCommandFailure } from "../../git/functions/utils.js";
import { ensureRestrictivePushRefspecsAsync, remotePushConfigsAreClearlyRestrictive } from "../../git/functions/push-guard.js";
import { hasExplicitOneshotIntent, normalizeIntakeHints } from "../../intake/functions/hints.js";
import {
  collectHandledSuggestionKeys,
  createApprovedSuggestionFollowUp,
  suggestionDecisionEventJson,
  suggestionDevJobDecision,
  suggestionReviewKey,
} from "../../planning/functions/suggestions.js";
import { approvePlan, rejectPlan, respawnAfterRejection, findPendingGate, isPlanApprovalEnabled, setPlanApprovalOverrideForRun } from "../../planning/functions/plan-approval.js";
import {
  createRedTeamPlanChain,
  RED_TEAM_PLANNING_MODE,
  redTeamPlanningPayload,
} from "../../planning/functions/red-team-plan.js";
import {
  getResearchBudget,
  isResearchBudgetDeep,
  maxResearchBudget,
  normalizeResearchBudget,
  researchBudgetFromDeepthink,
  researchBudgetToReasoningEffort,
} from "../../../shared/policies/functions/role-utils.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { ask, askMultiline, askSelectorChoice } from "./input-prompts.js";
import { nativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";
import { daemonSupervisor } from "../../../shared/tools/classes/daemon/index.js";
import { persistentMcpOwner } from "../../../shared/tools/classes/PersistentMcpOwner.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const AUTO_APPROVE = process.argv.includes("--auto-approve");
if (process.argv.includes("--approve-plan")) {
  setPlanApprovalOverrideForRun(true);
}
if (process.argv.includes("--auto-approve-plan")) {
  setPlanApprovalOverrideForRun(false);
}
const NO_TUI = process.argv.includes("--no-tui");
const NON_INTERACTIVE = process.argv.includes("--non-interactive") ||
  process.argv.includes("--yes") ||
  process.argv.includes("-y");
const DRY_RUN = process.argv.includes("--dry-run");
const ITERATE_FLAG = process.argv.includes("--iterate");
const RED_TEAM_PLAN = process.argv.includes("--red-team-plan");
const ITERATE_RED_TEAM_PLAN = process.argv.includes("--iterate-red-team") ||
  process.argv.includes("--red-team-iterate") ||
  process.argv.includes("--redteam-iterate");
const PROJECT_DIR = process.cwd();
const COMMAND = process.argv[2] && !String(process.argv[2]).startsWith("--")
  ? process.argv[2].toLowerCase()
  : undefined;
Object.assign(process.env, buildRuntimeEnv(PROJECT_DIR, PROJECT_DIR, process.env));

export function clearColdIndex(projectDir = PROJECT_DIR) {
  return clearColdIndexImpl(projectDir);
}

let _autoMergeConfig = null;
let _autoMergeSettingAnnounced = false;

function getAutoMergeConfig() {
  if (!_autoMergeConfig) _autoMergeConfig = parseAutoMerge();
  return _autoMergeConfig;
}

function maybeAnnounceAutoMergeSetting() {
  const AUTO_MERGE_CONFIG = getAutoMergeConfig();
  if (AUTO_MERGE_CONFIG.source !== "setting" || _autoMergeSettingAnnounced) return;
  _autoMergeSettingAnnounced = true;
  console.log(`\n  ${C.yellow}Auto-merge is enabled by admin setting auto_merge_completed=true.${C.reset}`);
  console.log(`  ${C.dim}Completed WI branches will be merged during wrap-up unless that setting is disabled.${C.reset}\n`);
}

// Per-process cache: a command's PATH location does not change mid-run,
// so we only need to spawn the probe once per name. spawnSync above was
// blocking the main thread for 1500ms per missing binary at boot.
const _commandOnPathCache = new Map();

async function commandOnPath(commandName) {
  if (_commandOnPathCache.has(commandName)) {
    return _commandOnPathCache.get(commandName);
  }
  const args = process.platform === "win32"
    ? { file: "where.exe", argv: [commandName] }
    : { file: "sh", argv: ["-c", `command -v ${commandName} >/dev/null 2>&1`] };
  let ok = false;
  try {
    await execFileAsync(args.file, args.argv, { timeout: 1500 });
    ok = true;
  } catch {
    ok = false;
  }
  _commandOnPathCache.set(commandName, ok);
  return ok;
}

async function posseAliasDiagnostic() {
  if (await commandOnPath("posse")) return "";
  if (!(await commandOnPath("claude-org"))) return "";
  return `  ${C.yellow}Alias notice:${C.reset} legacy command ${C.cyan}claude-org${C.reset} is on PATH, but ${C.cyan}posse${C.reset} is not. Re-run the installer or npm link this package to add the alias.\n`;
}

const BOOT_GIT_PROBE_TIMEOUT_MS = GIT_OPERATION_TIMEOUT_MS;
const BOOT_PUSH_GUARD_TIMEOUT_MS = 2_500;

function firstGitErrorLine(err) {
  return String(err?.stderr || err?.message || err || "unknown")
    .split(/\r?\n/)
    .find((line) => line.trim()) || "unknown";
}

async function ensureGitRepositoryInitialized({ verbose = false } = {}) {
  try {
    await gitExecAsync(["rev-parse", "--git-dir"], PROJECT_DIR, {
      timeoutMs: BOOT_GIT_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 128,
    });
    return { initialized: false };
  } catch (err) {
    // Only git itself saying "not a repository" may trigger init. A probe
    // that could not run (native git layer down, gate busy, timeout) must
    // not re-initialize an existing repo.
    if (!isGitCommandFailure(err)) {
      throw new Error(`git availability probe failed (not a missing repo): ${firstGitErrorLine(err)}`);
    }
    // First run in a fresh directory: create the local repository before
    // writing Posse runtime files so ignore rules can be staged for HEAD.
  }

  if (verbose) {
    console.log(`\n  ${C.yellow}${PROJECT_DIR} is not a git repository — initializing one.${C.reset}`);
  }
  try {
    await gitExecAsync(["init"], PROJECT_DIR, {
      timeoutMs: BOOT_GIT_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`failed to git init: ${firstGitErrorLine(err)}`);
  }
  if (verbose) {
    console.log(`  ${C.green}Initialized git repo.${C.reset}`);
  }
  return { initialized: true };
}

async function ensureSnapshotPushRefsGuarded({ verbose = false, timeoutMs = BOOT_PUSH_GUARD_TIMEOUT_MS } = {}) {
  if (await remotePushConfigsAreClearlyRestrictive(PROJECT_DIR, {
    timeoutMs: BOOT_GIT_PROBE_TIMEOUT_MS,
  })) {
    return;
  }
  try {
    const changed = await ensureRestrictivePushRefspecsAsync(PROJECT_DIR, {
      timeoutMs,
      bypassNativeBridge: true,
    });
    if (verbose && changed.length > 0) {
      console.log(`  ${C.dim}Restricted git push refspecs to protect Posse recovery snapshots.${C.reset}`);
    }
  } catch (err) {
    if (verbose) {
      console.log(`  ${C.yellow}Could not verify git push refspec safety: ${err?.message || String(err)}${C.reset}`);
    }
  }
}

/**
 * Ensure the project directory is a git repo with at least one commit.
 * Worktrees require a valid HEAD to branch from. Throws with a clear message
 * if the repo is unusable, or auto-creates an initial commit if the repo
 * exists but is empty (no commits yet).
 *
 * Initializes a missing repo before probing HEAD and user identity. The HEAD
 * and identity checks still run in parallel so the boot spinner is not blocked
 * by serial git calls once repository presence is settled.
 */
async function ensureGitReady() {
  const tryGit = async (args) => {
    try {
      const stdout = await gitExecAsync(args, PROJECT_DIR, {
        timeoutMs: BOOT_GIT_PROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      return { ok: true, stdout: String(stdout || "").trim() };
    } catch (err) {
      return { ok: false, error: err };
    }
  };

  const repoCheck = await tryGit(["rev-parse", "--git-dir"]);
  if (!repoCheck.ok) {
    if (!isGitCommandFailure(repoCheck.error)) {
      throw new Error(`git availability probe failed (not a missing repo): ${firstGitErrorLine(repoCheck.error)}`);
    }
    const initCheck = await tryGit(["init"]);
    if (!initCheck.ok) {
      throw new Error(`could not initialize git repository: ${firstGitErrorLine(initCheck.error)}`);
    }
    await ensurePosseRuntimeIgnoresAsync(PROJECT_DIR);
  }

  // rev-parse HEAD confirms HEAD exists. Run this in parallel with the
  // user.name / user.email probes.
  const [headCheck, nameCheck, emailCheck] = await Promise.all([
    tryGit(["rev-parse", "HEAD"]),
    tryGit(["config", "user.name"]),
    tryGit(["config", "user.email"]),
  ]);
  assertGitIdentityChecks(nameCheck, emailCheck);
  if (!headCheck.ok) {
    // Repo exists but has no commits — create an initial empty commit so HEAD is valid
    console.log(`\n  ${C.yellow}Git repo has no commits. Creating initial commit so worktrees can branch from HEAD...${C.reset}`);
    const git = async (args) => {
      const result = await tryGit(args);
      if (!result.ok) throw result.error;
      return result.stdout;
    };
    await stagePosseRuntimeGitignoreForInitialCommit(PROJECT_DIR, { git });
    const commitResult = await tryGit([
      "commit",
      "--allow-empty",
      "-m",
      "chore: initial commit (posse bootstrap)",
    ]);
    if (!commitResult.ok) {
      throw new Error(`could not create initial commit: ${String(commitResult.error?.message || commitResult.error || "unknown").split("\n")[0]}`);
    }
    console.log(`  ${C.green}Initial commit created.${C.reset}\n`);
  }
  await ensureSnapshotPushRefsGuarded();
}

/**
 * First-run setup check. Auto-initializes a missing git repo and creates the
 * initial commit when HEAD is missing — no confirmation prompt, so `posse go`
 * works the first time in a fresh directory. Only missing user identity still
 * prompts (interactive) or aborts (non-interactive), since it can't be derived.
 * Returns true if the repo is ready to proceed, false to abort cmdRun.
 */
async function ensureRepoSetupConfirmed() {
  // Async so the boot event loop isn't blocked on git between the interactive
  // prompts (the broader boot orchestration requires every task be off-loop).
  const runGit = async (args) => await gitExecAsync(args, PROJECT_DIR, {
    timeoutMs: BOOT_GIT_PROBE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  try {
    await ensureGitRepositoryInitialized({ verbose: true });
    await ensurePosseRuntimeIgnoresAsync(PROJECT_DIR);
    await stagePosseRuntimeGitignoreForInitialCommit(PROJECT_DIR);
  } catch (err) {
    console.error(`  ${C.red}${firstGitErrorLine(err)}${C.reset}\n`);
    return false;
  }

  const configValue = async (args) => {
    try { return (await runGit(args)).trim(); } catch { return ""; }
  };
  const readIdentity = async () => {
    const [name, email, globalName, globalEmail] = await Promise.all([
      configValue(["config", "user.name"]),
      configValue(["config", "user.email"]),
      configValue(["config", "--global", "user.name"]),
      configValue(["config", "--global", "user.email"]),
    ]);
    return { name, email, globalName, globalEmail };
  };
  let identity = await readIdentity();
  if (!identity.name || !identity.email) {
    const canPromptForIdentity = !NON_INTERACTIVE && !!process.stdin?.isTTY && !!process.stdout?.isTTY;
    if (!canPromptForIdentity) {
      console.error(`\n  ${C.red}Git user identity not configured for ${PROJECT_DIR}.${C.reset}`);
      console.error(`  Posse needs both user.name and user.email before it can create the initial commit.`);
      console.error(`  Run: git config --global user.name "Your Name" && git config --global user.email "you@example.com"\n`);
      return false;
    }
    console.log(`\n  ${C.yellow}Git user identity not configured for ${PROJECT_DIR}.${C.reset}`);
    console.log(`  Posse commits changes in worktrees and needs a name + email.`);
    const nameDefault = identity.name || identity.globalName || "";
    const emailDefault = identity.email || identity.globalEmail || "";
    const nameIn = (await ask(`  Name${nameDefault ? ` [${nameDefault}]` : ""}: `)).trim() || nameDefault;
    if (!nameIn) { console.log(`  ${C.red}Aborted - name is required.${C.reset}\n`); return false; }
    const emailIn = (await ask(`  Email${emailDefault ? ` [${emailDefault}]` : ""}: `)).trim() || emailDefault;
    if (!emailIn) { console.log(`  ${C.red}Aborted - email is required.${C.reset}\n`); return false; }
    const scopeAns = (await ask(`  Save globally (so all repos use this)? [Y/n]: `)).trim().toLowerCase();
    const scopeArgs = (scopeAns === "n" || scopeAns === "no") ? [] : ["--global"];
    try {
      await runGit(["config", ...scopeArgs, "user.name", nameIn]);
      await runGit(["config", ...scopeArgs, "user.email", emailIn]);
      identity = await readIdentity();
      if (!identity.name || !identity.email) {
        throw new Error("git config did not return both user.name and user.email after saving");
      }
      console.log(`  ${C.green}Git identity saved and verified (${scopeArgs.length > 0 ? "global" : "local"}).${C.reset}`);
    } catch (err) {
      console.error(`  ${C.red}Failed to save git identity: ${err.message.split("\n")[0]}${C.reset}\n`);
      return false;
    }
  }

  let hasHead = true;
  try { await runGit(["rev-parse", "HEAD"]); } catch { hasHead = false; }
  if (!hasHead) {
    // Worktrees need a valid HEAD to branch from. ensureGitReady creates this
    // commit unconditionally later in boot, so make it automatic here too
    // instead of prompting.
    console.log(`\n  ${C.yellow}Repo has no commits yet — creating an initial commit so worktrees can branch from HEAD.${C.reset}`);
    try {
      await stagePosseRuntimeGitignoreForInitialCommit(PROJECT_DIR);
      await runGit(["commit", "--allow-empty", "-m", "chore: initial commit (posse bootstrap)"]);
      console.log(`  ${C.green}Initial commit created.${C.reset}\n`);
    } catch (err) {
      console.error(`  ${C.red}Failed to create initial commit: ${err.message.split("\n")[0]}${C.reset}\n`);
      return false;
    }
  }

  await ensureSnapshotPushRefsGuarded({ verbose: true });
  return true;
}

let _gitWorkflowHelpersPromise = null;
let _adminGitWorkflowHelpersPromise = null;
let _maintenanceCommandsPromise = null;
let _statusCommandsPromise = null;
let _providerModulePromise = null;
let _atlasModulePromise = null;
let _displayModulePromise = null;
let _workerModulePromise = null;
let _schedulerModulePromise = null;
let _runSessionModulePromise = null;
let _reviewSessionModulePromise = null;
let _adminTuiModulePromise = null;
let _adminSettingsModulePromise = null;
let _adminCatalogModulePromise = null;
let _providerCliInitModulePromise = null;
let _auditCommandModulePromise = null;
let _reportCommandsModulePromise = null;
let _memoryCommandsModulePromise = null;
let _doctorCommandModulePromise = null;
let _updateCommandModulePromise = null;
let _adminWorktreesModulePromise = null;
let _serveCommandModulePromise = null;
let _diagnosticCommandsModulePromise = null;
let _localModelsCommandModulePromise = null;
let _nativeBinariesCommandModulePromise = null;
let _concurrency = null;
let _stallTimeout = undefined;

// Explicit merge target branch. resolveTargetBranch() is shared with worker
// worktree/rebase code, so settings and auto-detect stay in one order for the
// whole run. Deliberately SYNC: this is passed as the getTargetBranch callback
// into createGitWorkflowHelpers, whose contract rejects promise-returning
// callbacks (workflow-context.js currentTargetBranch).
function getTargetBranch() {
  return resolveTargetBranch(PROJECT_DIR);
}

function getAdminTargetBranch() {
  return resolveTargetBranchForAdmin(PROJECT_DIR);
}

async function loadProviderModule() {
  _providerModulePromise ||= import("../../providers/functions/provider.js");
  return _providerModulePromise;
}

async function loadProviderCliInitModule() {
  _providerCliInitModulePromise ||= import("../../providers/functions/provider-cli-init.js");
  return _providerCliInitModulePromise;
}

async function loadAuditCommandModule() {
  _auditCommandModulePromise ||= import("./audit-command.js");
  return _auditCommandModulePromise;
}

async function loadReportCommandsModule() {
  _reportCommandsModulePromise ||= import("./report-commands.js");
  return _reportCommandsModulePromise;
}

async function loadMemoryCommandsModule() {
  _memoryCommandsModulePromise ||= import("./memory-commands.js");
  return _memoryCommandsModulePromise;
}

async function loadDoctorCommandModule() {
  _doctorCommandModulePromise ||= import("./doctor-command.js");
  return _doctorCommandModulePromise;
}

async function loadUpdateCommandModule() {
  _updateCommandModulePromise ||= import("./update-command.js");
  return _updateCommandModulePromise;
}

async function loadAdminWorktreesModule() {
  _adminWorktreesModulePromise ||= import("./admin-worktrees.js");
  return _adminWorktreesModulePromise;
}

async function loadServeCommandModule() {
  _serveCommandModulePromise ||= import("./commands/serve.js");
  return _serveCommandModulePromise;
}

async function loadDiagnosticCommandsModule() {
  _diagnosticCommandsModulePromise ||= import("./diagnostic-commands.js");
  return _diagnosticCommandsModulePromise;
}

async function loadLocalModelsCommandModule() {
  _localModelsCommandModulePromise ||= import("./local-models-command.js");
  return _localModelsCommandModulePromise;
}

async function loadNativeBinariesCommandModule() {
  _nativeBinariesCommandModulePromise ||= import("./native-binaries-command.js");
  return _nativeBinariesCommandModulePromise;
}

async function loadAtlasModule() {
  _atlasModulePromise ||= import("../../integrations/functions/atlas.js");
  return _atlasModulePromise;
}

async function getGitWorkflowHelpers() {
  if (!_gitWorkflowHelpersPromise) {
    _gitWorkflowHelpersPromise = (async () => {
      const { createGitWorkflowHelpers } = await import("../../git/functions/workflows.js");
      return createGitWorkflowHelpers({
        projectDir: PROJECT_DIR,
        getTargetBranch,
        autoMerge: getAutoMergeConfig().enabled,
        nonInteractive: NON_INTERACTIVE,
        askFn: ask,
        isIterativeWorkItemActive,
        shouldAutoApproveIterativeWorkItem,
      });
    })();
  }
  return _gitWorkflowHelpersPromise;
}

async function getAdminGitWorkflowHelpers() {
  if (!_adminGitWorkflowHelpersPromise) {
    _adminGitWorkflowHelpersPromise = (async () => {
      const { createGitWorkflowHelpers } = await import("../../git/functions/workflows.js");
      return createGitWorkflowHelpers({
        projectDir: PROJECT_DIR,
        getTargetBranch: getAdminTargetBranch,
        autoMerge: getAutoMergeConfig().enabled,
        nonInteractive: NON_INTERACTIVE,
        askFn: ask,
        gitExecFn: adminGitExec,
        gitExecAsyncFn: adminGitExecAsync,
        // `merge` already holds the repo-scoped merge lock and refuses while a
        // scheduler is live. Avoid deriving the agent worktree lock through a
        // native daemon on this operator-only lane.
        withWorktreeLockFn: (_wtPath, _projectDir, fn) => fn(),
        worktreePathFn: adminWorktreePath,
        findLegacyWorktreeFn: findAdminLegacyWorktree,
        worktreeRootFn: adminWorktreeRoot,
        deleteBranchPreservingTipFn: adminDeleteBranchPreservingTip,
        preserveDirtyWorktreeSnapshotFn: adminPreserveDirtyWorktreeSnapshot,
        allowSnapshottedWorktreeRemoval: true,
        isIterativeWorkItemActive,
        shouldAutoApproveIterativeWorkItem,
      });
    })();
  }
  return _adminGitWorkflowHelpersPromise;
}

async function getMaintenanceCommands() {
  if (!_maintenanceCommandsPromise) {
    _maintenanceCommandsPromise = (async () => {
      const [
        { createMaintenanceCommands },
        helpers,
        { getAtlasIntegrationConfig },
      ] = await Promise.all([
        import("./maintenance-commands.js"),
        getAdminGitWorkflowHelpers(),
        loadAtlasModule(),
      ]);
      return createMaintenanceCommands({
        projectDir: PROJECT_DIR,
        getTargetBranch: getAdminTargetBranch,
        C,
        ask,
        getAtlasIntegrationConfig,
        cleanupWiBranch: helpers.cleanupWiBranch,
        gitBranchExists: helpers.gitBranchExists,
        gitWorktreePathsForBranch: helpers.gitWorktreePathsForBranch,
        gitWorktreeRemove: helpers.gitWorktreeRemove,
      });
    })();
  }
  return _maintenanceCommandsPromise;
}

async function getStatusCommands() {
  if (!_statusCommandsPromise) {
    _statusCommandsPromise = (async () => {
      const { createStatusCommands } = await import("./status-command.js");
      return createStatusCommands({
        targetBranch: getAdminTargetBranch(),
        C,
      });
    })();
  }
  return _statusCommandsPromise;
}

function getConcurrency() {
  if (_concurrency == null) _concurrency = parseConcurrency();
  return _concurrency;
}

function getStallTimeout() {
  if (_stallTimeout === undefined) _stallTimeout = parseStallTimeout();
  return _stallTimeout;
}

async function loadDisplayModule() {
  _displayModulePromise ||= import("../../ui/classes/display/Display.js");
  return _displayModulePromise;
}

async function loadWorkerModule() {
  _workerModulePromise ||= import("../../worker/classes/Worker.js");
  return _workerModulePromise;
}

async function loadSchedulerModule() {
  _schedulerModulePromise ||= import("../../scheduler/classes/Scheduler.js");
  return _schedulerModulePromise;
}

async function loadRunSessionModule() {
  _runSessionModulePromise ||= import("../classes/RunSession.js");
  return _runSessionModulePromise;
}

async function loadReviewSessionModule() {
  _reviewSessionModulePromise ||= import("../classes/ReviewSession.js");
  return _reviewSessionModulePromise;
}

function tierModelName(tier, { providerName = null, role = null, jobType = null } = {}) {
  const tierKey = String(tier || "standard").trim().toLowerCase() || "standard";
  let provider = String(providerName || "").trim().toLowerCase();
  if (!provider) {
    const resolvedRole = role || providerRoleForJobType(jobType) || "dev";
    if (resolvedRole && resolvedRole !== "human" && resolvedRole !== "promote") {
      try {
        provider = String(getSetting(`provider_${resolvedRole}`) || "")
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean)[0] || "";
      } catch {
        provider = "";
      }
    }
  }
  provider ||= "claude";
  try {
    const override = String(getSetting(`${provider}_model_${tierKey}`) || "").trim();
    if (override) return override;
  } catch {
    // DB may be unavailable in isolated CLI tests.
  }
  return getDefaultTierModel(provider, tierKey) || "sonnet";
}

function configureRuntimeEnv(projectDir) {
  Object.assign(process.env, buildRuntimeEnv(projectDir, projectDir, process.env));
}

// ─── Init ────────────────────────────────────────────────────────────────────

function createStartupReadiness({ enabled = false } = {}) {
  const interactive = enabled && !!process.stdout?.isTTY;
  if (!interactive) {
    return {
      step: async (_label, task) => task(),
      finish: () => {},
    };
  }
  const frames = ["|", "/", "-", "\\"];
  let frame = 0;
  let rendered = false;
  let timer = null;
  const steps = new Map();
  const firstLine = (value) => String(value || "").trim().split(/\r?\n/)[0] || "unknown";
  const iconFor = (step = {}) => {
    if (step.status === "ok") return `${C.green}✓${C.reset}`;
    if (step.status === "failed") return `${C.red}X${C.reset}`;
    return `${C.cyan}${frames[frame % frames.length]}${C.reset}`;
  };
  const render = ({ final = false } = {}) => {
    if (steps.size === 0 && !rendered) return;
    const parts = [...steps.entries()].map(([label, step]) => {
      const elapsed = Math.max(0, Math.round((Date.now() - step.startedAt) / 1000));
      const detail = step.status === "running"
        ? ` ${C.dim}${elapsed}s${C.reset}`
        : step.status === "failed"
          ? ` ${C.dim}${firstLine(step.error)}${C.reset}`
          : "";
      return `${iconFor(step)} ${label}${detail}`;
    });
    const text = final && !parts.some((part) => part.includes(`${C.red}X${C.reset}`))
      ? `${C.green}✓${C.reset} ready`
      : parts.join(`${C.dim} · ${C.reset}`);
    process.stdout.write(`\r  ${C.dim}Startup:${C.reset} ${text}\x1b[K`);
    rendered = true;
    if (!final) frame++;
  };
  const ensureTimer = () => {
    if (timer) return;
    timer = setInterval(() => render(), 120);
    timer.unref?.();
  };
  return {
    step: async (label, task) => {
      steps.set(label, { status: "running", startedAt: Date.now() });
      ensureTimer();
      render();
      await new Promise((resolve) => setImmediate(resolve));
      try {
        const result = await task();
        steps.set(label, {
          ...(steps.get(label) || {}),
          status: "ok",
          finishedAt: Date.now(),
        });
        render();
        return result;
      } catch (err) {
        steps.set(label, {
          ...(steps.get(label) || {}),
          status: "failed",
          error: err?.message || err,
          finishedAt: Date.now(),
        });
        render({ final: true });
        throw err;
      }
    },
    finish: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (rendered) {
        render({ final: true });
        process.stdout.write("\n");
      }
    },
  };
}

async function init({ requireWritableArtifacts = true, refreshStartupContext = false, showReadiness = false, ensureNativeGit = false, refreshNativeGit = false } = {}) {
  configureRuntimeEnv(PROJECT_DIR);
  const readiness = createStartupReadiness({ enabled: showReadiness });
  try {
    if (ensureNativeGit) {
      await readiness.step("Native Git", async () => {
        // The orchestrator owns one live remote heartbeat for the whole app.
        // Start it before artifact resolution or any key-gated native work;
        // children only pull derived pulse grants from their parent.
        await nativeBinaries.startHeartbeat();
        const result = await nativeBinaries.ensureAvailable("git", { refresh: refreshNativeGit });
        if (!result?.available) {
          throw new Error(`posse-git unavailable (${result?.reason || "unknown"})`);
        }
        // Authentication is a startup prerequisite for every key-gated Git
        // call. Warm both route grants on the live handle before readiness or
        // command dispatch so sync compatibility helpers never race a cold
        // heartbeat cache (git:read alone cannot authorize create/mutate work).
        await nativeBinaries.binary("git").ensureNativeAuth(["git:read", "git:mutate"]);
        const active = await nativeBinaries.ensureActive("git");
        if (!active?.active) {
          throw new Error(`posse-git inactive (${active?.reason || "unknown"})`);
        }
        return active;
      });
    }
    if (requireWritableArtifacts) {
      await readiness.step("Git repository", () => ensureGitRepositoryInitialized({ verbose: !showReadiness }));
    }
    // Ensure the DB connection works — schema is bootstrapped by db.js. This is
    // still sync inside better-sqlite3, so render the readiness label first.
    await readiness.step("Database", async () => getDb());
    if (requireWritableArtifacts) {
      await readiness.step("Artifact roots", () => initArtifactRootsAsync(PROJECT_DIR));
      const tasks = [
        readiness.step("Artifact cleanup", () => pruneEmptyArtifactDirsAsync(PROJECT_DIR)),
        readiness.step("Runtime ignores", async () => {
          const result = await ensurePosseRuntimeIgnoresAsync(PROJECT_DIR);
          result.gitignoreInitialCommit = await stagePosseRuntimeGitignoreForInitialCommit(PROJECT_DIR);
          return result;
        }),
        readiness.step("Project map", () => ensureProjectMapAsync(PROJECT_DIR)),
        readiness.step("Project map hook", () => ensureProjectMapRebuildHookAsync({ cwd: PROJECT_DIR })),
      ];
      // The startup-context digest is only consumed at the start of long-running
      // commands (run/go/review/merge). Skipping it for cheap intake commands
      // (add/inject/ask/plan/...) saves several seconds of git shellouts per call.
      if (refreshStartupContext) {
        tasks.push(readiness.step("Project context", () => refreshProjectContextAsync(PROJECT_DIR, { writeDigest: true })));
      }
      await Promise.all(tasks);
    }
  } finally {
    readiness.finish();
  }
}

// ─── WI Mode Inference ─────────────────────────────────────────────────────

/**
 * Infer WI mode from description text. Conservative: explicit flag wins,
 * ambiguous defaults to null (caller falls back to "build").
 */

// Thin wrappers around iterative/orchestration.js + research/intake-routing.js
// so the CLI dispatch sites keep their existing call shapes and the
// argv-derived RED_TEAM_PLAN / ITERATE_RED_TEAM_PLAN flags are bound
// once here instead of leaking into the extracted modules.
function applyIterativeWorkflowProfile(intakeHints, workflowMode, defaultMode = "build") {
  return applyIterativeWorkflowProfileImpl(intakeHints, workflowMode, defaultMode);
}

function shouldUseRedTeamPlanForWorkItem(wi) {
  return shouldUseRedTeamPlanForWorkItemImpl(wi, { redTeamPlan: RED_TEAM_PLAN, iterateRedTeam: ITERATE_RED_TEAM_PLAN });
}

function shouldPersistIterativeRedTeamPlan() {
  return shouldPersistIterativeRedTeamPlanImpl({ redTeamPlan: RED_TEAM_PLAN, iterateRedTeam: ITERATE_RED_TEAM_PLAN });
}

function persistIterativeRedTeamPlanIfRequested(wi) {
  return persistIterativeRedTeamPlanIfRequestedImpl(wi, { redTeamPlan: RED_TEAM_PLAN, iterateRedTeam: ITERATE_RED_TEAM_PLAN });
}

function classifyResearchForRouting(args = {}) {
  return classifyResearchForRoutingImpl({ projectDir: PROJECT_DIR, ...args });
}

function createInitialResearchOrPlanJob(workItem, opts = {}) {
  return createInitialResearchOrPlanJobImpl(workItem, { projectDir: PROJECT_DIR, ...opts });
}

function spawnIterativeNextPass(wi, state) {
  return spawnIterativeNextPassImpl(wi, state, {
    projectDir: PROJECT_DIR,
    redTeamPlan: RED_TEAM_PLAN,
    iterateRedTeam: ITERATE_RED_TEAM_PLAN,
  });
}

async function processIterativeWrapUp(opts = {}) {
  const helpers = await getGitWorkflowHelpers();
  return processIterativeWrapUpImpl({
    ...opts,
    projectDir: PROJECT_DIR,
    redTeamPlan: RED_TEAM_PLAN,
    iterateRedTeam: ITERATE_RED_TEAM_PLAN,
    mergeIterativePassToTarget: helpers.mergeIterativePassToTarget,
  });
}

function isReviewableWorkItem(wi) {
  const jobs = wi?.id ? listJobsByWorkItem(wi.id) : [];
  return shouldIncludeWorkItemInApprovalQueue(wi, jobs, {
    iterativeActive: isIterativeWorkItemActive(wi),
    hasMergedEvent: wi?.id ? hasMergedHistory(wi.id) : false,
  });
}

const RESPONSE_SHAPE_ALIASES = new Map([
  ["a", "auto"],
  ["auto", "auto"],
  ["r", "repo"],
  ["repo", "repo"],
  ["code", "repo"],
  ["artifact", "artifact"],
  ["artifacts", "artifact"],
  ["f", "artifact"],
  ["file", "artifact"],
  ["files", "artifact"],
  ["q", "question_only"],
  ["question", "question_only"],
  ["question-only", "question_only"],
  ["question_only", "question_only"],
]);

function normalizeResponseShapeChoice(value, fallback = "auto") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return { value: fallback, explicit: false };
  return { value: RESPONSE_SHAPE_ALIASES.get(raw) || raw, explicit: true };
}

async function promptForResponseShapeChoice(defaultOutputMode = "auto") {
  const value = await askSelectorChoice("  Response shape?", [
    { value: "auto", label: "Auto", aliases: ["a"] },
    { value: "repo", label: "Repo", aliases: ["r", "code"] },
    { value: "artifact", label: "Artifact", aliases: ["f", "file", "files"] },
    { value: "question_only", label: "Question", aliases: ["q", "question-only", "question"] },
  ], {
    defaultValue: defaultOutputMode || "auto",
    fallbackAsk: (prompt) => ask(prompt),
  });
  return normalizeResponseShapeChoice(value, defaultOutputMode);
}

function normalizeThinkingBudgetChoice(value, defaultDeepthink = false) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return { deepthink: !!defaultDeepthink, oneshot: false };
  }
  if (["a", "auto", "normal", "n"].includes(raw)) return { deepthink: false, oneshot: false };
  if (["d", "deepthink", "deep", "think", "thinking", "y", "yes"].includes(raw)) {
    return { deepthink: true, oneshot: false };
  }
  if (["o", "oneshot", "one-shot", "one_shot", "1shot"].includes(raw)) {
    return { deepthink: false, oneshot: true };
  }
  return { deepthink: !!defaultDeepthink, oneshot: false };
}

async function promptForThinkingBudgetChoice(defaultDeepthink = false) {
  const value = await askSelectorChoice("  Thinking budget?", [
    { value: "auto", label: "Auto" },
    { value: "deepthink", label: "Deepthink" },
    { value: "oneshot", label: "One-shot" },
  ], {
    defaultValue: "auto",
    fallbackAsk: (prompt) => ask(prompt),
  });
  return normalizeThinkingBudgetChoice(value || "auto", defaultDeepthink);
}

function normalizeSuggestedFilePath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeOneshotFileHintChoice(answer, suggestions) {
  const raw = String(answer || "").trim();
  if (!raw) return "";
  const selected = [];
  for (const part of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
    const index = Number.parseInt(part.replace(/^#/, ""), 10);
    if (Number.isInteger(index) && index >= 1 && index <= suggestions.length) {
      selected.push(suggestions[index - 1].file);
    } else {
      selected.push(part);
    }
  }
  return selected.map(normalizeSuggestedFilePath).filter(Boolean).join(",");
}

async function promptForOneshotFileHint() {
  const answer = await ask(`  One-shot file hint? path/comma list [none]: `);
  return normalizeOneshotFileHintChoice(answer, []);
}

async function promptForIterativeWorkflowMode() {
  const answer = (await ask(`  Iterative workflow mode? [b]ugfix / [d]esign(ux) / [r]efactor / [a]udit / [i]terate [bugfix]: `))
    .trim()
    .toLowerCase();
  const mode = normalizeIterativeWorkflowModeChoice(answer, "bugfix");
  return Object.prototype.hasOwnProperty.call(ITERATIVE_WORKFLOW_PROFILES, mode) ? mode : "bugfix";
}

async function promptForScopedAdd(description, defaultMode = "build", defaultDeepthink = false, workflowMode = null) {
  const baseHints = parseIntakeHintsFromArgv(description, defaultMode);

  if (workflowMode) {
    const profile = getIterativeWorkflowProfile(workflowMode);
    let deepthink = defaultDeepthink || !!profile.deepthink;
    if (!defaultDeepthink && !profile.deepthink) {
      deepthink = (await promptForThinkingBudgetChoice(false)).deepthink;
    }
    return {
      intakeHints: applyIterativeWorkflowProfile(normalizeIntakeHints({
        intent_type: profile.intent_type,
        intent_type_source: "explicit",
        deliverable_type: profile.deliverable_type,
        deliverable_type_source: "explicit",
        output_mode: profile.output_mode,
        output_mode_source: "explicit",
        desired_outputs_source: "explicit",
        suspected_files: baseHints.suspected_files,
        suspected_dirs: baseHints.suspected_dirs,
        subtasks: profile.subtasks,
        constraints: [...profile.constraints, ...(baseHints.constraints || [])],
      }, { requestText: description, fallbackMode: defaultMode }), workflowMode, defaultMode),
      deepthink,
    };
  }

  const defaultOutputMode = baseHints.output_mode || defaultOutputModeForMode(defaultMode);
  const responseShape = await promptForResponseShapeChoice(defaultOutputMode);
  const budgetChoice = await promptForThinkingBudgetChoice(defaultDeepthink);
  let suspectedFiles = baseHints.suspected_files;
  if (budgetChoice.oneshot && (!Array.isArray(suspectedFiles) || suspectedFiles.length === 0)) {
    const fileHint = await promptForOneshotFileHint(description);
    if (fileHint) suspectedFiles = fileHint;
  }
  return {
    intakeHints: normalizeIntakeHints({
      ...baseHints,
      intent_type: budgetChoice.oneshot ? "oneshot" : baseHints.intent_type,
      intent_type_source: budgetChoice.oneshot ? "explicit" : baseHints.intent_type_source,
      output_mode: responseShape.value || defaultOutputMode,
      output_mode_source: responseShape.explicit ? "explicit" : baseHints.output_mode_source,
      desired_outputs: responseShape.explicit ? responseShape.value : baseHints.desired_outputs,
      desired_outputs_source: responseShape.explicit ? "explicit" : baseHints.desired_outputs_source,
      suspected_files: suspectedFiles,
    }, { requestText: description, fallbackMode: defaultMode }),
    deepthink: budgetChoice.deepthink,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: add
// ═════════════════════════════════════════════════════════════════════════════

function promptViaEditor(header) {
  const tmp = path.join(os.tmpdir(), `posse-add-${Date.now()}-${process.pid}.md`);
  const MARK = "#~ ";
  const seed = [
    `${MARK}${header}`,
    MARK.trimEnd(),
    `${MARK}Write below. Lines starting with "${MARK.trim()}" are stripped.`,
    `${MARK}Save and close the editor when finished. Leave empty to cancel.`,
    "",
    "",
  ].join("\n");
  fs.writeFileSync(tmp, seed, "utf8");

  const editorValue = resolveEditorCommand();
  const { cmd, args } = parseEditorCommand(editorValue);
  try {
    let result;
    if (process.platform === "win32") {
      // cmd.exe needs each argument individually quoted. Node's `shell: true`
      // joins array args without quoting, so build the command string ourselves.
      const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
      const full = [q(cmd), ...args.map(q), q(tmp)].join(" ");
      result = spawnSync(full, { stdio: "inherit", shell: true });
    } else {
      result = spawnSync(cmd, [...args, tmp], { stdio: "inherit" });
    }
    if (result.error) {
      console.log(`  ${C.red}Failed to launch editor (${editorValue}): ${result.error.message}${C.reset}`);
      return "";
    }
    const raw = fs.readFileSync(tmp, "utf8");
    return raw
      .split(/\r?\n/)
      .filter((line) => !line.startsWith(MARK) && line.trimEnd() !== MARK.trimEnd())
      .join("\n")
      .trim();
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

async function cmdAdd() {
  const rawArgs = process.argv.slice(3);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    COMMAND_USAGE.add();
    return;
  }

  const descArgs = getCommandPositionalArgs(rawArgs);
  let description = descArgs.join(" ").trim();

  if (!description) {
    if (process.stdin.isTTY) {
      console.log(`\n  ${C.bold}Describe what you want built:${C.reset}  ${C.dim}(opening ${editorCommandLabel(resolveEditorCommand())}…)${C.reset}`);
      description = promptViaEditor("posse add — describe what you want built");
    } else {
      description = await askMultiline(`\n  ${C.bold}Describe what you want built:${C.reset}`);
    }
  }

  if (!description) {
    console.log(`  ${C.dim}Nothing entered.${C.reset}`);
    return;
  }

  // Task priority selection is temporarily hidden from intake UX.
  // Keep a fixed "medium" semantic, mapped to the queue's canonical "normal".
  const priority = "normal";

  // Use first line as title, full text as description
  const title = description.split("\n")[0].slice(0, 100);

  const mode = parseModeFlagFromArgv() || inferWiMode(description) || "build";
  const tier = parseTierFlagFromArgv() || "mvp";
  const parsedResearchBudget = parseResearchBudgetFromArgv();
  const defaultDeepthink = isResearchBudgetDeep(parsedResearchBudget.budget);
  const workflowMode = ITERATE_FLAG ? await promptForIterativeWorkflowMode() : null;
  const workflowRedTeamPlan = workflowMode ? shouldPersistIterativeRedTeamPlan() : false;
  const guidedScope = process.argv.includes("--guided") || (!hasExplicitOneshotIntent(description) && !hasIntakeHintFlags())
    ? await promptForScopedAdd(description, mode, defaultDeepthink, workflowMode)
    : { intakeHints: parseIntakeHintsFromArgv(description, mode), deepthink: defaultDeepthink || !!workflowMode };
  const intakeHints = workflowMode
    ? applyIterativeWorkflowProfile(guidedScope.intakeHints, workflowMode, mode)
    : guidedScope.intakeHints;
  const deepthink = workflowMode ? true : !!guidedScope.deepthink;
  const deepthinkBudget = resolveResearchBudgetForDeepthink(deepthink, parsedResearchBudget);
  const sessionRecycle = parseSessionRecycleFlagFromArgv();
  const iterationProfile = workflowMode ? getIterativeWorkflowProfile(workflowMode) : null;
  const item = createWorkItem(title, description, priority, {
    mode,
    governance_tier: tier,
    session_recycle: sessionRecycle,
    metadata: researchBudgetMetadata({
      research_budget_explicit: parsedResearchBudget.explicit,
      intake_hints: intakeHints,
      workflow_mode: workflowMode,
      iterate: !!workflowMode,
      iteration: workflowMode ? {
        active: true,
        auto_approve: true,
        pass_count: 0,
        max_passes: iterationProfile.max_passes,
        red_team_plan: workflowRedTeamPlan,
        awaiting_research_job_id: null,
        awaiting_plan_job_id: null,
        stop_reason: null,
      } : undefined,
    }, deepthinkBudget),
  });

  // Pre-create artifact directories — available for all modes.
  // The researcher/planner will decide the actual task_mode, but having
  // the dirs ready means they can reference them immediately.
  const dirs = ensureArtifactDirs(wiScopeId(item.id), "content", PROJECT_DIR);

  const tierTag = tier !== "mvp" ? ` ${C.yellow}[${tier}]${C.reset}` : "";
  const modeTag = mode !== "build" ? ` ${C.cyan}[${mode}]${C.reset}` : "";
  const workflowTag = workflowMode ? ` ${C.blue}[iterate:${workflowMode}]${C.reset}` : "";
  const redTeamTag = workflowRedTeamPlan ? ` ${C.magenta}[red-team-plan]${C.reset}` : "";
  const deepthinkTag = isResearchBudgetDeep(deepthinkBudget) ? ` ${C.magenta}[budget:${deepthinkBudget}]${C.reset}` : "";
  const recycleTag = sessionRecycle === "on" ? ` ${C.green}[session-recycle]${C.reset}` : sessionRecycle === "off" ? ` ${C.dim}[no-session-recycle]${C.reset}` : "";
  console.log(`\n  ${C.green}Added WI#${item.id}${C.reset}${modeTag}${tierTag}${workflowTag}${redTeamTag}${deepthinkTag}${recycleTag}`);
  console.log(`  ${C.dim}${title.slice(0, 70)}${description.length > 70 ? "..." : ""}${C.reset}`);
  if (intakeHints.suspected_files.length > 0 || intakeHints.suspected_dirs.length > 0 || intakeHints.subtasks.length > 0) {
    console.log(`  ${C.dim}Hints: intent=${intakeHints.intent_type}, output=${intakeHints.output_mode}, files=${intakeHints.suspected_files.length}, dirs=${intakeHints.suspected_dirs.length}, subtasks=${intakeHints.subtasks.length}${C.reset}`);
  }
  if (dirs.artifactRoot) {
    const relArtifact = path.relative(PROJECT_DIR, dirs.artifactRoot).replace(/\\/g, "/");
    console.log(`  ${C.dim}Artifacts: ${relArtifact}${C.reset}`);
  }

  const queued = listWorkItems("queued");
  console.log(`\n  Queue: ${queued.length} item(s) waiting to be planned`);
  console.log(`  ${C.dim}Run 'plan' to research & create jobs, or 'add' more items first${C.reset}\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: inject
// ═════════════════════════════════════════════════════════════════════════════

async function cmdInject() {
  const descArgs = getCommandPositionalArgs(process.argv.slice(3));
  const description = descArgs.join(" ").trim();

  if (!description) {
    console.log(`\n  Usage: inject "description of what you want added"`);
    console.log(`  ${C.dim}Creates a work item with research+plan jobs (works mid-run too).${C.reset}\n`);
    process.exitCode = 2;
    return;
  }

  const title = description.split("\n")[0].slice(0, 100);
  const mode = parseModeFlagFromArgv() || inferWiMode(description) || "build";
  const workflowMode = ITERATE_FLAG ? await promptForIterativeWorkflowMode() : null;
  const workflowRedTeamPlan = workflowMode ? shouldPersistIterativeRedTeamPlan() : false;
  const intakeHintsBase = parseIntakeHintsFromArgv(description, mode);
  const intakeHints = workflowMode
    ? applyIterativeWorkflowProfile(intakeHintsBase, workflowMode, mode)
    : intakeHintsBase;
  const parsedResearchBudget = parseResearchBudgetFromArgv();
  const deepthinkBudget = workflowMode
    ? maxResearchBudget(parsedResearchBudget.budget, "high")
    : parsedResearchBudget.budget;
  const sessionRecycle = parseSessionRecycleFlagFromArgv();
  const iterationProfile = workflowMode ? getIterativeWorkflowProfile(workflowMode) : null;
  const item = createWorkItem(title, description, "normal", {
    source: "inject",
    mode,
    session_recycle: sessionRecycle,
    metadata: researchBudgetMetadata({
      research_budget_explicit: parsedResearchBudget.explicit,
      intake_hints: intakeHints,
      workflow_mode: workflowMode,
      iterate: !!workflowMode,
      iteration: workflowMode ? {
        active: true,
        auto_approve: true,
        pass_count: 0,
        max_passes: iterationProfile.max_passes,
        red_team_plan: workflowRedTeamPlan,
        awaiting_research_job_id: null,
        awaiting_plan_job_id: null,
        stop_reason: null,
      } : undefined,
    }, deepthinkBudget),
  });
  updateWorkItemStatus(item.id, "planning");
  const initialJob = createInitialResearchOrPlanJob(item, {
    deepthinkBudget,
    deepthinkBudgetExplicit: parsedResearchBudget.explicit,
    source: "inject",
    redTeamPlan: shouldUseRedTeamPlanForWorkItem(item),
    routing: classifyResearchForRouting({ workItem: item, intakeHints, mode, source: "inject", live: true }),
  });

  const workflowTag = workflowMode ? ` ${C.blue}[iterate:${workflowMode}]${C.reset}` : "";
  const redTeamTag = shouldUseRedTeamPlanForWorkItem(item) ? ` ${C.magenta}[red-team-plan]${C.reset}` : "";
  const recycleTag = sessionRecycle === "on" ? ` ${C.green}[session-recycle]${C.reset}` : sessionRecycle === "off" ? ` ${C.dim}[no-session-recycle]${C.reset}` : "";
  console.log(`\n  ${C.green}Injected WI#${item.id}${C.reset}${workflowTag}${redTeamTag}${recycleTag} — ${title.slice(0, 50)}`);
  if (initialJob.kind === "plan") {
    console.log(`  ${C.dim}Skipped research; created plan job #${initialJob.job.id}. The scheduler will pick this up automatically.${C.reset}\n`);
  } else if (initialJob.kind === "preflight") {
    console.log(`  ${C.dim}Created preflight job #${initialJob.job.id}. The scheduler will route research automatically.${C.reset}\n`);
  } else if (initialJob.kind === "dev") {
    console.log(`  ${C.dim}Created one-shot dev job #${initialJob.job.id}. The scheduler will pick this up automatically.${C.reset}\n`);
  } else {
    console.log(`  ${C.dim}Created research job #${initialJob.job.id}. The scheduler will pick this up automatically.${C.reset}\n`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: ask — Research-only question (no dev tasks)
// ═════════════════════════════════════════════════════════════════════════════

function cmdAsk() {
  const descArgs = getCommandPositionalArgs(process.argv.slice(3));
  const question = descArgs.join(" ").trim();

  if (!question) {
    console.log(`\n  Usage: ask "your question about the codebase"`);
    console.log(`  ${C.dim}Creates a research-only work item (no dev tasks).${C.reset}\n`);
    process.exitCode = 2;
    return;
  }

  const title = question.split("\n")[0].slice(0, 100);
  const parsedResearchBudget = parseResearchBudgetFromArgv();
  const deepthinkBudget = parsedResearchBudget.budget;
  const inputSelection = parseFlagValue("--input-contexts") || parseFlagValue("--contexts");
  const mergedDirs = mergeSuspectedDirsWithInputContexts(
    parseFlagValue("--dirs"),
    inputSelection,
    PROJECT_DIR,
  );
  const intakeHints = normalizeIntakeHints({
    intent_type: "question",
    intent_type_source: "explicit",
    deliverable_type: "answer",
    deliverable_type_source: "explicit",
    output_mode: "question_only",
    output_mode_source: "explicit",
    desired_outputs_source: "explicit",
    suspected_files: parseFlagValue("--files"),
    suspected_dirs: mergedDirs.merged,
    subtasks: parseFlagValue("--subtasks"),
    constraints: parseFlagValue("--constraints"),
  }, { requestText: question, fallbackMode: "build" });
  const item = createWorkItem(title, question, "normal", {
    source: "ask",
    metadata: researchBudgetMetadata({
      mode: "question",
      intake_hints: intakeHints,
      research_budget_explicit: parsedResearchBudget.explicit,
    }, deepthinkBudget),
  });
  updateWorkItemStatus(item.id, "planning");
  const routing = classifyResearchForRouting({ workItem: item, intakeHints, mode: "question", source: "ask", live: true });
  const initialJob = createInitialResearchOrPlanJob(item, {
    deepthinkBudget,
    deepthinkBudgetExplicit: parsedResearchBudget.explicit,
    source: "ask",
    routing,
  });
  const jobLabel = initialJob.kind === "research_fanout" ? "fanout synthesis" : initialJob.kind;

  console.log(`\n  ${C.cyan}Ask WI#${item.id}${C.reset} — ${jobLabel} job #${initialJob.job.id}`);
  console.log(`  ${C.dim}The scheduler will research this automatically.${C.reset}\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: image — Direct image generation (skips research/plan pipeline)
// ═════════════════════════════════════════════════════════════════════════════

async function cmdImage() {
  const descArgs = getCommandPositionalArgs(process.argv.slice(3));
  const prompt = descArgs.join(" ").trim();

  if (!prompt) {
    console.log(`\n  Usage: image "description of the image to generate"`);
    console.log(`  ${C.dim}Generates an image directly — no research or planning step.${C.reset}\n`);
    process.exitCode = 2;
    return;
  }

  // Read protocol for provider routing; check readiness before creating the
  // work item so an unready provider does not leave a stale queued WI behind.
  const imageRoute = resolveImageExecutionProvider({ needs_image_generation: true });
  if (!imageRoute.readiness.ready) {
    console.log(`\n  ${C.red}${NO_IMAGE_PROVIDERS_AVAILABLE}${C.reset}\n`);
    process.exitCode = 1;
    return;
  }
  const provider = imageRoute.provider;

  const title = prompt.split("\n")[0].slice(0, 100);
  const item = createWorkItem(title, prompt, "normal", { source: "image", mode: "image" });

  // Pre-create artifact directories
  const dirs = ensureArtifactDirs(wiScopeId(item.id), "image", PROJECT_DIR);
  const outputRoot = artifactsDir(wiScopeId(item.id), PROJECT_DIR).replace(/\\/g, "/");

  updateWorkItemStatus(item.id, "running");

  // Emit a single artificer job — no research, no plan
  const imageJob = createJob({
    work_item_id: item.id,
    job_type: "artificer",
    title: `Generate: ${title.slice(0, 70)}`,
    priority: "normal",
    model_tier: "standard",
    reasoning_effort: "medium",
    provider,
    payload_json: JSON.stringify({
      task_spec: [
        `Generate an image based on this description:`,
        ``,
        prompt,
        ``,
        `Use the generate_image tool to create the image.`,
        `Save it to: image.png (your working directory is the output folder).`,
        `Use quality "high" for best results.`,
        ``,
        `Example tool call:`,
        `  generate_image({ "prompt": "a beautiful mermaid in the ocean", "path": "image.png", "quality": "high", "size": "1024x1024" })`,
      ].join("\n"),
      task_mode: "image",
      needs_image_generation: true,
      output_root: outputRoot,
      create_roots: [outputRoot],
      files_to_modify: [],
      files_to_create: [],
      success_criteria: ["Image file exists in output directory", "Image is a valid PNG/JPG/WebP"],
    }),
  });

  console.log(`\n  ${C.magenta}Image WI#${item.id}${C.reset} — job #${imageJob.id}`);
  console.log(`  ${C.dim}Prompt: ${prompt.slice(0, 70)}${prompt.length > 70 ? "..." : ""}${C.reset}`);
  console.log(`  ${C.dim}Output: ${path.relative(PROJECT_DIR, dirs.artifactRoot).replace(/\\/g, "/")}${C.reset}`);
  console.log(`  ${C.dim}The scheduler will run the artificer job through the configured role provider; generate_image will use ${provider} at tool-call time.${C.reset}\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: queue
// ═════════════════════════════════════════════════════════════════════════════

function cmdQueue() {
  const all = listWorkItems();

  if (all.length === 0) {
    console.log(`\n  Queue is empty. Use 'add' to add work items.\n`);
    return;
  }

  const byStatus = {};
  for (const wi of all) {
    if (!byStatus[wi.status]) byStatus[wi.status] = [];
    byStatus[wi.status].push(wi);
  }

  console.log(`\n  ${C.bold}Work Items${C.reset}\n`);

  const statusOrder = ["queued", "planning", "planned", "running", "blocked", "waiting_on_human", "waiting_on_review", "complete", "failed", "canceled"];

  for (const status of statusOrder) {
    const items = byStatus[status];
    if (!items || items.length === 0) continue;

    console.log(`  ${statusColor(status, C)}${C.bold}${status.toUpperCase()} (${items.length}):${C.reset}`);
    for (const wi of items) {
      const jobStats = getWorkItemJobStats(wi.id);
      const totalJobs = jobStats.reduce((s, r) => s + r.count, 0);
      const succeeded = jobStats.filter((r) => r.status === "succeeded").reduce((s, r) => s + r.count, 0);
      const prio = wi.priority === "high" ? ` ${C.red}HIGH${C.reset}` :
                   wi.priority === "urgent" ? ` ${C.red}${C.bold}URGENT${C.reset}` :
                   wi.priority === "low" ? ` ${C.dim}low${C.reset}` : "";
      console.log(`    ${C.bold}[WI#${wi.id}]${C.reset} ${wi.title.slice(0, 55)}${prio} ${C.dim}(${succeeded}/${totalJobs} jobs)${C.reset}`);
    }
    console.log();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: plan — Create research + plan jobs for queued work items
// ═════════════════════════════════════════════════════════════════════════════

function _parseWiArg(raw) {
  if (!raw) return null;
  const n = Number.parseInt(String(raw).replace(/^wi[:#-]?/i, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function _extractFlag(args, name, hasValue = false) {
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i] || "");
    if (arg === name) return hasValue ? (args[i + 1] || null) : true;
    if (hasValue && arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return hasValue ? null : false;
}

function cmdPlanReview(wiId) {
  const wi = getWorkItem(wiId);
  if (!wi) { console.log(`\n  ${C.red}No WI#${wiId}${C.reset}\n`); process.exitCode = 2; return; }
  const gate = findPendingGate(wiId);
  console.log(`\n  ${C.bold}Plan review for WI#${wi.id}${C.reset}  ${wi.title}`);
  console.log(`  ${C.dim}Status:${C.reset} ${wi.status}  ${C.dim}Approval:${C.reset} ${wi.plan_approval_state || "not_required"}`);
  if (wi.plan_rejection_feedback) {
    console.log(`  ${C.dim}Prior rejection feedback:${C.reset} ${wi.plan_rejection_feedback}`);
  }
  const jobs = listJobsByWorkItem(wiId);
  console.log(`\n  ${C.bold}Planned jobs (${jobs.length})${C.reset}`);
  for (const job of jobs) {
    const blocked = gate && getDependencies(job.id).some((d) => d.depends_on_job_id === gate.id);
    const marker = blocked ? `${C.yellow}gated${C.reset}` : C.dim + job.status + C.reset;
    console.log(`  ${C.cyan}#${String(job.id).padEnd(4)}${C.reset} ${job.job_type.padEnd(10)} ${marker.padEnd(18)} ${String(job.title).slice(0, 80)}`);
  }
  if (gate) {
    console.log(`\n  ${C.yellow}Gate job${C.reset}: #${gate.id} (${gate.status})`);
    console.log(`  Approve:  ${C.cyan}posse plan approve ${wi.id}${C.reset}`);
    console.log(`  Reject:   ${C.cyan}posse plan reject ${wi.id} [--feedback "…"] [--replan]${C.reset}`);
  } else if ((wi.plan_approval_state || "not_required") === "pending") {
    console.log(`\n  ${C.yellow}Warning:${C.reset} WI flagged pending but no gate job found.`);
  } else {
    console.log(`\n  ${C.dim}No pending gate.${C.reset}`);
  }
  console.log();
}

function cmdPlanApprove(wiId) {
  const result = approvePlan(wiId, { actor: "operator" });
  if (!result.ok) {
    console.log(`\n  ${C.red}Approve failed:${C.reset} ${result.reason}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n  ${C.green}Plan approved${C.reset} — gate job #${result.gateJobId} succeeded; downstream jobs unblocked.\n`);
}

function cmdPlanReject(wiId, rest) {
  const feedback = _extractFlag(rest, "--feedback", true);
  const shouldReplan = !!_extractFlag(rest, "--replan");
  const result = rejectPlan(wiId, { feedback, actor: "operator" });
  if (!result.ok) {
    console.log(`\n  ${C.red}Reject failed:${C.reset} ${result.reason}\n`);
    process.exitCode = 1;
    return;
  }
  const rejectedArtifactNote = result.rejectedArtifactIds?.length
    ? `; ${result.rejectedArtifactIds.length} artifact(s) marked rejected`
    : "";
  console.log(`\n  ${C.yellow}Plan rejected${C.reset} — gate job #${result.gateJobId} canceled; ${result.canceledCount} downstream job(s) canceled${rejectedArtifactNote}.`);
  if (shouldReplan) {
    const r = respawnAfterRejection(wiId, { feedback, rejectedArtifactIds: result.rejectedArtifactIds });
    if (r.ok) {
      updateWorkItemStatus(wiId, "planning");
      console.log(`  ${C.cyan}Replan queued:${C.reset} research job #${r.researchJobId} spawned${feedback ? " with prior feedback attached" : ""}.`);
    } else {
      console.log(`  ${C.red}Replan failed:${C.reset} ${r.reason}`);
      process.exitCode = 1;
    }
  } else {
    console.log(`  ${C.dim}Re-run with${C.reset} ${C.cyan}posse plan reject ${wiId} --replan${C.reset} ${C.dim}to spawn a fresh plan.${C.reset}`);
  }
  console.log();
}

async function cmdPlan() {
  // Subcommand dispatch: `posse plan review|approve|reject <wi-id> [flags]`.
  // Otherwise, default behavior — queue research jobs for any queued WIs.
  const sub = String(process.argv[3] || "").trim().toLowerCase();
  if (["review", "approve", "reject"].includes(sub)) {
    const wiId = _parseWiArg(process.argv[4]);
    if (!wiId) {
      console.log(`\n  Usage: posse plan ${sub} <wi-id>${sub === "reject" ? " [--feedback \"…\"] [--replan]" : ""}\n`);
      process.exitCode = 2;
      return;
    }
    if (sub === "review")  return cmdPlanReview(wiId);
    if (sub === "approve") return cmdPlanApprove(wiId);
    if (sub === "reject")  return cmdPlanReject(wiId, process.argv.slice(5));
  }

  const queued = listWorkItems("queued");

  if (queued.length === 0) {
    console.log(`\n  No items in queue. Use 'add' first.\n`);
    return;
  }

  console.log(`\n  ${C.bold}Planning ${queued.length} work item(s):${C.reset}`);
  for (const wi of queued) {
    console.log(`    ${C.bold}[WI#${wi.id}]${C.reset} ${wi.title.slice(0, 60)}`);
  }
  console.log();

  // Create research jobs — the researcher spawns the plan job when it finishes
  for (const wi of queued) {
    const effectiveWi = persistIterativeRedTeamPlanIfRequested(wi);
    updateWorkItemStatus(effectiveWi.id, "planning");
    const deepthinkBudget = getResearchBudget(effectiveWi);
    const metadata = parseWorkItemMetadata(effectiveWi);
    const initialJob = createInitialResearchOrPlanJob(effectiveWi, {
      deepthinkBudget,
      deepthinkBudgetExplicit: metadata.research_budget_explicit === true,
      source: "plan",
      redTeamPlan: shouldUseRedTeamPlanForWorkItem(effectiveWi),
      routing: classifyResearchForRouting({ workItem: effectiveWi, source: "plan", live: true }),
    });

    console.log(`  ${C.cyan}WI#${effectiveWi.id}:${C.reset} ${initialJob.kind} job #${initialJob.job.id}`);
  }

  console.log(`\n  ${C.dim}Jobs queued. Run 'run' to start execution, or 'go' next time for one-shot.${C.reset}\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SESSION DEPS — build the bundle that session-factories.js consumes
// ═════════════════════════════════════════════════════════════════════════════

function sessionBootDeps() {
  return {
    projectDir: PROJECT_DIR,
    NO_TUI,
    nonInteractive: NON_INTERACTIVE,
    AUTO_APPROVE,
    DRY_RUN,
    RUN_WORK_ITEM_IDS: parseWorkItemIdsFlagFromArgv(),
    ask,
    log,
    cmdDashboard,
    getResolvedImageProtocol,
    getConcurrency,
    getStallTimeout,
    getAutoMergeConfig,
    maybeAnnounceAutoMergeSetting,
    ensureRepoSetupConfirmed,
    ensureGitReady,
    getTargetBranch,
    isReviewableWorkItem,
    classifyResearchForRouting,
    createInitialResearchOrPlanJob,
    shouldUseRedTeamPlanForWorkItem,
    processIterativeWrapUp,
    loadDisplayModule,
    loadSchedulerModule,
    loadWorkerModule,
    loadProviderModule,
    loadRunSessionModule,
    loadReviewSessionModule,
    loadAtlasModule,
    getGitWorkflowHelpers,
  };
}

async function createReviewSessionDeps() {
  return createReviewSessionDepsImpl(sessionBootDeps());
}

async function createReviewSession() {
  return createReviewSessionImpl(sessionBootDeps());
}

async function createRunSessionDeps() {
  return createRunSessionDepsImpl(sessionBootDeps());
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: run — Start the scheduler + worker loop
// ═════════════════════════════════════════════════════════════════════════════


let coldIndexClearedForCliProcess = false;

function clearColdIndexFromCliFlagOnce() {
  if (!hasArgFlag("--cold-index")) return null;
  if (coldIndexClearedForCliProcess) return null;
  const result = clearColdIndex();
  coldIndexClearedForCliProcess = true;
  return result;
}

async function cmdRun() {
  clearColdIndexFromCliFlagOnce();
  const readiness = createStartupReadiness({ enabled: !!process.stdout?.isTTY });
  let sessionDeps;
  try {
    sessionDeps = await readiness.step("Run modules", () => createRunSessionDeps());
  } finally {
    readiness.finish();
  }
  const { RunSession, ...deps } = sessionDeps;
  return new RunSession(deps).run();
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: go — plan + run in one shot
// ═════════════════════════════════════════════════════════════════════════════

async function cmdGo() {
  clearColdIndexFromCliFlagOnce();
  const queued = listWorkItems("queued");
  const activeJobs = listJobs(["queued", ...ACTIVE_LEASE_STATUSES]);

  if (queued.length === 0 && activeJobs.length === 0) {
    const iterateResult = await processIterativeWrapUp({ reason: "go start" });
    if (iterateResult.rerun) {
      await cmdRun();
      return;
    }
    if (refuseIfSchedulerLive("go")) return;
    const helpers = await getGitWorkflowHelpers();
    const mergeOutcome = await withMergeLock(() => helpers.autoMergeCompletedWorkItems({ reason: "go start" }));
    if (!mergeOutcome.acquired) {
      console.log(`\n  ${C.red}go refused:${C.reset} another merge is already in progress; retry when it finishes.\n`);
      process.exitCode = 1;
      return;
    }
    const autoMergedNow = mergeOutcome.result;
    // Nothing to plan/run — but if there are reviewable work items, go to review
    const reviewable = listWorkItems(["complete", "failed"]).filter(isReviewableWorkItem);
    if (reviewable.length > 0) {
      console.log(`\n  ${C.bold}No active jobs — ${reviewable.length} work item(s) ready for review.${C.reset}\n`);
      await cmdReview();
      return;
    }
    if (autoMergedNow > 0) {
      await helpers.offerPush(autoMergedNow);
      return;
    }
    console.log(`\n  Nothing to do. Use 'add' to queue work items.\n`);
    return;
  }

  // If queued items exist, create research+plan jobs
  if (queued.length > 0) {
    console.log(`\n${C.bold}  Pipeline — ${queued.length} work item(s)${C.reset}\n`);
    for (const wi of queued) {
      console.log(`    ${C.bold}[WI#${wi.id}]${C.reset} ${wi.title.slice(0, 60)}`);
    }

    for (const wi of queued) {
      const effectiveWi = persistIterativeRedTeamPlanIfRequested(wi);
      updateWorkItemStatus(effectiveWi.id, "planning");
      const deepthinkBudget = getResearchBudget(effectiveWi);
      const metadata = parseWorkItemMetadata(effectiveWi);
      createInitialResearchOrPlanJob(effectiveWi, {
        deepthinkBudget,
        deepthinkBudgetExplicit: metadata.research_budget_explicit === true,
        source: "go",
        redTeamPlan: shouldUseRedTeamPlanForWorkItem(effectiveWi),
        routing: classifyResearchForRouting({ workItem: effectiveWi, source: "go", live: true }),
      });
    }
  }

  // Now run everything
  await cmdRun();
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: status
// ═════════════════════════════════════════════════════════════════════════════

async function cmdStatus() {
  return (await getStatusCommands()).status(process.argv.slice(3));
}

async function cmdHealth() {
  return (await getStatusCommands()).health();
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: dashboard
// ═════════════════════════════════════════════════════════════════════════════

function cmdDashboard(highlightJobId = null) {
  const workItems = listWorkItems();
  const allJobs = listJobs();

  if (allJobs.length === 0) {
    console.log(`\n  ${C.dim}No jobs. Use 'plan' or 'go' to create jobs.${C.reset}\n`);
    return;
  }

  const { total, failed, resolved, fraction } = computeJobProgressStats(allJobs);
  const blocked = allJobs.filter((j) => j.status === "blocked").length;

  // Progress bar
  const barWidth = 40;
  const filled = Math.round(fraction * barWidth);
  const bar = `${"#".repeat(filled)}${".".repeat(barWidth - filled)}`;

  console.log(`\n${C.dim}+${"---".repeat(21)}+${C.reset}`);
  console.log(`${C.dim}|${C.reset} ${C.bold}Progress${C.reset}  ${C.green}${bar}${C.reset}  ${resolved}/${total} ${C.dim}(${failed} failed, ${blocked} blocked)${C.reset}`);
  console.log(`${C.dim}+${"---".repeat(21)}+${C.reset}`);

  // Group jobs by work item
  const byWi = {};
  for (const j of allJobs) {
    const key = j.work_item_id;
    if (!byWi[key]) byWi[key] = [];
    byWi[key].push(j);
  }

  for (const [wiId, jobs] of Object.entries(byWi)) {
    const wi = workItems.find((w) => w.id === parseInt(wiId));
    const wiLabel = wi ? wi.title.slice(0, 45) : `WI#${wiId}`;
    const wiProgress = computeJobProgressStats(jobs);
    console.log(`${C.dim}|${C.reset} ${C.blue}${C.bold}WI#${wiId}${C.reset} ${wiLabel} ${C.dim}(${wiProgress.resolved}/${jobs.length})${C.reset}`);

    for (const j of jobs) {
      const isActive = j.id === highlightJobId;
      const icon = statusIcon(j.status, { kind: "job", colors: C });
      const tier = ` ${modelTierColor(j.model_tier, C)}[${tierModelName(j.model_tier, { jobType: j.job_type })}]${C.reset}`;
      const arrow = isActive ? ` ${C.yellow}${C.bold}<< ACTIVE${C.reset}` : "";
      console.log(`${C.dim}|${C.reset}   ${icon} #${j.id}${C.reset} ${j.job_type}: ${jobLabel(j.job_type, j.title).slice(0, 40)}${tier}${arrow}`);
    }
  }

  console.log(`${C.dim}+${"---".repeat(21)}+${C.reset}\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: review
// ═════════════════════════════════════════════════════════════════════════════

async function cmdReview() {
  if (refuseIfSchedulerLive("review")) return;
  return (await createReviewSession()).cmdReview();
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: events
// ═════════════════════════════════════════════════════════════════════════════

async function cmdTimeline() {
  const { runTimelineCommand } = await loadReportCommandsModule();
  return runTimelineCommand(process.argv.slice(3));
}

async function cmdCost() {
  const { runCostCommand } = await loadReportCommandsModule();
  return runCostCommand(process.argv.slice(3));
}

async function cmdFanout() {
  const { runFanoutCommand } = await loadReportCommandsModule();
  return runFanoutCommand(process.argv.slice(3));
}

async function cmdSessions() {
  const { runSessionsCommand } = await loadReportCommandsModule();
  return runSessionsCommand(process.argv.slice(3));
}

function cmdEvents() {
  const args = process.argv.slice(3);
  const sessionOnly = args.includes("--session");
  const jobArg = args.find((arg) => !String(arg).startsWith("--"));
  let jobId = null;
  if (jobArg != null) {
    const normalizedJobArg = String(jobArg).trim();
    if (!/^\d+$/.test(normalizedJobArg)) {
      console.error(`events expects an optional numeric job id, got: ${jobArg}`);
      process.exitCode = 2;
      return;
    }
    jobId = Number.parseInt(normalizedJobArg, 10);
  }
  let events = jobId ? getEvents(jobId, 50) : getEvents(null, 50);
  if (sessionOnly) {
    events = events.filter((ev) => String(ev.event_type || "").startsWith("session_"));
  }

  if (events.length === 0) {
    console.log(`\n  No${sessionOnly ? " session" : ""} events${jobId ? ` for job #${jobId}` : ""}.\n`);
    return;
  }

  console.log(`\n  ${C.bold}${sessionOnly ? "Session Event Log" : "Event Log"}${C.reset} ${jobId ? `(job #${jobId})` : "(recent)"}\n`);

  // Reverse to show oldest first
  for (const ev of events.reverse()) {
    const time = ev.created_at.split("T")[1]?.slice(0, 8) || "";
    const jobRef = ev.job_id ? `#${ev.job_id}` : "";
    const wiRef = ev.work_item_id ? `WI#${ev.work_item_id}` : "";
    const ref = [wiRef, jobRef].filter(Boolean).join("/");
    console.log(`  ${C.dim}${time}${C.reset} ${C.cyan}${ev.event_type}${C.reset} ${ref ? `${C.dim}${ref}${C.reset} ` : ""}${ev.message || ""}`);
  }
  console.log();
}

async function cmdAudit() {
  const { runAuditCommand } = await loadAuditCommandModule();
  return runAuditCommand(process.argv.slice(3), {
    projectDir: PROJECT_DIR,
    targetBranch: getAdminTargetBranch(),
  });
}

async function cmdClear() {
  return (await getMaintenanceCommands()).clear();
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: merge — Merge a completed WI branch into target branch
// ═════════════════════════════════════════════════════════════════════════════

function refuseIfSchedulerLive(commandName) {
  const message = getLiveSchedulerBlockMessage("main");
  if (!message) return false;
  console.log(`\n  ${C.red}${commandName} refused:${C.reset} ${message}\n`);
  process.exitCode = 1;
  return true;
}

async function cmdMerge() {
  const rawWiArg = String(process.argv[3] || "").trim();
  const targetBranch = getAdminTargetBranch();
  const helpers = await getAdminGitWorkflowHelpers();

  if (!rawWiArg) {
    // Show all mergeable work items
    const mergeable = listWorkItems(["complete"]).filter(wi => wi.branch_name);
    if (mergeable.length === 0) {
      console.log(`\n  No completed work items with branches to merge.\n`);
      return;
    }

    console.log(`\n  ${C.bold}Mergeable Work Items:${C.reset}\n`);
    for (const wi of mergeable) {
      const jobs = listJobsByWorkItem(wi.id);
      const succeeded = jobs.filter(j => j.status === "succeeded").length;
      console.log(`  ${C.green}\u2713${C.reset} ${C.bold}WI#${wi.id}${C.reset} ${wi.title.slice(0, 50)}`);
      console.log(`    ${C.dim}Branch: ${wi.branch_name}  Jobs: ${succeeded}/${jobs.length}${C.reset}`);
    }
    console.log(`\n  ${C.dim}Usage: merge <wi_id>${C.reset}\n`);
    return;
  }

  if (!/^(?:wi[:#-]?)?\d+$/i.test(rawWiArg)) {
    console.log(`\n  ${C.red}Invalid work item id:${C.reset} ${rawWiArg}\n  ${C.dim}Usage: merge <wi_id>${C.reset}\n`);
    process.exitCode = 2;
    return;
  }

  if (refuseIfSchedulerLive("merge")) return;

  const wiIdArg = Number.parseInt(rawWiArg.replace(/^wi[:#-]?/i, ""), 10);
  const wi = getWorkItem(wiIdArg);
  if (!wi) {
    console.log(`\n  ${C.red}Work item #${wiIdArg} not found.${C.reset}\n`);
    process.exitCode = 2;
    return;
  }
  if (wi.merge_state === "merged") {
    console.log(`\n  ${C.yellow}WI#${wiIdArg} is already marked merged.${C.reset}\n`);
    process.exitCode = 1;
    return;
  }
  if (!wi.branch_name) {
    console.log(`\n  ${C.yellow}WI#${wiIdArg} has no branch to merge.${C.reset}\n`);
    process.exitCode = 2;
    return;
  }
  if (wi.status !== "complete") {
    console.log(`\n  ${C.yellow}WI#${wiIdArg} is ${wi.status}; only complete work items can be merged.${C.reset}`);
    console.log(`  ${C.dim}Run review/status first, or let the scheduler finish the work item.${C.reset}\n`);
    process.exitCode = 1;
    return;
  }

  // Show diff stats before merging
  if (wi.merge_base_hash) {
    // `merge` is an operator/admin command (Bossy calls this path directly),
    // not an agent dispatch. Keep it on the direct Git workflow so MCP/native
    // daemon heartbeat readiness cannot block approval or merge execution.
    const diffLines = helpers.gitDiffStat(wi.merge_base_hash, wi.branch_name, PROJECT_DIR);
    if (diffLines.length > 0) {
      console.log(`\n  ${C.bold}Changes in ${wi.branch_name}:${C.reset}`);
      for (const line of diffLines) {
        console.log(`    ${line}`);
      }
    }
  }

  const confirm = await ask(`\n  Merge ${C.cyan}${wi.branch_name}${C.reset} into ${C.cyan}${targetBranch}${C.reset}? (y/n): `);
  if (confirm.toLowerCase() !== "y") {
    console.log(`  ${C.dim}Canceled.${C.reset}\n`);
    return;
  }

  const mergeOutcome = await withMergeLock(() => helpers.gitMergeToTarget(wi.branch_name, PROJECT_DIR, { wiId: wi.id }));
  if (!mergeOutcome.acquired) {
    console.log(`\n  ${C.red}merge refused:${C.reset} another merge is already in progress; retry when it finishes.\n`);
    process.exitCode = 1;
    return;
  }
  const result = mergeOutcome.result;
  if (result.ok) {
    // Record the merge
    const mergeHash = result.mergeHash || "(unknown)";
    logEvent({
      work_item_id: wi.id,
      event_type: EVENT_TYPES.WORK_ITEM_MERGED,
      actor_type: EVENT_ACTORS.HUMAN,
      message: `Merged ${wi.branch_name} into ${targetBranch} at ${mergeHash}`,
      event_json: JSON.stringify({ branch: wi.branch_name, merge_hash: mergeHash, target_branch: targetBranch }),
    });

    setMergeState(wi.id, "merged");

    // Clean up worktree + branch
    const cleanupOk = helpers.cleanupWiBranch(wi);

    console.log(`\n  ${C.green}\u2713 ${result.message}${C.reset} (${mergeHash.slice(0, 8)})`);
    console.log(cleanupOk
      ? `  ${C.dim}Branch and worktree cleaned up.${C.reset}\n`
      : `  ${C.yellow}Branch cleanup failed; branch metadata was kept for retry.${C.reset}\n`);
  } else if (result.deferred) {
    console.log(`\n  ${C.yellow}! ${result.message}${C.reset}`);
    console.log(`  ${C.dim}Merge the upstream work item first, then retry this merge.${C.reset}\n`);
  } else {
    setMergeState(wi.id, "merge_failed");
    console.log(`\n  ${C.red}\u2717 ${result.message}${C.reset}`);
    console.log(`  ${C.dim}Resolve conflicts manually, then run: git merge --continue${C.reset}\n`);
    process.exitCode = 1;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: prune — Clean up orphaned worktrees
// ═════════════════════════════════════════════════════════════════════════════

async function cmdPrune() {
  return (await getMaintenanceCommands()).prune(process.argv);
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: purge — Delete all unmerged posse branches + worktrees, reset DB
// ═════════════════════════════════════════════════════════════════════════════

async function cmdPurge() {
  return (await getMaintenanceCommands()).purge();
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: cleanup — Triage leftover posse artifacts
// ═════════════════════════════════════════════════════════════════════════════

async function cmdCleanup() {
  return (await getMaintenanceCommands()).cleanup(process.argv);
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: calls — Agent call performance stats
// ═════════════════════════════════════════════════════════════════════════════

async function cmdCalls() {
  const { cmdCalls: cmdCallsImpl } = await loadDiagnosticCommandsModule();
  return cmdCallsImpl({ tierModelName });
}

async function cmdPrompts() {
  const { cmdPrompts: cmdPromptsImpl } = await loadDiagnosticCommandsModule();
  return cmdPromptsImpl();
}

async function cmdReplay() {
  const { cmdReplay: cmdReplayImpl } = await loadDiagnosticCommandsModule();
  return cmdReplayImpl();
}

async function cmdUsage() {
  const { cmdUsage: cmdUsageImpl } = await loadDiagnosticCommandsModule();
  return cmdUsageImpl({ projectDir: PROJECT_DIR, loadProviderModule });
}

async function cmdAtlasSmoke() {
  const { cmdAtlasSmoke: cmdAtlasSmokeImpl } = await loadDiagnosticCommandsModule();
  return cmdAtlasSmokeImpl({ projectDir: PROJECT_DIR });
}

async function cmdAtlas() {
  const { cmdAtlas: cmdAtlasImpl } = await loadDiagnosticCommandsModule();
  return cmdAtlasImpl({ projectDir: PROJECT_DIR });
}

async function cmdAtlasV2() {
  const { cmdAtlasV2: cmdAtlasV2Impl } = await loadDiagnosticCommandsModule();
  return cmdAtlasV2Impl({ projectDir: PROJECT_DIR });
}

async function cmdCodexModels() {
  const { cmdCodexModels: cmdCodexModelsImpl } = await loadDiagnosticCommandsModule();
  return cmdCodexModelsImpl({ projectDir: PROJECT_DIR });
}

async function cmdLocalModels() {
  const { runLocalModelsCommand } = await loadLocalModelsCommandModule();
  return runLocalModelsCommand(process.argv.slice(3), { nonInteractive: NON_INTERACTIVE });
}

async function cmdMcpStatus() {
  const { cmdMcpStatus: cmdMcpStatusImpl } = await loadDiagnosticCommandsModule();
  return cmdMcpStatusImpl({ projectDir: PROJECT_DIR, loadAtlasModule });
}

async function cmdWindowsEvents() {
  const { cmdWindowsEvents: cmdWindowsEventsImpl } = await loadDiagnosticCommandsModule();
  return cmdWindowsEventsImpl();
}

async function cmdAdminWorktrees() {
  const { cmdAdminWorktrees: cmdAdminWorktreesImpl } = await loadAdminWorktreesModule();
  return cmdAdminWorktreesImpl(PROJECT_DIR);
}

async function cmdDoctor() {
  const { cmdDoctor: cmdDoctorImpl } = await loadDoctorCommandModule();
  return cmdDoctorImpl({ projectDir: PROJECT_DIR });
}

async function cmdUpdate() {
  const { cmdUpdate: cmdUpdateImpl } = await loadUpdateCommandModule();
  return cmdUpdateImpl({ projectDir: PROJECT_DIR });
}

async function maybeWarnPosseUpdateAvailable(commandPolicy) {
  const commandName = commandPolicy?.name || "";
  if (!commandPolicy?.known || ["help", "run", "go", "update"].includes(commandName) || process.argv.includes("--json")) return;
  try {
    const {
      checkPosseUpdateAvailabilityCached,
      formatPosseUpdateAvailableWarning,
    } = await loadUpdateCommandModule();
    const check = await checkPosseUpdateAvailabilityCached();
    if (!check?.available) return;
    console.warn(`\n  ${C.yellow}${formatPosseUpdateAvailableWarning(check)}${C.reset}\n`);
  } catch {
    // Update checks are advisory only; boot should never fail because the
    // network, git remote, or install checkout is unavailable.
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND: admin — Admin dashboard for stats, reports, and settings
// ═════════════════════════════════════════════════════════════════════════════

async function cmdAdmin() {
  _adminTuiModulePromise ||= import("../../ui/classes/admin/AdminTUI.js");
  _adminSettingsModulePromise ||= import("../../ui/classes/admin/settings-controller.js");
  _adminCatalogModulePromise ||= import("../../settings/functions/admin-catalog.js");
  const [
    { AdminTUI },
    { validateAdminSettingValue },
    { HIDDEN_SETTING_KEYS },
  ] = await Promise.all([
    _adminTuiModulePromise,
    _adminSettingsModulePromise,
    _adminCatalogModulePromise,
  ]);
  const adminArgs = getCommandPositionalArgs(process.argv.slice(3));
  const adminAction = adminArgs[0]?.toLowerCase();
  const adminArg1 = adminArgs[1];
  const adminArg2 = adminArgs[2];
  const ensureAdminPromptBundle = async () => {
    await loadRemotePromptBundle();
  };
  const printAdminUsage = () => {
    console.log("\n  Usage: posse admin [init|snapshot|worktrees|memory|settings|list|get <key>|set <key> <value>|tui]\n");
  };
  const setAdminSettingFromArgs = (key, value, usageLabel = "admin set", extraArgs = []) => {
    if (!key || typeof value === "undefined") {
      console.log(`\n  Usage: posse ${usageLabel} <setting_key> <value>\n`);
      process.exitCode = 2;
      return;
    }
    if (extraArgs.length > 0) {
      console.log(`\n  ${C.red}Unexpected extra argument:${C.reset} ${extraArgs[0]}`);
      console.log(`  Usage: posse ${usageLabel} <setting_key> <value>\n`);
      process.exitCode = 2;
      return;
    }
    const validated = validateAdminSettingValue(key, value);
    if (!validated.ok) {
      console.log(`\n  ${C.red}Invalid setting:${C.reset} ${validated.error}\n`);
      process.exitCode = 2;
      return;
    }
    const storageKey = validated.storageKey || key;
    setSetting(storageKey, validated.value, { projectDir: PROJECT_DIR });
    const displayValue = HIDDEN_SETTING_KEYS.has(storageKey) ? "[hidden]" : validated.value;
    console.log(`Updated ${storageKey}=${displayValue}`);
  };

  const renderProviderCliInitEntry = (entry) => {
    const name = String(entry.provider || "provider").padEnd(6);
    if (entry.status === "updated" || entry.status === "would_update") {
      const verb = entry.status === "would_update" ? "would set" : "set";
      console.log(`  ${C.green}${name}${C.reset} ${verb} ${entry.settingKey}=${entry.selected}`);
      return;
    }
    if (entry.status === "kept") {
      const source = entry.current ? entry.current : entry.selected;
      console.log(`  ${C.green}${name}${C.reset} ready ${C.dim}${source}${C.reset}`);
      return;
    }
    console.log(`  ${C.yellow}${name}${C.reset} not found ${C.dim}${entry.reason || "no executable candidate found"}${C.reset}`);
  };

  if (adminAction === "init") {
    const dryRun = hasArgFlag("--dry-run");
    const force = hasArgFlag("--force");
    const nonInteractive = hasArgFlag("--non-interactive") || !process.stdout?.isTTY;
    const providerClisOnly = hasArgFlag("--provider-clis-only");

    console.log(`\n${C.bold}Posse admin init${C.reset}`);
    if (providerClisOnly) {
      console.log(`  ${C.dim}Provider CLI detection only; repository setup skipped.${C.reset}`);
    } else if (nonInteractive) {
      console.log(`  ${C.dim}Non-interactive mode: prompt-free repo repair only.${C.reset}`);
    }
    if (!providerClisOnly) {
      const repoReady = await ensureRepoSetupConfirmed();
      if (!repoReady) {
        process.exitCode = 2;
        return;
      }
    }

    const { initializeProviderCliSettings } = await loadProviderCliInitModule();
    const report = initializeProviderCliSettings({ force, dryRun });
    console.log(`\n${C.bold}Provider CLIs${C.reset}`);
    for (const entry of report.entries) renderProviderCliInitEntry(entry);
    console.log("");
    return;
  }
  if (adminAction === "settings") {
    const settingsAction = adminArg1?.toLowerCase();
    if (settingsAction === "set") {
      setAdminSettingFromArgs(adminArg2, adminArgs[3], "admin settings set", adminArgs.slice(4));
      return;
    }
    if (settingsAction) {
      console.log(`\n  ${C.red}Unknown admin settings action:${C.reset} ${adminArg1}`);
      console.log("  Usage: posse admin settings [set <setting_key> <value>]\n");
      process.exitCode = 2;
      return;
    }
    await ensureAdminPromptBundle();
    const admin = new AdminTUI({ projectDir: PROJECT_DIR });
    console.log(admin.renderSettingsSnapshot());
    return;
  }

  if (adminAction === "get") {
    if (!adminArg1) {
      console.log("\n  Usage: posse admin get <setting_key>\n");
      process.exitCode = 2;
      return;
    }
    const key = String(adminArg1 || "").trim();
    if (HIDDEN_SETTING_KEYS.has(key)) {
      console.log(`\n  ${C.red}Hidden setting:${C.reset} ${key} is not available through admin get.\n`);
      process.exitCode = 2;
      return;
    }
    const value = getSetting(key, { projectDir: PROJECT_DIR });
    console.log(value == null ? `${key} is not set` : `${key}=${value}`);
    return;
  }

  if (adminAction === "set") {
    setAdminSettingFromArgs(adminArg1, adminArg2, "admin set", adminArgs.slice(3));
    return;
  }

  if (adminAction === "list") {
    const rows = listSettings({ projectDir: PROJECT_DIR }).filter((row) => !HIDDEN_SETTING_KEYS.has(row.setting_key));
    if (rows.length === 0) {
      console.log("No admin settings stored in DB");
      return;
    }
    for (const row of rows) {
      console.log(`${row.setting_key}=${row.setting_value}`);
    }
    return;
  }

  if (adminAction === "snapshot") {
    await ensureAdminPromptBundle();
    const admin = new AdminTUI({ projectDir: PROJECT_DIR });
    console.log(admin.renderSnapshot({ reason: "snapshot requested" }));
    return;
  }

  if (adminAction === "worktrees") {
    await cmdAdminWorktrees();
    return;
  }

  if (adminAction === "memory") {
    const { runMemoryAdminCommand } = await loadMemoryCommandsModule();
    const ok = await runMemoryAdminCommand(adminArgs.slice(1), { cwd: PROJECT_DIR, C });
    if (!ok) process.exitCode = 2;
    return;
  }

  if (adminAction && adminAction !== "tui") {
    printAdminUsage();
    process.exitCode = 2;
    return;
  }

  if (NO_TUI) {
    await ensureAdminPromptBundle();
    const admin = new AdminTUI({ projectDir: PROJECT_DIR });
    console.log(admin.renderSnapshot({ reason: "--no-tui was requested" }));
    return;
  }
  await ensureAdminPromptBundle();
  const admin = new AdminTUI({ projectDir: PROJECT_DIR });
  try {
    await admin.run();
  } catch (err) {
    console.log(admin.renderSnapshot({ reason: `interactive admin failed to start: ${err.message}` }));
  }
}

async function cmdServe() {
  const { runServeCommand } = await loadServeCommandModule();
  return runServeCommand(process.argv.slice(3), { projectDir: PROJECT_DIR, C });
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════

// Per-command --help, intercepted in main() before init/dispatch so that
// `posse <command> --help` prints usage instead of executing the command
// (previously `posse run --help` booted the scheduler).
const COMMAND_USAGE = {
  add: () => {
    console.log(`\n  Usage: posse add "description of what you want built"`);
    console.log(`  ${C.dim}Optional: --mode build|report|image --oneshot --intent task|bugfix|design|context|question|oneshot|report|image (hotkeys ok: b,d,c,q,o,r,i) --output repo|artifact|question_only --files LIST --constraints LIST${C.reset}\n`);
  },
  run: () => {
    console.log(`\n  Usage: posse run [flags]`);
    console.log(`  Execute all pending jobs (scheduler + worker loop).\n`);
    console.log(`    ${C.cyan}--concurrency N${C.reset}     Run N workers in parallel`);
    console.log(`    ${C.cyan}--auto-approve${C.reset}      Dev won't pause for tool permission prompts`);
    console.log(`    ${C.cyan}--auto-merge${C.reset} / ${C.cyan}--no-auto-merge${C.reset}  Merge (or don't) completed WI branches during wrap-up`);
    console.log(`    ${C.cyan}--auto-approve-plan${C.reset} Skip plan approval gates for this run`);
    console.log(`    ${C.cyan}--no-tui${C.reset}            Disable split-screen display (classic output)`);
    console.log(`    ${C.cyan}--non-interactive${C.reset}   Suppress terminal prompts; leave app gates open instead`);
    console.log(`    ${C.cyan}--dry-run${C.reset}           Research + plan only — dev jobs auto-pass without execution`);
    console.log(`    ${C.cyan}--stall-timeout N${C.reset}   Seconds before killing stalled process`);
    console.log(`    ${C.cyan}--work-item N${C.reset}       Run only jobs for one work item (repeat or comma-separate)`);
    console.log(`    ${C.cyan}--cold-index${C.reset}        Clear the cold index before starting\n`);
  },
  go: () => {
    console.log(`\n  Usage: posse go [flags]`);
    console.log(`  plan + run in one shot: plans queued work items, then starts the scheduler.`);
    console.log(`  ${C.dim}Accepts the same flags as 'run' — see: posse run --help${C.reset}\n`);
  },
  "local-models": () => {
    console.log(`\n  Usage: posse local-models [list [--json] | download [shorthand]]`);
    console.log(`  Lists signed local models with download size and recommended memory.`);
    console.log(`  Downloads always require an interactive, size-aware confirmation.\n`);
  },
  "native-binaries": () => {
    console.log(`\n  Usage: posse native-binaries\n  Reconcile native artifacts and emit NDJSON progress.\n`);
  },
};

function helpFlagRequested() {
  const args = process.argv.slice(3);
  return args.includes("--help") || args.includes("-h");
}

async function printCommandHelp(command) {
  // Doctor and update own richer, lazily loaded help. Dispatching them here
  // keeps `posse <command> --help` out of bootstrap while avoiding a second
  // copy of their timeout and safety contract in the global usage table.
  if (command === "doctor") return cmdDoctor();
  if (command === "update") return cmdUpdate();
  const usage = COMMAND_USAGE[command];
  if (usage) {
    usage();
    return;
  }
  await printGlobalHelp();
}

export async function main() {
  const command = normalizeCommandName((!COMMAND && ITERATE_FLAG) ? "add" : COMMAND);
  if (rejectUnknownFlags()) return;
  const commandPolicy = getCommandBootstrapPolicy(command);
  if (!isHelpCommand(command) && commandPolicy.known && helpFlagRequested()) {
    await printCommandHelp(command);
    return;
  }
  const runBootPanelOwnsReadiness = commandPolicy.name === "run" || commandPolicy.name === "go";
  await init({
    requireWritableArtifacts: commandPolicy.requiresWritableArtifacts,
    refreshStartupContext: commandPolicy.refreshContextAfter,
    showReadiness: !runBootPanelOwnsReadiness
      && (commandPolicy.requiresProvider || commandPolicy.requiresNativeGit || commandPolicy.refreshContextAfter),
    // Only provider/scheduler dispatch owns native-daemon readiness. Read-only
    // and operator/admin commands (including Bossy status + merge) must remain
    // usable when agent MCP/native heartbeat infrastructure is unavailable.
    ensureNativeGit: commandPolicy.requiresProvider || commandPolicy.requiresNativeGit,
    // Any command that cannot proceed without Git must reconcile the exact
    // issued artifact before minting route grants. Otherwise a release move
    // can reject the staged handle before run boot reaches its broader native
    // artifact refresh, and maintenance commands never reach one at all.
    refreshNativeGit: commandPolicy.requiresNativeGit,
  });
  await maybeWarnPosseUpdateAvailable(commandPolicy);

  if (isHelpCommand(command)) {
    await printGlobalHelp();
    return;
  }

  return dispatchResolvedCommand(command);
}

async function printGlobalHelp() {
  const aliasDiagnostic = await posseAliasDiagnostic();
  console.log(`
${C.bold}  Posse (claude-org v4) — SQLite Job Queue Orchestrator${C.reset}
  ${C.dim}Project: ${PROJECT_DIR}${C.reset}
  ${C.dim}Providers: configured per role in Posse settings${C.reset}
  ${C.dim}DB:      ${getRuntimeDbPath(PROJECT_DIR)}${C.reset}
${aliasDiagnostic}

  ${C.bold}Workflow:${C.reset}
    ${C.cyan}add${C.reset}        Queue a work item (what you want built)
    ${C.cyan}plan${C.reset}       Create research + plan jobs for queued items
    ${C.cyan}run${C.reset}        Execute all pending jobs (scheduler + worker)
    ${C.cyan}go${C.reset}         plan + run in one shot

  ${C.bold}Manage:${C.reset}
    ${C.cyan}queue${C.reset}      Show all work items and their status
    ${C.cyan}status${C.reset}     Detailed job-level status
    ${C.dim}             status [--active] [--limit N|all] [--json]${C.reset}
    ${C.cyan}serve${C.reset}      Start local bridge HTTP+WS API
    ${C.dim}             serve [--show-token] [--pair]${C.reset}
    ${C.cyan}health${C.reset}     Failure/stuck-job health summary
    ${C.cyan}dashboard${C.reset}  Visual job board
    ${C.cyan}doctor${C.reset}     Repair dependencies, native binaries, and Jina
    ${C.dim}             doctor [--dry-run] [--json]${C.reset}
    ${C.cyan}update${C.reset}     Update Posse + dependencies, binaries, and Jina
    ${C.dim}             update [--dry-run] [--json] [--branch main]${C.reset}
    ${C.cyan}review${C.reset}     Approve/reject completed work items
    ${C.cyan}events${C.reset}     Show event log (audit trail)
    ${C.dim}             events [jobId] [--session]${C.reset}
    ${C.cyan}timeline${C.reset}   Full execution chain for a work item
    ${C.dim}             timeline <wi-id> [--json] [--verbose]${C.reset}
    ${C.cyan}sessions${C.reset}   Session-recycling lanes and token savings
    ${C.dim}             sessions [wi-id] [--json] [--savings] [--all]${C.reset}
    ${C.cyan}cost${C.reset}       Per-WI cost attribution + pricing overrides
    ${C.dim}             cost | cost <wi-id> [--by role|provider|tier|model] [--json] [--recycling]${C.reset}
    ${C.dim}             cost pricing [list|set <provider> <model> <in/M> <out/M>]${C.reset}
    ${C.cyan}fanout${C.reset}     Research fanout quality/readiness report
    ${C.dim}             fanout [--json] [--limit N]${C.reset}
    ${C.cyan}plan review/approve/reject${C.reset}  Review/approve plans before dev/fix run
    ${C.dim}             plan review <wi-id>${C.reset}
    ${C.dim}             plan approve <wi-id>${C.reset}
    ${C.dim}             plan reject <wi-id> [--feedback "…"] [--replan]${C.reset}
    ${C.cyan}calls${C.reset}      Agent call performance stats
    ${C.cyan}prompts${C.reset}    Recent agent prompts (last 3 days, JSONL log)
    ${C.dim}             prompts [--job N] [--role R] [--limit N] [--full]${C.reset}
    ${C.cyan}replay${C.reset}     Compressed replay packet for one agent call
    ${C.dim}             replay <agent-call-id> [--json] [--exact-prompt]${C.reset}
    ${C.cyan}usage${C.reset}      Show cached provider usage/quota tracker
    ${C.dim}             usage [--refresh|--force-refresh]${C.reset}
    ${C.cyan}atlas-smoke${C.reset}  Run Posse's local ATLAS smoke test against a repo
    ${C.dim}             atlas-smoke <repoPath> [query] [provider]${C.reset}
    ${C.cyan}atlas${C.reset}        Atlas admin commands
    ${C.dim}             atlas mutations are system-owned; use atlas-v2 diagnostics${C.reset}
    ${C.cyan}atlas-v2${C.reset}     Inspect/manage the ATLAS v2 ledger, views, and warmer queue
    ${C.dim}             atlas-v2 ${atlasV2UsageSummary({ compact: true })}${C.reset}
    ${C.cyan}mcp-status${C.reset} Show repo-scoped MCP runtime state
    ${C.cyan}codex-models${C.reset} Validate/list Codex model candidates against CLI
    ${C.dim}             codex-models [validate|list] [oauth|api|auto]${C.reset}
    ${C.cyan}local-models${C.reset} List/download signed local models with size and system recommendations
    ${C.dim}             local-models [list [--json] | download [shorthand]]${C.reset}
    ${C.cyan}native-binaries${C.reset} Reconcile signed native artifacts (NDJSON progress)
    ${C.cyan}windows-events${C.reset} Probe Windows crash/resource events into the run dir
    ${C.dim}             windows-events [--around ISO] [--minutes N] [--json]${C.reset}
    ${C.cyan}audit${C.reset}      Provider/handoff audit for jobs or work items
    ${C.dim}             audit | audit <jobId> | audit wi<id> | audit worktrees${C.reset}
    ${C.cyan}admin${C.reset}      Stats, session history, and settings management
    ${C.dim}             admin init [--provider-clis-only] | admin snapshot | admin worktrees | admin memory <note|suppress|correct> <id> | admin settings${C.reset}
    ${C.cyan}merge${C.reset}      Merge a completed WI branch
    ${C.cyan}prune${C.reset}      Clean up orphaned worktrees
    ${C.dim}             prune [--dry-run]${C.reset}
    ${C.cyan}purge${C.reset}      Delete ALL posse/* branches + worktrees (asks first)
    ${C.cyan}cleanup${C.reset}    Triage leftover snapshots, branches, worktrees, stashes
    ${C.dim}             cleanup [--auto] [--dry-run]  (--auto asks before discarding)${C.reset}
    ${C.cyan}clear${C.reset}      Reset everything

  ${C.bold}Mid-Run:${C.reset}
    ${C.cyan}inject${C.reset}     Quick-add work item (scheduler picks it up)
    ${C.cyan}ask${C.reset}        Ask a question (research-only, no dev tasks)
    ${C.cyan}image${C.reset}      Generate an image directly (skips research/plan)

  ${C.bold}Flags:${C.reset}
      ${C.cyan}--auto-approve${C.reset}   Dev won't pause for tool permission prompts
      ${C.cyan}--auto-merge${C.reset}     Merge completed WI branches during wrap-up
      ${C.cyan}--no-auto-merge${C.reset}  Disable auto-merge for this run
      ${C.cyan}--auto-approve-plan${C.reset} Skip plan approval gates for this run
      ${C.cyan}--deepthink${C.reset}      Raise planner/research budget for deeper analysis
      ${C.cyan}--deepthink-budget N${C.reset}  Set planner/research budget: low, normal, high, xhigh
      ${C.cyan}--oneshot${C.reset}        Propose one-shot routing; deterministic gate still validates scope and safety
      ${C.cyan}--intent KIND${C.reset}    Intake type: task, bugfix, design, context, question, oneshot, report, image ${C.dim}(hotkeys ok)${C.reset}
      ${C.cyan}--input-contexts${C.reset} Select context dirs from resources/inputs (names, indices, or all)
      ${C.cyan}--files LIST${C.reset}     Optional hinted files for research/planning
      ${C.cyan}--constraints LIST${C.reset} Optional intake constraints for research/planning
      ${C.cyan}--session-recycle${C.reset} Enable session recycling for this work item
      ${C.cyan}--no-session-recycle${C.reset} Disable session recycling for this work item
      ${C.cyan}--red-team-plan${C.reset}  Use primary planner -> red-team planner -> synthesis planner
      ${C.cyan}--iterate${C.reset}        Guided iterative workflow intake ${C.dim}([b]ugfix|[d]esign/ux|[r]efactor|[a]udit|[i]terate)${C.reset}
      ${C.cyan}--iterate-red-team${C.reset} Persist red-team planning across iterative follow-up rounds
      ${C.cyan}--concurrency N${C.reset}  Run N workers in parallel       ${C.dim}(default: ${getCatalogRuntimeFallbackInt("scheduler_concurrency", 3)})${C.reset}
    ${C.cyan}--no-tui${C.reset}         Disable split-screen display (classic output)
    ${C.cyan}--non-interactive${C.reset} Suppress terminal prompts; leave app gates open instead
    ${C.cyan}--bossy${C.reset}          Open the Bossy fleet TUI for this machine's posses instead of the CLI
    ${C.cyan}--dry-run${C.reset}        Research + plan only — dev jobs auto-pass without execution
    ${C.cyan}--stall-timeout N${C.reset}  Seconds before killing stalled process ${C.dim}(default: ${getCatalogRuntimeFallbackInt("stall_timeout", 600)})${C.reset}

  ${C.bold}Settings:${C.reset}
    Runtime behavior is configured in Posse admin/account settings.
    Secrets remain in the environment.

  ${C.bold}Provider / Remote Secrets:${C.reset}
    ${C.cyan}POSSE_KEY${C.reset}                  Posse remote API key ${C.dim}(required for remote prompt/tool catalog)${C.reset}
    ${C.cyan}OPENAI_API_KEY${C.reset}             OpenAI API key ${C.dim}(required if using openai provider)${C.reset}
    ${C.cyan}CODEX_API_KEY${C.reset}              Optional Codex CLI API key ${C.dim}(or cached ~/.codex/auth.json login)${C.reset}
    ${C.cyan}XAI_API_KEY${C.reset}                xAI API key ${C.dim}(required if using grok provider)${C.reset}
    ${C.cyan}CLAUDE_CODE_OAUTH_TOKEN${C.reset}    Claude OAuth token override

  ${C.bold}Example:${C.reset}
    posse add "Build a REST API for user management"
    posse add "Add JWT authentication to all endpoints"
    posse go --auto-approve
`);
}

async function dispatchResolvedCommand(command) {
  const cmdNativeBinaries = async () => (await loadNativeBinariesCommandModule()).cmdNativeBinaries();
  const { handled, result } = await dispatchCommand(command, {
    add: cmdAdd,
    queue: cmdQueue,
    plan: cmdPlan,
    run: cmdRun,
    go: cmdGo,
    status: cmdStatus,
    serve: cmdServe,
    health: cmdHealth,
    dashboard: cmdDashboard,
    doctor: cmdDoctor,
    update: cmdUpdate,
    review: cmdReview,
    inject: cmdInject,
    ask: cmdAsk,
    image: cmdImage,
    events: cmdEvents,
    timeline: cmdTimeline,
    sessions: cmdSessions,
    cost: cmdCost,
    fanout: cmdFanout,
    audit: cmdAudit,
    calls: cmdCalls,
    prompts: cmdPrompts,
    replay: cmdReplay,
    usage: cmdUsage,
    "atlas-smoke": cmdAtlasSmoke,
    atlas: cmdAtlas,
    "atlas-v2": cmdAtlasV2,
    "mcp-status": cmdMcpStatus,
    "codex-models": cmdCodexModels,
    "local-models": cmdLocalModels,
    "native-binaries": cmdNativeBinaries,
    "windows-events": cmdWindowsEvents,
    admin: cmdAdmin,
    merge: cmdMerge,
    prune: cmdPrune,
    purge: cmdPurge,
    cleanup: cmdCleanup,
    clear: cmdClear,
  });
  if (!handled) {
    console.log(`\n  Unknown command: ${command}\n  Run with no arguments for help.\n`);
    process.exitCode = 2;
  }

  if (handled && shouldRefreshContextAfterCommand(command)) {
    await refreshProjectContextAsync(PROJECT_DIR, { writeDigest: true });
  }
  return result;
}

export function runOrchestratorCli() {
  let fatal = false;
  return main()
    .catch((err) => {
      fatal = true;
      console.error(`\n${C.red}Fatal: ${err.message}${C.reset}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try { await daemonSupervisor.shutdownAll(); } catch { /* teardown is best effort */ }
      try { await persistentMcpOwner.close({ force: true }); } catch { /* teardown is best effort */ }
      try { await nativeBinaries.disposeAll(); } catch { /* teardown is best effort */ }
      flushEventsNow();
      closeLog();
      closeObservationLog();
      closePromptLog();
      closeDb();
      if (fatal) {
        // A fatal error can strand non-unref'd resources — e.g. a backgrounded
        // ATLAS boot-warm worker thread whose MessagePort pins the event loop —
        // leaving the process printing "Fatal:" and then hanging indefinitely.
        // The clean-exit path handles this with an explicit exit in RunSession;
        // mirror it here once teardown has finished. stderr was written and
        // teardown awaited above, so nothing user-visible is truncated.
        setImmediate(() => process.exit(process.exitCode ?? 1));
      }
    });
}
