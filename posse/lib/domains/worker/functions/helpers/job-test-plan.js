import fs from "node:fs";
import path from "node:path";
import { JOB_TESTS_DEFERRED_TO_INTEGRATION } from "../../../../catalog/verification.js";
import { jobTestPaths, unfinishedTestOwners } from "../../../queue/functions/job-test-scope.js";
import { discoverUnitTestCapability } from "../../../../shared/tools/functions/toolkit/unit-test-runner.js";
import { packageManagerScriptForwardedArgs } from "../../../verification/functions/planner-test-command.js";
import { nodeRunnerCommand } from "../../../verification/functions/node-runner-command.js";
import { parseCommandArguments } from "../../../../shared/scope/functions/test-command.js";
import { sha256 } from "../../../../shared/format/functions/sha256.js";

function broadTestSelection(check, cwd, depth = 0) {
  if (check.unit_test_paths?.length || check.covered_unit_test_paths?.length) return false;
  const command = check.command || check.execution_command || "";
  const script = packageManagerScriptForwardedArgs(command);
  if (script && /^test(?:$|[:.-])/i.test(script.script || "")) {
    if (depth >= 4) return true;
    const root = path.resolve(cwd, script.cwd_relative || check.cwd_relative || ".");
    try {
      const body = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts?.[script.script];
      if (!body) return true;
      return broadTestSelection({ command: body }, root, depth + 1);
    } catch { return true; }
  }
  let words;
  try { words = parseCommandArguments(command); } catch { return false; }
  const launched = nodeRunnerCommand(command);
  const runner = launched?.runner || path.basename(words[0] || "");
  if (launched) words = [runner, ...launched.args];
  const discoverer = /^(?:jest|vitest|pytest|phpunit)(?:\.exe)?$/.test(runner)
    || (/^node(?:\.exe)?$/.test(runner) && words.includes("--test"));
  if (!discoverer) return false;
  if (["jest", "vitest"].includes(runner)) return true;
  if (words.some((arg) => /[?*{}]/.test(arg))) return true;
  // A missing explicit file is still a bounded selection. The verifier, not
  // broad-suite deferral, owns its unavailable-file diagnostic.
  return !words.slice(1).some((arg) => !arg.startsWith("-")
    && /\.(?:[cm]?[jt]s|py|php)$/.test(arg));
}

// Broad test discovery belongs to the isolated merge-candidate gate. Keep
// explicit file commands and non-test registry obligations intact; their
// post-change execution also runs in a detached, immutable checkout.
export function scopeJobTestPlan(plan, { job, payload = {}, cwd, declaredPaths = [] } = {}) {
  if (!plan || !cwd || !["dev", "fix"].includes(job?.job_type)
    || plan.source === "operator_approved_operation") return plan;
  if (plan.validation_error && plan.validation_error !== JOB_TESTS_DEFERRED_TO_INTEGRATION) return plan;
  const owners = unfinishedTestOwners(job, payload);
  const exact = [...new Set([...(plan.unit_test_paths || []), ...(plan.covered_unit_test_paths || []), ...declaredPaths])];
  const checks = plan.execution_checks || [plan];
  for (const check of checks) for (const file of [...(check.unit_test_paths || []), ...(check.covered_unit_test_paths || [])]) {
    if (!exact.includes(file)) exact.push(file);
  }
  const deferred = plan.deferred_checks || checks.filter((check) => broadTestSelection(check, cwd)).map((check) => ({
    command: check.command, execution_command: check.execution_command, cwd_relative: check.cwd_relative || null,
  }));
  const blocked = exact.filter((file) => owners.has(file));
  if (!deferred.length && !blocked.length) return plan;
  if (plan.deferred_checks && !blocked.length && plan.unit_test_paths?.length) return plan;
  const candidates = [...new Set([...jobTestPaths(payload), ...exact])];
  const capability = discoverUnitTestCapability({ projectDir: cwd });
  const selected = candidates.filter((file) => !owners.has(file) && capability.files.includes(file));
  const retainedChecks = plan.execution_checks?.filter((check) => !broadTestSelection(check, cwd)
    && !check.unit_test_paths?.length && !check.covered_unit_test_paths?.length);
  const planId = sha256(`job-tests-v1\0${selected.join("\0")}\0${JSON.stringify([deferred, retainedChecks || []])}`);
  const primary = { ...plan, cwd_relative: null, plan_id: planId,
    check_id: `unit_tests:${planId.slice(0, 16)}`, intent: "test", unit_test_paths: selected,
    covered_unit_test_paths: selected, execution_checks: undefined, deferred_checks: deferred,
    blocked_test_paths: [...new Set([...blocked, ...candidates.filter((file) => owners.has(file))])],
    validation_error: selected.length || retainedChecks?.length ? null : JOB_TESTS_DEFERRED_TO_INTEGRATION,
    verification_eligible: selected.length > 0 || !!retainedChecks?.length };
  if (retainedChecks?.length) primary.execution_checks = [...(selected.length ? [{ ...primary, deferred_checks: undefined }] : []), ...retainedChecks];
  return primary;
}
