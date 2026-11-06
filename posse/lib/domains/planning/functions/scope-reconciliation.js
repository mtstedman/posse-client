import { existingJobDependencyId, validExistingJobDependency } from "./existing-job-dependencies.js";
import { PLANNER_EXISTING_JOB_PREFIX } from "../../../catalog/planning.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { FUZZY_SCAN_SKIP_DIRS } from "../../../catalog/scope-discovery.js";
import fs from "node:fs";
import path from "node:path";
import { listIgnoredRepoPathsSync } from "../../git/functions/ignored-paths.js";
import { AGENT_HANDOFF_PROFILES } from "../../../catalog/handoff.js";

function pathEntryExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function scopePathKey(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
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
  if (!projectDir) return false;
  let directory = path.resolve(projectDir);
  for (;;) {
    if (pathEntryExists(path.join(directory, ".git"))) return true;
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

function ignoredUntrackedPathKeys(projectDir, values) {
  return new Set(listIgnoredRepoPathsSync(projectDir, uniqueScopePaths(values)).map(entry => scopePathKey(entry.path)));
}

function legacyTaskNode(task, index) {
  return {
    index,
    id: String(index),
    role: String(task?.job_type || "dev").trim().toLowerCase(),
    taskMode: String(task?.task_mode || "code").trim().toLowerCase(),
    dependsOn: [
      ...(Array.isArray(task?.depends_on_index) ? task.depends_on_index.filter(Number.isInteger).map(String) : []),
      ...(Array.isArray(task?.depends_on_job_ids) ? task.depends_on_job_ids.map(id => `${PLANNER_EXISTING_JOB_PREFIX}${id}`) : []),
    ],
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

function createdPaths(node) {
  const promoted = node.role === "promote" && Array.isArray(node.scope.mappings)
    ? node.scope.mappings.map(mapping => mapping?.dest).filter(value => typeof value === "string") : [];
  return uniqueScopePaths([...(node.scope.files_to_create || []), ...promoted]);
}

function repoCodeTask(node) {
  return ["dev", "code"].includes(node.role) && ["code", "dev"].includes(node.taskMode);
}

function dependencyNodeMap(nodes, context = {}) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const workItemId = context.workItemId ?? context.work_item_id;
  if (!workItemId) return byId;
  const db = context.db || getDb();
  const pending = nodes.flatMap(node => node.dependsOn);
  const seen = new Set();
  while (pending.length) {
    const ref = pending.pop();
    if (seen.has(ref)) continue;
    seen.add(ref);
    const id = existingJobDependencyId(ref);
    if (id == null || !validExistingJobDependency(id, { workItemId, planJobId: context.planJobId ?? context.jobId ?? context.job_id, db })) continue;
    const job = db.prepare("SELECT payload_json, job_type FROM jobs WHERE id = ?").get(id);
    let scope;
    try { scope = JSON.parse(job.payload_json || "{}"); } catch { continue; }
    const dependsOn = db.prepare("SELECT depends_on_job_id FROM job_dependencies WHERE job_id = ?").all(id)
      .map(row => `${PLANNER_EXISTING_JOB_PREFIX}${row.depends_on_job_id}`);
    byId.set(ref, { id: ref, role: job.job_type, scope: scope || {}, dependsOn });
    pending.push(...dependsOn);
  }
  return byId;
}

function validateNodes(nodes, projectDir, context) {
  if (!isRepository(projectDir)) return [];
  const byId = dependencyNodeMap(nodes, context);
  const issues = [];
  const ignoredPathKeys = ignoredUntrackedPathKeys(
    projectDir,
    nodes
      .filter(repoCodeTask)
      .flatMap((node) => [
        ...uniqueScopePaths(node.scope.files_to_modify),
        ...uniqueScopePaths(node.scope.files_to_create),
      ]),
  );

  for (const node of nodes) {
    if (!repoCodeTask(node)) continue;
    const ancestors = ancestorNodes(node, byId);
    const ancestorCreates = new Set(
      ancestors.flatMap(createdPaths).map(scopePathKey),
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
      if (resolved && ignoredPathKeys.has(key) && !ancestorCreates.has(key)) {
        issues.push({
          taskIndex: node.index,
          taskId: node.id,
          path: filePath,
          declaredKind: "files_to_modify",
          reason: "the path is ignored and will not exist in an isolated worktree",
        });
      } else if (resolved && !pathEntryExists(resolved) && !ancestorCreates.has(key)) {
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

export function validatePlannerTaskFileKinds(tasks, projectDir, context = {}) {
  const nodes = Array.isArray(tasks) ? tasks.map(legacyTaskNode) : [];
  return validateNodes(nodes, projectDir, context);
}

export function validatePlannerPacketFileKinds(packet, projectDir, context = {}) {
  if (packet?.profile !== AGENT_HANDOFF_PROFILES.PLANNER_PLAN || packet?.outcome !== "success") return [];
  const nodes = Array.isArray(packet?.handoffs) ? packet.handoffs.map(handoffNode) : [];
  return validateNodes(nodes, projectDir, context);
}

const FUZZY_SCAN_MAX_ENTRIES = 40000;
const FUZZY_SCAN_MAX_DEPTH = 10;


// Files in the checkout that share the requested path's basename. Bounded
// walk; a repository too large to scan simply yields no fuzzy match.
function filesMatchingBasename(projectDir, basename) {
  const root = path.resolve(projectDir);
  const matches = [];
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > FUZZY_SCAN_MAX_DEPTH || visited > FUZZY_SCAN_MAX_ENTRIES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++visited > FUZZY_SCAN_MAX_ENTRIES) return;
      if (entry.isDirectory()) {
        if (!FUZZY_SCAN_SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && entry.name === basename) {
        matches.push(path.relative(root, path.join(dir, entry.name)).replace(/\\/g, "/"));
      }
    }
  };
  walk(root, 0);
  return matches;
}

/**
 * A planner path that does not exist is often a near miss (wrong directory,
 * stale rename). When exactly one file in the checkout shares its basename,
 * or exactly one shares its last two segments, that file is what the planner
 * meant. Anything else returns null: the caller trims instead of guessing.
 */
export function fuzzyResolveRepoScopePath(projectDir, requested) {
  const normalized = String(requested || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) return null;
  const basename = path.posix.basename(normalized);
  if (!basename || basename === "." || basename === "..") return null;
  const matches = filesMatchingBasename(projectDir, basename);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const segments = normalized.split("/");
  if (segments.length >= 2) {
    const tail = segments.slice(-2).join("/");
    const byTail = matches.filter((candidate) => candidate === tail || candidate.endsWith(`/${tail}`));
    if (byTail.length === 1) return byTail[0];
  }
  return null;
}

function scopeListWithout(list, filePath) {
  const key = scopePathKey(filePath);
  return (Array.isArray(list) ? list : []).filter((entry) => scopePathKey(entry) !== key);
}

// The one other task that creates `filePath`, provided making
// `handoffs[index]` depend on it cannot close a cycle. Modifying a sibling's
// new file needs that file to exist first, so ordering the two keeps the
// planner's scope where trimming would drop it.
function dependableSiblingCreator(handoffs, index, filePath) {
  const key = scopePathKey(filePath);
  const creators = handoffs.filter((candidate, candidateIndex) => candidateIndex !== index
    && uniqueScopePaths(candidate?.report?.scope?.files_to_create).some((entry) => scopePathKey(entry) === key));
  if (creators.length !== 1) return null;
  const dependentId = handoffs[index]?.id;
  const creatorId = creators[0]?.id;
  if (dependentId == null || creatorId == null) return null;
  const byId = new Map(handoffs.map((handoff) => [handoff.id, handoff]));
  const seen = new Set();
  const pending = [creatorId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === dependentId) return null;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(byId.get(id)?.depends_on || []));
  }
  return creatorId;
}

/**
 * Repair planner scope file kinds in place rather than rejecting the plan.
 * A rejection sends the planner back for another full-context turn; the dev
 * can request any scope it turns out to need, so a trimmed or re-pointed path
 * is the cheaper outcome. Each repair is returned for the caller to record.
 */
export function repairPlannerPacketFileKinds(packet, projectDir, { maxPasses = 3, addDependencies = true, context = {} } = {}) {
  const repairs = [];
  if (packet?.profile !== AGENT_HANDOFF_PROFILES.PLANNER_PLAN || packet?.outcome !== "success") return repairs;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const issues = validatePlannerPacketFileKinds(packet, projectDir, context);
    if (issues.length === 0) break;
    let changed = false;
    for (const issue of issues) {
      const handoff = packet.handoffs[issue.taskIndex];
      const scope = handoff?.report?.scope;
      if (!scope) continue;
      const exists = (() => {
        const resolved = resolveRepoScopePath(projectDir, issue.path);
        return Boolean(resolved && pathEntryExists(resolved));
      })();
      let action = null;
      if (issue.declaredKind === "modify_and_create") {
        if (exists) scope.files_to_create = scopeListWithout(scope.files_to_create, issue.path);
        else scope.files_to_modify = scopeListWithout(scope.files_to_modify, issue.path);
        action = exists ? "file_kind_kept_modify" : "file_kind_kept_create";
      } else if (issue.declaredKind === "files_to_modify" && /does not exist/.test(issue.reason)) {
        const creatorId = addDependencies ? dependableSiblingCreator(packet.handoffs, issue.taskIndex, issue.path) : null;
        if (creatorId != null) {
          if (!(handoff.depends_on || []).includes(creatorId)) {
            handoff.depends_on = [...(handoff.depends_on || []), creatorId];
          }
          repairs.push({ ...issue, action: "file_kind_dependency_added", dependsOn: creatorId });
          changed = true;
          continue;
        }
        const resolved = fuzzyResolveRepoScopePath(projectDir, issue.path);
        scope.files_to_modify = scopeListWithout(scope.files_to_modify, issue.path);
        if (resolved && !scope.files_to_modify.some((entry) => scopePathKey(entry) === scopePathKey(resolved))) {
          scope.files_to_modify = [...scope.files_to_modify, resolved];
        }
        action = resolved ? "file_kind_path_resolved" : "file_kind_path_trimmed";
        if (resolved) repairs.push({ ...issue, action, resolved });
        else repairs.push({ ...issue, action });
        changed = true;
        continue;
      } else if (issue.declaredKind === "files_to_create" && /already exists/.test(issue.reason)) {
        scope.files_to_create = scopeListWithout(scope.files_to_create, issue.path);
        if (!(scope.files_to_modify || []).some((entry) => scopePathKey(entry) === scopePathKey(issue.path))) {
          scope.files_to_modify = [...(scope.files_to_modify || []), issue.path];
        }
        action = "file_kind_moved_to_modify";
      } else {
        // Ignored paths cannot exist in an isolated worktree: trim them.
        scope[issue.declaredKind] = scopeListWithout(scope[issue.declaredKind], issue.path);
        action = "file_kind_path_trimmed";
      }
      repairs.push({ ...issue, action });
      changed = true;
    }
    if (!changed) break;
  }
  return repairs;
}

/**
 * Legacy compiler guard. This intentionally does not repair planner scope on
 * the compiler path; `repairPlannerPacketFileKinds` does so at handoff time,
 * where each repair is recorded for the planner and the dev. Callers here
 * must still reject `issues`.
 */
/**
 * Drop git-ignored paths from a task's files_to_modify before validation and
 * return what was dropped. An ignored file (vendor/, a sqlite database, a
 * build output) never exists in an isolated worktree, so a dev could not edit
 * it anyway; it reaches the scope because the planner named it, or because
 * scope completion picked the path out of a task spec that merely mentions
 * it ("require vendor/autoload.php"). Rejecting the whole task for such a
 * path, and every task that depends on it, threw away a complete plan in the
 * field. Removing the path is the repair; validation still rejects what is
 * left when it is wrong.
 */
export function pruneIgnoredModifyScope(task, projectDir, { tasks = [task], taskIndex = 0, context = {} } = {}) {
  if (!task || !Array.isArray(task.files_to_modify) || task.files_to_modify.length === 0) return [];
  if (!isRepository(projectDir)) return [];
  const ignoredKeys = ignoredUntrackedPathKeys(projectDir, task.files_to_modify);
  if (ignoredKeys.size === 0) return [];
  const nodes = tasks.map(legacyTaskNode);
  const creates = new Set(ancestorNodes(nodes[taskIndex], dependencyNodeMap(nodes, context))
    .flatMap(createdPaths).map(scopePathKey));
  const removed = [];
  const kept = [];
  for (const value of task.files_to_modify) {
    const key = scopePathKey(value);
    if (key && ignoredKeys.has(key) && !creates.has(key) && resolveRepoScopePath(projectDir, value)) removed.push(value);
    else kept.push(value);
  }
  if (removed.length > 0) task.files_to_modify = kept;
  return removed;
}

export function reconcilePlannerFileKinds(task, projectDir, { tasks = [task], taskIndex = 0, context = {} } = {}) {
  const allIssues = validatePlannerTaskFileKinds(tasks, projectDir, context);
  const issues = allIssues.filter((issue) => issue.taskIndex === taskIndex);
  return {
    changed: false,
    movedToCreate: [],
    movedToModify: [],
    issues,
    errors: issues.map((issue) => `${issue.declaredKind} path "${issue.path}" is invalid: ${issue.reason}`),
  };
}
