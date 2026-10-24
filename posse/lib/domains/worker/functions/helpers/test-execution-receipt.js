// Deterministic test execution owned by the worker, outside model context.
//
// A planner or benchmark harness identifies one explicit test command. The
// worker freezes that command before DEV, runs it once against the pre-change
// worktree, then once per assessed commit. Full bounded output is persisted as
// an artifact; only a compact before/after receipt is rendered for ASSESSOR.

import { TEST_EXECUTION_RECEIPT_SCHEMA_VERSION as RECEIPT_SCHEMA_VERSION, REUSABLE_RECEIPT_STATUSES, SCOPE_ATTRIBUTABLE_DELTAS } from "../../../../catalog/verification.js";
import { sha256 } from "../../../../shared/format/functions/sha256.js";
import { validatePlannerTestCommandForRepository } from "../../../verification/functions/planner-test-command.js";
export { validatePlannerTestCommand, validatePlannerTestCommandForRepository, operationalCommandApprovalRequest } from "../../../verification/functions/planner-test-command.js";
import { classifyNestedRunnerInfrastructureFailure, classifyPackageManagerTestPlanFailure } from "../../../verification/functions/test-runner-failure.js";
export { classifyNestedRunnerInfrastructureFailure } from "../../../verification/functions/test-runner-failure.js";
import { resolveFrozenTestPlan, frozenTestPlanFromReceipt, prunedTestPlan } from "./frozen-test-plan.js";
export { resolveFrozenTestPlan } from "./frozen-test-plan.js";
import { currentCommit, currentHeadRef, repositoryFingerprint, worktreeFingerprint, dirtyPathDigests, dirtyFingerprintFromDigests, environmentFilesFingerprint, isAncestorCommit, porcelain, porcelainChangedPaths } from "../../../verification/functions/receipt-fingerprint.js";
export { dirtyWorktreeFingerprint, environmentFilesFingerprint, porcelainChangedPaths } from "../../../verification/functions/receipt-fingerprint.js";
import { unitTestCommandResult, effectiveVerificationPolicy, runVerificationChecks, runFrozenTestPlanOnce, didInvokeTestFile, testCoverageStatus, aggregateCheckCoverageStatus } from "./frozen-test-execution.js";
export { runFrozenTestPlanOnce, testCoverageStatus, aggregateCheckCoverageStatus } from "./frozen-test-execution.js";
import { testExecutionDelta, scopedTypecheckAttribution } from "./test-receipt-evidence.js";
export { testExecutionDelta, scopedTypecheckAttribution, renderTestExecutionEvidence, postChangeTestLogSummary, testReceiptObservationDetail } from "./test-receipt-evidence.js";
import { runCommand, MAX_STREAM_CHARS } from "./test-command-process.js";
import { withBaselineCheckout } from "../../../verification/functions/baseline-checkout.js";
import fs from "fs";
import path from "path";
import { getArtifact, getArtifacts, storeArtifact, updateJobPayload } from "../../../queue/functions/index.js";
import { linkPrimaryTestDependencies, pruneTestHandoff, testCommandCapability } from "../../../verification/functions/test-capability.js";
import { getRecentArtifactsByMimeType } from "../../../queue/functions/artifacts.js";
import { knownRedCommandsFromReceipts } from "./known-red-test-history.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { siblingJobScopePaths } from "../../../queue/functions/file-locks.js";
import { gitExecAsync } from "../../../git/functions/utils.js";
import "../../../providers/functions/shared/windows-spawn.js";
import { parseCommandArguments } from "../../../../shared/scope/functions/test-command.js";
import "../../../../shared/platform/functions/subprocess-output.js";
import "../../../../shared/platform/functions/process-env.js";
import { describeToolchain, toolchainFingerprint } from "../../../settings/functions/verification-policy.js";
import { verificationOutcome } from "./verification-outcome.js";
import { withLineagePathsRestored } from "../../../verification/functions/lineage-tree.js";
import { TEST_EXECUTION_RECEIPT_KIND, TEST_EXECUTION_RECEIPT_MIME_TYPE, TEST_EXECUTION_REUSE_KIND, REPOSITORY_PLAN_UNAVAILABLE_CHECK_ID, UNESTABLISHED_COVERAGE_STATUSES, VERIFICATION_DEPENDENCY_LOCK_INVALID } from "../../../../catalog/verification.js";
import { checkRunsFailureFingerprint, comparableTestFailureFingerprint, testFailureFingerprint, testFailureInventory } from "./test-failure-evidence.js";
import { discoverUnitTestCapability, runUnitTestFiles } from "../../../../shared/tools/functions/toolkit/unit-test-runner.js";
import { testExecutionCounts } from "../../../../shared/tools/functions/toolkit/test-output-counts.js";
export { normalizeFailureFingerprintText } from "./test-failure-evidence.js";
export { testExecutionCounts };

const RECEIPT_KIND = TEST_EXECUTION_RECEIPT_KIND;
const RECEIPT_MIME_TYPE = TEST_EXECUTION_RECEIPT_MIME_TYPE;

export { runCommand as __testRunFrozenCommand };

function parseReceiptArtifact(artifact) {
  if (!artifact?.content_json) return null;
  try {
    const parsed = typeof artifact.content_json === "string"
      ? JSON.parse(artifact.content_json)
      : artifact.content_json;
    if (parsed?.kind !== RECEIPT_KIND || parsed?.schema_version !== RECEIPT_SCHEMA_VERSION) {
      return null;
    }
    return {
      ...parsed,
      verification_outcome: parsed.verification_outcome || verificationOutcome(parsed),
      artifact_id: artifact.id,
      artifact_job_id: artifact.job_id ?? null,
    };
  } catch {
    return null;
  }
}

function storedReceipts(jobId) {
  return getArtifacts(jobId, "log")
    .map(parseReceiptArtifact)
    .filter(Boolean);
}

function storeReceipt(job, attemptId, receipt) {
  const storedReceipt = {
    ...receipt,
    verification_outcome: receipt.verification_outcome || verificationOutcome(receipt),
  };
  const artifact = storeArtifact({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attemptId,
    artifact_type: "log",
    mime_type: RECEIPT_MIME_TYPE,
    content_json: storedReceipt,
  });
  return { ...storedReceipt, artifact_id: artifact.id };
}

export function isReusableReceipt(receipt, policy = null, { projectDir = null } = {}) {
  if (!receipt) return false;
  // Every reusable result is an execution claim. Legacy rows without policy
  // identity, changed toolchains, and transient infrastructure outcomes must
  // all run again. In particular, a timeout is evidence, never a cache hit.
  if (!REUSABLE_RECEIPT_STATUSES.has(receipt.status) || receipt.tree_state !== "clean") return false;
  if (!policy?.fingerprint
    || !receipt.policy_fingerprint
    || !receipt.toolchain_fingerprint
    || !receipt.tree_fingerprint
    || !receipt.environment_files_fingerprint) return false;
  return receipt.policy_fingerprint === policy.fingerprint
    && receipt.toolchain_fingerprint === toolchainFingerprint(describeToolchain({ projectDir }))
    && receipt.environment_files_fingerprint === environmentFilesFingerprint(projectDir);
}

export function findFrozenTestBaseline(jobId, { policy = null, projectDir = null, planId = null } = {}) {
  return storedReceipts(jobId)
    .find((receipt) => receipt.phase === "baseline"
      && (!planId || receipt.plan_id === planId)
      && isReusableReceipt(receipt, policy, { projectDir })) || null;
}

function findLatestFrozenTestBaseline(jobId) {
  return storedReceipts(jobId)
    .filter((receipt) => receipt.phase === "baseline")
    .sort((left, right) => Number(right.artifact_id || 0) - Number(left.artifact_id || 0))[0] || null;
}

function findPostChangeReceipt(jobId, planId, commitHash, {
  policy = null, projectDir = null, treeFingerprint = null, accept = () => true,
} = {}) {
  return storedReceipts(jobId)
    .find((receipt) => (
      receipt.phase === "post_change"
      && receipt.plan_id === planId
      && receipt.commit_hash === commitHash
      && !!treeFingerprint
      && receipt.tree_fingerprint === treeFingerprint
      && isReusableReceipt(receipt, policy, { projectDir })
      && accept(receipt)
    )) || null;
}

