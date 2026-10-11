import { comparableTestFailureFingerprint } from "../../worker/functions/helpers/test-failure-evidence.js";
import { testExecutionDelta } from "../../worker/functions/helpers/test-execution-receipt.js";

const MAX_ATTRIBUTION_COMMITS = 64;

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

function usable(result) {
  return result && ["passed", "failed"].includes(comparableRun(result).status)
    && !["timeout", "signal", "output_overflow", "spawn_error"].includes(result.failure_kind);
}

function singleLocalIntroducer({ git, checkout, mergeBase, targetHead, targetBranch, lookupWorkItem }) {
  if (!/^[0-9a-f]{40}$/i.test(String(mergeBase || ""))) return null;
  try {
    git(["merge-base", "--is-ancestor", mergeBase, targetHead], checkout);
    const lines = String(git(["log", "--first-parent", `--max-count=${MAX_ATTRIBUTION_COMMITS + 1}`,
      "--format=%H%x09%s", `${mergeBase}..${targetHead}`], checkout)).split("\n").filter(Boolean);
    if (lines.length > MAX_ATTRIBUTION_COMMITS) return null;
    const candidates = lines.map((line) => {
      const [commit, ...subject] = line.split("\t");
      const branch = parseSquashMergeSubject(subject.join("\t"), targetBranch);
      const workItem = branch ? lookupWorkItem(branch) : null;
      return branch && workItem?.branch_name === branch && workItem?.merge_state === "merged"
        ? { commit, branch, work_item_id: workItem.id } : null;
    }).filter(Boolean);
    return candidates.length === 1 ? candidates[0] : null;
  } catch {
    return null;
  }
}

/**
 * Compare one failed check against the target in one checkout. A matching
 * failure is debt only after removing one locally attributed target commit
 * makes the integrated candidate pass.
 */
export function classifyMergeTargetDebt({ candidateResult, candidateCommit, targetHead, mergeBase,
  targetBranch, checkout, git, reset, runCurrent, lookupWorkItem, deadlineMs = Date.now() + 12 * 60_000 } = {}) {
  const remaining = () => Math.max(0, deadlineMs - Date.now());
  const unverified = (reason) => ({ outcome: "unverified", reason });
  if (!usable(candidateResult) || remaining() < 1000) return unverified("candidate check did not finish normally or gate budget expired");
  const runAt = (revision) => {
    if (remaining() < 1000) return null;
    reset(revision);
    return runCurrent(Math.min(10 * 60_000, remaining()));
  };
  try {
    const target = runAt(targetHead);
    if (!usable(target)) return unverified("target check unavailable, abnormal, or budget expired");
    if (target.ok === true) {
      const rerun = runAt(candidateCommit);
      if (!usable(rerun)) return unverified("candidate rerun unavailable, abnormal, or budget expired");
      return { outcome: rerun.ok === true ? "flaky_suspect" : "regression",
        target_status: "passed", candidate_status: rerun.ok === true ? "passed" : "failed" };
    }
    const delta = testExecutionDelta(comparableRun(target), comparableRun(candidateResult));
    const introducer = singleLocalIntroducer({ git, checkout, mergeBase, targetHead, targetBranch, lookupWorkItem });
    if (!introducer) return unverified("no single local target introducer can be proven");
    if (remaining() < 1000) return unverified("gate budget expired before isolation");
    reset(candidateCommit);
    try { git(["revert", "--no-commit", introducer.commit], checkout); }
    catch { return unverified("introducer revert conflicted"); }
    const isolated = remaining() >= 1000 ? runCurrent(Math.min(10 * 60_000, remaining())) : null;
    if (!usable(isolated) || isolated.ok !== true) return unverified("isolation check did not pass");
    if (!["persistent_failure", "changed_failure"].includes(delta)) return unverified(`target comparison was ${delta}`);
    const fingerprint = comparableTestFailureFingerprint(comparableRun(target));
    return { outcome: delta === "persistent_failure" ? "target_debt" : "changed_debt",
      target_status: "failed", candidate_status: "failed", delta, introducer,
      failure_fingerprint: fingerprint };
  } catch (error) {
    return unverified(String(error?.message || error).slice(0, 240));
  } finally {
    try { reset(candidateCommit); } catch { /* checkout is disposable */ }
  }
}
