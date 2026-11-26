import path from "node:path";
import { validateToolArguments } from "../../../shared/tools/functions/schema-validation.js";
import { EXPERIMENT_INTEGRATION_SCHEMA, EXPERIMENT_INTEGRATION_STRATEGIES as M } from "../../../catalog/experiment-integration.js";

// Existing approvals retain their original agent authority; new setups choose direct.
export const integrationStrategy = config => config.strategy || M.AGENT;

export function integrationRelativePath(file) {
  return typeof file === "string" && file.split("/").every(part => /^[\w.-]+$/.test(part) && ![".", "..", ".git", ".posse"].includes(part.toLowerCase()));
}

export function validateIntegration(config) {
  const checked = validateToolArguments({ name: "integration", parameters: EXPERIMENT_INTEGRATION_SCHEMA }, config);
  if (!checked.ok) throw new Error(checked.message);
  if (![config.repo_path, config.worktree_path].every(p => path.isAbsolute(p) && path.resolve(p) === p)
    || config.repo_path === config.worktree_path) throw new Error("Distinct absolute repository and worktree paths are required.");
  if (!config.branch.startsWith("experiment/") || !/^experiment\/[\w/-]+$/.test(config.branch)) throw new Error("Use a new experiment/ branch.");
  if (config.trunk_branch && (!/^[\w/-]+$/.test(config.trunk_branch) || config.trunk_branch === config.branch)) throw new Error("Declare a distinct local trunk branch.");
  if (integrationStrategy(config) === M.DIRECT) {
    if (!config.trunk_branch || !config.mapping?.length) throw new Error("Direct integration requires file mapping and a trunk branch.");
    if (new Set(config.mapping.map(item => item.source)).size !== config.mapping.length || new Set(config.mapping.map(item => item.target)).size !== config.mapping.length
      || config.mapping.some(item => !integrationRelativePath(item.source) || !integrationRelativePath(item.target))) throw new Error("Mapping must contain unique relative source and target paths.");
    const writable = config.files.filter(file => file.mode !== "read").map(file => file.path);
    if (config.mapping.length !== writable.length || config.mapping.some(item => !writable.includes(item.target))) throw new Error("Mapping must cover exactly the writable repository files.");
  } else if (!config.instructions || !config.model || !config.reasoning_effort || !config.budget.model_calls || !config.budget.tokens || !config.budget.spend_usd || config.mapping) {
    throw new Error("Agent adaptation requires instructions, model settings, positive inference budgets, and no direct mapping.");
  }
  if (new Set(config.files.map(f => f.path)).size !== config.files.length || config.files.some(f => !integrationRelativePath(f.path))
    || !config.files.some(f => f.mode !== "read")) throw new Error("Declare distinct relative files with a writable scope.");
  for (const command of [...config.prepare, ...config.checks]) if (command.cwd !== "." && !integrationRelativePath(command.cwd)) throw new Error("Commands must use a repository-relative cwd.");
  if (Buffer.byteLength(JSON.stringify(config)) > 65536) throw new Error("Integration configuration exceeds 64 KiB.");
  return config;
}

export function validateDirectMapping(config, plan, files) {
  if (integrationStrategy(config) !== M.DIRECT) return;
  const writable = plan.files.filter(file => file.mode !== "read").map(file => file.path);
  if (writable.length !== config.mapping.length || config.mapping.some(item => !writable.includes(item.source) || typeof files[item.source] !== "string"))
    throw new Error("Every writable experiment file must map to a repository file; keep adapters read-only.");
}