function repositoryReceiptCandidates(jobId, limit = 512) {
  const rows = getDb().prepare(`
    SELECT id
    FROM artifacts
    WHERE mime_type = ?
      AND job_id IS NOT NULL
      AND job_id <> ?
    ORDER BY id DESC
    LIMIT ?
  `).all(RECEIPT_MIME_TYPE, jobId, limit);
  return rows
    .map((row) => getArtifact(row.id))
    .map(parseReceiptArtifact)
    .filter(Boolean);
}

/**
 * Historical commands whose latest conclusive receipt on this lineage is red.
 * This is planning input, not a waiver: it steers new plans toward a passing
 * check or an explicit task that repairs the pre-existing failure.
 */
export async function knownRedTestCommandsForRepository(projectDir, { limit = 12 } = {}) {
  const [repositoryFingerprintValue, head] = await Promise.all([
    repositoryFingerprint(projectDir), currentCommit(projectDir),
  ]);
  if (!repositoryFingerprintValue || !head) return [];
  const receipts = getRecentArtifactsByMimeType(RECEIPT_MIME_TYPE)
    .map(parseReceiptArtifact)
    .filter((receipt) => receipt
      && ["passed", "failed"].includes(receipt.status)
      && receipt.tree_state !== "dirty"
      && receipt.repository_fingerprint === repositoryFingerprintValue);
  return knownRedCommandsFromReceipts(receipts, { projectDir, head, limit });
}

// Receipts other jobs of the same work item recorded for this exact command,
// newest first. Baseline attribution reads them to find the last known pass.
export function workItemCommandReceipts(workItemId, {
  excludeJobId = null,
  command,
  cwdRelative = null,
  limit = 256,
} = {}) {
  if (!workItemId || !command) return [];
  return getDb().prepare(`
    SELECT id
    FROM artifacts
    WHERE work_item_id = ? AND mime_type = ? AND job_id IS NOT NULL AND job_id <> ?
    ORDER BY id DESC
    LIMIT ?
  `).all(workItemId, RECEIPT_MIME_TYPE, excludeJobId ?? -1, limit)
    .map((row) => parseReceiptArtifact(getArtifact(row.id)))
    .filter((receipt) => receipt
      && receipt.command === command
      && (receipt.cwd_relative || null) === (cwdRelative || null));
}

async function findRepositoryFrozenTestBaseline({
  jobId,
  planId,
  commitHash,
  policy,
  projectDir,
  treeFingerprint,
} = {}) {
  if (!jobId || !planId || !commitHash || !projectDir || !treeFingerprint) return null;
  const repositoryFingerprintValue = await repositoryFingerprint(projectDir);
  if (!repositoryFingerprintValue) return null;
  return repositoryReceiptCandidates(jobId).find((receipt) => (
    receipt.phase === "baseline"
    && !receipt.reuse_scope
    && receipt.repository_fingerprint === repositoryFingerprintValue
    && receipt.plan_id === planId
    && receipt.commit_hash === commitHash
    && receipt.tree_fingerprint === treeFingerprint
    && isReusableReceipt(receipt, policy, { projectDir })
  )) || null;
}

function storeRepositoryBaselineReference(job, receipt, { reuseScope = "repository_commit" } = {}) {
  const {
    artifact_id: sourceArtifactId,
    artifact_job_id: sourceJobId,
    created_at: sourceCreatedAt,
    reused: _reused,
    ...sourceReceipt
  } = receipt;
  return storeReceipt(job, null, {
    ...sourceReceipt,
    reuse_scope: reuseScope,
    reuse_source_artifact_id: sourceArtifactId || null,
    reuse_source_job_id: sourceJobId || null,
    reuse_source_created_at: sourceCreatedAt || null,
    reused: true,
    created_at: new Date().toISOString(),
  });
}

function recordPostChangeReuse(job, attemptId, sourceReceipt) {
  const sourceId = Number(sourceReceipt?.artifact_id);
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) return null;
  const consumer = {
    job_id: Number(job.id),
    attempt_id: Number.isSafeInteger(Number(attemptId)) && Number(attemptId) > 0 ? Number(attemptId) : null,
    phase: "post_change",
  };
  const existing = getArtifacts(job.id, "log").find((artifact) => {
    let detail;
    try { detail = JSON.parse(String(artifact.content_json || "{}")); } catch { return false; }
    return detail.kind === TEST_EXECUTION_REUSE_KIND
      && detail.source_artifact_id === sourceId
      && detail.consumer?.job_id === consumer.job_id
      && detail.consumer?.attempt_id === consumer.attempt_id;
  });
  if (existing) return existing.id;
  const artifact = storeArtifact({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: consumer.attempt_id,
    artifact_type: "log",
    content_json: {
      kind: TEST_EXECUTION_REUSE_KIND,
      schema_version: 1,
      source_artifact_id: sourceId,
      source_job_id: sourceReceipt.artifact_job_id || job.id,
      plan_id: sourceReceipt.plan_id || null,
      commit_hash: sourceReceipt.commit_hash || null,
      consumer,
      observed_at: new Date().toISOString(),
    },
  });
  return artifact.id;
}

// Undo a test's own side effects path by path, for a shared worktree where a
// whole-worktree reset would also erase sibling jobs' files.
async function restorePathsToHead(cwd, paths = []) {
  for (const relPath of paths) {
    const inHead = await gitExecAsync(["cat-file", "-e", `HEAD:${relPath}`], cwd).then(() => true, () => false);
    if (inHead) {
      await gitExecAsync(["restore", "--source=HEAD", "--staged", "--worktree", "--", relPath], cwd);
      continue;
    }
    await gitExecAsync(["rm", "--cached", "--quiet", "--ignore-unmatch", "--", relPath], cwd).catch(() => {});
    await fs.promises.rm(path.join(cwd, relPath), { force: true, recursive: true });
  }
}

// Compare the worktree after a test run with its state before, and undo what
// the run changed. Returns how cleanup went and which changed paths belong to
// sibling jobs.
async function restoreAfterTest({
  cwd,
  before,
  beforeDirtyDigests = null,
  actualCommit,
  originalHeadRef,
  siblingOwnedPaths = null,
  cleanupWorktree = null,
  cleanupPaths = restorePathsToHead,
  allowProjectedBaseline = false,
}) {
  const after = await porcelain(cwd);
  const afterCommit = await currentCommit(cwd);
  const afterHeadRef = await currentHeadRef(cwd);
  const headChanged = afterCommit !== actualCommit || afterHeadRef !== originalHeadRef;
  if (beforeDirtyDigests) {
    const afterDirtyDigests = await dirtyPathDigests(cwd, after);
    const afterByPath = new Map(afterDirtyDigests || []);
    if (!afterDirtyDigests || beforeDirtyDigests.some(([relative, digest]) => afterByPath.get(relative) !== digest)) {
      // The original dirty bytes cannot be reconstructed by restoring HEAD.
      // Preserve them and decline this receipt instead of destroying work.
      return { cleanupStatus: "unavailable", cleanupError: "pre-existing dirty input changed during verification", siblingPaths: new Set() };
    }
  }
  // Sibling jobs of the same work item share this worktree. Files they own
  // (their write locks, or files materialized for them) that changed while
  // this test ran are their work, not this test's side effects.
  let siblingPaths = new Set();
  let ownChangedPaths = null;
  if (after !== before && typeof siblingOwnedPaths === "function") {
    const changedPaths = porcelainChangedPaths(after);
    try {
      siblingPaths = new Set(await siblingOwnedPaths(changedPaths));
    } catch {
      siblingPaths = new Set();
    }
    ownChangedPaths = changedPaths.filter((changedPath) => !siblingPaths.has(changedPath));
  }
  const ownWorktreeChanges = after !== before && (ownChangedPaths === null || ownChangedPaths.length > 0);
  let cleanupStatus = "not_needed";
  let cleanupError = null;
  if (ownWorktreeChanges || headChanged) {
    cleanupStatus = "required";
    try {
      if (ownWorktreeChanges) {
        if (siblingPaths.size > 0 || allowProjectedBaseline) {
          // A whole-worktree reset would erase the sibling files too; undo
          // only what this test changed.
          await cleanupPaths(cwd, ownChangedPaths);
        } else {
          if (typeof cleanupWorktree !== "function") {
            throw new Error("test changed worktree files but no cleanup implementation is available");
          }
          await cleanupWorktree();
        }
      }
      // A WI worktree may host disjoint sibling jobs. If one of those jobs
      // commits while this test is running, resetting to the captured HEAD
      // would erase valid sibling progress. A safe test is not authorized to
      // move HEAD either, so fail as infrastructure and leave the newer branch
      // state intact; the scheduler can retry once the worktree settles.
      if (headChanged) {
        throw new Error("worktree HEAD changed during test; refusing to reset possible concurrent progress");
      }
      const [cleaned, restoredCommit, restoredHeadRef] = await Promise.all([
        porcelain(cwd),
        currentCommit(cwd),
        currentHeadRef(cwd),
      ]);
      if (porcelainChangedPaths(cleaned).some((cleanedPath) => !siblingPaths.has(cleanedPath))) {
        throw new Error("test cleanup left the worktree dirty");
      }
      if (restoredCommit !== actualCommit || restoredHeadRef !== originalHeadRef) {
        throw new Error("test cleanup did not restore the original Git HEAD");
      }
      cleanupStatus = "completed";
    } catch (error) {
      cleanupStatus = typeof cleanupWorktree === "function" || headChanged
        ? "failed"
        : "unavailable";
      cleanupError = error?.message || String(error);
    }
  }
  return { cleanupStatus, cleanupError, siblingPaths };
}

