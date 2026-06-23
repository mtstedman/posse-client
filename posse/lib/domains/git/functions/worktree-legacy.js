// lib/domains/git/functions/worktree-legacy.js
//
// Migration of legacy (pre-canonical-naming) worktrees to their canonical path,
// in both sync (git-move with on-disk rename fallback) and async (native) forms.

import fs from "fs";
import path from "path";
import { Worktree } from "../classes/index.js";
import { runGitNativeMethodAsync } from "./native/invoke.js";
import { findLegacyWorktreeForWi } from "./worktree-path.js";

export function migrateLegacyWorktreeIfNeeded(canonicalPath, projectDir, wiId) {
  if (fs.existsSync(canonicalPath) || wiId == null) return null;
  const legacy = findLegacyWorktreeForWi(projectDir, wiId);
  if (!legacy) return null;
  try {
    Worktree.at(projectDir, legacy).move(canonicalPath);
    return legacy;
  } catch {
    // Fallback: rename on disk then repair git metadata.
    try {
      Worktree.at(projectDir, legacy).move(canonicalPath, { fallbackRename: true });
      return legacy;
    } catch {
      return null;
    }
  }
}

export async function migrateLegacyWorktreeIfNeededAsync(
  canonicalPath,
  projectDir,
  wiId,
  { signal = null, nativeParity = {} } = {},
) {
  if (wiId == null) return null;
  return await runGitNativeMethodAsync(
    "git.worktree.migrateLegacy",
    {
      canonicalPath: path.resolve(canonicalPath),
      projectDir: path.resolve(projectDir),
      wiId: String(wiId),
    },
    { ...nativeParity, signal },
  );
}
