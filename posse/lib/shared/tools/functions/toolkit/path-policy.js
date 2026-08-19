import path from "path";

import { isInsideRoot, realpathExistingPrefix } from "../../../../domains/runtime/functions/fs-safety.js";
import {
  isSensitiveEnvFileOrTargetPath,
  isSensitiveEnvFilePath,
} from "../../../../domains/runtime/functions/sensitive-paths.js";
import { normalizeDisplaySlashes } from "../../../format/functions/display-paths.js";
import { MutationPolicy, splitShellSubcommands as policySplitShellSubcommands } from "../../../scope/classes/MutationPolicy.js";
import { agentHiddenReadablePathReason } from "../../../scope/functions/agent-hidden-paths.js";

const PRIVATE_WORKSPACE_DOT_DIRS = new Set([".git", ".claude", ".codex", ".posse-worktrees", ".posse-test-suites"]);
const PRIVATE_POSSE_ROOTS = new Set(["agent-loaders", "db", "logs", "mcp", "research-state", "atlas"]);

export function safePath(cwd, filePath, scopePredicates = null) {
  const resolved = path.resolve(cwd, filePath);
  const realCwd = realpathExistingPrefix(cwd);
  const realResolved = realpathExistingPrefix(resolved);
  const withinCwd = isInsideRoot(realResolved, realCwd, { followSymlinks: false });
  if (!withinCwd && !scopePredicates?.isWithinScopeRoot(realResolved)) {
    throw new Error(`Path escapes working directory: ${filePath}`);
  }
  if (withinCwd && isPrivateWorkspacePath(realCwd, realResolved)) {
    throw new Error(`Access to private workspace metadata is blocked: ${filePath}`);
  }
  return resolved;
}

function isPrivateWorkspacePath(realCwd, resolvedPath) {
  const rel = normalizeDisplaySlashes(path.relative(realCwd, resolvedPath));
  if (!rel || rel === ".") return false;
  const parts = rel.split("/").filter(Boolean);
  const first = parts[0];
  if (PRIVATE_WORKSPACE_DOT_DIRS.has(first)) return true;
  if (first === ".posse") {
    if (parts[1] === "resources") return false;
    if (!parts[1] || PRIVATE_POSSE_ROOTS.has(parts[1])) return true;
    return true;
  }
  return false;
}

export function agentHiddenPathReasonForAbsolute(cwd, resolvedPath) {
  const rel = normalizeDisplaySlashes(path.relative(cwd, resolvedPath));
  return agentHiddenReadablePathReason(rel);
}

export function agentHiddenPathError(cwd, resolvedPath, displayPath) {
  const reason = agentHiddenPathReasonForAbsolute(cwd, resolvedPath);
  return reason ? `Access to hidden workspace path is blocked: ${displayPath} (${reason}).` : null;
}

export function buildScopePredicates(cwd, scope) {
  return MutationPolicy.fromScopeSpec(scope, { cwd }).toToolkitPredicates();
}

export function splitShellSubcommands(command) {
  return policySplitShellSubcommands(command);
}

export { isSensitiveEnvFileOrTargetPath, isSensitiveEnvFilePath };