// Test files the change created or edited that the frozen plan does not run.
// They run on the assessed tree in their own drift window, after the plan's
// cleanup, so their side effects, a failed cleanup or a HEAD move are charged
// to this result and never to the plan's receipt. The result sits beside the
// plan's and is never folded into it, so the baseline comparison stays like
// for like.
async function runChangedUnitTests(paths, policy, cleanupOptions, { base = null, scopePaths = [] } = {}) {
  const { cwd } = cleanupOptions;
  const [before, actualCommit, originalHeadRef] = await Promise.all([
    porcelain(cwd),
    currentCommit(cwd),
    currentHeadRef(cwd),
  ]);
  let run;
  try {
    run = await runFrozenTestPlanOnce(
      { command: paths.join(", "), unit_test_paths: paths },
      { cwd, timeoutMs: policy.wall_timeout_ms },
    );
  } catch (error) {
    run = { status: "infrastructure_error", ok: null, reason: String(error?.message || error).slice(0, 300) };
  }
  const { cleanupStatus, cleanupError } = await restoreAfterTest({
    ...cleanupOptions,
    before,
    actualCommit,
    originalHeadRef,
  });
  const cleanupFailed = cleanupStatus === "failed" || cleanupStatus === "unavailable";
  const attribution = cleanupFailed
    ? null
    : await attributeChangedTestFailures(run.file_results, { base, scopePaths, policy, cleanupOptions });
  return {
    paths,
    status: cleanupFailed ? "infrastructure_error" : String(run.status || "unknown"),
    ok: cleanupFailed ? null : run.ok ?? null,
    exit_code: run.code ?? null,
    duration_ms: run.duration_ms ?? 0,
    test_counts: run.test_counts || null,
    file_results: run.file_results || [],
    execution_root: cwd,
    failure_fingerprint: cleanupFailed ? null : testFailureFingerprint(run, { executionRoot: cwd }),
    reason: cleanupError || run.reason || null,
    cleanup_status: cleanupStatus,
    ...(attribution ? { baseline_attribution: attribution } : {}),
    stdout: String(run.stdout || "").slice(-MAX_STREAM_CHARS),
    stderr: String(run.stderr || "").slice(-MAX_STREAM_CHARS),
  };
}

// Only per-file runner results can suppress a changed-file execution. Command
// arguments and aggregate counts cannot prove what a repository wrapper ran.
function changedTestPathsCoveredByPlan(changedTestPaths, _plan, result) {
  if (result?.status !== "passed") return [];
  const proven = new Set((result.file_results || []).filter((file) => file.status === "passed"
    && file.test_counts?.total > 0 && file.test_counts.skipped === 0
    && ["node_test", "vitest", "pytest", "phpunit"].includes(file.runner)).map((file) => file.path));
  return changedTestPaths.filter((candidate) => proven.has(candidate));
}

function changedTestsCoveredByPlanResult(cwd) {
  return {
    paths: [], status: "passed", ok: true, exit_code: null, duration_ms: 0, test_counts: null,
    execution_root: cwd, failure_fingerprint: null, reason: null, cleanup_status: "not_needed", stdout: "", stderr: "",
  };
}

// A changed test file has no pre-development baseline: the plan was frozen
// before anyone knew which test files the change would touch. When one fails,
// each failing file the base tree already has runs again with the change's
// in-scope paths projected back to the lineage base (HEAD never moves), in a
// drift window of its own. A file that fails the same way there is a
// persistent_failure the change did not introduce, the same comparison the
// plan's own baseline makes. A file the change created, or one that passed or
// failed differently at the base, is the change's failure. Without a usable
// base run every failure counts.
async function attributeChangedTestFailures(fileResults, { base = null, scopePaths = [], policy, cleanupOptions }) {
  const failing = (Array.isArray(fileResults) ? fileResults : [])
    .filter((result) => ["failed", "timed_out"].includes(result?.status) && result.path);
  if (failing.length === 0 || !base) return null;
  const { cwd } = cleanupOptions;
  const edited = [];
  for (const result of failing) {
    try {
      await gitExecAsync(["cat-file", "-e", `${base}:${result.path}`], cwd);
      edited.push(result.path);
    } catch {
      // Absent at the base: the change created it.
    }
  }
  const baseResults = new Map();
  let error = null;
  if (edited.length > 0) {
    const [before, actualCommit, originalHeadRef] = await Promise.all([
      porcelain(cwd),
      currentCommit(cwd),
      currentHeadRef(cwd),
    ]);
    try {
      const run = await withLineagePathsRestored({
        cwd,
        baseCommit: base,
        paths: [...scopePaths, ...edited],
        run: () => runUnitTestFiles({
          projectDir: cwd,
          paths: edited,
          capability: discoverUnitTestCapability({ projectDir: cwd }),
          timeoutMs: policy.wall_timeout_ms,
        }),
      });
      for (const result of run?.results || []) baseResults.set(result.path, result);
    } catch (runError) {
      error = String(runError?.message || runError).slice(0, 300);
    }
    const { cleanupStatus, cleanupError } = await restoreAfterTest({
      ...cleanupOptions,
      before,
      actualCommit,
      originalHeadRef,
    });
    if (cleanupStatus === "failed" || cleanupStatus === "unavailable") {
      baseResults.clear();
      error = cleanupError || "base run cleanup failed";
    }
  }
  const files = failing.map((result) => {
    const baseResult = baseResults.get(result.path) || null;
    return {
      path: result.path,
      status: result.status,
      baseline_status: baseResult?.status || (edited.includes(result.path) ? "not_run" : "absent"),
      delta: baseResult ? testExecutionDelta(baseResult, result) : "post_only",
      test_counts: result.test_counts || null,
      baseline_test_counts: baseResult?.test_counts || null,
    };
  });
  const introduced = files.filter((file) => file.delta !== "persistent_failure").map((file) => file.path);
  return {
    commit: base,
    files,
    introduced_paths: introduced,
    debt_only: introduced.length === 0,
    ...(error ? { error } : {}),
  };
}

