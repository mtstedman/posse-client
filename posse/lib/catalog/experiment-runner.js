import { EXPERIMENT_SETUP_SCHEMA, EXPERIMENT_PLAN_JSON_SCHEMA, EXPERIMENT_RUNNER_ROLES, experimentPlanExample } from "./experiments.js";
import { AGENT_REASONING_EFFORTS } from "./agent.js";

import { EXPERIMENT_INTEGRATION_SCHEMA } from "./experiment-integration.js";

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

experimentSetupSchema.properties.integration = EXPERIMENT_INTEGRATION_SCHEMA;

export function experimentSetupContract() {
  const plan = experimentPlanExample();
  plan.acceptance = { mode: "automatic", primary_metric: "quality", min_improvement: 0 };
  return { schema: experimentSetupSchema, example: { schema: EXPERIMENT_SETUP_SCHEMA,
    prompt: "Improve the algorithm against the declared metrics and return the best accepted version and a concise report.",
    guidelines: "Keep the public interface stable. Use general improvements. Never infer or special-case hidden evaluation answers.",
    plan, files: { "work/candidate.py": "# Supply the starting implementation before approval.\n" },
    models: Object.fromEntries(EXPERIMENT_RUNNER_ROLES.map(role => [role, { model: ["coordinator", "assessor"].includes(role) ? "strong" : "cheap", reasoning_effort: ["coordinator", "assessor"].includes(role) ? "high" : "low" }])),
    budget: { model_calls: 60, wall_seconds: 1800, tokens: 100000, spend_usd: 5 } },
    integration_example: { strategy: "direct", repo_path: "/absolute/path/repo", worktree_path: "/absolute/path/task-worktree", branch: "experiment/algorithm",
      trunk_branch: "main", base_commit: "0".repeat(40), commit_message: "Apply accepted algorithm experiment",
      mapping: [{ source: "work/candidate.py", target: "src/candidate.py" }], files: [{ path: "src/candidate.py", mode: "modify" }], prepare: [],
      checks: [{ program: "python", args: ["-m", "unittest", "discover"], cwd: ".", timeout_seconds: 120 }],
      budget: { model_calls: 0, tokens: 0, spend_usd: 0, wall_seconds: 600 } },
    note: "Recommended defaults are editable. Approval launches one runner agent; it owns writing, assessment, sandbox runs and iteration. Placeholder evaluation references and initial files must be replaced. Budget checks stop new model calls; the final in-flight call can exceed the token/spend threshold." };
}

const toolText = { type: "string", minLength: 1, maxLength: 4000 };
export const EXPERIMENT_CANDIDATE_TOOL = { name: "test.submit_candidate", description: "Return only declared payload edits and their hypothesis.", parameters: object({ changes: { type: "object", additionalProperties: { type: "string" } }, hypothesis: toolText }) };
export const EXPERIMENT_PATCH_TOOL = { name: "test.submit_patch", description: "Submit small exact replacements against the accepted files. Each before span must match exactly once, in order. Prefer this over repeating a large file.", parameters: object({
  edits: { type: "array", minItems: 1, maxItems: 32, items: object({ path: { type: "string", minLength: 1, maxLength: 240 }, before: { type: "string", minLength: 1, maxLength: 262144 }, after: { type: "string", maxLength: 262144 } }) }, hypothesis: toolText,
}) };
export const EXPERIMENT_REVIEW_TOOL = { name: "test.review_candidate", description: "Review whether the proposed general change follows the approved plan and can be tested. This does not score the candidate.", parameters: object({ approved: { type: "boolean" }, reason: toolText }) };
export const EXPERIMENT_READ_TOOL = { name: "test.read", description: "Read a bounded range of a declared accepted or candidate payload file. Use when a diff is truncated or additional source context is needed.", parameters: object({
  path: { type: "string", minLength: 1, maxLength: 240 }, version: { enum: ["accepted", "candidate"] }, start_line: count(1000000), line_count: count(200),
}) };
export const EXPERIMENT_RUNNER_TOOLS = [
  { name: "test.prepare", description: "Dispatch the writer and independent assessor, then stage the reviewed candidate. Uses the accepted files and consumes one iteration only after review passes.", parameters: object({ instructions: toolText }) },
  { name: "test.run", description: "Execute the baseline or staged candidate and wait for the owner-scored result. The harness publishes live progress without model calls.", parameters: object({}) },
  { name: "test.files", description: "List accepted payload file paths, modes, sizes, and digests. Use test.read for specific source ranges.", parameters: object({}) },
  EXPERIMENT_READ_TOOL,
  { name: "test.proctor", description: "Ask the configured inexpensive proctor to inspect compact findings. It cannot change files, metrics, acceptance or goals.", parameters: object({ question: toolText }) },
];
