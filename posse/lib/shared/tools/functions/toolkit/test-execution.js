import { jobTestPermission } from "../../../../domains/queue/functions/job-test-scope.js";
import { getObservationContext } from "../../../../domains/observability/functions/observations.js";
import { TestFailureGuidance } from "../../classes/TestFailureGuidance.js";
import path from "node:path";
import { gitCurrentHashAsync, gitHasChangesAsync, gitExecAsync } from "../../../../domains/git/functions/utils.js";
import { runScopedChecks } from "./scoped-runners.js";
import { discoverUnitTestCapability, runUnitTestFile } from "./unit-test-runner.js";

function jsonResult(label, action) {
  try { return JSON.stringify(action(), null, 2); } catch (err) { return `Error: ${label} failed - ${err?.message || String(err)}`; }
}

// The commit a run proves something about: HEAD, and only when the worktree
// holds no uncommitted edits that the run also exercised.
async function cleanExecutedCommit(cwd, testPath) {
  try {
    const [commit, dirty] = await Promise.all([gitCurrentHashAsync(cwd), gitHasChangesAsync(cwd)]);
    const hash = String(commit || "").trim().toLowerCase();
    if (dirty !== false || !/^[0-9a-f]{40,64}$/.test(hash)) return null;
    // Ignored new tests are absent from ordinary Git status. Do not attribute
    // their execution to a commit that does not contain them.
    const relative = path.posix.normalize(String(testPath || "").replace(/\\/g, "/"));
    const tracked = await gitExecAsync(["ls-files", "--cached", "-z", "--", `:(literal)${relative}`], cwd, { trim: false });
    return String(tracked || "").split("\0").includes(relative) ? hash : null;
  } catch {
    return null;
  }
}

export function createTestExecutionExecutors() {
  const failureGuidance = new TestFailureGuidance();
  return {
    execRunScopedChecks(args, cwd, _scopePredicates, declaredScope = {}) {
      return jsonResult("run_scoped_checks", () => runScopedChecks({ args: args || {}, cwd, declaredScope }));
    },
    async execRunUnitTest(args, cwd, _scopePredicates, declaredScope = {}, options = {}) {
      const capability = options.unitTestCapability || discoverUnitTestCapability({
        projectDir: cwd,
        scipAvailable: options.scipAvailable !== false,
      });
      try {
        const permission = jobTestPermission(options.jobId || getObservationContext()?.job_id, args?.path);
        if (permission?.allowed === false) return JSON.stringify({ ok: null, status: "unavailable", reason: "test_outside_job_scope", path: args?.path, message: permission.reason });
        const executedCommitHash = await cleanExecutedCommit(cwd, args?.path);
        const result = await runUnitTestFile({ projectDir: cwd, path: args?.path, capability, declaredScope, scipAvailable: options.scipAvailable !== false,
          // The gateway aborts this when the calling session is released.
          signal: options.signal });
        const guidance = failureGuidance.forResult(result, options.agentCallId);
        return JSON.stringify({
          ...(guidance ? { failure_guidance: guidance } : {}),
          ...result, executed_commit_hash: executedCommitHash,
        }, null, 2);
      } catch (err) {
        return `Error: run_unit_test failed - ${err?.message || String(err)}`;
      }
    },
  };
}
