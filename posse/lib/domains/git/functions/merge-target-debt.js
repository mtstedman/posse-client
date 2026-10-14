import { comparableTestFailureFingerprint } from "../../worker/functions/helpers/test-failure-evidence.js";
import { testExecutionDelta } from "../../worker/functions/helpers/test-execution-receipt.js";
import {
  MERGE_CHECK_ABNORMAL_FAILURE_KINDS,
  MERGE_TARGET_COMPARISON_OUTCOMES as OUTCOMES,
} from "../../../catalog/verification.js";

const MAX_ATTRIBUTION_COMMITS = 64;
const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60_000;

export function parseSquashMergeSubject(subject, targetBranch) {
  const match = /^Squash merge (\S+) into (\S+)$/.exec(String(subject || "").trim());
  return match && match[2] === targetBranch ? match[1] : null;
}

function comparableRun(result) {
  const status = result?.status === "unavailable" ? "unavailable"
    : result?.ok === true ? "passed" : "failed";
  const stdout = String(result?.stdout ?? result?.failure?.message ?? result?.output ?? "");
  const stderr = String(result?.stderr ?? "");
  return { status, stdout, stderr, exit_code: Number.isInteger(result?.exit_code) ? result.exit_code : status === "passed" ? 0 : 1,
    signal: result?.signal || null };
}

/** The comparable failure identity of one merge check result. */
export function mergeCheckFailureFingerprint(result) {
  return comparableTestFailureFingerprint(comparableRun(result));
}

// A run that timed out, was killed or overflowed its output is not a result,
// whichever runner produced it (registry failures carry timed_out/signal).
function usable(result) {
  return result && ["passed", "failed"].includes(comparableRun(result).status)
    && !MERGE_CHECK_ABNORMAL_FAILURE_KINDS.includes(result.failure_kind)
    && !result.failure?.timed_out && !result.failure?.signal;
}

// The squash commits of merged local work items in (rangeStart, targetHead].
function localIntroducers({ git, checkout, rangeStart, targetHead, targetBranch, lookupWorkItem }) {
  if (!/^[0-9a-f]{40}$/i.test(String(rangeStart || ""))) return { candidates: [], reason: "no attribution range start" };
  try {
    git(["merge-base", "--is-ancestor", rangeStart, targetHead], checkout);
    const lines = String(git(["log", "--first-parent", `--max-count=${MAX_ATTRIBUTION_COMMITS + 1}`,
      "--format=%H%x09%s", `${rangeStart}..${targetHead}`], checkout)).split("\n").filter(Boolean);
    if (lines.length > MAX_ATTRIBUTION_COMMITS) {
      return { candidates: [], reason: `more than ${MAX_ATTRIBUTION_COMMITS} target commits since the range start` };
    }
    const candidates = lines.map((line) => {
      const [commit, ...subject] = line.split("\t");
      const branch = parseSquashMergeSubject(subject.join("\t"), targetBranch);
      const workItem = branch ? lookupWorkItem(branch) : null;
      return branch && workItem?.branch_name === branch && workItem?.merge_state === "merged"
        ? { commit, branch, work_item_id: workItem.id } : null;
    }).filter(Boolean);
    return { candidates };
  } catch {
    return { candidates: [], reason: "attribution range is not on the target" };
  }
}

/**
 * Compare one failed check against the target in one checkout. A matching
 * failure is debt only after removing one locally attributed target commit
 * makes the integrated candidate pass. The attribution range starts at
 * `rangeStart`: the newest commit where this check last passed, or the work
 * item's merge base. Reruns use the candidate's own per-check timeout.
 */
