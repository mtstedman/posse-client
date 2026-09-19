import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
import { verificationOutcome } from "../../worker/functions/helpers/verification-outcome.js";
import { repairVerificationPrerequisites } from "../../verification/functions/prerequisite-adapters.js";
import { getSetting } from "../../settings/functions/repository-settings.js";
import {
  DEFAULT_VERIFICATION_DEPENDENCY_NETWORK_POLICY,
  VERIFICATION_DEPENDENCY_LOCK_INVALID,
} from "../../../catalog/verification.js";

const RECEIPT_KIND = "assessment_scoped_checks";
const RECEIPT_SCHEMA_VERSION = 3;
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

function unavailableResult({ commit, assessedCommit = null, files, reason }) {
  const result = {
    ok: false,
    status: "unavailable",
    summary: reason,
    executed_commit_hash: commit,
    assessed_commit_hash: assessedCommit,
    verification_commit_relation: "mismatch",
    verification_eligible: false,
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
  return {
    ...result,
    verification_outcome: verificationOutcome({ ...result, phase: "post_change", reason }),
  };
}

function withVerificationOutcome(result = {}) {
  return {
    ...result,
    verification_outcome: result.verification_outcome || verificationOutcome({
      ...result,
      phase: "post_change",
      reason: result.reason || (result.status === "incomplete" ? "scoped_check_coverage_incomplete" : null),
    }),
  };
}

function receiptKey({ commit, executionCommit = commit, files }) {
  return crypto.createHash("sha256").update(JSON.stringify({
    schema_version: RECEIPT_SCHEMA_VERSION,
    commit,
    execution_commit: executionCommit,
    files,
    checks: REQUESTED_CHECKS,
  })).digest("hex");
}

async function verificationCommitRelation(cwd, expectedCommit, actualCommit, files) {
  if (!expectedCommit || !actualCommit) return { eligible: false, relation: "mismatch" };
  if (expectedCommit === actualCommit) return { eligible: true, relation: "exact" };
  try {
    await gitExecAsync(["merge-base", "--is-ancestor", expectedCommit, actualCommit], cwd);
    const changedScopedFiles = String(await gitExecAsync(
      ["diff", "--name-only", `${expectedCommit}..${actualCommit}`, "--", ...files],
      cwd,
    ) || "").trim();
    if (!changedScopedFiles) {
      return { eligible: true, relation: "descendant_unchanged_scope" };
    }
  } catch {
    // A divergent/unresolvable commit cannot provide verification coverage.
  }
  return { eligible: false, relation: "mismatch" };
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
  return { result: withVerificationOutcome(metadata.result) };
}

// Failure identity that survives the line shifts an edit introduces: check,
// file, rule and message with positional coordinates removed. Typecheck
// reports one output blob per root; each of its lines is an identity.
function failureIdentities(failure) {
  const message = String(failure?.message || "");
  const strip = (text) => text
    .replace(/\(\d+,\d+\)/gu, "")
    .replace(/:\d+:\d+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const prefix = `${failure?.check || "check"}|${failure?.file || ""}|${failure?.rule || ""}|`;
  if (!failure?.file && message.includes("\n")) {
    return message.split("\n")
      .map((line) => ({ identity: `${prefix}${strip(line)}`, text: line }))
      .filter((entry) => entry.identity !== prefix);
  }
  return [{ identity: `${prefix}${strip(message)}`, text: message }];
}

async function commitExists(cwd, commit) {
  try {
    await gitExecAsync(["cat-file", "-e", `${commit}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Failures the pre-change tree already produces are baseline debt, not a
 * regression of the assessed change. A project-wide typecheck that fails
 * before the change (an ungenerated gitignored module, an unrelated broken
 * file) would otherwise fail every commit on the branch and spawn fix jobs
 * no developer can satisfy. The same checks run at the base commit in the
 * same worktree; only failures absent there are attributed to the change.
 */
async function attributeFailuresToBaseline({
  cwd,
  result,
  baselineCommit,
  files,
  headRef,
  actualCommit,
  runChecks,
}) {
  const failedChecks = (result.checks || []).filter((check) => check.status === "failed");
  if (failedChecks.length === 0) return result;
  let baseline;
  try {
    await gitExecAsync(["checkout", "--detach", "--force", baselineCommit], cwd);
    const baselineFiles = files.filter((file) => fs.existsSync(path.join(cwd, file)));
    baseline = baselineFiles.length > 0 ? runChecks(baselineFiles) : null;
  } catch (error) {
    baseline = { error: error?.message || String(error) };
  } finally {
    await restoreGitHead(cwd, { commit: actualCommit, headRef });
  }
  const baselineChecks = new Map((baseline?.checks || []).map((check) => [check.name, check]));
  const baselineIdentities = new Set(
    (baseline?.failures || []).flatMap(failureIdentities).map((entry) => entry.identity),
  );
  const attribution = {
    commit: baselineCommit,
    ...(baseline?.error ? { error: baseline.error } : {}),
    checks: {},
  };
  const novelFailures = [];
  let suppressed = 0;
  const unattributable = new Set();
  for (const failure of result.failures || []) {
    const baseCheck = baselineChecks.get(failure.check);
    if (baseCheck?.status !== "failed") {
      novelFailures.push(failure);
      continue;
    }
    const identities = failureIdentities(failure);
    const novel = identities.filter((entry) => !baselineIdentities.has(entry.identity));
    if (novel.length === 0) {
      suppressed += 1;
      continue;
    }
    if (novel.length < identities.length) {
      // Keep only the lines the baseline did not already report.
      novelFailures.push({ ...failure, message: novel.map((entry) => entry.text).join("\n") });
      suppressed += 1;
    } else {
      novelFailures.push(failure);
    }
  }
  for (const check of failedChecks) {
    const baseCheck = baselineChecks.get(check.name);
    const novelCount = novelFailures.filter((failure) => failure.check === check.name).length;
    attribution.checks[check.name] = {
      baseline_status: baseCheck?.status || "not_run",
      novel_failure_count: novelCount,
      attributable: baseCheck?.status !== "failed" || novelCount > 0,
    };
    if (baseCheck?.status === "failed" && novelCount === 0) unattributable.add(check.name);
  }
  const remainingFailed = failedChecks.filter((check) => !unattributable.has(check.name));
  const short = baselineCommit.slice(0, 12);
  const checks = (result.checks || []).map((check) => (
    unattributable.has(check.name)
      ? { ...check, status: "baseline_debt", reason: `already failing at pre-change commit ${short}; no failure attributable to the assessed change` }
      : check
  ));
  if (remainingFailed.length === 0) {
    return {
      ...result,
      ok: null,
      status: "baseline_debt",
      reason: "scoped_checks_fail_at_baseline",
      summary: `${[...unattributable].join(", ")} already fail at the pre-change commit ${short}; no failure is attributable to the assessed change (${suppressed} pre-existing failure(s) suppressed)`,
      checks,
      failures: [],
      baseline_attribution: attribution,
    };
  }
  return {
    ...result,
    summary: `${result.summary}${suppressed > 0 ? ` (${suppressed} pre-existing failure(s) at ${short} suppressed)` : ""}`,
    checks,
    failures: novelFailures,
    baseline_attribution: attribution,
  };
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
    `The harness ran these checks before model assessment at commit ${result.executed_commit_hash || "unknown"}${result.assessed_commit_hash && result.assessed_commit_hash !== result.executed_commit_hash ? `, covering assessed commit ${result.assessed_commit_hash} (${result.verification_commit_relation || "descendant"})` : ""}. Treat the receipt as ground truth and do not rerun lint, typecheck, syntax checks, or run_scoped_checks for the listed files.`,
    `overall_status: ${result.status || "unknown"}`,
    `outcome: ${result.verification_outcome?.type || withVerificationOutcome(result).verification_outcome.type}`,
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
  repairPrerequisitesImpl = repairVerificationPrerequisites,
  readSettingImpl = getSetting,
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
  const [actualCommit, headRef, before] = await Promise.all([
    currentCommit(cwd),
    currentHeadRef(cwd),
    porcelain(cwd),
  ]);
  const commitCoverage = await verificationCommitRelation(cwd, expectedCommit, actualCommit, files);
  const key = receiptKey({ commit: expectedCommit, executionCommit: actualCommit, files: allFiles });

  let result;
  let reused = false;
  let persistReceipt = false;
  if (!commitCoverage.eligible) {
    result = unavailableResult({
      commit: actualCommit,
      assessedCommit: expectedCommit,
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
      const runOnce = () => runScopedChecksImpl({
        cwd,
        args: {
          checks: [...REQUESTED_CHECKS],
          scope: { files },
        },
      });
      result = runOnce();
      // A fresh worktree carries no installed dependencies, so the verifier
      // binaries can be missing even though the code is correct. Repair the
      // worktree once through the same adapter the frozen test path uses,
      // then re-run; if repair cannot run, the result stays "dependency
      // unavailable" rather than becoming a product failure.
      const missing = Array.isArray(result?.checks)
        ? result.checks.find((check) => check?.dependency_unavailable === true)
        : null;
      if (result?.status === "unavailable" && missing) {
        let repair;
        try {
          let networkPolicy = DEFAULT_VERIFICATION_DEPENDENCY_NETWORK_POLICY;
          try {
            networkPolicy = String(
              readSettingImpl("verification_dependency_network_policy", { projectDir: cwd })
              || DEFAULT_VERIFICATION_DEPENDENCY_NETWORK_POLICY,
            );
          } catch { /* default */ }
          repair = await repairPrerequisitesImpl({
            projectDir: cwd,
            command: missing.command || "npm",
            receipt: { execution_command: missing.command || null, stdout: missing.reason || "" },
            networkPolicy,
          });
        } catch (error) {
          repair = { ok: false, status: "failed", reason: error?.code || error?.message || "dependency_repair_failed" };
        }
        const dependencyRepair = {
          attempted: true,
          ok: repair?.ok === true,
          status: repair?.status || null,
          reason: repair?.reason || null,
          trigger: missing.reason || null,
        };
        recordObservation({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attemptId,
          observation_type: "assessment.dependency_repair",
          summary: `Scoped-check dependency repair ${dependencyRepair.ok ? "succeeded" : `did not complete (${dependencyRepair.status || "unknown"})`}`,
          detail: dependencyRepair,
        });
        if (dependencyRepair.ok) result = runOnce();
        else if (dependencyRepair.reason === VERIFICATION_DEPENDENCY_LOCK_INVALID) {
          result = {
            ...result,
            ok: false,
            status: "failed",
            summary: "The dependency lockfile is missing required package data or is out of sync with its manifest.",
            reason: VERIFICATION_DEPENDENCY_LOCK_INVALID,
            checks: (result.checks || []).map((check) => check === missing
              ? {
                  ...check,
                  status: "failed",
                  reason: VERIFICATION_DEPENDENCY_LOCK_INVALID,
                  dependency_unavailable: false,
                }
              : check),
          };
        }
        result = { ...result, dependency_repair: dependencyRepair };
      }
      const baselineCommit = normalizedCommit(assessmentContext.commit_base_hash)
        || normalizedCommit(assessmentContext.branch_net_diff_base);
      if (result?.status === "failed" && baselineCommit && baselineCommit !== expectedCommit
        && await commitExists(cwd, baselineCommit)) {
        result = await attributeFailuresToBaseline({
          cwd,
          result,
          baselineCommit,
          files,
          headRef,
          actualCommit,
          runChecks: (baselineFiles) => runScopedChecksImpl({
            cwd,
            args: { checks: [...REQUESTED_CHECKS], scope: { files: baselineFiles } },
          }),
        });
        if (result.baseline_attribution) {
          recordObservation({
            work_item_id: job.work_item_id,
            job_id: job.id,
            attempt_id: attemptId,
            observation_type: "assessment.scoped_check_baseline",
            summary: result.status === "baseline_debt"
              ? `Scoped-check failures already present at pre-change commit ${baselineCommit.slice(0, 12)}; not attributed to the change`
              : `Scoped-check failures compared against pre-change commit ${baselineCommit.slice(0, 12)}`,
            detail: result.baseline_attribution,
          });
        }
      }
      result = {
        ...result,
        assessed_commit_hash: expectedCommit,
        verification_commit_relation: commitCoverage.relation,
        verification_eligible: true,
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

  result = withVerificationOutcome(result);
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
        verification_outcome: result.verification_outcome,
        receipt_key: key,
        scoped_check_result: result,
      },
    });
  }
  return { result, evidence, reused };
}