// Compare the declared suite on today's sibling tree with this job's scoped
// changes removed. An old frozen baseline cannot attribute a later sibling
// failure; unchanged tests can also regress because production code changed.
async function attributeDeclaredTestFailure(result, plan, { base, scopePaths, policy, cleanupOptions }) {
  if (result.status !== "failed" || !base || !scopePaths?.length
    || plan.verification_eligible === false || plan.source === "operator_approved_operation") return null;
  const { cwd } = cleanupOptions;
  const [before, actualCommit, originalHeadRef] = await Promise.all([porcelain(cwd), currentCommit(cwd), currentHeadRef(cwd)]);
  if (String(before || "").trim()) return null;
  let baseline = null;
  try {
    baseline = await withLineagePathsRestored({ cwd, baseCommit: base, paths: scopePaths,
      run: () => runFrozenTestPlanOnce(plan, { cwd, timeoutMs: policy.wall_timeout_ms }),
    });
  } catch { /* Without a trustworthy comparison, retain the original failure. */ }
  const cleanup = await restoreAfterTest({ ...cleanupOptions, before, actualCommit, originalHeadRef });
  if (!["not_needed", "completed"].includes(cleanup.cleanupStatus)) {
    return { commit: base, debt_only: false, cleanup_status: cleanup.cleanupStatus,
      error: cleanup.cleanupError || "Could not restore the workspace after the attribution check." };
  }
  if (!baseline) return null;
  const comparableBaseline = { ...baseline, execution_root: cwd, exit_code: baseline.code ?? null };
  const delta = testExecutionDelta(comparableBaseline, { ...result, execution_root: cwd, exit_code: result.code ?? null });
  // What the base run executed, so coverage of the debt can be judged.
  return { commit: base, comparison: "scoped_change_removed", baseline_status: baseline.status,
    delta, debt_only: delta === "persistent_failure",
    baseline_test_counts: baseline.test_counts || null,
    baseline_failure_fingerprint: comparableTestFailureFingerprint(comparableBaseline),
    baseline_failure_inventory: testFailureInventory(comparableBaseline),
    ...(Array.isArray(baseline.check_runs) ? { baseline_check_runs: baseline.check_runs.map((check) => ({
      check_id: check.check_id, intent: check.intent, status: check.status,
      test_counts: check.test_counts || null, failure_fingerprint: check.failure_fingerprint ?? null,
      failure_inventory: check.failure_inventory || null,
    })) } : {}) };
}

