import { adminGitExec } from "./admin-git-exec.js";

const COMMIT = /^[0-9a-f]{40}$/;

/** Local history evidence only. A descendant may have reverted the change. */
export function readDeploymentInclusion({ projectDir, mergeCommit, publication } = {}) {
  const deployed = publication?.deployment_head;
  if (!projectDir || !COMMIT.test(String(mergeCommit || "")) || !COMMIT.test(String(deployed || ""))
    || mergeCommit === deployed || publication.deployment_state !== "verified" || publication.head !== deployed) return null;
  try {
    // No fetch, checkout or branch resolution. Missing/shallow history and
    // unrelated revisions remain unknown; replacement refs cannot establish proof.
    adminGitExec(["--no-replace-objects", "merge-base", "--is-ancestor", mergeCommit, deployed], projectDir,
      { timeoutMs: 1500 });
    return { merge_commit: mergeCommit, deployment_commit: deployed };
  } catch { return null; }
}
