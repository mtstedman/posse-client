// lib/handoff/helpers/merge-state.js
//
// Merge-state detection for worktrees.

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

/**
 * Detect a pending merge in a worktree (from rebase-on-lease conflicts).
 * Returns { targetHash, mergeMsg, conflicts } or null when no merge is pending.
 */
export function detectPendingMerge(cwd) {
  if (!cwd) return null;
  let mergeHead = null;
  try {
    mergeHead = execFileSync("git", ["rev-parse", "--verify", "MERGE_HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }

  let conflicts = [];
  try {
    // --relative anchors paths to `cwd` rather than the git top-level.
    const raw = execFileSync("git", ["diff", "--name-only", "--diff-filter=U", "--relative"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
    conflicts = raw
      .split("\n")
      .map((s) => s.replace(/\\/g, "/").trim())
      .filter(Boolean);
  } catch {
    // keep empty list
  }

  let mergeMsg = null;
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
    const msgPath = path.isAbsolute(gitDir) ? path.join(gitDir, "MERGE_MSG") : path.join(cwd, gitDir, "MERGE_MSG");
    if (fs.existsSync(msgPath)) mergeMsg = fs.readFileSync(msgPath, "utf-8").trim();
  } catch {
    // best effort
  }

  return { targetHash: mergeHead, mergeMsg, conflicts };
}
