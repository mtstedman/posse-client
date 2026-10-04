import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { automationDataDir, repositoryID } from "../../automation/functions/paths.js";

function fail(message) {
  throw Object.assign(new Error(message), { code: "agent_scope_mismatch" });
}

function realDirectory(value, label) {
  let resolved;
  try { resolved = fs.realpathSync(path.resolve(value)); } catch { fail(`${label} does not exist`); }
  if (!fs.statSync(resolved).isDirectory()) fail(`${label} must be a folder`);
  return resolved;
}

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function repositoryRoot(value) {
  let current = realDirectory(value, "Agent working folder");
  while (true) {
    if (fs.existsSync(path.join(current, ".git")) || fs.existsSync(path.join(current, ".posse"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// resolveAgentWorkingDirectory turns the authored scope into the directory
// actually supplied to the provider. Sandbox ignores the caller's cwd;
// folder and repository reject callers outside their authored boundary.
export function resolveAgentWorkingDirectory(definition, requested = process.cwd(), { createSandbox = true } = {}) {
  const scope = definition?.scope || {};
  if (scope.kind === "sandbox") {
    const root = path.join(automationDataDir(), "agent-sandboxes", definition.name);
    if (createSandbox) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return createSandbox ? fs.realpathSync(root) : path.resolve(root);
  }
  if (scope.kind === "folder") {
    const root = realDirectory(scope.folder_path, "Agent scope folder");
    const candidate = realDirectory(requested || root, "Agent working folder");
    if (!contains(root, candidate)) fail(`Agent ${definition.name} may run only in ${root} or its children`);
    return candidate;
  }
  if (scope.kind === "repository") {
    const root = repositoryRoot(requested);
    if (!root || repositoryID(root) !== scope.repo_id) fail(`Agent ${definition.name} may run only in repository ${scope.repo_id}`);
    return realDirectory(requested, "Agent working folder");
  }
  if (scope.kind === "global" || scope.kind === "general") return realDirectory(requested || os.tmpdir(), "Agent working folder");
  fail(`Agent ${definition?.name || "definition"} has an unsupported scope`);
}

