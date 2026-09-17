import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

import { getLivePairingState } from "./state.js";
import { permitsGrantPath } from "./team-scope.js";
import {
  TEAM_FILE_WRITE_TOOLS,
  TEAM_READ_TOOLS,
} from "../../../catalog/team.js";
import { getVerifiedTeamGrantForWorkItem } from "./team-submissions.js";

// A managed Session deliberately has a small executable write surface. The
// canonical sets live in the catalog because the provider tool runtime and the
// MCP transport both gate on them.
const READ_TOOLS = new Set(TEAM_READ_TOOLS);
const FILE_WRITE_TOOLS = new Set(TEAM_FILE_WRITE_TOOLS);
const verifiedWriteContext = new AsyncLocalStorage();

export function teamApprovalModeActive() {
  const state = getLivePairingState();
  return state?.submission_approval_enabled === 1;
}

export function teamManagedSynchronousToolDenied(toolName) {
  return teamApprovalModeActive() && !READ_TOOLS.has(toolName)
    ? denied(toolName, "this synchronous route has no fresh work-item grant check")
    : null;
}

/** Admission for the MCP transport, which reaches the owner over JSON-RPC in a
 * separate process. A verified, path-bound write context cannot follow that
 * call, so a write arriving this way could never be grant-checked; refuse it
 * here rather than admitting it and failing at the write guard with a reason
 * that reads like a bug. Writes are admitted only on a grant-bound transport
 * (TEAM_GRANT_BOUND_TRANSPORTS), which runs them through
 * runWithTeamManagedToolGrant in the same process as the write. */
export function teamManagedToolAdmitted(suite, name) {
  if (!teamApprovalModeActive()) return true;
  return suite === "tools" && READ_TOOLS.has(name);
}

export function assertTeamManagedProvider(providerName) {
  if (!teamApprovalModeActive()) return;
  if (["openai", "grok"].includes(String(providerName || "").toLowerCase())) return;
  const error = new Error("Team approval mode requires a mediated tool-only provider (OpenAI or Grok)");
  error.code = "POSSE_TEAM_PROVIDER_WRITE_BOUNDARY_UNAVAILABLE";
  throw error;
}

function relativeWritePath(cwd, candidate) {
  if (typeof candidate !== "string" || !candidate.trim() || candidate.includes("\0")) return null;
  const base = path.resolve(cwd);
  const target = path.resolve(base, candidate);
  const rel = path.relative(base, target).replace(/\\/gu, "/");
  if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return null;
  // Do not let a scoped spelling traverse an existing symlink. The toolkit
  // checks this too, but the grant check must bind the same filesystem path.
  let cursor = base;
  for (const component of rel.split("/")) {
    cursor = path.join(cursor, component);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
    }
  }
  return rel;
}

function denied(toolName, reason) {
  return `Error: ${toolName} blocked - ${reason}.`;
}

/** Run a bounded file tool only after a fresh Remote lookup of the current
 * host-signed WI grant. The child context lets synchronous filesystem guards
 * verify the exact path again immediately before mutation. */
export async function runWithTeamManagedToolGrant({ toolName, args, cwd, workItemId, run, grantLookup = getVerifiedTeamGrantForWorkItem }) {
  if (!teamApprovalModeActive()) return run();
  if (READ_TOOLS.has(toolName)) return run();
  if (!FILE_WRITE_TOOLS.has(toolName)) {
    return denied(toolName, "approval mode does not permit this mutation route");
  }
  const rel = relativeWritePath(cwd, args?.path);
  if (!rel) return denied(toolName, "the target is not a regular in-repository path");
  if (!Number.isSafeInteger(Number(workItemId)) || Number(workItemId) <= 0) {
    return denied(toolName, "a bound work item is required");
  }
  let grant;
  try {
    grant = await grantLookup(workItemId, { projectDir: cwd, fresh: true });
  } catch {
    return denied(toolName, "the current work-item grant could not be verified");
  }
  if (!grant?.ok || !permitsGrantPath(grant.effectivePermissions?.write, rel)) {
    return denied(toolName, grant?.reason || "the host grant does not cover this path");
  }
  const context = Object.freeze({
    cwd: path.resolve(cwd),
    toolName,
    workItemId: Number(workItemId),
    path: rel,
    expiresAt: Date.parse(grant.expiresAt || ""),
  });
  return verifiedWriteContext.run(context, run);
}

/** The synchronous toolkit lock guard calls this immediately before a write.
 * No ambient job or locally forged scope approval can substitute for it. */
export function teamManagedWriteGuard(toolName, displayPath, cwd) {
  if (!teamApprovalModeActive()) return null;
  const context = verifiedWriteContext.getStore();
  const rel = relativeWritePath(cwd, displayPath);
  if (!context || context.cwd !== path.resolve(cwd) || context.toolName !== toolName
    || !rel || context.path !== rel
    || !Number.isFinite(context.expiresAt) || context.expiresAt <= Date.now()) {
    return denied(toolName, "a fresh, path-bound work-item grant is required");
  }
  return null;
}
