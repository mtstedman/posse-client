import fs from "node:fs";
import path from "node:path";

function pathEntryExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function scopePathKey(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function uniqueScopePaths(values = []) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const key = scopePathKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function resolveRepoScopePath(projectDir, value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const root = path.resolve(projectDir);
  const resolved = path.resolve(root, raw);
  const relative = path.relative(root, resolved);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return null;
  }
  return resolved;
}

/**
 * Correct planner file-kind mistakes against the checked-out repository.
 * This runs only when a real Git worktree marker is present; isolated planner
 * fixtures and non-repository artifact roots retain their declared scope.
 *
 * @param {Record<string, any>} task
 * @param {string} projectDir
 * @returns {{ changed: boolean, movedToCreate: string[], movedToModify: string[] }}
 */
export function reconcilePlannerFileKinds(task, projectDir) {
  const jobType = task?.job_type || "dev";
  const taskMode = task?.task_mode || "code";
  const repoCodeTask = (jobType === "dev" || jobType === "code")
    && (taskMode === "code" || taskMode === "dev");
  if (!repoCodeTask || !projectDir || !pathEntryExists(path.join(path.resolve(projectDir), ".git"))) {
    return { changed: false, movedToCreate: [], movedToModify: [] };
  }

  const originalModify = Array.isArray(task.files_to_modify) ? task.files_to_modify : [];
  const originalCreate = Array.isArray(task.files_to_create) ? task.files_to_create : [];
  const filesToModify = [];
  const filesToCreate = [];
  const movedToCreate = [];
  const movedToModify = [];

  for (const filePath of originalModify) {
    const resolved = resolveRepoScopePath(projectDir, filePath);
    if (resolved && !pathEntryExists(resolved)) {
      filesToCreate.push(filePath);
      movedToCreate.push(filePath);
    } else {
      filesToModify.push(filePath);
    }
  }

  for (const filePath of originalCreate) {
    const resolved = resolveRepoScopePath(projectDir, filePath);
    if (resolved && pathEntryExists(resolved)) {
      filesToModify.push(filePath);
      movedToModify.push(filePath);
    } else {
      filesToCreate.push(filePath);
    }
  }

  task.files_to_modify = uniqueScopePaths(filesToModify);
  task.files_to_create = uniqueScopePaths(filesToCreate);
  const changed = JSON.stringify(task.files_to_modify) !== JSON.stringify(originalModify)
    || JSON.stringify(task.files_to_create) !== JSON.stringify(originalCreate);
  return { changed, movedToCreate, movedToModify };
}
