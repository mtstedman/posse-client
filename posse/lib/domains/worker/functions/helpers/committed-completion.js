// lib/domains/worker/functions/helpers/committed-completion.js
//
// Post-execution reads the agent's terminal status from the compatibility
// DEV/ARTIFICER RESULT block, whose notes are cut to 30 words. The committed
// handoff packet keeps the agent's full blocker and remaining_work; these
// helpers read that structured completion and what it says about a failed
// scoped commit.

import { getCommittedAttemptCompletion } from "../../../handoff/functions/agent-handoff.js";

/**
 * The attempt's committed completion when it agrees with the rendered status.
 * @returns {{ status: string, blocker: string|null, remainingWork: string[] }|null}
 */
export function committedCompletionForAttempt({ jobId, attemptId, status } = {}, {
  readCompletion = getCommittedAttemptCompletion,
} = {}) {
  const expected = String(status || "").trim().toUpperCase();
  if (!expected) return null;
  let completion = null;
  try {
    completion = readCompletion({ jobId, attemptId });
  } catch {
    return null;
  }
  if (!completion || String(completion.status || "").trim().toUpperCase() !== expected) return null;
  const blocker = typeof completion.blocker === "string" && completion.blocker.trim()
    ? completion.blocker.trim()
    : null;
  const remainingWork = Array.isArray(completion.remaining_work)
    ? completion.remaining_work.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  return { status: expected, blocker, remainingWork };
}

// posse-git's MATERIALIZED_FILE_NOT_WRITTEN message lists the empty paths.
const EMPTY_MATERIALIZED_PATHS_RE = /materialized creation target\(s\) are still empty:\s*(.+)$/i;

export function unwrittenMaterializedPaths(gitErr) {
  if (gitErr?.code !== "MATERIALIZED_FILE_NOT_WRITTEN") return [];
  const message = String(gitErr?.nativeFailure?.message || gitErr?.message || "").trim();
  const listed = message.match(EMPTY_MATERIALIZED_PATHS_RE)?.[1] || "";
  return [...new Set(listed.split(",").map((entry) => entry.trim().replace(/\\/g, "/")).filter(Boolean))];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Named in full or by file name as a whole word: agents write
// "passive-tree.json was NOT generated" as often as the repository path.
function textNamesPath(text, relPath) {
  const baseName = relPath.split("/").pop();
  return [relPath, baseName].filter(Boolean).some((needle) => (
    new RegExp(`(?:^|[^A-Za-z0-9_.-])${escapeRegExp(needle)}(?![A-Za-z0-9_-])(?!\\.[A-Za-z0-9])`).test(text)
  ));
}

/**
 * Materialized files the commit refused as still empty that the agent itself
 * listed in its PARTIAL remaining_work. A blind retry of the same call cannot
 * produce them; the agent already said it could not.
 */
export function selfDeclaredUnwrittenPaths(gitErr, remainingWork = []) {
  const text = (Array.isArray(remainingWork) ? remainingWork : []).join("\n");
  if (!text.trim()) return [];
  return unwrittenMaterializedPaths(gitErr).filter((relPath) => textNamesPath(text, relPath));
}
