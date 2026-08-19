import { declaredScopeFiles, runScopedChecks } from "./scoped-runners.js";
import {
  createRegisteredTest,
  createRegisteredTestSuite,
  runRegisteredTest,
  runRegisteredTestSuite,
} from "./registered-tests.js";

function actorFromOptions(options = {}) {
  return { role: options.role || null, jobId: options.jobId || null, workItemId: options.workItemId || null };
}

function jsonResult(label, action) {
  try { return JSON.stringify(action(), null, 2); } catch (err) { return `Error: ${label} failed - ${err?.message || String(err)}`; }
}

export function createTestExecutionExecutors() {
  return {
    execRunScopedChecks(args, cwd, _scopePredicates, declaredScope = {}) {
      return jsonResult("run_scoped_checks", () => runScopedChecks({ args: args || {}, cwd, declaredScope }));
    },
    execCreateTestSuite(args, cwd, _scopePredicates, _declaredScope = {}, options = {}) {
      return jsonResult("create_test_suite", () => createRegisteredTestSuite({ args: args || {}, cwd, actor: actorFromOptions(options) }));
    },
    execCreateTest(args, cwd, _scopePredicates, declaredScope = {}, options = {}) {
      return jsonResult("create_test", () => createRegisteredTest({ args: args || {}, cwd, actor: actorFromOptions(options), scopeFiles: declaredScopeFiles(cwd, declaredScope) }));
    },
    execRunTest(args, cwd, _scopePredicates, declaredScope = {}, options = {}) {
      return jsonResult("run_test", () => runRegisteredTest({ args: args || {}, cwd, actor: actorFromOptions(options), scopeFiles: declaredScopeFiles(cwd, declaredScope) }));
    },
    execRunTestSuite(args, cwd, _scopePredicates, declaredScope = {}, options = {}) {
      return jsonResult("run_test_suite", () => runRegisteredTestSuite({ args: args || {}, cwd, actor: actorFromOptions(options), scopeFiles: declaredScopeFiles(cwd, declaredScope) }));
    },
  };
}
