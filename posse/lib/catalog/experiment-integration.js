import { AGENT_REASONING_EFFORTS } from "./agent.js";

const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const text = maxLength => ({ type: "string", minLength: 1, maxLength });
const count = maximum => ({ type: "integer", minimum: 1, maximum });
const command = object({ program: text(1024), args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 8000 } }, cwd: text(240), timeout_seconds: count(900) });

// Operator-owned host authority, separate from the sandbox's payload scope.
export const EXPERIMENT_INTEGRATION_SCHEMA = object({
  repo_path: text(1024), worktree_path: text(1024), branch: text(200), base_commit: { type: "string", pattern: "^[a-f0-9]{40,64}$" },
  instructions: text(16000), commit_message: text(500),
  files: { type: "array", minItems: 1, maxItems: 128, items: object({ path: text(240), mode: { enum: ["read", "modify", "create"] } }) },
  prepare: { type: "array", maxItems: 8, items: command },
  checks: { type: "array", minItems: 1, maxItems: 16, items: command },
  model: text(128), reasoning_effort: { enum: AGENT_REASONING_EFFORTS },
  budget: object({ model_calls: count(200), wall_seconds: count(7200), tokens: count(1000000), spend_usd: { type: "number", exclusiveMinimum: 0, maximum: 100 } }),
});
export const EXPERIMENT_INTEGRATION_STATES = Object.freeze({ RUNNING: "running", COMMITTING: "committing", COMMITTED: "committed", ERROR: "error", INTERRUPTED: "interrupted", CANCELLED: "cancelled", BUDGET: "budget_exhausted" });
export const EXPERIMENT_INTEGRATION_TOOLS = [
  { name: "integration.read", description: "Read declared repository files in the integration worktree.", parameters: object({ paths: { type: "array", minItems: 1, maxItems: 16, items: text(240) } }) },
  { name: "integration.write", description: "Create or replace one declared writable file. Invalidates previous verification.", parameters: object({ path: text(240), content: { type: "string", maxLength: 262144 } }) },
  { name: "integration.replace", description: "Replace exactly one matching text span in a declared writable file. Read first; invalidates verification.", parameters: object({ path: text(240), before: text(262144), after: { type: "string", maxLength: 262144 } }) },
  { name: "integration.check", description: "Run all fixed repository checks. A failure can be repaired; check commands cannot be changed.", parameters: object({}) },
  { name: "integration.commit", description: "Commit the exact verified changes locally. Requires successful checks of the current tree; never pushes or merges.", parameters: object({ summary: text(4000) }) },
];
