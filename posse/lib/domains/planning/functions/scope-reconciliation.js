import fs from "node:fs";
import path from "node:path";
import { adminGitExec } from "../../git/functions/admin-git-exec.js";
import { gitExecBuffer } from "../../git/functions/utils.js";

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

function ignoredUntrackedPathKeys(projectDir, values) {
  const paths = uniqueScopePaths(values);
  if (paths.length === 0) return new Set();
  // ls-files is read-only and exact pathspecs keep the scan bounded to the
  // planner's proposed scope. The native transport still needs a warm pulse
  // token, which a fresh process (tests, cold boots) does not have -- fall
  // back to direct system git so the ignored-path guard cannot silently
  // disable itself; only when both transports fail does the probe degrade to
  // "nothing ignored".
  const args = [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ...paths,
  ];
  let output = null;
  try {
    output = gitExecBuffer(args, projectDir, { maxBuffer: 1024 * 1024 });
  } catch {
    try {
      output = adminGitExec(args, projectDir, { encoding: "buffer", maxBuffer: 1024 * 1024 });
    } catch {
      return new Set();
    }
  }
  return new Set(output.toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(scopePathKey));
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
      if (resolved && ignoredPathKeys.has(key)) {
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
      if (resolved && ignoredPathKeys.has(key)) {
        issues.push({
          taskIndex: node.index,
          taskId: node.id,
          path: filePath,
          declaredKind: "files_to_create",
          reason: "the path is ignored by repository policy",
        });
      } else if (resolved && pathEntryExists(resolved) && !ancestorDeletes.has(key)) {
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

const FUZZY_SCAN_MAX_ENTRIES = 40000;
const FUZZY_SCAN_MAX_DEPTH = 10;
const FUZZY_SCAN_SKIP_DIRS = new Set([".git", "node_modules", ".posse", "dist", "build", "target", "vendor", ".cache"]);

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

/**
 * Repair planner scope file kinds in place rather than rejecting the plan.
 * A rejection sends the planner back for another full-context turn; the dev
 * can request any scope it turns out to need, so a trimmed or re-pointed path
 * is the cheaper outcome. Each repair is returned for the caller to record.
 */
export function repairPlannerPacketFileKinds(packet, projectDir, { maxPasses = 3 } = {}) {
  const repairs = [];
  if (packet?.profile !== "planner.plan.v1" || packet?.outcome !== "success") return repairs;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const issues = validatePlannerPacketFileKinds(packet, projectDir);
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