export function classifyMergeTargetDebt({ candidateResult, candidateCommit, targetHead, rangeStart,
  targetBranch, checkout, git, reset, runCurrent, lookupWorkItem, deadlineMs = Date.now() + 12 * 60_000 } = {}) {
  const remaining = () => Math.max(0, deadlineMs - Date.now());
  const checkTimeoutMs = Number(candidateResult?.timeout_ms) > 0 ? Number(candidateResult.timeout_ms) : DEFAULT_CHECK_TIMEOUT_MS;
  const unverified = (reason) => ({ outcome: OUTCOMES.UNVERIFIED, reason });
  if (!usable(candidateResult) || remaining() < 1000) return unverified("candidate check did not finish normally or gate budget expired");
  const runAt = (revision) => {
    if (remaining() < 1000) return null;
    reset(revision);
    return runCurrent(Math.min(checkTimeoutMs, remaining()));
  };
  try {
    const target = runAt(targetHead);
    if (!usable(target)) return unverified("target check unavailable, abnormal, or budget expired");
    if (target.ok === true) {
      const rerun = runAt(candidateCommit);
      if (!usable(rerun)) return unverified("candidate rerun unavailable, abnormal, or budget expired");
      return { outcome: rerun.ok === true ? OUTCOMES.FLAKY_SUSPECT : OUTCOMES.REGRESSION,
        target_status: "passed", candidate_status: rerun.ok === true ? "passed" : "failed" };
    }
    const delta = testExecutionDelta(comparableRun(target), comparableRun(candidateResult));
    const range = localIntroducers({ git, checkout, rangeStart, targetHead, targetBranch, lookupWorkItem });
    if (range.candidates.length !== 1) {
      return unverified(range.reason
        || `no single local target introducer can be proven (${range.candidates.length} merged work items since ${String(rangeStart).slice(0, 12)})`);
    }
    const [introducer] = range.candidates;
    if (remaining() < 1000) return unverified("gate budget expired before isolation");
    reset(candidateCommit);
    try { git(["revert", "--no-commit", introducer.commit], checkout); }
    catch { return unverified("introducer revert conflicted"); }
    const isolated = remaining() >= 1000 ? runCurrent(Math.min(checkTimeoutMs, remaining())) : null;
    if (!usable(isolated) || isolated.ok !== true) return unverified("isolation check did not pass");
    if (!["persistent_failure", "changed_failure"].includes(delta)) return unverified(`target comparison was ${delta}`);
    const fingerprint = comparableTestFailureFingerprint(comparableRun(target));
    return { outcome: delta === "persistent_failure" ? OUTCOMES.TARGET_DEBT : OUTCOMES.CHANGED_DEBT,
      target_status: "failed", candidate_status: "failed", delta, introducer,
      failure_fingerprint: fingerprint, range_start: rangeStart };
  } catch (error) {
    return unverified(String(error?.message || error).slice(0, 240));
  } finally {
    try { reset(candidateCommit); } catch { /* checkout is disposable */ }
  }
}

/**
 * A required check that could not run on the candidate (absent runner, no
 * tests collected) is compared at the target head. Unavailable there the
 * same way, it is the repository's condition, not this change's:
 * target_unavailable proceeds under MERGE_TARGET_DEBT_AUTO_PROCEED and is
 * reported as unverified on the push offer. Unavailable only on the candidate
 * (the change deleted or skipped its tests), the gate keeps blocking.
 */
export function classifyUnavailableMergeCheck({ candidateResult, candidateCommit, targetHead, reset, runCurrent,
  deadlineMs = Date.now() + 12 * 60_000 } = {}) {
  const remaining = () => Math.max(0, deadlineMs - Date.now());
  const unverified = (reason) => ({ outcome: OUTCOMES.UNVERIFIED, reason });
  if (candidateResult?.status !== "unavailable" || !candidateResult.failure_kind) {
    return unverified("candidate check unavailable without a recorded reason");
  }
  if (remaining() < 1000) return unverified("gate budget expired before the target comparison");
  const checkTimeoutMs = Number(candidateResult.timeout_ms) > 0 ? Number(candidateResult.timeout_ms) : DEFAULT_CHECK_TIMEOUT_MS;
  try {
    reset(targetHead);
    const target = runCurrent(Math.min(checkTimeoutMs, remaining()));
    if (target?.status === "unavailable" && target.failure_kind === candidateResult.failure_kind
      && JSON.stringify(target.missing_runtime_capabilities || []) === JSON.stringify(candidateResult.missing_runtime_capabilities || [])) {
      return { outcome: OUTCOMES.TARGET_UNAVAILABLE, target_status: "unavailable", candidate_status: "unavailable",
        failure_kind: target.failure_kind };
    }
    return unverified(target?.status === "unavailable"
      ? `check unavailable on the target for a different reason (${target.failure_kind || "unknown"})`
      : "check is unavailable only on the candidate");
  } catch (error) {
    return unverified(String(error?.message || error).slice(0, 240));
  } finally {
    try { reset(candidateCommit); } catch { /* checkout is disposable */ }
  }
}
