import crypto from "node:crypto";

import {
  getArtifacts,
  storeArtifact,
} from "../../queue/functions/index.js";
import { gitExecAsync } from "../../git/functions/utils.js";
import { recordObservation } from "../../observability/functions/observations.js";
import {
  declaredScopeFiles,
  runScopedChecks,
} from "../../../shared/tools/functions/toolkit/scoped-runners.js";

const RECEIPT_KIND = "assessment_scoped_checks";
const RECEIPT_SCHEMA_VERSION = 2;
const REQUESTED_CHECKS = Object.freeze(["lint", "typecheck"]);
const MAX_CHANGED_FILES = 250;

function normalizedCommit(value) {
  const commit = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{40,64}$/i.test(commit) ? commit : null;
}

function artifactJson(artifact) {
  try {
    return typeof artifact?.content_json === "string"
      ? JSON.parse(artifact.content_json)
      : artifact?.content_json;
  } catch {
    return null;
  }
}

async function currentCommit(cwd) {
  try {
    return normalizedCommit(await gitExecAsync(["rev-parse", "HEAD"], cwd));
  } catch {
    return null;
  }
}

async function currentHeadRef(cwd) {
  try {
    return String(await gitExecAsync(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd) || "").trim() || null;
  } catch {
    return null;
  }
}

async function porcelain(cwd) {
  try {
    return String(await gitExecAsync(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      cwd,
      { trim: false },
    ) || "");
  } catch {
    return null;
  }
}

async function restoreGitHead(cwd, { commit, headRef } = {}) {
  if (!commit) throw new Error("cannot restore scoped-check Git HEAD without the original commit");
  if (headRef) {
    await gitExecAsync(["checkout", "--force", headRef], cwd);
  } else {
    await gitExecAsync(["checkout", "--detach", "--force", commit], cwd);
  }
  await gitExecAsync(["reset", "--hard", commit], cwd);
}

function unavailableResult({ commit, files, reason }) {
  return {
    ok: false,
    status: "unavailable",
    summary: reason,
    executed_commit_hash: commit,
    scoped_files: files,
    checks: REQUESTED_CHECKS.map((name) => ({
      name,
      coverage: name === "typecheck" ? "project_root" : "file",
      status: "unavailable",
      reason,
      target_count: files.length,
      duration_ms: 0,
      command: null,
      targets: files,
      subchecks: null,
    })),
    failures: [],
  };
}

function receiptKey({ commit, files }) {
  return crypto.createHash("sha256").update(JSON.stringify({
    schema_version: RECEIPT_SCHEMA_VERSION,
    commit,
    files,
    checks: REQUESTED_CHECKS,
  })).digest("hex");
}

function cachedReceipt(jobId, key) {
  const artifact = getArtifacts(jobId, "log").findLast((candidate) => {
    const metadata = artifactJson(candidate);
    return metadata?.kind === RECEIPT_KIND
      && metadata?.schema_version === RECEIPT_SCHEMA_VERSION
      && metadata?.receipt_key === key
      && metadata?.result;
  });
  if (!artifact) return null;
  const metadata = artifactJson(artifact);
  return { result: metadata.result };
}

function checkStatusForFile(check, file) {
  const targets = Array.isArray(check?.targets) ? check.targets : [];
  if (!targets.includes(file)) return "not_applicable";
  const status = String(check.status || "unknown");
  return check.coverage === "project_root" ? `${status}(project_root)` : status;
}

export function renderAssessmentScopedCheckEvidence(result = null, {
  omittedFileCount = 0,
  reused = false,
} = {}) {
  if (!result) return "";
  const files = Array.isArray(result.scoped_files) ? result.scoped_files : [];
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const lines = [
    `DETERMINISTIC CHANGED-FILE CHECK RECEIPT:`,
    `The harness ran these checks before model assessment at commit ${result.executed_commit_hash || "unknown"}. Treat the receipt as ground truth and do not rerun lint, typecheck, syntax checks, or run_scoped_checks for the listed files.`,
    `overall_status: ${result.status || "unknown"}`,
    `summary: ${result.summary || "no summary"}`,
    `receipt_reused: ${reused ? "true" : "false"}`,
    `coverage_complete: ${result.coverage_complete === false ? "false" : "true"}`,
    `checked_files: ${files.length}`,
    ...(omittedFileCount > 0
      ? [`coverage_warning: ${omittedFileCount} additional changed file(s) exceeded the ${MAX_CHANGED_FILES}-file deterministic check cap.`]
      : []),
    `PER-FILE COVERAGE:`,
    ...files.map((file) => (
      `- ${file}: ${checks.map((check) => `${check.name}=${checkStatusForFile(check, file)}`).join(", ") || "no checks available"}`
    )),
    `CHECK SUMMARY:`,
    ...checks.map((check) => [
      `- ${check.name}: ${check.status || "unknown"}`,
      `coverage=${check.coverage || "file"}`,
      `targets=${Array.isArray(check.targets) ? check.targets.length : 0}`,
      check.duration_ms == null ? null : `duration_ms=${check.duration_ms}`,
      check.reason ? `reason=${check.reason}` : null,
      check.command ? `command=${check.command}` : null,
    ].filter(Boolean).join("; ")),
  ];
  const failures = Array.isArray(result.failures) ? result.failures : [];
  if (failures.length > 0) {
    lines.push(
      `FAILURES:`,
      ...failures.map((failure) => [
        failure.check || "check",
        failure.file || null,
        failure.line ? `line ${failure.line}` : null,
        failure.rule || null,
        failure.message || null,
      ].filter(Boolean).join(" — ")),
    );
  }
  return lines.join("\n");
}

