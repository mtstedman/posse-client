import path from "path";
import { gitExec } from "../../git/functions/utils.js";
import { isInsideRoot, normPath } from "../../../shared/scope/functions/path.js";

export class AssessmentScopePathResolver {
  #nestedRepoPrefixCache = new Map();

  // Worktree roots do not move during an assessment session. Keep successful
  // resolutions by cwd while allowing a transient Git failure to retry.
  deriveNestedRepoPrefix(cwd = process.cwd()) {
    if (!cwd) return null;
    const key = path.resolve(cwd);
    if (this.#nestedRepoPrefixCache.has(key)) return this.#nestedRepoPrefixCache.get(key);
    try {
      const repoRoot = path.resolve(gitExec(["rev-parse", "--show-toplevel"], cwd));
      const rel = path.relative(repoRoot, key);
      const prefix = (!rel || rel === "." || !isInsideRoot(key, repoRoot, { allowEqual: false, followSymlinks: false }))
        ? null
        : (normPath(rel) || null);
      this.#nestedRepoPrefixCache.set(key, prefix);
      return prefix;
    } catch {
      return null;
    }
  }
}

export const assessmentScopePathResolver = new AssessmentScopePathResolver();
