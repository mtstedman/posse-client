import { gitCurrentHashAsync, gitHasChangesAsync } from "../../../../domains/git/functions/utils.js";
import { runScopedChecks } from "./scoped-runners.js";
import { discoverUnitTestCapability, runUnitTestFile } from "./unit-test-runner.js";

function jsonResult(label, action) {
  try { return JSON.stringify(action(), null, 2); } catch (err) { return `Error: ${label} failed - ${err?.message || String(err)}`; }
}

// The commit a run proves something about: HEAD, and only when the worktree
// holds no uncommitted edits that the run also exercised.
async function cleanExecutedCommit(cwd) {
  try {
    const [commit, dirty] = await Promise.all([gitCurrentHashAsync(cwd), gitHasChangesAsync(cwd)]);
    const hash = String(commit || "").trim().toLowerCase();
    return dirty === false && /^[0-9a-f]{40,64}$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

export function createTestExecutionExecutors() {
  return {
    execRunScopedChecks(args, cwd, _scopePredicates, declaredScope = {}) {
      return jsonResult("run_scoped_checks", () => runScopedChecks({ args: args || {}, cwd, declaredScope }));
    },
    async execRunUnitTest(args, cwd, _scopePredicates, _declaredScope = {}, options = {}) {
      const capability = options.unitTestCapability || discoverUnitTestCapability({
        projectDir: cwd,
        scipAvailable: options.scipAvailable !== false,
      });
      try {
        const executedCommitHash = await cleanExecutedCommit(cwd);
        const result = await runUnitTestFile({ projectDir: cwd, path: args?.path, capability });
        return JSON.stringify({ ...result, executed_commit_hash: executedCommitHash }, null, 2);
      } catch (err) {
        return `Error: run_unit_test failed - ${err?.message || String(err)}`;
      }
    },
  };
}
