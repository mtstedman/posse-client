import { runScopedChecks } from "./scoped-runners.js";
import { discoverUnitTestCapability, runUnitTestFile } from "./unit-test-runner.js";

function jsonResult(label, action) {
  try { return JSON.stringify(action(), null, 2); } catch (err) { return `Error: ${label} failed - ${err?.message || String(err)}`; }
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
        return JSON.stringify(await runUnitTestFile({ projectDir: cwd, path: args?.path, capability }), null, 2);
      } catch (err) {
        return `Error: run_unit_test failed - ${err?.message || String(err)}`;
      }
    },
  };
}
