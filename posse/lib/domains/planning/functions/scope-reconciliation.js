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

function isRepository(projectDir) {
  return !!projectDir && pathEntryExists(path.join(path.resolve(projectDir), ".git"));
}

function legacyTaskNode(task, index) {
  return {
    index,
    id: String(index),
    role: String(task?.job_type || "dev").trim().toLowerCase(),
    taskMode: String(task?.task_mode || "code").trim().toLowerCase(),
    dependsOn: Array.isArray(task?.depends_on_index)
      ? task.depends_on_index.filter(Number.isInteger).map(String)
      : [],
    scope: task || {},
  };
}

function handoffNode(handoff, index) {
  return {
    index,
    id: String(handoff?.id || index),
    role: String(handoff?.target?.role || "").trim().toLowerCase(),
    taskMode: String(handoff?.report?.scope?.task_mode || "code").trim().toLowerCase(),
    dependsOn: Array.isArray(handoff?.depends_on) ? handoff.depends_on.map(String) : [],
    scope: handoff?.report?.scope || {},
  };
}

function ancestorNodes(node, byId) {
  const result = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const ancestor = byId.get(id);
    if (!ancestor) return;
    result.push(ancestor);
    for (const parentId of ancestor.dependsOn) visit(parentId);
  };
  for (const id of node.dependsOn) visit(id);
  return result;
}

function repoCodeTask(node) {
  return ["dev", "code"].includes(node.role) && ["code", "dev"].includes(node.taskMode);
}

function validateNodes(nodes, projectDir) {
  if (!isRepository(projectDir)) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const issues = [];

  for (const node of nodes) {
    if (!repoCodeTask(node)) continue;
    const ancestors = ancestorNodes(node, byId);
    const ancestorCreates = new Set(
      ancestors.flatMap((ancestor) => uniqueScopePaths(ancestor.scope.files_to_create)).map(scopePathKey),
    );
    const ancestorDeletes = new Set(
      ancestors.flatMap((ancestor) => uniqueScopePaths(ancestor.scope.files_to_delete)).map(scopePathKey),
    );
    const filesToModify = uniqueScopePaths(node.scope.files_to_modify);
    const filesToCreate = uniqueScopePaths(node.scope.files_to_create);
    const modifyKeys = new Set(filesToModify.map(scopePathKey));

    for (const filePath of filesToModify) {
      const key = scopePathKey(filePath);
      if (filesToCreate.some((candidate) => scopePathKey(candidate) === key)) {
        issues.push({
          taskIndex: node.index,
          taskId: node.id,
          path: filePath,
          declaredKind: "modify_and_create",
          reason: "the same task declares the path in both files_to_modify and files_to_create",
        });
        continue;
      }
      const resolved = resolveRepoScopePath(projectDir, filePath);
      if (resolved && !pathEntryExists(resolved) && !ancestorCreates.has(key)) {
        issues.push({
          taskIndex: node.index,
          taskId: node.id,
          path: filePath,
          declaredKind: "files_to_modify",
          reason: "the path does not exist and no prerequisite task creates it",
        });
      }
    }

    for (const filePath of filesToCreate) {
      const key = scopePathKey(filePath);
      if (modifyKeys.has(key)) continue;
      const resolved = resolveRepoScopePath(projectDir, filePath);
      if (resolved && pathEntryExists(resolved) && !ancestorDeletes.has(key)) {
        issues.push({
          taskIndex: node.index,
          taskId: node.id,
          path: filePath,
          declaredKind: "files_to_create",
          reason: "the path already exists and no prerequisite task deletes it",
        });
      }
    }
  }
  return issues;
}

export function validatePlannerTaskFileKinds(tasks, projectDir) {
  const nodes = Array.isArray(tasks) ? tasks.map(legacyTaskNode) : [];
  return validateNodes(nodes, projectDir);
}

export function validatePlannerPacketFileKinds(packet, projectDir) {
  if (packet?.profile !== "planner.plan.v1" || packet?.outcome !== "success") return [];
  const nodes = Array.isArray(packet?.handoffs) ? packet.handoffs.map(handoffNode) : [];
  return validateNodes(nodes, projectDir);
}

/**
 * Legacy compiler guard. This intentionally does not repair planner scope: a
 * missing modify path may be a typo, and silently turning it into creation
 * authority can materialize an unrelated file. Callers must reject `issues`.
 */
export function reconcilePlannerFileKinds(task, projectDir, { tasks = [task], taskIndex = 0 } = {}) {
  const allIssues = validatePlannerTaskFileKinds(tasks, projectDir);
  const issues = allIssues.filter((issue) => issue.taskIndex === taskIndex);
  return {
    changed: false,
    movedToCreate: [],
    movedToModify: [],
    issues,
    errors: issues.map((issue) => `${issue.declaredKind} path "${issue.path}" is invalid: ${issue.reason}`),
  };
}
