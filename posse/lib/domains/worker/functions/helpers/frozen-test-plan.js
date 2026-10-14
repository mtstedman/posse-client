import { TEST_EXECUTION_RECEIPT_SCHEMA_VERSION as RECEIPT_SCHEMA_VERSION } from "../../../../catalog/verification.js";
import { declaredNodeTestCommand } from "../../../../shared/tools/functions/toolkit/repository-test-runner.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { parseCommandArguments } from "../../../../shared/scope/functions/test-command.js";
import { resolveLocalVitestCommand } from "../../../verification/functions/vitest-command.js";
import { resolveRepositoryVerificationPlan, VERIFICATION_PLAN_CONFIG, VERIFICATION_PLAN_SCHEMA_VERSION, verificationPlanSnapshot } from "../../../verification/functions/verification-plan.js";
import { REPOSITORY_PLAN_UNAVAILABLE_CHECK_ID } from "../../../../catalog/verification.js";
import { discoverUnitTestCapability, resolveUnitTestInvocation } from "../../../../shared/tools/functions/toolkit/unit-test-runner.js";
import { sha256 } from "../../../../shared/format/functions/sha256.js";
import { validatePlannerTestCommand, validatePlannerTestCommandForRepository, operationalCommandApprovalRequest, safeRelativeTestDirectory } from "../../../verification/functions/planner-test-command.js";

// A fix job's payload (verdicts/fail.js) carries its root task's test_command
// but not the planner's tests_to_run. A fix without its own list verifies with
// its root's non-empty one: it runs the tests the task declared, and its plan
// matches the root's, so the root's frozen baseline is reused. An empty root
// list is not inherited; the fix keeps its test_command or the repository plan.
function rootJobPayload(job, payload) {
  const rootJobId = Number(payload?.root_job_id);
  if (!Number.isSafeInteger(rootJobId) || rootJobId <= 0 || rootJobId === Number(job?.id)) return null;
  try {
    const row = getDb().prepare("SELECT payload_json FROM jobs WHERE id = ?").get(rootJobId);
    return JSON.parse(row?.payload_json || "{}");
  } catch {
    return null;
  }
}

function lineageTestsToRun(payload, rootPayload) {
  if (Array.isArray(payload?.tests_to_run)) return payload.tests_to_run;
  const rootTests = rootPayload?.tests_to_run;
  return Array.isArray(rootTests) && rootTests.length > 0 ? rootTests : null;
}

// A declared command proves one discovered test file only when its exact
// argv matches the repository runner's invocation for that file. A broad
// suite, a name filter, or a command that merely mentions the path does not.
export function exactDeclaredTestInvocation(command, cwd, cwdRelative = null) {
  if (!cwd || cwdRelative) return null;
  let argv;
  try { argv = parseCommandArguments(command); } catch { return null; }
  const capability = discoverUnitTestCapability({ projectDir: cwd });
  if (!capability.available) return null;
  const candidates = capability.files.filter((file) => argv.includes(file));
  if (candidates.length !== 1) return null;
  const invocation = resolveUnitTestInvocation(cwd, candidates[0], capability);
  if (!invocation?.runner) return null;
  const expected = [invocation.executable, ...invocation.args];
  return expected.length === argv.length && expected.every((value, index) => value === argv[index])
    ? invocation : null;
}

function exactDeclaredTestFile(command, cwd, cwdRelative = null) {
  return exactDeclaredTestInvocation(command, cwd, cwdRelative)?.path || null;
}

// A planner command is an additional selection, never a replacement for
// committed repository obligations. Keep each check's identity and command
// so execution can report which obligations actually ran.
function sameRepositoryCheckInvocation(plan, check) {
  if (Array.isArray(plan.unit_test_paths) || check.unavailable_reason
    || (check.cwd_relative || null) !== (plan.cwd_relative || null)) return false;
  return check.execution_command === plan.execution_command;
}

