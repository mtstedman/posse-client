import { EXPERIMENT_SETUP_SCHEMA, EXPERIMENT_PLAN_JSON_SCHEMA, EXPERIMENT_RUNNER_ROLES, experimentPlanExample } from "./experiments.js";
import { AGENT_REASONING_EFFORTS } from "./agent.js";

const object = properties => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const text = maxLength => ({ type: "string", minLength: 1, maxLength });
const count = maximum => ({ type: "integer", minimum: 1, maximum });
export const experimentSetupSchema = object({
  schema: { const: EXPERIMENT_SETUP_SCHEMA }, prompt: text(16000), guidelines: text(8000),
  plan: EXPERIMENT_PLAN_JSON_SCHEMA,
  files: { type: "object", maxProperties: 128, additionalProperties: { type: "string", maxLength: 262144 } },
  models: object(Object.fromEntries(EXPERIMENT_RUNNER_ROLES.map(role => [role, object({ model: text(128), reasoning_effort: { enum: AGENT_REASONING_EFFORTS } })]))),
  budget: object({ model_calls: count(1000), wall_seconds: count(3600), tokens: count(1000000), spend_usd: { type: "number", exclusiveMinimum: 0, maximum: 100 } }),
});

export function experimentSetupContract() {
  const plan = experimentPlanExample();
  plan.acceptance = { mode: "automatic", primary_metric: "quality", min_improvement: 0 };
  return { schema: experimentSetupSchema, example: { schema: EXPERIMENT_SETUP_SCHEMA,
    prompt: "Improve the algorithm against the declared metrics and return the best accepted version and a concise report.",
    guidelines: "Keep the public interface stable. Use general improvements. Never infer or special-case hidden evaluation answers.",
    plan, files: { "work/candidate.py": "# Supply the starting implementation before approval.\n" },
    models: Object.fromEntries(EXPERIMENT_RUNNER_ROLES.map(role => [role, { model: ["coordinator", "assessor"].includes(role) ? "strong" : "cheap", reasoning_effort: ["coordinator", "assessor"].includes(role) ? "high" : "low" }])),
    budget: { model_calls: 60, wall_seconds: 1800, tokens: 100000, spend_usd: 5 } },
    note: "Recommended defaults are editable. Approval launches one runner agent; it owns writing, assessment, sandbox runs and iteration. Placeholder evaluation references and initial files must be replaced. Budget checks stop new model calls; the final in-flight call can exceed the token/spend threshold." };
}

const toolText = { type: "string", minLength: 1, maxLength: 4000 };
export const EXPERIMENT_CANDIDATE_TOOL = { name: "test.submit_candidate", description: "Return only declared payload edits and their hypothesis.", parameters: object({ changes: { type: "object", additionalProperties: { type: "string" } }, hypothesis: toolText }) };
export const EXPERIMENT_REVIEW_TOOL = { name: "test.review_candidate", description: "Review whether the proposed general change follows the approved plan and can be tested. This does not score the candidate.", parameters: object({ approved: { type: "boolean" }, reason: toolText }) };
export const EXPERIMENT_RUNNER_TOOLS = [
  { name: "test.prepare", description: "Dispatch the writer and independent assessor, then stage the reviewed candidate. Uses the accepted files and consumes one iteration only after review passes.", parameters: object({ instructions: toolText }) },
  { name: "test.run", description: "Execute the baseline or staged candidate and wait for the owner-scored result. The harness publishes live progress without model calls.", parameters: object({}) },
  { name: "test.files", description: "Read the currently accepted payload files, never the runner or hidden evaluation.", parameters: object({}) },
  { name: "test.proctor", description: "Ask the configured inexpensive proctor to inspect compact findings. It cannot change files, metrics, acceptance or goals.", parameters: object({ question: toolText }) },
];
