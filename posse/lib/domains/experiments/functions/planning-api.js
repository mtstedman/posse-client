import { EXPERIMENT_OPERATIONS, EXPERIMENT_PLAN_JSON_SCHEMA, EXPERIMENT_LIMITS, EXPERIMENT_EXECUTION_UNAVAILABLE, EXPERIMENT_PAYLOAD_API, experimentPlanExample } from "../../../catalog/experiments.js";
import { validateExperimentPlan } from "./plan.js";

export function experimentPlanningRequest(operation, args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Experiment arguments must be an object.");
  if (operation === EXPERIMENT_OPERATIONS.SCHEMA && Object.keys(args).length === 0) return {
    plan_schema: structuredClone(EXPERIMENT_PLAN_JSON_SCHEMA), example: experimentPlanExample(), max_plan_bytes: EXPERIMENT_LIMITS.planBytes,
    payload_api: structuredClone(EXPERIMENT_PAYLOAD_API),
    execution: { available: false, reason: EXPERIMENT_EXECUTION_UNAVAILABLE },
    note: "Example references are placeholders. Validation checks structure only; it does not resolve files, dependencies, evaluation packages or baseline evidence. No runner source is exposed.",
  };
  if (operation === EXPERIMENT_OPERATIONS.VALIDATE && Object.keys(args).length === 1 && Object.hasOwn(args, "plan")) return validateExperimentPlan(args.plan);
  throw new Error("Unsupported experiment operation or arguments. Only schema and plan validation are available.");
}