function primaryExecutionCheck(plan) {
  return {
    id: plan.check_id,
    command: plan.command,
    execution_command: plan.execution_command,
    cwd_relative: plan.cwd_relative || null,
    source: plan.source,
    intent: plan.intent || "test",
    ...(Array.isArray(plan.unit_test_paths) ? { unit_test_paths: plan.unit_test_paths } : {}),
  };
}

function unavailableRepositoryPlanCheck(repositoryPlan) {
  return { id: REPOSITORY_PLAN_UNAVAILABLE_CHECK_ID, command: VERIFICATION_PLAN_CONFIG, intent: "test",
    unavailable_reason: repositoryPlan.reason || "verification_plan_invalid" };
}

// Only a committed posse.verification.json registers obligations beside a
// planner selection; package scripts are never added to one, and one that
// cannot run is recorded as ignored. A registry that cannot run adds one
// unavailable obligation naming why. Neither ever rejects the planner's own
// valid command, which still runs.
function withRepositoryChecks(plan, repositoryPlan) {
  if (!plan || !repositoryPlan) return plan;
  if (repositoryPlan.source !== "repository_config") {
    return repositoryPlan.status === "ready" ? plan : { ...plan, repository_plan_ignored: {
      source: repositoryPlan.source || null, reason: repositoryPlan.reason || "verification_plan_invalid" } };
  }
  if (repositoryPlan.status !== "ready") {
    return { ...plan, verification_plan: repositoryPlan,
      execution_checks: [primaryExecutionCheck(plan), unavailableRepositoryPlanCheck(repositoryPlan)],
      plan_id: sha256(`combined-verification-v1\0${plan.plan_id}\0${repositoryPlan.plan_id}`) };
  }
  const checks = repositoryPlan.checks.map((check) => ({ ...check }));
  const primaryMatches = checks.some((check) => sameRepositoryCheckInvocation(plan, check));
  const executionChecks = primaryMatches ? checks : [primaryExecutionCheck(plan), ...checks];
  return { ...plan, verification_plan: repositoryPlan, execution_checks: executionChecks,
    plan_id: primaryMatches ? repositoryPlan.plan_id
      : sha256(`combined-verification-v1\0${plan.plan_id}\0${repositoryPlan.plan_id}`) };
}

// A job is planned against one registry graph. A registry edit made before
// the job runs is accepted and recorded, never a rejection of the planner's
// command: checks added since planning join the plan, and a planned check
// that is gone stays an unavailable obligation. A registry that cannot run
// now stays the single unavailable obligation withRepositoryChecks adds.
function reconcilePlannedRepositoryPlan(current, planned) {
  if (planned?.schema_version !== VERIFICATION_PLAN_SCHEMA_VERSION || planned.source !== "repository_config") return current;
  const currentSnapshot = verificationPlanSnapshot(current);
  if (planned.plan_id === currentSnapshot.plan_id && planned.status === currentSnapshot.status
    && planned.source === currentSnapshot.source) return current;
  const change = { planned_snapshot: planned, current_snapshot: currentSnapshot };
  const registry = current?.source === "repository_config" ? current : null;
  if (registry && registry.status !== "ready") return { ...registry, verification_plan_change: change };
  const plannedIds = Array.isArray(planned.check_ids) ? planned.check_ids.map(String) : [];
  const currentIds = (registry?.checks || []).map((check) => check.id);
  const removed = plannedIds.filter((id) => !currentIds.includes(id));
  const added = currentIds.filter((id) => !plannedIds.includes(id));
  if (registry && removed.length === 0) {
    return { ...registry, verification_plan_change: { ...change, added_check_ids: added, removed_check_ids: [] } };
  }
  return {
    schema_version: VERIFICATION_PLAN_SCHEMA_VERSION,
    source: "repository_config",
    status: "ready",
    checks: [...(registry?.checks || []), ...removed.map((id) => ({
      id, command: id, intent: "test", stage: "canonical", required: true, depends_on: [],
      unavailable_reason: `verification_check_removed_since_planning:${id}`,
    }))],
    plan_id: sha256(`verification-plan-drift-v1\0${planned.plan_id || "none"}\0${currentSnapshot.plan_id || "none"}`),
    verification_plan_change: { ...change, added_check_ids: added, removed_check_ids: removed },
  };
}

