import { experimentSkillInventory } from './skills.js';
import { experimentBudget } from './budget.js';
import { runCorpusCli } from "./corpus-cli.js";
import { experimentInitContract, EXPERIMENT_WORKSPACE_ACTIONS } from "../../../catalog/experiment-workspace.js";
import { initializeExperiment } from "./workspace-init.js";
import { workspaceExperimentCommand } from "./workspace-cli.js";
import { EXPERIMENT_LIMITS, EXPERIMENT_OPERATIONS, EXPERIMENT_USAGE } from "../../../catalog/experiments.js";
import { experimentPlanningRequest } from "./planning-api.js";
import { createExperimentReport } from "./report.js";
import { experimentSetupContract, validateExperimentSetup } from "./setup.js";

export async function runExperimentCli(argv = [], { input = process.stdin, print = value => console.log(value), request = ownerRequest, initialize = initializeExperiment, workspace = workspaceExperimentCommand } = {}) {
  const [action = "help", ...rest] = argv;
  if (action === "skills" && !rest.length) { print(JSON.stringify({ skills: experimentSkillInventory(), attach: "Role-scoped map: setup.skills:{writer:[image-manipulation]} in init/launch, skills:{setup:[image-manipulation]} in setup-prepare, or setup.attach_skill with an explicit role." })); return 0; }
  if (action === "corpus") return runCorpusCli(rest, { input, print });
  if (rest.length) {
    if (rest.length !== 1 || !EXPERIMENT_WORKSPACE_ACTIONS.includes(action) || rest[0].startsWith("-")) throw new Error(EXPERIMENT_USAGE);
    print(JSON.stringify(await workspace(action, rest[0]))); return 0;
  }
  if (["help", "--help", "-h"].includes(action)) { print(EXPERIMENT_USAGE); return 0; }
  let result;
  if (action === "init-schema") { result = structuredClone(experimentInitContract()); result.defaults.budget = experimentBudget(); }
  else if (action === "schema") result = experimentPlanningRequest(EXPERIMENT_OPERATIONS.SCHEMA);
  else if (action === "setup-schema") result = experimentSetupContract();
  else if (action === "list") result = await request(EXPERIMENT_OPERATIONS.LIST, {});
  else if (["setup-prepare", "setup-status", "setup-stop", "setup-list", "setup-get", "corpus-contract", "corpus-options", "corpus-prepare", "corpus-status", "corpus-bind", "init", "validate", "setup-validate", "launch", "integrate", "integration-log", "case-results", "stop", "report", "create", "get", "stage", "run", "decide", "files", "progress", "status", "cancel"].includes(action)) {
    const limit = action === "validate" ? EXPERIMENT_LIMITS.planBytes : EXPERIMENT_LIMITS.reportBytes;
    const chunks = []; let bytes = 0;
    for await (const chunk of input) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > limit) throw new Error("Experiment request exceeds the input limit.");
      chunks.push(buffer);
    }
    let plan;
    try { plan = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Experiment plan must be valid JSON."); }
    result = action === "init" ? await initialize(plan) : action === "setup-validate" ? validateExperimentSetup(plan) : action === "validate" ? experimentPlanningRequest(EXPERIMENT_OPERATIONS.VALIDATE, { plan })
      : action === "report" ? createExperimentReport(plan) : await request(`experiment.${action === "status" ? "report" : action.replaceAll("-", "_")}`, plan);
  } else throw new Error(EXPERIMENT_USAGE);
  print(JSON.stringify(result));
  return result.ok === false ? 1 : 0;
}

async function ownerRequest(operation, args) {
  const { AutomationOwnerClient, ensureAutomationOwner } = await import("../../automation/classes/AutomationOwnerClient.js");
  await ensureAutomationOwner();
  return new AutomationOwnerClient({ operator: true, timeoutMs: 60000 }).request(operation, args);
}
