import { EXPERIMENT_LIMITS, EXPERIMENT_OPERATIONS, EXPERIMENT_USAGE } from "../../../catalog/experiments.js";
import { experimentPlanningRequest } from "./planning-api.js";
import { createExperimentReport } from "./report.js";
import { experimentSetupContract, validateExperimentSetup } from "./setup.js";

export async function runExperimentCli(argv = [], { input = process.stdin, print = value => console.log(value), request = ownerRequest } = {}) {
  const [action = "help", ...rest] = argv;
  if (rest.length) throw new Error(EXPERIMENT_USAGE);
  if (["help", "--help", "-h"].includes(action)) { print(EXPERIMENT_USAGE); return 0; }
  let result;
  if (action === "schema") result = experimentPlanningRequest(EXPERIMENT_OPERATIONS.SCHEMA);
  else if (action === "setup-schema") result = experimentSetupContract();
  else if (action === "list") result = await request(EXPERIMENT_OPERATIONS.LIST, {});
  else if (["validate", "setup-validate", "launch", "stop", "report", "create", "get", "stage", "run", "decide", "files", "progress", "status", "cancel"].includes(action)) {
    const limit = action === "validate" ? EXPERIMENT_LIMITS.planBytes : EXPERIMENT_LIMITS.reportBytes;
    const chunks = []; let bytes = 0;
    for await (const chunk of input) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > limit) throw new Error("Experiment request exceeds the input limit.");
      chunks.push(buffer);
    }
    let plan;
    try { plan = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Experiment plan must be valid JSON."); }
    result = action === "setup-validate" ? validateExperimentSetup(plan) : action === "validate" ? experimentPlanningRequest(EXPERIMENT_OPERATIONS.VALIDATE, { plan })
      : action === "report" ? createExperimentReport(plan) : await request(`experiment.${action === "status" ? "report" : action}`, plan);
  } else throw new Error(EXPERIMENT_USAGE);
  print(JSON.stringify(result));
  return result.ok === false ? 1 : 0;
}

async function ownerRequest(operation, args) {
  const { AutomationOwnerClient, ensureAutomationOwner } = await import("../../automation/classes/AutomationOwnerClient.js");
  await ensureAutomationOwner();
  return new AutomationOwnerClient({ operator: true, timeoutMs: 60000 }).request(operation, args);
}
