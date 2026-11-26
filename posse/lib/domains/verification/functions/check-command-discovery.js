import { detectNodePackageManager } from "../../../shared/tools/functions/node-package-manager.js";
import fs from "node:fs";
import path from "node:path";
import { CHECK_DISCOVERY as POLICY } from "../../../catalog/check-discovery.js";

// Facts only: discovering a runner never executes repository scripts.
export function discoverCheckCommands(cwd) {
  if (!cwd) return [];
  const root = path.resolve(cwd);
  const pending = [{ dir: root, depth: 0 }];
  const candidates = [];
  let visited = 0, entriesRead = 0;
  let rootManager;
  while (pending.length && visited++ < POLICY.maxDirectories && candidates.length < POLICY.maxCandidates) {
    const { dir, depth } = pending.shift();
    const facts = commandsAt(dir, rootManager);
    if (dir === root) rootManager = facts.manager;
    const relative = path.relative(root, dir).split(path.sep).join("/");
    for (const fact of facts.candidates) {
      if (candidates.length === POLICY.maxCandidates) break;
      candidates.push(relative ? { ...fact, source: `${relative}/${fact.source}`, cwd: relative } : fact);
    }
    if (depth >= POLICY.maxDepth || entriesRead >= POLICY.maxEntries) continue;
    // Do not follow symlinks or traverse dependency/generated/hidden trees.
    // opendir bounds inspection even for directories with enormous fan-out.
    const children = [];
    let handle;
    try {
      handle = fs.opendirSync(dir);
      let entry;
      while (entriesRead < POLICY.maxEntries && (entry = handle.readSync())) {
        entriesRead++;
        if (entry.isDirectory() && !entry.name.startsWith(".") && !POLICY.ignoredDirectories.includes(entry.name)) children.push(entry.name);
      }
    } catch { /* unreadable directories contribute no facts */ }
    finally { handle?.closeSync(); }
    for (const name of children.sort()) {
      if (pending.length + visited >= POLICY.maxDirectories) break;
      pending.push({ dir: path.join(dir, name), depth: depth + 1 });
    }
  }
  return candidates;
}

function commandsAt(cwd, defaultManager) {
  const candidates = [];
  const read = name => {
    try {
      const file = path.join(cwd, name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > POLICY.maxManifestBytes) return "";
      return fs.readFileSync(file, "utf8");
    } catch { return ""; }
  };
  const json = name => { try { return JSON.parse(read(name)); } catch { return {}; } };
  const pkg = json("package.json");
  const manager = detectNodePackageManager(cwd, { packageManager: pkg.packageManager || "", allowUnversioned: true, defaultManager }).manager;
  for (const name of POLICY.nodeScripts) {
    if (typeof pkg.scripts?.[name] === "string") candidates.push({ command: `${manager} run ${name}`, source: "package.json", script: name });
  }
  const pyproject = read("pyproject.toml");
  if (/\[tool\.pytest(?:\.|\])|\bpytest\b/.test(pyproject)) candidates.push({ command: "python -m pytest", source: "pyproject.toml" });
  if (/\[tool\.mypy(?:\.|\])/.test(pyproject)) candidates.push({ command: "python -m mypy .", source: "pyproject.toml" });
  const composer = json("composer.json");
  for (const name of POLICY.composerScripts) {
    if (composer.scripts?.[name]) candidates.push({ command: `composer run-script ${name}`, source: "composer.json", script: name });
  }
  for (const manifest of POLICY.nativeManifests) {
    if (manifest.pattern.test(read(manifest.source))) {
      for (const command of manifest.commands) candidates.push({ command, source: manifest.source });
    }
  }
  return { candidates, manager };
}
