import { parsePayloadJson } from "./keys.js";

function normalizePath(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function scopedScopeForJob(job) {
  const payload = parsePayloadJson(job?.payload_json);
  const files = [...new Set([
    ...(Array.isArray(payload.files_to_modify) ? payload.files_to_modify : []),
    ...(Array.isArray(payload.files_to_create) ? payload.files_to_create : []),
  ].map(normalizePath).filter(Boolean))];
  const roots = [...new Set((Array.isArray(payload.create_roots) ? payload.create_roots : [])
    .map(normalizePath)
    .filter(Boolean))];
  return {
    entries: [
      ...files.map((value) => ({ kind: "file", value })),
      ...roots.map((value) => ({ kind: "root", value })),
    ],
    tokens: new Set([
      ...files.map((value) => `file:${value}`),
      ...roots.map((value) => `root:${value}`),
    ]),
  };
}

function ancestorDirs(value, { includeSelf = false } = {}) {
  const parts = String(value || "").split("/").filter(Boolean);
  const lastPart = includeSelf ? parts.length : parts.length - 1;
  const ancestors = [];
  for (let i = 1; i <= lastPart; i++) {
    ancestors.push(parts.slice(0, i).join("/"));
  }
  return ancestors;
}

function buildScopeIndex(scope) {
  const files = new Set(scope.entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.value));
  const roots = new Set(scope.entries
    .filter((entry) => entry.kind === "root")
    .map((entry) => entry.value));
  const fileAncestors = new Set();
  const rootAncestors = new Set();

  for (const file of files) {
    for (const ancestor of ancestorDirs(file)) fileAncestors.add(ancestor);
  }
  for (const root of roots) {
    for (const ancestor of ancestorDirs(root)) rootAncestors.add(ancestor);
  }

  return { files, roots, fileAncestors, rootAncestors };
}

function fileOverlapsIndex(file, index) {
  if (!file) return false;
  if (index.files.has(file) || index.roots.has(".")) return true;
  return ancestorDirs(file, { includeSelf: true }).some((ancestor) => index.roots.has(ancestor));
}

function rootOverlapsIndex(root, index) {
  if (!root) return false;
  if (root === ".") return index.files.size > 0 || index.roots.size > 0;
  if (index.files.has(root) || index.fileAncestors.has(root)) return true;
  if (index.roots.has(".") || index.roots.has(root) || index.rootAncestors.has(root)) return true;
  return ancestorDirs(root).some((ancestor) => index.roots.has(ancestor));
}

function entryOverlapsIndex(entry, index) {
  if (entry?.kind === "file") return fileOverlapsIndex(entry.value, index);
  if (entry?.kind === "root") return rootOverlapsIndex(entry.value, index);
  return false;
}

export function computeOverlap(jobA, jobB) {
  const a = scopedScopeForJob(jobA);
  const b = scopedScopeForJob(jobB);
  if (a.tokens.size === 0 || b.tokens.size === 0) return 0;

  const union = new Set([...a.tokens, ...b.tokens]);
  const bIndex = buildScopeIndex(b);
  let intersection = 0;
  for (const entry of a.entries) {
    if (entryOverlapsIndex(entry, bIndex)) intersection++;
  }
  return union.size > 0 ? intersection / union.size : 0;
}

export function shouldRecycleSiblingDevJobs(jobA, jobB, { threshold = 0.5 } = {}) {
  return computeOverlap(jobA, jobB) >= threshold;
}
