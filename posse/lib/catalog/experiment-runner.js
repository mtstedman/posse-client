import { EXPERIMENT_INIT_DEFAULTS } from './experiment-workspace.js';
import { EXPERIMENT_SETUP_SCHEMA, EXPERIMENT_PLAN_JSON_SCHEMA, EXPERIMENT_RUNNER_ROLES, experimentPlanExample } from "./experiments.js";
import { AGENT_REASONING_EFFORTS } from "./agent.js";

import { EXPERIMENT_INTEGRATION_SCHEMA } from "./experiment-integration.js";

const object = properties => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const text = maxLength => ({ type: "string", minLength: 1, maxLength });
const count = maximum => ({ type: "integer", minimum: 1, maximum });
export const EXPERIMENT_SOURCE_LIMITS = Object.freeze({ searchBytes: 8192, contextBytes: 16384, batchBytes: 7500, batchItems: 8, lookupTurns: 8, results: 20, targets: 8, cachedFiles: 128, history: 8 });
export const EXPERIMENT_SOURCE_FALLBACKS = Object.freeze({ UNSUPPORTED: "unsupported_language", UNAVAILABLE: "parser_unavailable", FAILED: "parser_failed", NO_SYMBOL: "no_symbol_match" });
export const EXPERIMENT_IDEA_LIMITS = Object.freeze({ lookups: 4, failedPreparations: 3 });
export const EXPERIMENT_IDEA_EXHAUSTED = "idea_attempts_exhausted";
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
    models: structuredClone(EXPERIMENT_INIT_DEFAULTS.models),
    budget: { ...EXPERIMENT_INIT_DEFAULTS.budget } },
    integration_example: { strategy: "direct", repo_path: "/absolute/path/repo", worktree_path: "/absolute/path/task-worktree", branch: "experiment/algorithm",
      trunk_branch: "main", base_commit: "0".repeat(40), commit_message: "Apply accepted algorithm experiment",
      mapping: [{ source: "work/candidate.py", target: "src/candidate.py" }], files: [{ path: "src/candidate.py", mode: "modify" }], prepare: [],
      checks: [{ program: "python", args: ["-m", "unittest", "discover"], cwd: ".", timeout_seconds: 120 }],
      budget: { model_calls: 0, tokens: 0, spend_usd: 0, wall_seconds: 600 } },
    note: "Recommended defaults are editable. Approval launches one runner agent; it owns writing, assessment, sandbox runs and iteration. Placeholder evaluation references and initial files must be replaced. Budget checks stop new model calls; the final in-flight call can exceed the token/spend threshold." };
}

const toolText = { type: "string", minLength: 1, maxLength: 4000 };
const hypothesis = { ...toolText, description: "Lead with one concise sentence naming the concrete change and expected effect. Omit workflow recaps and claimed check results." };
export const EXPERIMENT_CANDIDATE_TOOL = { name: "test.submit_candidate", description: "Compatibility option for edits unsuitable for targeted replacements. Return only changed declared files and their hypothesis. Prefer test.submit_patch to avoid emitting unchanged source.", parameters: object({ changes: { type: "object", additionalProperties: { type: "string" } }, hypothesis }) };
export const EXPERIMENT_PATCH_TOOL = { name: "test.submit_patch", description: "Submit small exact replacements against the accepted files. Each before span must match exactly once, in order. Prefer this over repeating a large file.", parameters: object({
  edits: { type: "array", minItems: 1, maxItems: 32, items: object({ path: { type: "string", minLength: 1, maxLength: 240 }, before: { type: "string", minLength: 1, maxLength: 262144 }, after: { type: "string", maxLength: 262144 } }) }, hypothesis,
}) };
export const EXPERIMENT_DECLINE_TOOL = { name: "test.decline_candidate", description: "Decline this preparation when source evidence is insufficient or no supported improvement is available. Return a concise reason; never invent an unsafe edit to satisfy a lookup limit.", parameters: object({ reason: toolText }) };
export const EXPERIMENT_REVIEW_TOOL = { name: "test.review_candidate", description: "Review whether the proposed general change follows the approved plan and can be tested. This does not score the candidate.", parameters: object({ approved: { type: "boolean" }, reason: toolText }) };
export const EXPERIMENT_READ_TOOL = { name: "test.read", description: "Read a bounded range of a declared accepted or candidate payload file. Use when a diff is truncated or additional source context is needed.", parameters: object({
  path: { type: "string", minLength: 1, maxLength: 240 }, version: { enum: ["accepted", "candidate"] }, start_line: count(1000000), line_count: count(200),
}) };
export const EXPERIMENT_SEARCH_TOOL = { name: "test.search", description: "Find declarations or literal source anchors only in the declared snapshot. Returns file digests and line ranges for test.read and targeted test.prepare. Uses Atlas buffer parsing when available, with explicit lexical fallback. No host repository search.", parameters: {
  type: "object", additionalProperties: false, required: ["query", "version"], properties: {
    query: text(240), version: { enum: ["accepted", "candidate"] }, path: text(240),
    limit: count(EXPERIMENT_SOURCE_LIMITS.results), offset: { type: "integer", minimum: 0, maximum: 1000000 },
  },
} };
export const EXPERIMENT_LOOKUP_BATCH_TOOL = { name: "test.lookup_batch", description: "After checking prefetch, fetch up to eight independent missing source ranges or symbol searches in one turn. Snapshot-only test.read/test.search operations; no arbitrary tools or repository access. Results preserve request order and per-item errors under one byte cap. Use individual reads for truncated ranges requiring more detail.", parameters: object({
  requests: { type: "array", minItems: 1, maxItems: EXPERIMENT_SOURCE_LIMITS.batchItems, items: { oneOf: [EXPERIMENT_READ_TOOL, EXPERIMENT_SEARCH_TOOL].map(tool => object({ name: { const: tool.name }, arguments: tool.parameters })) } },
}) };
const prepareParameters = object({ instructions: toolText, targets: { type: "array", minItems: 1, maxItems: EXPERIMENT_SOURCE_LIMITS.targets, items: object({
  path: text(240), sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, start_line: count(1000000), line_count: count(200), change: text(400),
}) } });
prepareParameters.required = ["instructions"];
export const EXPERIMENT_RUNNER_TOOLS = [
  { name: "test.prepare", description: "Dispatch the writer and independent assessor, then stage the reviewed candidate. Prefer a concise edit brief with optional targets from test.search/read: current file digest, line range, and intended change. Targets guide the edit without changing the approved file scope. Consumes one iteration only after review passes.", parameters: prepareParameters },
  { name: "test.run", description: "Execute the baseline or staged candidate and wait for the owner-scored result. The harness publishes live progress without model calls.", parameters: object({}) },
  { name: "test.files", description: "List accepted payload file paths, modes, sizes, and digests. Use test.read for specific source ranges.", parameters: object({}) },
  EXPERIMENT_READ_TOOL,
  EXPERIMENT_SEARCH_TOOL,
  EXPERIMENT_LOOKUP_BATCH_TOOL,
  { name: "test.proctor", description: "Ask the configured inexpensive proctor to inspect compact findings. It cannot change files, metrics, acceptance or goals.", parameters: object({ question: toolText }) },
];