async function executeReceipt({
  job,
  plan,
  phase,
  cwd,
  commitHash = null,
  attemptId = null,
  policy = null,
  cleanupWorktree = null,
  siblingOwnedPaths = null,
  cleanupPaths = restorePathsToHead,
  baselineReceipt = null,
  dependencyRepair = null,
  allowProjectedBaseline = false,
} = {}) {
  const effectivePolicy = policy || effectiveVerificationPolicy({ cwd });
  const toolchain = describeToolchain({ projectDir: cwd });
  const executionCommand = plan.execution_command || plan.command;
  let normalizedArgv = null;
  try { normalizedArgv = parseCommandArguments(executionCommand); } catch { normalizedArgv = null; }
  const policyIdentity = {
    policy_schema_version: effectivePolicy.schema_version,
    check_class: effectivePolicy.check_class,
    timeout_ms: effectivePolicy.wall_timeout_ms,
    idle_timeout_ms: effectivePolicy.idle_timeout_ms ?? null,
    policy_source: effectivePolicy.wall_source,
    policy_fingerprint: effectivePolicy.fingerprint,
    toolchain_fingerprint: toolchainFingerprint(toolchain),
    platform: toolchain.platform,
    arch: toolchain.arch,
    node_version: toolchain.node_version,
    runtimes: toolchain.runtimes,
    lockfile_digests: toolchain.identity_files,
    environment_profile: toolchain.environment_profile,
    repository_fingerprint: await repositoryFingerprint(cwd),
    environment_files_fingerprint: environmentFilesFingerprint(cwd),
  };
  const actualCommit = await currentCommit(cwd);
  const originalHeadRef = await currentHeadRef(cwd);
  const initialPorcelain = await porcelain(cwd);
  // Hashed once: the receipt identity and the pre-run cleanup snapshot are
  // the same bytes.
  const initialDirtyDigests = initialPorcelain ? await dirtyPathDigests(cwd, initialPorcelain) : null;
  const receiptIdentity = {
    ...policyIdentity,
    execution_root: cwd,
    check_id: plan.check_id || `frozen_test:${plan.plan_id}`,
    intent: plan.intent || "test",
    verification_plan_id: plan.verification_plan?.plan_id || plan.plan_id,
    verification_plan: plan.verification_plan || null,
    normalized_argv: normalizedArgv,
    normalized_cwd: plan.cwd_relative || ".",
    baseline_commit_hash: phase === "baseline" ? (commitHash || actualCommit) : null,
    assessed_commit_hash: phase === "post_change" ? (commitHash || actualCommit) : null,
    tree_fingerprint: initialPorcelain
      ? dirtyFingerprintFromDigests(actualCommit, initialPorcelain, initialDirtyDigests)
      : worktreeFingerprint(actualCommit, initialPorcelain),
    tree_state: initialPorcelain === "" ? "clean" : "dirty",
  };
  const testedIntegratedDescendant = !!(
    commitHash
    && actualCommit
    && commitHash !== actualCommit
    && await isAncestorCommit(cwd, commitHash, actualCommit)
  );
  const changedTestPaths = phase === "post_change" && Array.isArray(plan.changed_unit_test_paths)
    ? plan.changed_unit_test_paths
    : [];
  const changedTestsBase = phase === "post_change"
    ? { base: plan.changed_tests_base || null, scopePaths: plan.changed_tests_scope || [] }
    : {};
  if (plan.validation_error) {
    // A rejected declared plan does not run, but the change's own test files
    // still do when the tree is the assessed commit and clean.
    const changedTests = changedTestPaths.length > 0
      && !initialPorcelain
      && (!commitHash || !actualCommit || commitHash === actualCommit || testedIntegratedDescendant)
      ? await runChangedUnitTests(changedTestPaths, effectivePolicy, { cwd, siblingOwnedPaths, cleanupWorktree, cleanupPaths }, changedTestsBase)
      : null;
    return storeReceipt(job, attemptId, {
      kind: RECEIPT_KIND,
      schema_version: RECEIPT_SCHEMA_VERSION,
      phase,
      plan_id: plan.plan_id,
      command: plan.command,
      source: plan.source,
      verification_eligible: plan.verification_eligible !== false,
      validation_error: plan.validation_error,
      commit_hash: commitHash || actualCommit,
      ...receiptIdentity,
      status: "rejected",
      ok: null,
      exit_code: null,
      duration_ms: 0,
      failure_fingerprint: null,
      reason: plan.validation_error,
      cleanup_status: "not_attempted",
      stdout: "",
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
      ...(changedTests ? { changed_tests: changedTests } : {}),
      created_at: new Date().toISOString(),
    });
  }
  // An unavailable registry obligation has no command of its own to validate.
  if (!["task_ab_acceptance", "operator_approved_operation", "planner_unit_tests"].includes(plan.source)
    && plan.check_id !== REPOSITORY_PLAN_UNAVAILABLE_CHECK_ID && phase === "baseline") {
    const repositoryValidation = validatePlannerTestCommandForRepository(plan.command, cwd, {
      filesToCreate: JSON.parse(job?.payload_json || "{}").files_to_create || [],
    });
    if (!repositoryValidation.ok) {
      return storeReceipt(job, attemptId, {
        kind: RECEIPT_KIND,
        schema_version: RECEIPT_SCHEMA_VERSION,
        phase,
        plan_id: plan.plan_id,
        command: plan.command,
        source: plan.source,
        verification_eligible: false,
        validation_error: repositoryValidation.reason,
        commit_hash: commitHash || actualCommit,
        executed_commit_hash: null,
        ...receiptIdentity,
        status: "invalid_test_plan",
        ok: null,
        exit_code: null,
        duration_ms: 0,
        failure_fingerprint: null,
        reason: repositoryValidation.reason,
        cleanup_status: "not_attempted",
        stdout: "",
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
        created_at: new Date().toISOString(),
      });
    }
  }
  if (commitHash && actualCommit && commitHash !== actualCommit && !testedIntegratedDescendant) {
    return storeReceipt(job, attemptId, {
      kind: RECEIPT_KIND,
      schema_version: RECEIPT_SCHEMA_VERSION,
      phase,
      plan_id: plan.plan_id,
      command: plan.command,
      source: plan.source,
      verification_eligible: plan.verification_eligible !== false,
      commit_hash: actualCommit,
      expected_commit_hash: commitHash,
      ...receiptIdentity,
      status: "unavailable",
      ok: null,
      exit_code: null,
      duration_ms: 0,
      failure_fingerprint: null,
      reason: "worktree_head_does_not_match_assessed_commit",
      cleanup_status: "not_attempted",
      stdout: "",
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
      created_at: new Date().toISOString(),
    });
  }
  const before = initialPorcelain;
  const beforeDirtyDigests = before ? initialDirtyDigests : null;
  if (before && (!allowProjectedBaseline || !beforeDirtyDigests)) {
    return storeReceipt(job, attemptId, {
      kind: RECEIPT_KIND,
      schema_version: RECEIPT_SCHEMA_VERSION,
      phase,
      plan_id: plan.plan_id,
      command: plan.command,
      source: plan.source,
      verification_eligible: plan.verification_eligible !== false,
      commit_hash: commitHash || actualCommit,
      ...receiptIdentity,
      status: "unavailable",
      ok: null,
      exit_code: null,
      duration_ms: 0,
      failure_fingerprint: null,
      reason: beforeDirtyDigests ? "worktree_not_clean_before_test" : "dirty_input_fingerprint_unavailable",
      cleanup_status: "not_attempted",
      stdout: "",
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
      created_at: new Date().toISOString(),
    });
  }

  const executionCwd = plan.cwd_relative
    ? path.resolve(cwd, plan.cwd_relative)
    : cwd;
  const hasExecutionChecks = Array.isArray(plan.execution_checks) && plan.execution_checks.length > 0;
  const rawResult = hasExecutionChecks
    ? await runVerificationChecks(plan, { cwd, policy: effectivePolicy, phase,
        baselineCommit: plan.capability_base_commit || (baselineReceipt?.status === "passed" ? baselineReceipt.commit_hash : null) || "HEAD" })
    : Array.isArray(plan.unit_test_paths)
    ? await runUnitTestFiles({
        projectDir: cwd,
        paths: plan.unit_test_paths,
        capability: discoverUnitTestCapability({ projectDir: cwd }),
        timeoutMs: effectivePolicy.wall_timeout_ms,
      }).then((aggregate) => unitTestCommandResult(aggregate, { cwd, filesToCreate: phase === "baseline" ? [] : plan.files_to_create || [],
        baselineCommit: plan.capability_base_commit || (baselineReceipt?.status === "passed" ? baselineReceipt.commit_hash : null) || "HEAD" }))
    : await runCommand(executionCommand, {
        cwd: executionCwd,
        timeoutMs: effectivePolicy.wall_timeout_ms,
        idleTimeoutMs: effectivePolicy.idle_timeout_ms,
        trustedShell: plan.source === "task_ab_acceptance",
        filesToCreate: (phase === "baseline" ? [] : plan.files_to_create || []).map((file) => path.relative(executionCwd, path.resolve(cwd, file))),
        baselineCommit: plan.capability_base_commit || (baselineReceipt?.status === "passed" ? baselineReceipt.commit_hash : null) || "HEAD",
      });
  const plannerClassifiedResult = !hasExecutionChecks && !["task_ab_acceptance", "operator_approved_operation"].includes(plan.source) && phase === "baseline"
    ? classifyPackageManagerTestPlanFailure(executionCommand, rawResult)
    : rawResult;
  const result = hasExecutionChecks ? plannerClassifiedResult : classifyNestedRunnerInfrastructureFailure(
    executionCommand,
    plannerClassifiedResult,
    { projectRoot: executionCwd },
  );
  const cleanupOptions = { cwd, siblingOwnedPaths, cleanupWorktree, cleanupPaths, allowProjectedBaseline };
  let { cleanupStatus, cleanupError, siblingPaths } = await restoreAfterTest({
    ...cleanupOptions,
    before,
    beforeDirtyDigests,
    actualCommit,
    originalHeadRef,
  });
  const cleanedUp = ["not_needed", "completed"].includes(cleanupStatus);
  // When nothing was declared, the changed test files are the plan and have
  // no baseline: their failures are compared with the base tree here.
  const planAttribution = phase === "post_change" && cleanedUp
    ? (plan.source === "changed_unit_tests"
      ? await attributeChangedTestFailures(result.file_results, { ...changedTestsBase, policy: effectivePolicy, cleanupOptions })
      : await attributeDeclaredTestFailure(result, plan, { ...changedTestsBase, policy: effectivePolicy, cleanupOptions }))
    : null;
  // Only once the plan's drift check and cleanup are done do the changed test
  // files run, in a window of their own.
  if (["failed", "unavailable"].includes(planAttribution?.cleanup_status)) {
    cleanupStatus = planAttribution.cleanup_status;
    cleanupError = planAttribution.error;
  }
  const testCounts = result.test_counts || testExecutionCounts(`${result.stdout || ""}\n${result.stderr || ""}`);
  const fileInvoked = (plan.intent || "test") === "test"
    && didInvokeTestFile(result, executionCommand, cwd, plan.cwd_relative, testCounts);
  // A changed test file the plan command itself names, which the plan's
  // passing run on this same tree demonstrably executed, already has its
  // proof; the changed-test window would only repeat it. A failed or
  // count-less plan run proves nothing about any one file, so then every
  // changed file runs for its own attribution. The receipt keeps the full path
  // list as its identity and records which paths the plan covered.
  const coveredByPlan = changedTestPaths.length > 0
    ? changedTestPathsCoveredByPlan(changedTestPaths, plan, result, testCounts, { cwd, fileInvoked })
    : [];
  const changedTestsToRun = changedTestPaths.filter((candidate) => !coveredByPlan.includes(candidate));
  let changedTests = null;
  if (changedTestPaths.length > 0 && ["not_needed", "completed"].includes(cleanupStatus)) {
    changedTests = changedTestsToRun.length > 0
      ? await runChangedUnitTests(changedTestsToRun, effectivePolicy, cleanupOptions, changedTestsBase)
      : changedTestsCoveredByPlanResult(cwd);
    if (coveredByPlan.length > 0) {
      changedTests = { ...changedTests, paths: changedTestPaths, executed_paths: changedTestsToRun, covered_by_plan: coveredByPlan };
    }
  }
  const noTestsExecuted = result.status === "passed" && testCounts
    && (testCounts.total === 0 || testCounts.skipped === testCounts.total);
  const coverageStatus = hasExecutionChecks
    ? aggregateCheckCoverageStatus(result.check_runs)
    : testCoverageStatus(result, plan.intent || "test", testCounts, { fileInvoked });
  const receiptData = {
    kind: RECEIPT_KIND,
    schema_version: RECEIPT_SCHEMA_VERSION,
    phase,
    plan_id: plan.plan_id,
    command: plan.command,
    execution_command: executionCommand,
    cwd_relative: plan.cwd_relative || null,
    source: plan.source,
    ...(plan.capability_base_commit ? { capability_base_commit: plan.capability_base_commit } : {}),
    files_to_create: plan.files_to_create || [],
    ...(Array.isArray(plan.unit_test_paths) ? { unit_test_paths: plan.unit_test_paths } : {}),
    ...(Array.isArray(plan.covered_unit_test_paths) ? { covered_unit_test_paths: plan.covered_unit_test_paths } : {}),
    ...(Array.isArray(plan.execution_checks) ? { execution_checks: plan.execution_checks } : {}),
    ...(Array.isArray(plan.unresolved_test_paths) ? { unresolved_test_paths: plan.unresolved_test_paths } : {}),
    ...(plan.repository_plan_ignored ? { repository_plan_ignored: plan.repository_plan_ignored } : {}),
    ...(Array.isArray(result.check_runs) ? { check_runs: result.check_runs } : {}),
    verification_eligible: plan.verification_eligible !== false,
    commit_hash: commitHash || actualCommit,
    executed_commit_hash: actualCommit,
    tested_integrated_descendant: testedIntegratedDescendant,
    // Sibling jobs wrote while this ran: the tested tree was neither this
    // commit nor a stable mix, so the result is not evidence about either.
    // Unavailable is never reused or shared, so the same-commit rerun applies.
    status: cleanupStatus === "failed" || cleanupStatus === "unavailable"
      ? "infrastructure_error"
      : siblingPaths.size > 0 ? "unavailable"
        : noTestsExecuted ? "skipped" : result.status,
    ok: cleanupStatus === "failed" || cleanupStatus === "unavailable" || siblingPaths.size > 0
      ? null
      : noTestsExecuted ? null : result.ok,
    test_counts: testCounts,
    file_results: result.file_results || [],
    coverage_status: coverageStatus,
    exit_code: result.code,
    signal: result.signal,
    timed_out: result.timed_out,
    timeout_kind: result.timeout_kind || null,
    ...receiptIdentity,
    ...(siblingPaths.size > 0 ? { tree_state: "mixed" } : {}),
    duration_ms: result.duration_ms,
    failure_fingerprint: (hasExecutionChecks && checkRunsFailureFingerprint(result.check_runs)) || testFailureFingerprint(result, { executionRoot: cwd }),
    failure_inventory: testFailureInventory(result, { executionRoot: cwd }),
    execution_root: cwd,
    reason: cleanupError || (siblingPaths.size > 0 ? "concurrent_sibling_writes" : null)
      || (noTestsExecuted ? "no_tests_executed" : result.reason) || null,
    missing_executable: result.missing_executable || null,
    cleanup_status: cleanupStatus,
    ...(siblingPaths.size > 0 ? { concurrent_sibling_paths: [...siblingPaths].slice(0, 50) } : {}),
    stdout: result.stdout,
    stderr: result.stderr,
    stdout_truncated: result.stdout_truncated,
    stderr_truncated: result.stderr_truncated,
    ...(planAttribution ? { baseline_attribution: planAttribution } : {}),
    ...(changedTests ? { changed_tests: changedTests } : {}),
    // A rerun after dependency repair records the repair on the stored
    // artifact, not only on the in-memory receipt handed back to the caller.
    ...(dependencyRepair ? { dependency_repair: dependencyRepair } : {}),
    created_at: new Date().toISOString(),
  };
  const delta = baselineReceipt || planAttribution ? testExecutionDelta(baselineReceipt, receiptData) : null;
  const comparison = delta === "fixed"
    ? "fixed"
    : delta === "persistent_failure"
      ? "persistent"
      : delta === "regression"
        ? "regressed"
        : "not_comparable";
  return storeReceipt(job, attemptId, {
    ...receiptData,
    verification_outcome: verificationOutcome(receiptData, { comparison }),
  });
}

