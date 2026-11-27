import { experimentSetupSchema } from "../../../catalog/experiment-runner.js";
import { experimentSetupContract as catalogSetupContract } from "../../../catalog/experiment-runner.js";
import { experimentBudget } from './budget.js';
export function experimentSetupContract() {
  const contract = catalogSetupContract();
  contract.example.budget = experimentBudget();
  return contract;
}
import { validateExperimentPlan } from "./plan.js";
import { experimentDigest, snapshotFiles } from "./snapshots.js";
import { validateToolArguments } from "../../../shared/tools/functions/schema-validation.js";

import { validateIntegration, validateDirectMapping } from "./integration-config.js";

export function validateExperimentSetup(setup) {
  const errors = [];
  const checked = validateToolArguments({ name: "experiment.setup", parameters: experimentSetupSchema }, setup);
  if (!checked.ok) errors.push(checked.message);
  else {
    if (setup.integration) { try { validateIntegration(setup.integration); validateDirectMapping(setup.integration, setup.plan, setup.files); } catch (error) { errors.push(error.message); } }
    const plan = validateExperimentPlan(setup.plan);
    if (!plan.ok) errors.push(...plan.issues.map(item => item.message));
    if (setup.plan.baseline.mode !== "capture") errors.push("The runner requires baseline capture.");
    try { snapshotFiles(setup.plan, setup.files); } catch (error) { errors.push(error.message); }
  }
  if (Buffer.byteLength(JSON.stringify(setup) || "") > 524288) errors.push("Setup exceeds 512 KiB.");
  return { ok: errors.length === 0, setup_digest: errors.length ? null : experimentDigest(setup), errors,
    summary: errors.length ? null : { objective: setup.plan.objective, max_iterations: setup.plan.max_iterations, acceptance: setup.plan.acceptance || { mode: "human" }, models: setup.models, budget: setup.budget, integration: setup.integration || null, metrics: setup.plan.metrics, files: setup.plan.files.map(file => file.path) } };
}
