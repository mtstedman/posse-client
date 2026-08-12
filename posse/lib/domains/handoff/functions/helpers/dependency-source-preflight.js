// @ts-check

import fs from "node:fs";
import path from "node:path";

const NODE_DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

/**
 * Identify task-named npm dependencies whose source is absent from the active
 * checkout. This is deliberately conservative: it reports only dependencies
 * named by the task and suppresses the warning when an installed or obvious
 * workspace copy exists.
 *
 * @param {{ repoRoot?: string, taskText?: string, maxItems?: number }} input
 */
export function detectUnavailableDependencySources({
  repoRoot = "",
  taskText = "",
  maxItems = 6,
} = {}) {
  if (!String(repoRoot || "").trim()) return [];
  const root = path.resolve(String(repoRoot));
  const manifestPath = path.join(root, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return [];
  }
  const declared = new Map();
  for (const field of NODE_DEPENDENCY_FIELDS) {
    const entries = manifest?.[field];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [name, version] of Object.entries(entries)) {
      if (!declared.has(name)) declared.set(name, { name, version: String(version || ""), field });
    }
  }
  const task = String(taskText || "").toLowerCase();
  const out = [];
  for (const dependency of declared.values()) {
    if (!taskNamesDependency(task, dependency.name)) continue;
    if (dependencySourceExists(root, dependency.name)) continue;
    out.push({
      ecosystem: "npm",
      dependency: dependency.name,
      version: dependency.version,
      manifest: "package.json",
      manifestField: dependency.field,
      sourceStatus: "absent",
      guidance: `Source for external dependency ${dependency.name} is not present in this checkout. Trace only the local call boundary and do not reconstruct dependency internals.`,
    });
    if (out.length >= Math.max(1, Number(maxItems) || 1)) break;
  }
  return out;
}

function taskNamesDependency(task, dependencyName) {
  if (!task) return false;
  const full = String(dependencyName || "").toLowerCase();
  const base = full.split("/").pop() || full;
  return tokenPresent(task, full) || (base.length >= 3 && tokenPresent(task, base));
}

function tokenPresent(text, token) {
  const escaped = String(token || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !!escaped && new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`, "i").test(text);
}

function dependencySourceExists(root, dependencyName) {
  const base = String(dependencyName || "").split("/").pop() || "";
  const candidates = [
    path.join(root, "node_modules", ...String(dependencyName || "").split("/")),
    path.join(root, "packages", base),
    path.join(root, "vendor", base),
    path.join(root, "lib", base),
    path.join(root, "src", base),
  ];
  return candidates.some((candidate) => {
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  });
}
