// Keep a compiled task's prose in step with output paths the plan compiler
// moved. When the compiler re-roots an artifact task's outputs (for example
// into a task-scoped `.../wi-N/task-01-<slug>/` directory), the planner's
// task_spec still names the old location; the worker sees two contradictory
// output paths. Only exact mentions of the moved file paths are rewritten, so
// consumer/install paths and other files under the old root stay untouched.

import path from "path";
import { normalizeArtifactCreateFiles } from "../../artifacts/functions/index.js";

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function projectRelative(projectDir, absPath) {
  if (!projectDir || !absPath) return null;
  const rel = toPosix(path.relative(projectDir, absPath));
  if (!rel || rel === "." || rel.startsWith("../") || path.isAbsolute(rel)) return null;
  return rel;
}

/**
 * Pairs of { from, to } for each planned output file whose resolved location
 * changed between the planner's root and the compiled root. Both absolute and
 * project-relative spellings are returned.
 */
export function movedOutputPathReplacements({ projectDir = null, filesToCreate = [], fromRoot, toRoot } = {}) {
  const oldRoot = toPosix(fromRoot);
  const newRoot = toPosix(toRoot);
  if (!oldRoot || !newRoot || oldRoot === newRoot || !Array.isArray(filesToCreate)) return [];
  const pairs = new Map();
  const add = (from, to) => {
    if (!from || !to || from === to || pairs.has(from)) return;
    pairs.set(from, to);
  };
  for (const raw of filesToCreate) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const before = normalizeArtifactCreateFiles([raw], oldRoot)[0];
    const after = normalizeArtifactCreateFiles([raw], newRoot)[0];
    if (!before || !after || before === after) continue;
    add(before, after);
    add(projectRelative(projectDir, before), projectRelative(projectDir, after));
  }
  return [...pairs].map(([from, to]) => ({ from, to }));
}

/**
 * Replace whole-path mentions of each `from` with its `to`. A mention must
 * not continue a longer path on either side (so `a/x.png` never matches
 * inside `b/a/x.png` or `a/x.png.bak`); trailing sentence punctuation is fine.
 */
export function rewriteTaskTextPaths(text, replacements = []) {
  if (typeof text !== "string" || !text) return text;
  const map = new Map();
  for (const entry of Array.isArray(replacements) ? replacements : []) {
    const from = typeof entry?.from === "string" ? entry.from : "";
    const to = typeof entry?.to === "string" ? entry.to : "";
    if (from && to && from !== to && !map.has(from)) map.set(from, to);
  }
  if (map.size === 0) return text;
  const alternatives = [...map.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp(`(?<![\\w./-])(?:${alternatives.join("|")})(?![\\w-]|[./][\\w-])`, "g");
  return text.replace(pattern, (match) => map.get(match) ?? match);
}