async function retryAfterDependencyRepair(receipt, repairDependencies, rerun) {
  if (receipt?.reason !== "test_task_dependency_unavailable"
    || typeof repairDependencies !== "function") {
    return receipt;
  }
  let repair = null;
  try {
    repair = await repairDependencies(receipt);
  } catch (error) {
    repair = { ok: false, error: error?.message || String(error) };
  }
  if (repair?.ok !== true) {
    const dependencyRepair = {
      ok: false,
      status: repair?.status || null,
      reason: repair?.reason || null,
      error: repair?.error || repair?.message || null,
    };
    if (dependencyRepair.reason === VERIFICATION_DEPENDENCY_LOCK_INVALID) {
      const failedReceipt = {
        ...receipt,
        status: "failed",
        ok: false,
        reason: VERIFICATION_DEPENDENCY_LOCK_INVALID,
        dependency_repair: dependencyRepair,
      };
      return {
        ...failedReceipt,
        verification_outcome: verificationOutcome(failedReceipt),
      };
    }
    return {
      ...receipt,
      dependency_repair: dependencyRepair,
    };
  }
  const dependencyRepair = {
    ok: true,
    status: repair.status || "ok",
    ...(Array.isArray(repair.results) && repair.results.some((entry) => entry?.command === "link:primary_checkout")
      ? { via: "primary_checkout_link" }
      : {}),
  };
  const repairedReceipt = await rerun(dependencyRepair);
  return { ...repairedReceipt, dependency_repair: dependencyRepair };
}

export async function __testRetryAfterDependencyRepair(receipt, repairDependencies, rerun) {
  return retryAfterDependencyRepair(receipt, repairDependencies, rerun);
}

function pruneJobTests(job, payload, cwd) {
  payload ||= {};
  const baseline = job?.id ? findLatestFrozenTestBaseline(job.id) : null;
  const withBaseline = baseline?.status === "passed" && baseline.commit_hash
    && baseline.commit_hash !== payload._test_capability_base_commit
    ? { ...payload, _test_capability_base_commit: baseline.commit_hash } : payload;
  // The persisted prune links the primary checkout's lock-matched install
  // first, so its descendants do not inherit a runner the link would supply.
  const pruned = pruneTestHandoff(withBaseline, cwd, { jobId: job?.id, linkDependencies: linkPrimaryTestDependencies });
  if (pruned !== payload) {
    // Persist before dev/assessment handoff so fix and replan descendants do
    // not inherit the discarded command. Historical receipts stay intact.
    Object.assign(payload, pruned);
    if (job?.id) {
      job.payload_json = JSON.stringify(payload);
      updateJobPayload(job.id, job.payload_json);
    }
  }
  return payload;
}

export async function ensurePreDevelopmentTestBaseline({
  job,
  payload,
  cwd,
  timeoutMs = null,
  idleTimeoutMs = undefined,
  policy = null,
  cleanupWorktree = null,
  siblingOwnedPaths = null,
  repairDependencies = null,
} = {}) {
  if (!cwd) {
    const legacy = findFrozenTestBaseline(job?.id);
    return legacy ? { ...legacy, reused: true } : null;
  }
  const effectivePolicy = effectiveVerificationPolicy({ cwd, policy, timeoutMs, idleTimeoutMs });
  payload = pruneJobTests(job, payload, cwd);
  const plan = resolveFrozenTestPlan(job, payload, { cwd });
  if (!plan) return null;
  const existing = findFrozenTestBaseline(job?.id, { policy: effectivePolicy, projectDir: cwd, planId: plan.plan_id });
  if (existing) return { ...existing, reused: true };
  // An approved operational command is intentionally single-phase. Running a
  // migration, build, generator, or server-start command against the baseline
  // can mutate state before implementation and still is not test evidence.
  if (plan.source === "operator_approved_operation") return null;
  const rootJobId = Number(payload?.root_job_id || payload?.original_job_id || 0);
  if (Number.isSafeInteger(rootJobId) && rootJobId > 0 && rootJobId !== Number(job?.id)) {
    const rootBaseline = findFrozenTestBaseline(rootJobId, { policy: effectivePolicy, projectDir: cwd, planId: plan.plan_id });
    if (rootBaseline?.plan_id === plan.plan_id) {
      return storeRepositoryBaselineReference(job, rootBaseline, { reuseScope: "lineage_root" });
    }
  }
  const headCommit = await currentCommit(cwd);
  const headPorcelain = await porcelain(cwd);
  const repositoryBaseline = headPorcelain === ""
    ? await findRepositoryFrozenTestBaseline({
        jobId: job?.id,
        planId: plan.plan_id,
        commitHash: headCommit,
        policy: effectivePolicy,
        projectDir: cwd,
        treeFingerprint: worktreeFingerprint(headCommit, headPorcelain),
      })
    : null;
  if (repositoryBaseline) return storeRepositoryBaselineReference(job, repositoryBaseline);
  const prior = findLatestFrozenTestBaseline(job?.id);
  if (prior) {
    // A non-reusable baseline may be retried only while the worktree is still
    // at the same pre-development commit. Once implementation has committed,
    // recording a new "baseline" would test the changed tree and can disguise
    // a regression as a persistent pre-existing failure.
    if (!prior.commit_hash || !headCommit || prior.commit_hash !== headCommit) {
      const ownAttemptCommits = getDb().prepare(`
        SELECT commit_hash FROM job_attempts
        WHERE job_id = ? AND commit_hash IS NOT NULL AND TRIM(commit_hash) != ''
      `).all(Number(job?.id)).map((row) => String(row.commit_hash || "").trim()).filter(Boolean);
      let ownCommitReachable = false;
      for (const commit of ownAttemptCommits) {
        if (await isAncestorCommit(cwd, commit, headCommit)) {
          ownCommitReachable = true;
          break;
        }
      }
      if (ownCommitReachable) return null;
    }
  }
  const rootBaseCommit = String(payload?.root_base_commit || "").trim();
  const lineagePaths = [...new Set([
    ...(Array.isArray(payload?.files_to_modify) ? payload.files_to_modify : []),
    ...(Array.isArray(payload?.files_to_create) ? payload.files_to_create : []),
    ...(Array.isArray(payload?.files_to_delete) ? payload.files_to_delete : []),
  ])];
  const useLineageProjection = !!(rootBaseCommit && lineagePaths.length > 0);
  const runAt = async (executionCwd, cleanup) => {
    const executeBaseline = (dependencyRepair = null) => executeReceipt({
      job, plan, phase: "baseline", cwd: executionCwd,
      commitHash: rootBaseCommit || headCommit || null,
      policy: effectivePolicy, cleanupWorktree: cleanup,
      siblingOwnedPaths: executionCwd === cwd ? siblingOwnedPaths : null,
      dependencyRepair,
      allowProjectedBaseline: useLineageProjection,
    });
    const runBaseline = (dependencyRepair = null) => useLineageProjection
      ? withLineagePathsRestored({ cwd: executionCwd, baseCommit: rootBaseCommit, paths: lineagePaths,
          run: () => executeBaseline(dependencyRepair) })
      : executeBaseline(dependencyRepair);
    const receipt = await runBaseline();
    return retryAfterDependencyRepair(receipt,
      typeof repairDependencies === "function" ? (unavailable) => repairDependencies(unavailable, executionCwd) : null,
      (dependencyRepair) => runBaseline(dependencyRepair));
  };
  // A sibling placeholder is one instance of dirty shared state. Test HEAD
  // in isolation rather than special-casing filenames or ignoring dirty bytes.
  return headPorcelain && headCommit && !useLineageProjection
    ? withBaselineCheckout({ cwd, commit: headCommit, run: runAt })
    : runAt(cwd, cleanupWorktree);
}

