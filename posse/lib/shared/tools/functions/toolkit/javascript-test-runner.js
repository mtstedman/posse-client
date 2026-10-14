import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JAVASCRIPT_TEST_FRAMEWORK_IMPORTS, VITEST_SELECTION_OPTIONS } from "../../../../catalog/unit-test-runner.js";
import { parseCommandArguments } from "../../../scope/functions/test-command.js";

// Resolve the nearest owning package. File imports disambiguate mixed suites;
// dependencies alone never override an explicitly imported framework.
export function javascriptTestRunner(root, relative, source) {
  let directory = path.dirname(path.join(root, relative));
  let manifest = path.join(root, "package.json");
  while (directory.startsWith(root)) {
    const candidate = path.join(directory, "package.json");
    if (fs.existsSync(candidate)) { manifest = candidate; break; }
    if (directory === root) break;
    directory = path.dirname(directory);
  }
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(manifest, "utf8")); } catch { /* no package */ }
  const require = createRequire(manifest);
  const imports = [...source.matchAll(/(?:\bfrom\s*|\b(?:require|import)\s*\(\s*|\bimport\s*)["']([^"']+)["']/gu)].map((match) => match[1]);
  const frameworks = new Set(imports.map((name) => JAVASCRIPT_TEST_FRAMEWORK_IMPORTS[name]).filter(Boolean));
  if (frameworks.size > 1) return { reason: "project_test_runner_ambiguous" };
  const scripts = Object.values(pkg.scripts || {}).filter((value) => typeof value === "string").join("\n");
  const declared = new Set([...scripts.matchAll(/\b(vitest|jest|mocha|ava)\b/gu)].map((match) => match[1]));
  if (declared.size === 0) {
    for (const name of ["vitest", "jest", "mocha", "ava"]) {
      if (pkg.dependencies?.[name] || pkg.devDependencies?.[name]) declared.add(name);
    }
  }
  const nodeDeclared = /\b(?:node|tsx)\b[^\n]*--test\b/u.test(scripts);
  let framework = [...frameworks][0];
  if (!framework) {
    if (declared.size > 1 || (declared.size > 0 && nodeDeclared)) return { reason: "project_test_runner_ambiguous" };
    framework = [...declared][0] || "node:test";
  }
  if (framework === "vitest") {
    const variants = [];
    for (const script of scripts.split("\n").filter((value) => /\bvitest\b/u.test(value))) {
      let words;
      try { words = parseCommandArguments(script); } catch { continue; }
      // npx is syntax here, never executed: only the installed owning package's
      // API can be selected below. Unrelated wrapper/coverage scripts must not
      // suppress an otherwise unambiguous direct test declaration.
      if (words[0] === "npx") words.shift();
      if (words[0] !== "vitest" || words.some((word) => /[;&|]/u.test(word))) continue;
      const options = [];
      const filters = [];
      let unsupported = false;
      for (let index = 1; index < words.length; index++) {
        const word = words[index];
        if (["run", "watch", "--run", "--watch", "--coverage", "--coverage=true", "--coverage=false"].includes(word)) continue;
        if (!word.startsWith("-")) { filters.push(word); continue; }
        const [option, value] = word.split("=", 2);
        if (!Object.hasOwn(VITEST_SELECTION_OPTIONS, option)) { unsupported = true; break; }
        options.push(word);
        if (VITEST_SELECTION_OPTIONS[option] && value == null) {
          if (!words[index + 1] || words[index + 1].startsWith("-")) { unsupported = true; break; }
          options.push(words[++index]);
        }
      }
      if (unsupported) continue;
      const local = path.relative(path.dirname(manifest), path.join(root, relative)).replaceAll("\\", "/");
      if (filters.length === 0 || filters.some((filter) => local.includes(filter) || path.matchesGlob(local, filter))) variants.push(options);
    }
    const options = [...new Set(variants.map((variant) => JSON.stringify(variant)))];
    if (options.length > 1) return { reason: "project_test_runner_ambiguous" };
    if (scripts.includes("vitest") && variants.length === 0) return { reason: "project_test_runner_requires_declared_command" };
    try {
      const api = require.resolve("vitest/node");
      if (!fs.statSync(api).isFile()) return { reason: "test_dependency_unavailable" };
      const cwd = path.dirname(manifest);
      return {
        runner: "vitest", executable: "node", cwd,
        args: [fileURLToPath(new URL("./vitest-file-runner.js", import.meta.url)), api,
          path.resolve(root, relative), ...(options.length ? JSON.parse(options[0]) : []), "--root", cwd],
      };
    } catch { return { reason: "test_dependency_unavailable" }; }
  }
  if (framework !== "node:test") return { reason: "project_test_runner_requires_declared_command" };
  const jsx = /\.[jt]sx$/u.test(relative);
  const typed = /\.[cm]?ts$/u.test(relative);
  const usesTsx = /\btsx\b/u.test(scripts);
  if (jsx || (typed && usesTsx)) {
    try {
      return { runner: "node_test", executable: "node", args: [require.resolve("tsx/cli"), "--test", relative] };
    } catch { return { reason: "typescript_test_loader_unavailable" }; }
  }
  return { runner: "node_test", executable: "node", args: [...(typed ? ["--experimental-strip-types"] : []), "--test", relative] };
}
