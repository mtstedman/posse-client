import fs from "node:fs";
import path from "node:path";
import { protectedMutablePathReason, isSensitiveEnvRepoPath } from "../../runtime/functions/protected-paths.js";
import { isInsideRoot } from "../../runtime/functions/fs-safety.js";

export function namedTaskPaths(task = {}) {
  // Exact path tokens only; no basename search, globs, or inferred directories.
  return [...new Set([...String(task.task_spec || "").matchAll(/(?:^|[\s`"'(\[{:])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+)/g)].map((match) => match[1]))];
}

// Only a code task edits the files its spec names. A report, content or image
// task that cites an existing repo file as its subject must stay file-free:
// completing its scope would route it to dev as a code change (H4).
const CODE_TASK_MODES = new Set(["code", "dev"]);

export function completeTaskScope(task, root) {
  if (!root || !["dev", "fix", undefined].includes(task.job_type) || !CODE_TASK_MODES.has(task.task_mode ?? "code")) return [];
  const declared = new Set([...(task.files_to_modify || []), ...(task.files_to_create || []), ...(task.files_to_delete || [])]);
  const added = namedTaskPaths(task).filter((file) => {
    if (declared.has(file) || file.split("/").includes("..") || protectedMutablePathReason(file) || isSensitiveEnvRepoPath(file)) return false;
    const target = path.resolve(root, file);
    try { return isInsideRoot(target, root, { allowEqual: false }) && !fs.lstatSync(target).isSymbolicLink() && fs.statSync(target).isFile(); }
    catch { return false; }
  });
  if (added.length) task.files_to_modify = [...(task.files_to_modify || []), ...added];
  return added;
}

export function plannerDependencyKind(task = {}, upstream = {}) {
  if (task._shared_contracts?.some((contract) => contract.owner_task_id === upstream._plan_task_id)) return "hard";
  // Non-file work (research, DB effects, environment/approval gates) cannot be
  // proven independent by comparing files. Preserve its ordering contract.
  if (![task, upstream].every((entry) => ["dev", "fix", undefined].includes(entry.job_type) && entry.task_mode !== "db")) return "hard";
  const downstream = new Set([...(task.files_to_modify || []), ...(task.files_to_create || []), ...(task.files_to_delete || [])]);
  const upstreamFiles = [...(upstream.files_to_modify || []), ...(upstream.files_to_create || []), ...(upstream.files_to_delete || [])];
  if (!downstream.size || !upstreamFiles.length || task.create_roots?.length || upstream.create_roots?.length) return "hard";
  if (upstreamFiles.some((file) => downstream.has(file))) return "hard";
  // A spec that names an upstream file verbatim depends on that file's final
  // shape whether the upstream creates, modifies or deletes it.
  const named = new Set(namedTaskPaths(task));
  if (upstreamFiles.some((file) => named.has(file))) return "hard";
  return "soft";
}