// The whole frozen plan when the committed registry cannot run and the planner
// selected nothing else: one unavailable obligation with the exact reason.
function unavailableRegistryPlan(repositoryPlan) {
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    command: "repository verification plan",
    execution_command: "repository verification plan",
    cwd_relative: null,
    source: "repository_config",
    plan_id: repositoryPlan.plan_id,
    check_id: REPOSITORY_PLAN_UNAVAILABLE_CHECK_ID,
    intent: "test",
    verification_plan: repositoryPlan,
    execution_checks: [unavailableRepositoryPlanCheck(repositoryPlan)],
    validation_error: null,
    verification_eligible: true,
  };
}

function withUnresolvedTestSelection(plan, unresolved) {
  if (!plan || unresolved.length === 0) return plan;
  const paths = [...new Set(unresolved)].slice(0, 24);
  const reason = `planner_test_selection_unresolved:${paths.join(",")}`;
  if (plan.validation_error) return { ...plan, unresolved_test_paths: paths };
  const primary = primaryExecutionCheck(plan);
  return { ...plan, unresolved_test_paths: paths,
    plan_id: sha256(`unresolved-selection-v1\0${plan.plan_id}\0${paths.join("\0")}`),
    execution_checks: [...(Array.isArray(plan.execution_checks) ? plan.execution_checks : [primary]), {
      id: "planner:unresolved_test_selection", command: paths.join(", "), intent: "test",
      unavailable_reason: reason,
    }] };
}

// A durable replacement for an obsolete obligation, including when intake
// pruned it before assessment began. This never reintroduces the command as
// runnable work and never rewrites its historical failure receipts.
export function prunedTestPlan(payload = {}) {
  const pruned = Array.isArray(payload._pruned_tests) ? payload._pruned_tests : [];
  if (!pruned.length) return null;
  const planId = sha256(JSON.stringify(pruned));
  return {
    schema_version: RECEIPT_SCHEMA_VERSION, plan_id: planId, source: "planner",
    command: "pruned test selection", execution_command: "pruned test selection",
    check_id: `legacy:${planId.slice(0, 16)}`, intent: "test", verification_eligible: false,
    execution_checks: pruned.map((entry) => ({
      id: `legacy:${sha256(entry.command || entry.path).slice(0, 16)}`,
      command: entry.command || entry.path, intent: "test", required: false, unavailable_reason: entry.reason,
    })),
  };
}

export function resolveFrozenTestPlan(job = {}, payload = {}, options = {}) {
  const plan = resolveTestPlan(job, payload, options);
  const base = payload._test_capability_base_commit || payload.root_base_commit || payload.commit_base_hash;
  return plan && base ? { ...plan, capability_base_commit: base } : plan;
}

