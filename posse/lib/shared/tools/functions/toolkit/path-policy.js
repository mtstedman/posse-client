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
import { primaryCheckoutAlias } from "../../../scope/functions/primary-checkout-alias.js";

const PRIVATE_WORKSPACE_DOT_DIRS = new Set([".git", ".claude", ".codex", ".posse-worktrees", ".posse-test-suites"]);
const PRIVATE_POSSE_ROOTS = new Set(["agent-loaders", "db", "logs", "mcp", "research-state", "atlas"]);
export const DETERMINISTIC_READ_FILE_MAX_SIZE_BYTES = 5 * 1024 * 1024;

export function safePath(cwd, filePath, scopePredicates = null) {
  let resolved = path.resolve(cwd, filePath);
  const realCwd = realpathExistingPrefix(cwd);
  let realResolved = realpathExistingPrefix(resolved);
  let withinCwd = isInsideRoot(realResolved, realCwd, { followSymlinks: false });
  if (!withinCwd && !scopePredicates?.isWithinScopeRoot(realResolved)) {
    // A job in a linked worktree that names `<primary checkout>/x` means the
    // same repo path in its own checkout, never the primary's stale copy.
    const alias = primaryCheckoutAlias(cwd, filePath);
    if (alias) {
      resolved = alias.aliased;
      realResolved = realpathExistingPrefix(resolved);
      withinCwd = isInsideRoot(realResolved, realCwd, { followSymlinks: false });
    }
    if (!withinCwd) {
      const checkoutPath = checkoutReadRootPath(filePath, resolved, realResolved, scopePredicates);
      if (checkoutPath) return checkoutPath;
      throw new Error(`Path escapes working directory: ${filePath}. Readable roots: ${readableRootsText(cwd, scopePredicates)}`);
    }
  }
  if (withinCwd && isPrivateWorkspacePath(realCwd, realResolved)) {
    throw new Error(`Access to private workspace metadata is blocked: ${filePath}`);
  }
  return resolved;
}

// A read-only checkout root (an artificer's work item checkout) admits a path
// by both its spelling and its symlink-resolved target. When that root is a
// linked worktree, `<primary checkout>/x` names the same repo path in it.
function checkoutReadRootPath(filePath, resolved, realResolved, scopePredicates) {
  const within = scopePredicates?.isWithinCheckoutReadRoot;
  if (typeof within !== "function") return null;
  if (within(resolved) && within(realResolved)) return resolved;
  for (const root of scopePredicates.checkoutReadRoots || []) {
    const alias = primaryCheckoutAlias(root, filePath);
    if (alias && within(alias.aliased) && within(realpathExistingPrefix(alias.aliased))) return alias.aliased;
  }
  return null;
}

/**
 * True for an entry a list or search reached outside the cwd that no read
 * root admits, such as a checkout read root's `.env*` file or a `.posse` file
 * an include glob pulled back past the skip globs.
 */
export function isUnreadableOutsideCwd(cwd, absPath, scopePredicates = null) {
  if (isInsideRoot(absPath, cwd, { followSymlinks: false })) return false;
  return !scopePredicates?.isWithinScopeRoot?.(absPath)
    && !scopePredicates?.isWithinCheckoutReadRoot?.(absPath);
}

function readableRootsText(cwd, scopePredicates) {
  const roots = [
    `${path.resolve(cwd)} (working directory)`,
    ...(scopePredicates?.readableRoots || []),
    ...(scopePredicates?.checkoutReadRoots || []).map((root) => `${root} (read-only checkout)`),
  ];
  return [...new Set(roots)].join(", ");
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
const LONG_LINE_PROBE_BYTES = 1024 * 1024;

function startsWithVeryLongLine(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const probe = Buffer.allocUnsafe(LONG_LINE_PROBE_BYTES);
    const bytesRead = fs.readSync(fd, probe, 0, probe.length, 0);
    return bytesRead === LONG_LINE_PROBE_BYTES && !probe.subarray(0, bytesRead).includes(10);
  } catch {
    return false;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

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
      error: startsWithVeryLongLine(filePath)
        ? `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB) and its first line is longer than 1 MB (minified or single-line data), so offset/limit line paging cannot split it. Use jsonPath to extract a JSON value, search to get match snippets with their columns, or maxBytes to read the first bytes.`
        : `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Use offset/limit to read a portion.`,
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
