import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { BABEL_CONFIG_NAMES, BABEL_CONFIG_CHECK, BABEL_CONFIG_TIMEOUT_MS } from "../../../../catalog/scoped-verification.js";
import { missingDeclaredNodeDependency } from "./node-test-failure.js";

export function babelConfigTargets(cwd, files) {
  return files.filter(file => BABEL_CONFIG_NAMES.has(path.basename(file)) && fs.existsSync(path.resolve(cwd, file)));
}

// Syntax checking alone cannot prove that a new Babel config can load its
// presets/plugins. Validate only scoped configs, even when no tests exist yet.
export function runBabelConfigCheck(cwd, targets, runProcess) {
  const base = { name: BABEL_CONFIG_CHECK, targets, failures: [] };
  if (!targets.length) return { ...base, status: "not_applicable" };
  let core;
  try { core = createRequire(path.join(cwd, "package.json")).resolve("@babel/core"); }
  catch { return { ...base, status: "unavailable", dependency_unavailable: true, reason: "Babel loader is not installed in this package" }; }
  const failures = [];
  const unavailable = [];
  let dependencyUnavailable = false;
  let durationMs = 0;
  for (const file of targets) {
    const result = runProcess(process.execPath, [fileURLToPath(new URL("./babel-config-probe.mjs", import.meta.url)), core, path.resolve(cwd, file)], cwd,
      { timeoutMs: BABEL_CONFIG_TIMEOUT_MS });
    durationMs += result.durationMs || 0;
    let probe;
    try { probe = JSON.parse(result.stdout.trim().split("\n").at(-1)); } catch { /* crashed or interrupted loader */ }
    if (result.error || result.timedOut || result.signal || result.exitCode !== 0 || !probe) {
      unavailable.push(`${file}: Babel config loader could not complete`);
    } else if (probe.status === "unavailable") {
      unavailable.push(`${file}: ${probe.message}`);
    } else if (probe.status === "failed") {
      const dependency = missingDeclaredNodeDependency(probe.message, cwd);
      if (dependency) {
        dependencyUnavailable = true;
        unavailable.push(`${file}: declared dependency ${dependency} is not installed`);
      }
      else failures.push({ file, line: probe.line, rule: BABEL_CONFIG_CHECK, message: probe.message });
    }
  }
  return { ...base, status: failures.length ? "failed" : unavailable.length ? "unavailable" : "passed",
    ...(!failures.length && dependencyUnavailable ? { dependency_unavailable: true } : {}),
    command: "Babel config load (scoped files, test environment)", durationMs, failures,
    reason: unavailable.length ? unavailable.join("; ") : null };
}
