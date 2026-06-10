export const WORKSPACE_SKIP_DIR_NAMES = Object.freeze([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".cache",
  ".vscode",
  ".idea",
  ".posse",
  ".posse-worktrees",
  ".posse-test-suites",
  ".claude",
  ".codex",
]);

export const WORKSPACE_SKIP_DIRS = new Set(WORKSPACE_SKIP_DIR_NAMES);

export function createWorkspaceSkipDirs(extra = []) {
  return new Set([
    ...WORKSPACE_SKIP_DIR_NAMES,
    ...(Array.isArray(extra) ? extra : []),
  ]);
}