export async function ensureAssessmentScopedCheckEvidence({
  job,
  attemptId = null,
  cwd,
  assessmentContext = null,
  cleanupWorktree = null,
  runScopedChecksImpl = runScopedChecks,
} = {}) {
  if (!job?.id || !cwd || assessmentContext?.task_mode !== "code") return null;
  const expectedCommit = normalizedCommit(
    assessmentContext.commit_hash || assessmentContext.branch_net_diff_head,
  );
  if (!expectedCommit) return null;

  const committedFiles = Array.isArray(assessmentContext.files_committed)
    ? assessmentContext.files_committed
    : [];
  const branchFiles = Array.isArray(assessmentContext.branch_net_diff_files)
    ? assessmentContext.branch_net_diff_files
    : [];
  const allFiles = declaredScopeFiles(cwd, {
    files: committedFiles.length > 0 ? committedFiles : branchFiles,
  }).sort();
  if (allFiles.length === 0) return null;
  const files = allFiles.slice(0, MAX_CHANGED_FILES);
  const omittedFileCount = Math.max(0, allFiles.length - files.length);
  // Cache identity covers the complete declared change set, not only the
  // executable prefix. Otherwise two >250-file changes with the same prefix
  // could reuse a receipt whose omitted-file accounting belongs to another
  // assessed scope.
  const key = receiptKey({ commit: expectedCommit, files: allFiles });
  const [actualCommit, headRef, before] = await Promise.all([
    currentCommit(cwd),
    currentHeadRef(cwd),
    porcelain(cwd),
  ]);

  let result;
  let reused = false;
  let persistReceipt = false;
  if (!actualCommit || actualCommit !== expectedCommit) {
    result = unavailableResult({
      commit: actualCommit,
      files,
      reason: `assessed commit mismatch: expected ${expectedCommit}, found ${actualCommit || "unknown"}`,
    });
  } else if (before == null) {
    result = unavailableResult({
      commit: actualCommit,
      files,
      reason: "Git worktree status was unavailable before deterministic checks",
    });
  } else if (before !== "") {
    result = unavailableResult({
      commit: actualCommit,
      files,
      reason: "worktree was not clean before deterministic changed-file checks",
    });
  } else {
    const cached = cachedReceipt(job.id, key);
    if (cached) {
      result = cached.result;
      reused = true;
    } else {
      result = runScopedChecksImpl({
        cwd,
        args: {
          checks: [...REQUESTED_CHECKS],
          scope: { files },
        },
      });
      result = {
        ...result,
        coverage_complete: omittedFileCount === 0,
        omitted_file_count: omittedFileCount,
        ...(omittedFileCount > 0 && result?.status === "passed"
          ? {
              ok: false,
              status: "incomplete",
              summary: `${omittedFileCount} changed file(s) were not checked because the deterministic scope cap was reached`,
            }
          : {}),
      };
      persistReceipt = true;
      const [after, afterCommit, afterHeadRef] = await Promise.all([
        porcelain(cwd),
        currentCommit(cwd),
        currentHeadRef(cwd),
      ]);
      const headChanged = afterCommit !== actualCommit || afterHeadRef !== headRef;
      if (after !== before || headChanged) {
        if (after !== before) {
          if (typeof cleanupWorktree !== "function") {
            throw new Error("deterministic changed-file checks modified the worktree but no cleanup implementation was available");
          }
          await cleanupWorktree();
        }
        if (headChanged) {
          await restoreGitHead(cwd, { commit: actualCommit, headRef });
        }
        const [cleaned, restoredCommit, restoredHeadRef] = await Promise.all([
          porcelain(cwd),
          currentCommit(cwd),
          currentHeadRef(cwd),
        ]);
        if (cleaned !== "" || restoredCommit !== actualCommit || restoredHeadRef !== headRef) {
          throw new Error("deterministic changed-file check cleanup did not restore the assessed worktree");
        }
        result.cleanup_status = "completed";
      }
    }
  }

  const evidence = renderAssessmentScopedCheckEvidence(result, { omittedFileCount, reused });
  if (!reused) {
    if (persistReceipt) {
      storeArtifact({
        work_item_id: job.work_item_id,
        job_id: job.id,
        artifact_type: "log",
        content_long: evidence,
        content_json: {
          kind: RECEIPT_KIND,
          schema_version: RECEIPT_SCHEMA_VERSION,
          receipt_key: key,
          commit_hash: expectedCommit,
          omitted_file_count: omittedFileCount,
          result,
        },
      });
    }
    recordObservation({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attemptId,
      observation_type: "assessment.scoped_checks",
      summary: `Harness scoped checks: ${String(result.status || "unknown").toUpperCase()} (${files.length} changed files)`,
      detail: {
        source: "assessment_harness",
        outcome: result.status === "passed" ? "succeeded" : result.status,
        ok: result.ok === true && result.status === "passed",
        receipt_key: key,
        scoped_check_result: result,
      },
    });
  }
  return { result, evidence, reused };
}
