// lib/domains/handoff/functions/helpers/merge-state.js
//
// Merge-state detection for worktrees.

import fs from "fs";
import path from "path";
import { gitExecAsync } from "../../../git/functions/utils.js";

async function gitTextAsync(cwd, args) {
  return await gitExecAsync(args, cwd, {
    timeoutMs: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

/**
 * Detect a pending merge in a worktree (from rebase-on-lease conflicts).
 * Returns { targetHash, mergeMsg, conflicts } or null when no merge is pending.
 */
export async function detectPendingMergeAsync(cwd) {
  if (!cwd) return null;
  let mergeHead = null;
  try {
    mergeHead = (await gitTextAsync(cwd, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).trim();
  } catch (err) {
    // `rev-parse --verify --quiet` uses status 1 only for an absent ref. Native
    // auth, transport, timeout, binary, and malformed-repository failures must
    // remain distinguishable and block handoff rather than shrinking scope.
    const status = Number(err?.status ?? err?.statusCode ?? err?.code);
    if (status === 1) return null;
    throw err;
  }

  if (!mergeHead) throw new Error("git returned an empty MERGE_HEAD");

  // --relative anchors paths to `cwd` rather than the git top-level. Once
  // MERGE_HEAD exists, failure to enumerate conflicts is not equivalent to an
  // empty conflict set and must remain visible to the caller.
  const raw = await gitTextAsync(cwd, ["diff", "--name-only", "--diff-filter=U", "--relative"]);
  const conflicts = raw
    .split("\n")
    .map((s) => s.replace(/\\/g, "/").trim())
    .filter(Boolean);

  let mergeMsg = null;
  try {
    const gitDir = (await gitTextAsync(cwd, ["rev-parse", "--git-dir"])).trim();
    const msgPath = path.isAbsolute(gitDir) ? path.join(gitDir, "MERGE_MSG") : path.join(cwd, gitDir, "MERGE_MSG");
    mergeMsg = (await fs.promises.readFile(msgPath, "utf-8")).trim();
  } catch {
    // best effort
  }

  return { targetHash: mergeHead, mergeMsg, conflicts };
}
