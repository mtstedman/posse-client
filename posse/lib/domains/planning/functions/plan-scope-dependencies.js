import fs from "node:fs";
import path from "node:path";
import { protectedMutablePathReason, isSensitiveEnvRepoPath } from "../../runtime/functions/protected-paths.js";
import { isInsideRoot } from "../../runtime/functions/fs-safety.js";

export function namedTaskPaths(task = {}) {
  // Exact path tokens only; no basename search, globs, or inferred directories.
  return [...new Set([...String(task.task_spec || "").matchAll(/(?:^|[\s`"'(\[{:])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+)/g)].map((match) => match[1]))];
}

export function completeTaskScope(task, root) {
  if (!root || !["dev", "fix", undefined].includes(task.job_type) || task.task_mode === "db") return [];
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
  const named = new Set(namedTaskPaths(task));
  if ((upstream.files_to_create || []).some((file) => named.has(file))) return "hard";
  return "soft";
}
