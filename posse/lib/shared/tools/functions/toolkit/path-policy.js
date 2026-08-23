import fs from "node:fs";
import path from "node:path";

import { isInsideRoot, realpathExistingPrefix } from "../../../../domains/runtime/functions/fs-safety.js";
import {
  isSensitiveEnvFileOrTargetPath,
  isSensitiveEnvFilePath,
} from "../../../../domains/runtime/functions/sensitive-paths.js";
import {
  normalizeDisplaySlashes,
  toDisplayPath,
} from "../../../format/functions/display-paths.js";
import { MutationPolicy, splitShellSubcommands as policySplitShellSubcommands } from "../../../scope/classes/MutationPolicy.js";
import { agentHiddenReadablePathReason } from "../../../scope/functions/agent-hidden-paths.js";

const PRIVATE_WORKSPACE_DOT_DIRS = new Set([".git", ".claude", ".codex", ".posse-worktrees", ".posse-test-suites"]);
const PRIVATE_POSSE_ROOTS = new Set(["agent-loaders", "db", "logs", "mcp", "research-state", "atlas"]);
export const DETERMINISTIC_READ_FILE_MAX_SIZE_BYTES = 5 * 1024 * 1024;

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

/**
 * Resolve one existing regular file through the deterministic read_file path
 * policy. Callers own text decoding and range selection, but must share this
 * gate so handoff evidence cannot read anything read_file itself would reject.
 */
export function resolveDeterministicReadableFile(cwd, displayPath, scopePredicates = null, {
  maxSizeBytes = DETERMINISTIC_READ_FILE_MAX_SIZE_BYTES,
  safePathImpl = safePath,
} = {}) {
  let filePath;
  try {
    filePath = safePathImpl(cwd, displayPath, scopePredicates);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  const hiddenErr = agentHiddenPathError(cwd, filePath, displayPath);
  if (hiddenErr) return { ok: false, error: hiddenErr };
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `File not found: ${toDisplayPath(cwd, filePath)}` };
  }
  if (isSensitiveEnvFileOrTargetPath(filePath)) {
    return {
      ok: false,
      error: "Access to .env files is blocked. Use documented config examples or code paths instead.",
    };
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return { ok: false, error: `Could not inspect file: ${err?.message || String(err)}` };
  }
  if (!stat.isFile()) {
    const kind = stat.isDirectory() ? "a directory, not a file" : "not a regular file";
    return { ok: false, error: `Path is ${kind}: ${toDisplayPath(cwd, filePath)}` };
  }
  if (stat.size > maxSizeBytes) {
    return {
      ok: false,
      error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Use offset/limit to read a portion.`,
    };
  }
  return { ok: true, path: filePath, stat };
}

export function buildScopePredicates(cwd, scope) {
  return MutationPolicy.fromScopeSpec(scope, { cwd }).toToolkitPredicates();
}

export function splitShellSubcommands(command) {
  return policySplitShellSubcommands(command);
}

export { isSensitiveEnvFileOrTargetPath, isSensitiveEnvFilePath };
