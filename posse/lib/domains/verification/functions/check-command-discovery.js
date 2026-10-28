import { detectNodePackageManager } from "../../../shared/tools/functions/node-package-manager.js";
import fs from "node:fs";
import path from "node:path";

// Facts only: discovering a runner never executes repository scripts.
export function discoverCheckCommands(cwd) {
  const candidates = [];
  const read = name => { try { return fs.readFileSync(path.join(cwd, name), "utf8"); } catch { return ""; } };
  const json = name => { try { return JSON.parse(read(name)); } catch { return {}; } };
  const pkg = json("package.json");
  const manager = cwd ? detectNodePackageManager(cwd, { allowUnversioned: true }).manager : "npm";
  for (const name of ["test", "typecheck", "check-types", "lint"]) {
    if (typeof pkg.scripts?.[name] === "string") candidates.push({ command: `${manager} run ${name}`, source: "package.json", script: name });
  }
  const pyproject = read("pyproject.toml");
  if (/\[tool\.pytest(?:\.|\])|\bpytest\b/.test(pyproject)) candidates.push({ command: "python -m pytest", source: "pyproject.toml" });
  if (/\[tool\.mypy(?:\.|\])/.test(pyproject)) candidates.push({ command: "python -m mypy .", source: "pyproject.toml" });
  const composer = json("composer.json");
  for (const name of ["test", "typecheck", "lint", "analyse"]) {
    if (composer.scripts?.[name]) candidates.push({ command: `composer run-script ${name}`, source: "composer.json", script: name });
  }
  return candidates;
}
