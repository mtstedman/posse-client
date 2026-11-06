import path from "node:path";
import { JEST_SELECTION_OPTIONS, JEST_OVERRIDDEN_OPTIONS, JEST_FILE_RUN_OPTIONS } from "../../../../catalog/unit-test-runner.js";
import { installedRunnerBin, nodeRunnerCommand } from "../../../../domains/verification/functions/node-runner-command.js";

// Only the owning package's installed Jest executes. Script wrappers are not
// shell commands here: ambiguous or unsupported configuration stays unavailable.
export function jestTestRunner(root, relative, manifest, scripts) {
  const cwd = path.dirname(manifest);
  const local = path.relative(cwd, path.resolve(root, relative)).replaceAll("\\", "/");
  const variants = [];
  const declarations = scripts.split("\n").filter((script) => /\bjest\b/u.test(script));
  for (const script of declarations) {
    let invocation;
    try { invocation = nodeRunnerCommand(script); } catch { continue; }
    if (invocation?.runner !== "jest") continue;
    const options = [];
    const filters = [];
    let unsupported = false;
    for (let index = 0; index < invocation.args.length; index++) {
      const word = invocation.args[index];
      if (/[;&|]/u.test(word)) { unsupported = true; break; }
      const option = word.split("=", 1)[0];
      if (JEST_OVERRIDDEN_OPTIONS.includes(option)) continue;
      if (!word.startsWith("-")) { filters.push(word); continue; }
      if (!Object.hasOwn(JEST_SELECTION_OPTIONS, option)) { unsupported = true; break; }
      options.push(word);
      if (!word.includes("=")) {
        const value = invocation.args[++index];
        if (!value || value.startsWith("-") || /[;&|]/u.test(value)) { unsupported = true; break; }
        options.push(value);
      }
    }
    if (unsupported) continue;
    try {
      if (!filters.length || filters.some((filter) => new RegExp(filter).test(local))) variants.push(options);
    } catch { /* Invalid Jest selection expression. */ }
  }
  const variantsByOptions = [...new Set(variants.map((options) => JSON.stringify(options)))];
  if (variantsByOptions.length > 1) return { reason: "project_test_runner_ambiguous" };
  if (declarations.length && !variantsByOptions.length) return { reason: "project_test_runner_requires_declared_command" };
  const bin = installedRunnerBin(cwd, "jest");
  if (!bin) return { reason: "test_dependency_unavailable" };
  return {
    runner: "jest", executable: process.execPath, cwd,
    args: [bin, ...(variantsByOptions.length ? JSON.parse(variantsByOptions[0]) : []),
      ...JEST_FILE_RUN_OPTIONS, "--runTestsByPath", path.resolve(root, relative)],
  };
}
