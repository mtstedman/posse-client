// Tool-time write-lock guard (defense in depth).
//
// Called by the mutating tool executors right before they touch the
// filesystem. Verifies the ambient job holds a file lock covering the target
// path; acquires one transactionally when the lease-time scope allows it but
// the row is missing; refuses the write when another work item owns the path.
// The refusal copy deliberately instructs the agent to report BLOCKED rather
// than retry: cross-WI locks are held until the holder's branch merges, so
// polling can never succeed within an attempt — and even if the lock freed,
// this worktree's base would be stale by exactly the change that mattered.
//
// The guard must never break tool execution: any internal error (no DB in
// this process, schema drift, unexpected path shape) fails open with a
// warning, because the scope predicates above it remain the primary barrier.

import path from "path";
import { getObservationContext } from "../../observability/functions/observations.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import { verifyOrAcquireJobWriteLockForPath } from "./file-locks.js";

function repoRelativePath(cwd, displayPath) {
  const base = path.resolve(cwd || process.cwd());
  const resolved = path.resolve(base, String(displayPath || ""));
  const rel = path.relative(base, resolved);
  if (!rel || rel === "." || path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../")) {
    return null;
  }
  return rel.replace(/\\/g, "/");
}

function holderLabel(conflict) {
  if (conflict?.type === "work_item") {
    const title = conflict.lock?.work_item_title ? ` ("${String(conflict.lock.work_item_title).slice(0, 60)}")` : "";
    return `work item WI#${conflict.lock?.work_item_id}${title}`;
  }
  const status = conflict?.lock?.job_status ? ` (${conflict.lock.job_status})` : "";
  return `job #${conflict?.lock?.job_id}${status}`;
}

/**
 * Guard a mutating tool call against the file-lock table. Returns null when
 * the write may proceed, or an "Error: ..." string to return to the agent.
 *
 * Skips (returns null) when: no ambient job (ad-hoc CLI/test usage), the path
 * resolves outside the workspace (external artifact roots are not lockable
 * repo paths), or the job type takes no write locks (artificer, db-mode,
 * assess-only).
 */
export function guardToolWriteLock(toolName, displayPath, cwd) {
  try {
    const ambient = getObservationContext() || {};
    if (ambient.job_id == null) return null;
    const rel = repoRelativePath(cwd, displayPath);
    if (!rel) return null;
    const result = verifyOrAcquireJobWriteLockForPath(ambient.job_id, rel, { source: "tool_guard" });
    if (result?.ok !== false) return null;
    const holder = holderLabel(result.conflict);
    return `Error: ${toolName} blocked - ${displayPath} is write-locked by ${holder}. `
      + `Another work item currently owns this path; the lock is only released when its branch merges. `
      + `Do not retry or poll for the lock. Finish what you can within your remaining scope, `
      + `then report status BLOCKED naming the lock holder (${holder}) as the reason.`;
  } catch (err) {
    log.warn("write-lock-guard", `guard failed open for ${toolName} ${displayPath}: ${err?.message || err}`);
    return null;
  }
}
