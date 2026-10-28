import fs from "node:fs";
import path from "node:path";
import { safePath, isSensitiveEnvFileOrTargetPath } from "../../../shared/tools/functions/toolkit/index.js";
import { protectedMutablePathReason } from "../../runtime/functions/protected-paths.js";
import { gitCommitAll } from "../../git/functions/commit-scope.js";
import { gitExec } from "../../git/functions/utils.js";
import { withWorktreeLock } from "../../git/functions/worktree.js";

// workspaceCwd comes from the executing host, never from tool arguments. Keep
// file creation and the scoped commit under the same worktree lock.
export function materializeScopeCreates(workspaceCwd, entries, { jobId, gateId = null } = {}) {
  const creates = entries.filter((entry) => entry.access === "create");
  if (!creates.length || !workspaceCwd) return [];
  return withWorktreeLock(workspaceCwd, workspaceCwd, () => {
    const candidates = creates.map((entry) => {
      const target = safePath(workspaceCwd, entry.path);
      const reason = protectedMutablePathReason(entry.path);
      if (reason || isSensitiveEnvFileOrTargetPath(target)) throw new Error(`Scope create refused for ${entry.path}: ${reason || "protected environment file"}`);
      // Reject symlinks even within the checkout: a grant is for this exact path.
      for (let cursor = target; cursor !== path.resolve(workspaceCwd); cursor = path.dirname(cursor)) {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Scope create refused for symlink: ${entry.path}`);
      }
      let ignored = "";
      try { ignored = gitExec(["check-ignore", "-v", "--", entry.path], workspaceCwd); }
      catch (error) { if (Number(error.status ?? error.exitCode ?? error.exit_code) !== 1) throw error; }
      if (String(ignored || "").trim() && !String(ignored).split("\t")[0].split(":").at(-1)?.startsWith("!")) throw new Error(`Scope create refused for ignored path: ${entry.path}`);
      return { ...entry, target };
    });
    const created = [];
    for (const entry of candidates) {
      if (fs.existsSync(entry.target)) continue;
      fs.mkdirSync(path.dirname(entry.target), { recursive: true });
      fs.writeFileSync(entry.target, "", { flag: "wx" });
      try {
        const result = gitCommitAll(`posse: scope grant create ${entry.path}${gateId ? ` (gate #${gateId})` : ""}`, workspaceCwd,
          { createFiles: [entry.path], modifyFiles: [] }, { jobId, worktreeLock: false, allowEmptyCreatePaths: [entry.path] });
        if (!result.createdCommit) throw new Error(`Scope create was not committed: ${entry.path}`);
        created.push(entry.path);
      } catch (error) {
        const tracked = gitExec(["ls-files", "--", entry.path], workspaceCwd).trim();
        if (!tracked && fs.statSync(entry.target).size === 0) fs.unlinkSync(entry.target);
        throw new Error(`Scope create commit failed for ${entry.path}: ${error.message}`, { cause: error });
      }
    }
    return created;
  });
}
