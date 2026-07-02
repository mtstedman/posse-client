// lib/domains/git/functions/worktree-legacy.js
//
// Migration of legacy (pre-canonical-naming) worktrees to their canonical path
// via the native git daemon.

import path from "path";
import { runGitNativeMethodAsync } from "./native/invoke.js";

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