/** A path test for the task's declared scope; an undeclared scope admits every path. */
function declaredScopeIncludes(payload = {}) {
  const normalize = (value) => String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const files = new Set(["files_to_modify", "files_to_create", "files_to_delete"]
    .flatMap((field) => (Array.isArray(payload?.[field]) ? payload[field] : []))
    .map(normalize)
    .filter(Boolean));
  const roots = (Array.isArray(payload?.create_roots) ? payload.create_roots : []).map(normalize).filter(Boolean);
  if (files.size === 0 && roots.length === 0) return () => true;
  return (candidate) => files.has(candidate) || roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
}

// The commit a job's lineage started from: the fix chain's root_base_commit,
// else the base recorded on the root job's first committed attempt. A read of
// the run database only; it never runs Git.
export function lineageBaseCommit(job, payload) {
  const recorded = String(payload?.root_base_commit || "").trim();
  if (recorded) return recorded;
  const rootJobId = Number(payload?.root_job_id || payload?.original_job_id || job?.id);
  if (!Number.isSafeInteger(rootJobId) || rootJobId <= 0) return "";
  return String(getDb().prepare(`
    SELECT commit_base_hash FROM job_attempts
    WHERE job_id = ? AND commit_base_hash IS NOT NULL AND TRIM(commit_base_hash) != ''
    ORDER BY attempt_number, id LIMIT 1
  `).get(rootJobId)?.commit_base_hash || "").trim();
}

/**
 * The discovered unit test files in the task's declared scope that changed
 * since the lineage base, up to `head` or, when `head` is null, the working
 * tree. The post-change receipt and final_review both run these, so a fix runs
 * the tests its root wrote whether or not the fix edits them. Paths in
 * `exclude` (the declared plan's own files) are left out; at most 24 return.
 * `scopePaths` is every in-scope changed path, the change to project back
 * when a failure is compared with the base tree. `addedPaths` are the `paths`
 * the lineage created (added, or the new side of a rename or copy): the base
 * tree has no such file.
 */
export async function lineageChangedTestPaths({
  job,
  payload,
  cwd,
  head = null,
  fallbackBase = null,
  exclude = [],
} = {}) {
  const none = { base: null, paths: [], scopePaths: [], addedPaths: [] };
  if (!cwd || !["dev", "fix"].includes(String(job?.job_type || ""))
    || String(payload?.task_mode || "code") !== "code") return none;
  const base = lineageBaseCommit(job, payload) || String(fallbackBase || "").trim();
  if (!base) return none;
  let changed;
  try {
    const range = head ? [`${base}..${head}`] : [base];
    const output = await gitExecAsync(["diff", "--name-status", "-z", ...range, "--"], cwd, { trim: false });
    changed = nameStatusChanges(output);
  } catch {
    return { ...none, base };
  }
  const inScope = declaredScopeIncludes(payload);
  const scopePaths = changed.paths.filter((candidate) => inScope(candidate));
  const capability = discoverUnitTestCapability({ projectDir: cwd });
  const excluded = new Set(exclude);
  const runnable = (candidates) => candidates
    .filter((candidate) => inScope(candidate) && capability.files.includes(candidate) && !excluded.has(candidate))
    .slice(0, 24);
  return { base, paths: runnable(scopePaths), scopePaths, addedPaths: runnable(changed.added) };
}

// `git diff --name-status -z`: a status field, then one path, or for a rename
// or copy the old and new paths. Each change is named by its resulting path,
// as `--name-only` names it; the added ones are listed apart.
function nameStatusChanges(output) {
  const fields = String(output || "").split("\0");
  const paths = [];
  const added = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index];
    if (!status) { index += 1; continue; }
    const renamed = /^[RC]/u.test(status);
    const target = fields[index + (renamed ? 2 : 1)];
    index += renamed ? 3 : 2;
    if (!target) continue;
    paths.push(target);
    if (renamed || status.startsWith("A")) added.push(target);
  }
  return { paths, added };
}

/**
 * The plan for changed test files nothing declared: the discovered unit test
 * files among `paths` (at most 24) and nothing else. Repository checks belong
 * to the declared plan and never join this one, so their debt is never
 * charged to the change's own tests. Null when no path resolves. `base` and
 * `scopePaths` let a failing file be compared with the lineage base tree.
 */
export function changedUnitTestPlan(paths, { cwd, capability = null, base = null, scopePaths = [] } = {}) {
  if (!cwd) return null;
  const discovered = new Set((capability || discoverUnitTestCapability({ projectDir: cwd })).files);
  const unitTestPaths = [...new Set((Array.isArray(paths) ? paths : [])
    .map((value) => String(value || "").trim().replace(/\\/g, "/"))
    .filter((value) => discovered.has(value)))]
    .slice(0, 24);
  if (unitTestPaths.length === 0) return null;
  const command = unitTestPaths.join(", ");
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    command,
    execution_command: command,
    cwd_relative: null,
    source: "changed_unit_tests",
    plan_id: sha256(`changed_unit_tests\0${unitTestPaths.join("\0")}`),
    check_id: `unit_tests:${sha256(unitTestPaths.join("\0")).slice(0, 16)}`,
    intent: "test",
    verification_plan: null,
    validation_error: null,
    verification_eligible: true,
    unit_test_paths: unitTestPaths,
    changed_tests_base: base || null,
    changed_tests_scope: Array.isArray(scopePaths) ? scopePaths : [],
  };
}

