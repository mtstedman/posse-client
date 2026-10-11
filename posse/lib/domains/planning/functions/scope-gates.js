import { PLANNER_UNDER_SCOPED_BROAD_GATE_VALUES } from "../../settings/functions/catalog.js";
import { BROAD_SCOPE_STRONG_TITLE_PATTERNS, BROAD_SCOPE_WEAK_TITLE_PATTERNS } from "../../../catalog/scope-gates.js";

const BROAD_GATE_MODES = new Set(PLANNER_UNDER_SCOPED_BROAD_GATE_VALUES);

export function parseUnderScopedBroadGateMode(rawValue) {
  const value = String(rawValue || "warn").trim().toLowerCase();
  if (BROAD_GATE_MODES.has(value)) return value;
  return "warn";
}

export function broadNarrowScopedCodeTaskSignal(task = {}) {
  const filesToModify = Array.isArray(task.files_to_modify) ? task.files_to_modify : [];
  const filesToCreate = Array.isArray(task.files_to_create) ? task.files_to_create : [];
  const createRoots = Array.isArray(task.create_roots) ? task.create_roots : [];
  const filesToDelete = Array.isArray(task.files_to_delete) ? task.files_to_delete : [];
  const scopeCount = filesToModify.length + filesToCreate.length + createRoots.length
    + filesToDelete.length;
  if (scopeCount === 0 || scopeCount > 2 || createRoots.includes(".")) return null;

  const title = String(task.title || "");
  if (BROAD_SCOPE_STRONG_TITLE_PATTERNS.some((pattern) => pattern.test(title))) return "strong";
  const scopedPaths = [...filesToModify, ...filesToCreate, ...filesToDelete];
  if (scopedPaths.some((file) => {
    const basename = String(file || "").replace(/\\/g, "/").split("/").pop();
    return basename && title.toLowerCase().includes(basename.toLowerCase());
  })) return null;
  return BROAD_SCOPE_WEAK_TITLE_PATTERNS.filter((pattern) => pattern.test(title)).length >= 2 ? "weak" : null;
}

export function isBroadNarrowScopedCodeTask(task = {}) {
  return broadNarrowScopedCodeTaskSignal(task) !== null;
}