function resolveTestPlan(job = {}, payload = {}, { cwd = null } = {}) {
  if (!["dev", "fix"].includes(String(job?.job_type || ""))) return null;
  if (String(payload?.task_mode || "code") !== "code") return null;
  const declaredCommand = typeof payload?.test_command === "string"
    ? payload.test_command.trim()
    : "";
  const needsRootTests = !Array.isArray(payload?.tests_to_run);
  const rootPayload = needsRootTests || (cwd && !payload?._repository_verification_plan_snapshot)
    ? rootJobPayload(job, payload) : null;
  const testsToRun = lineageTestsToRun(payload, rootPayload);
  const selectedPaths = Array.isArray(testsToRun)
    ? [...new Set(testsToRun.map((value) => String(value || "").trim().replace(/\\/g, "/")).filter(Boolean))]
    : [];
  const repositoryPlan = cwd ? reconcilePlannedRepositoryPlan(resolveRepositoryVerificationPlan({
    projectDir: cwd,
    selectedCheckIds: payload?.verification_check_ids,
    validateCommand: (candidate) => validatePlannerTestCommandForRepository(candidate, cwd),
  }), payload?._repository_verification_plan_snapshot || rootPayload?._repository_verification_plan_snapshot || null) : null;
  // A committed registry is an obligation for every job. Package scripts are
  // consulted only by a job that selected nothing at all: an explicit, even
  // empty, planner list is not permission to substitute a repository gate.
  const registryPlan = repositoryPlan?.source === "repository_config" ? repositoryPlan : null;
  const capability = Array.isArray(testsToRun) && cwd
    ? discoverUnitTestCapability({ projectDir: cwd })
    : null;
  const unitTestPaths = Array.isArray(testsToRun)
    ? selectedPaths.filter((value) => capability?.available && capability.files.includes(value))
      .slice(0, 24)
    : [];
  const unresolvedSelection = selectedPaths.filter((value) => !unitTestPaths.includes(value));
  // Preserve unresolved selections as missing coverage. The planner cannot
  // turn an unknown or deleted test path into a passing repository check.
  if (Array.isArray(payload?.tests_to_run) && unitTestPaths.length === 0 && !declaredCommand && !registryPlan) {
    if (unresolvedSelection.length === 0) return null;
    return { schema_version: RECEIPT_SCHEMA_VERSION, command: "planner test selection",
      execution_command: "planner test selection", cwd_relative: null,
      source: "planner_unit_tests", plan_id: sha256(`unresolved-only\0${unresolvedSelection.join("\0")}`),
      check_id: "planner:unresolved_test_selection", intent: "test",
      verification_plan: null, validation_error: `planner_test_selection_unresolved:${unresolvedSelection.slice(0, 24).join(",")}`,
      verification_eligible: false, unresolved_test_paths: unresolvedSelection.slice(0, 24) };
  }
  // File selection cannot replace the project's declared runner/loader.
  if (unitTestPaths.length > 0 && !declaredCommand) {
    const command = unitTestPaths.join(", ");
    return withUnresolvedTestSelection(withRepositoryChecks({
      schema_version: RECEIPT_SCHEMA_VERSION,
      command,
      execution_command: command,
      cwd_relative: null,
      source: "planner_unit_tests",
      plan_id: sha256(`planner_unit_tests\0${unitTestPaths.join("\0")}`),
      check_id: `unit_tests:${sha256(unitTestPaths.join("\0")).slice(0, 16)}`,
      intent: "test",
      verification_plan: null,
      validation_error: null,
      verification_eligible: true,
      unit_test_paths: unitTestPaths,
    }, repositoryPlan), unresolvedSelection);
  }
  const command = declaredCommand;
  if (!command && cwd) {
    const verificationPlan = repositoryPlan;
    if (!verificationPlan) return null;
    if (verificationPlan.status !== "ready") {
      // A legacy package-script fallback that cannot run is no obligation.
      return verificationPlan.source === "repository_config"
        ? withUnresolvedTestSelection(unavailableRegistryPlan(verificationPlan), unresolvedSelection)
        : null;
    }
    const runnable = verificationPlan.checks.filter((check) => !check.unavailable_reason);
    const selected = [...runnable].reverse().find((check) => check.stage === "canonical") || runnable.at(-1);
    if (!selected && verificationPlan.checks.length > 0) {
      return withUnresolvedTestSelection({ ...unavailableRegistryPlan(verificationPlan),
        execution_checks: verificationPlan.checks }, unresolvedSelection);
    }
    if (!selected) return null;
    return withUnresolvedTestSelection({
      schema_version: RECEIPT_SCHEMA_VERSION,
      command: selected.command,
      execution_command: selected.execution_command,
      cwd_relative: selected.cwd_relative,
      source: verificationPlan.source,
      plan_id: verificationPlan.plan_id,
      check_id: selected.id,
      intent: selected.intent,
      verification_plan: verificationPlan,
      execution_checks: verificationPlan.checks,
      validation_error: null,
      verification_eligible: true,
    }, unresolvedSelection);
  }
  if (!command) return null;
  const taskAbAcceptance = payload?._task_ab_test_command === true;
  const approvalRequest = taskAbAcceptance ? null : operationalCommandApprovalRequest(command);
  const approval = payload?._operator_approved_command;
  const operatorApproved = !!(
    approvalRequest
    && approval?.schema_version === 1
    && approval?.command_sha256 === approvalRequest.command_sha256
    && Number.isSafeInteger(Number(approval?.gate_job_id))
    && Number(approval.gate_job_id) > 0
  );
  const source = taskAbAcceptance
    ? "task_ab_acceptance"
    : operatorApproved
      ? "operator_approved_operation"
      : "planner";
  const validation = taskAbAcceptance
    ? { ok: true, reason: null }
    : operatorApproved
      ? {
          ok: true,
          reason: null,
          execution_command: approvalRequest.execution_command,
          cwd_relative: approvalRequest.cwd_relative,
        }
      : resolveLocalVitestCommand(cwd, declaredNodeTestCommand(cwd, validatePlannerTestCommand(command)));
  const coveredFile = validation.ok && source !== "operator_approved_operation"
    ? exactDeclaredTestFile(validation.execution_command || command, cwd, validation.cwd_relative || null)
    : null;
  return withUnresolvedTestSelection(withRepositoryChecks({
    schema_version: RECEIPT_SCHEMA_VERSION,
    command,
    execution_command: validation.execution_command || command,
    cwd_relative: validation.cwd_relative || null,
    source,
    plan_id: sha256(validation.repository_runner
      ? `${source}\0${command}\0${validation.execution_command}`
      : `${source}\0${command}`),
    check_id: `legacy:${sha256(command).slice(0, 16)}`,
    intent: "test",
    verification_plan: null,
    validation_error: validation.ok ? null : validation.reason,
    verification_eligible: source !== "operator_approved_operation",
    ...(validation.unit_test_paths ? { unit_test_paths: validation.unit_test_paths } : {}),
    ...(coveredFile ? { covered_unit_test_paths: [coveredFile] } : {}),
  }, repositoryPlan), unresolvedSelection);
}

