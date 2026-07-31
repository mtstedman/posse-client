export function getReviewDirtyState(worktreeStatus = {}) {
  const targetFiles = Array.isArray(worktreeStatus?.targetFiles)
    ? worktreeStatus.targetFiles
    : [];
  const worktreeFiles = Array.isArray(worktreeStatus?.wtFiles)
    ? worktreeStatus.wtFiles
    : [];
  const inScopeFiles = worktreeFiles.filter((entry) => entry?.inScope);
  const discardableWorktreeFiles = worktreeFiles.filter((entry) => !entry?.inScope);
  const targetDirty = worktreeStatus?.targetDirty === true || targetFiles.length > 0;
  const blockers = [
    ...targetFiles.map((entry) => ({ ...entry, location: "target" })),
    ...worktreeFiles.map((entry) => ({ ...entry, location: "worktree" })),
  ];

  if (blockers.length === 0 && targetDirty) {
    blockers.push({
      status: "??",
      path: "(unknown target change)",
      location: "target",
    });
  }

  return {
    targetFiles,
    worktreeFiles,
    inScopeFiles,
    discardableWorktreeFiles,
    discardCandidates: [
      ...targetFiles.map((entry) => ({ ...entry, location: "target" })),
      ...discardableWorktreeFiles.map((entry) => ({ ...entry, location: "worktree" })),
    ],
    blockers,
    dirty: blockers.length > 0,
    canDecide: blockers.length === 0,
    canCommit: inScopeFiles.length > 0,
    canStashTarget: targetDirty,
    canDiscard: targetFiles.length > 0 || discardableWorktreeFiles.length > 0,
  };
}