export async function ensurePostChangeTestReceipt({
  job,
  payload,
  cwd,
  commitHash = null,
  attemptId = null,
  timeoutMs = null,
  idleTimeoutMs = undefined,
  policy = null,
  cleanupWorktree = null,
  siblingOwnedPaths = null,
  repairDependencies = null,
} = {}) {
  if (!cwd) return null;
  payload = pruneJobTests(job, payload, cwd);
  const effectivePolicy = effectiveVerificationPolicy({ cwd, policy, timeoutMs, idleTimeoutMs });
  const baseline = findFrozenTestBaseline(job?.id, { policy: effectivePolicy, projectDir: cwd });
  const assessedCommit = commitHash || await currentCommit(cwd);
  let plan = baseline
    ? frozenTestPlanFromReceipt(baseline)
    : resolveFrozenTestPlan(job, payload, { cwd });
  // An in-flight job may already have failed receipts for the discarded
  // selection. Record its current unavailable result rather than leaving a
  // historical failure as the latest evidence for this same candidate.
  if (!plan && payload._pruned_tests?.length) {
    plan = prunedTestPlan(payload);
  }
  if (plan && payload._test_capability_base_commit) plan = { ...plan, capability_base_commit: payload._test_capability_base_commit };
  const lineageBase = lineageBaseCommit(job, payload);
  // Every discovered test file the change creates or edits runs in the
  // post-change receipt, whether or not the task was asked to write tests. The
  // change is taken from the lineage base, so a fix also runs the tests its
  // root wrote, and held to the task's declared scope, since sibling jobs
  // commit to the same branch.
  const changed = assessedCommit
    ? await lineageChangedTestPaths({
        job,
        payload,
        cwd,
        head: assessedCommit,
        fallbackBase: baseline?.commit_hash,
        exclude: [],
      })
    : { base: null, paths: [], scopePaths: [], addedPaths: [] };
  const changedPaths = changed.paths;
  // A failing changed test file is compared with the base tree before it
  // counts against the change.
  const changedAttribution = { changed_tests_base: changed.base, changed_tests_scope: changed.scopePaths };
  if (changedPaths.length > 0 && plan) {
    // They join the declared plan rather than replace it.
    plan = { ...plan, changed_unit_test_paths: changedPaths, ...changedAttribution };
  } else if (changedPaths.length > 0) {
    plan = changedUnitTestPlan(changedPaths, { cwd, base: changed.base, scopePaths: changed.scopePaths });
  }
  if (!plan) return null;
  plan = { ...plan, ...changedAttribution };
  const debtIdentitiesFor = async (postChange) => {
    const identities = new Set();
    const add = (receipt) => {
      const identity = comparableTestFailureFingerprint(receipt);
      if (receipt?.status === "failed" && identity) identities.add(identity);
    };
    add(baseline);
    if (lineageBase) {
      const candidates = repositoryReceiptCandidates(job.id)
        .filter((receipt) => receipt.status === "failed"
          && receipt.command === plan.command
          && (receipt.cwd_relative || null) === (plan.cwd_relative || null)
          && receipt.commit_hash)
        .slice(0, 64);
      for (const receipt of candidates) {
        if (receipt.commit_hash === lineageBase || await isAncestorCommit(cwd, receipt.commit_hash, lineageBase)) add(receipt);
      }
    }
    const postIdentity = comparableTestFailureFingerprint(postChange);
    return {
      debt_failure_identities: [...identities].sort(),
      debt_only: postChange?.status === "failed" && (
        (!!postIdentity && identities.has(postIdentity))
        || postChange?.baseline_attribution?.debt_only === true
        || testExecutionDelta(baseline, postChange) === "persistent_failure"
      ),
    };
  };
  // The changed test files' result is reused only on the same terms as the
  // plan's: they ran to a pass or a fail. One that never ran to a result runs
  // again on reassessment, with the plan.
  const changedTestPaths = JSON.stringify(plan.changed_unit_test_paths || []);
  const currentHead = await currentCommit(cwd);
  const currentPorcelain = await porcelain(cwd);
  const reusableTreeFingerprint = currentHead && currentPorcelain === ""
    ? worktreeFingerprint(currentHead, currentPorcelain) : null;
  // A pass whose coverage was never established is not reused either: a
  // reassessment, or a retry after the runner was fixed, runs it again under
  // the current parsers instead of replaying the same unverified result.
  // Baselines keep isReusableReceipt's terms (findFrozenTestBaseline).
  const unestablished = (coverage) => UNESTABLISHED_COVERAGE_STATUSES.includes(coverage);
  const coverageEstablished = (receipt) => receipt.status !== "passed" || (
    !unestablished(receipt.coverage_status)
    && !(Array.isArray(receipt.check_runs) ? receipt.check_runs : [])
      .some((check) => check?.intent === "test" && unestablished(check.coverage_status))
  );
  const existing = findPostChangeReceipt(job.id, plan.plan_id, assessedCommit, {
    policy: effectivePolicy,
    projectDir: cwd,
    treeFingerprint: reusableTreeFingerprint,
    accept: (receipt) => ![plan, ...(plan.execution_checks || [])].some((check) => testCommandCapability(check.command, cwd))
      && coverageEstablished(receipt) && (changedTestPaths === "[]" || (
      REUSABLE_RECEIPT_STATUSES.has(receipt.changed_tests?.status)
      && JSON.stringify(receipt.changed_tests.paths || []) === changedTestPaths
    )),
  });
  if (existing) {
    const debt = await debtIdentitiesFor(existing);
    const reuseRecordId = recordPostChangeReuse(job, attemptId, existing);
    return {
      baseline,
      post_change: { ...existing, reused: true,
        reuse_source_artifact_id: existing.artifact_id,
        reuse_record_artifact_id: reuseRecordId },
      reused: true,
      ...debt,
    };
  }
  const firstPostChange = await executeReceipt({
    job,
    plan,
    phase: "post_change",
    cwd,
    commitHash: assessedCommit,
    attemptId,
    policy: effectivePolicy,
    cleanupWorktree,
    siblingOwnedPaths,
    baselineReceipt: baseline,
  });
  const postChange = await retryAfterDependencyRepair(
    firstPostChange,
    repairDependencies,
    (dependencyRepair) => executeReceipt({
      job,
      plan,
      phase: "post_change",
      cwd,
      commitHash: assessedCommit,
      attemptId,
      policy: effectivePolicy,
      cleanupWorktree,
      siblingOwnedPaths,
      baselineReceipt: baseline,
      dependencyRepair,
    }),
  );
  const debt = await debtIdentitiesFor(postChange);
  return {
    baseline,
    post_change: postChange,
    reused: false,
    ...debt,
  };
}

function jobScopeFiles(jobId) {
  try {
    const row = getDb().prepare("SELECT payload_json FROM jobs WHERE id = ?").get(Number(jobId));
    const payload = JSON.parse(row?.payload_json || "{}");
    return [
      ...(Array.isArray(payload.files_to_modify) ? payload.files_to_modify : []),
      ...(Array.isArray(payload.files_to_create) ? payload.files_to_create : []),
    ];
  } catch {
    return [];
  }
}

export function testRunScopeAttribution(jobId, { baseline = null, post_change: postChange = null, postChange: postChangeAlias = null } = {}) {
  return scopedTypecheckAttribution(baseline, postChange || postChangeAlias, {
    scopeFiles: jobScopeFiles(jobId),
    siblingOwned: (paths) => siblingJobScopePaths(jobId, paths),
  });
}

export function latestTestReceiptDelta(jobId, { commitHash = null } = {}) {
  const receipts = storedReceipts(jobId)
    .sort((left, right) => Number(right.artifact_id || 0) - Number(left.artifact_id || 0));
  // Receipts accumulate across attempts. Without a commit filter, a stale
  // post_change receipt from an earlier attempt (e.g. a 'regression' pair)
  // would be paired against a later attempt's reworked code and poison its
  // verdict. When the caller names the assessed commit, only a post_change
  // receipt for that exact commit counts; older receipts yield delta null.
  const postChange = receipts.find((receipt) => (
    receipt.phase === "post_change"
    && (!commitHash || receipt.commit_hash === commitHash)
  )) || null;
  if (commitHash && !postChange) {
    return { delta: null, baseline: null, postChange: null };
  }
  const baseline = receipts.find((receipt) => (
    receipt.phase === "baseline"
    && (!postChange?.plan_id || receipt.plan_id === postChange.plan_id)
  )) || null;
  let delta = baseline || postChange ? testExecutionDelta(baseline, postChange) : null;
  const scopeAttribution = SCOPE_ATTRIBUTABLE_DELTAS.has(delta)
    ? testRunScopeAttribution(jobId, { baseline, post_change: postChange })
    : null;
  if (scopeAttribution && !scopeAttribution.attributable) delta = "out_of_scope_failure";
  return {
    delta,
    baseline,
    postChange,
    ...(scopeAttribution ? { scope_attribution: scopeAttribution } : {}),
  };
}

export function __testRunDeterministicTestCommand(command, options = {}) {
  return runCommand(command, options);
}

export function __testParseCommandArguments(command) {
  return parseCommandArguments(command);
}