export function frozenTestPlanFromReceipt(receipt = {}) {
  if (!receipt || receipt.schema_version !== RECEIPT_SCHEMA_VERSION) return null;
  const command = typeof receipt.command === "string" ? receipt.command.trim() : "";
  const source = typeof receipt.source === "string" ? receipt.source.trim() : "";
  const planId = typeof receipt.plan_id === "string" ? receipt.plan_id.trim() : "";
  if (!command || !source || !planId) return null;

  // The baseline receipt is the durable frozen plan. Preserve its normalized
  // executable and working directory for the post-change run; reconstructing
  // only the display command turns a safe wrapper such as
  // `cd htdocs && npm run typecheck` back into a direct spawn of `cd`.
  const executionCommand = typeof receipt.execution_command === "string"
    ? receipt.execution_command.trim()
    : (receipt.execution_command == null && receipt.cwd_relative == null ? command : "");
  const cwdRelative = receipt.cwd_relative == null
    ? null
    : safeRelativeTestDirectory(receipt.cwd_relative);
  if (!executionCommand || (receipt.cwd_relative != null && !cwdRelative)) return null;

  return {
    schema_version: receipt.schema_version,
    command,
    execution_command: executionCommand,
    cwd_relative: cwdRelative,
    source,
    plan_id: planId,
    ...(receipt.capability_base_commit ? { capability_base_commit: receipt.capability_base_commit } : {}),
    check_id: receipt.check_id || null,
    intent: receipt.intent || "test",
    verification_plan: receipt.verification_plan || null,
    ...(Array.isArray(receipt.execution_checks) ? { execution_checks: receipt.execution_checks } : {}),
    ...(Array.isArray(receipt.unresolved_test_paths) ? { unresolved_test_paths: receipt.unresolved_test_paths } : {}),
    ...(receipt.repository_plan_ignored ? { repository_plan_ignored: receipt.repository_plan_ignored } : {}),
    validation_error: receipt.validation_error || null,
    verification_eligible: receipt.verification_eligible !== false,
    ...(Array.isArray(receipt.unit_test_paths) ? { unit_test_paths: receipt.unit_test_paths } : {}),
    ...(Array.isArray(receipt.covered_unit_test_paths) ? { covered_unit_test_paths: receipt.covered_unit_test_paths } : {}),
  };
}
