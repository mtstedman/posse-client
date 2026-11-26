import path from "node:path";
import { validateToolArguments } from "../../../shared/tools/functions/schema-validation.js";
import { EXPERIMENT_INTEGRATION_SCHEMA } from "../../../catalog/experiment-integration.js";

export function integrationRelativePath(file) {
  return typeof file === "string" && file.split("/").every(part => /^[\w.-]+$/.test(part) && ![".", "..", ".git", ".posse"].includes(part.toLowerCase()));
}

export function validateIntegration(config) {
  const checked = validateToolArguments({ name: "integration", parameters: EXPERIMENT_INTEGRATION_SCHEMA }, config);
  if (!checked.ok) throw new Error(checked.message);
  if (![config.repo_path, config.worktree_path].every(p => path.isAbsolute(p) && path.resolve(p) === p)
    || config.repo_path === config.worktree_path) throw new Error("Distinct absolute repository and worktree paths are required.");
  if (!config.branch.startsWith("experiment/") || !/^experiment\/[\w/-]+$/.test(config.branch)) throw new Error("Use a new experiment/ branch.");
  if (new Set(config.files.map(f => f.path)).size !== config.files.length || config.files.some(f => !integrationRelativePath(f.path))
    || !config.files.some(f => f.mode !== "read")) throw new Error("Declare distinct relative files with a writable scope.");
  for (const command of [...config.prepare, ...config.checks]) if (command.cwd !== "." && !integrationRelativePath(command.cwd)) throw new Error("Commands must use a repository-relative cwd.");
  if (Buffer.byteLength(JSON.stringify(config)) > 65536) throw new Error("Integration configuration exceeds 64 KiB.");
  return config;
}

