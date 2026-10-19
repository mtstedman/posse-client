import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { LAUNCHED_NODE_CHECK_PACKAGES, LOCAL_NODE_TEST_RUNNER_PACKAGES } from "../../../catalog/test-command-policy.js";
import { parseCommandArguments } from "../../../shared/scope/functions/test-command.js";

const RUNNER_PACKAGES = { ...LOCAL_NODE_TEST_RUNNER_PACKAGES, ...LAUNCHED_NODE_CHECK_PACKAGES };

// The installed Node runner a command names, with its original-case argv.
// A launcher must name the runner directly: `npx --yes`, `npx runner@version`
// and `pnpm dlx` stay unrecognized.
export function nodeRunnerCommand(command) {
  const words = parseCommandArguments(command);
  const launcher = words[0].match(/^(npx|pnpm|yarn|bunx)(?:\.cmd|\.exe)?$/i)?.[1].toLowerCase();
  if (launcher) {
    words.shift();
    if ((launcher === "npx" && words[0] === "--no-install") || (launcher === "pnpm" && words[0] === "exec")) words.shift();
    return Object.hasOwn(RUNNER_PACKAGES, words[0] || "") ? { runner: words[0], args: words.slice(1) } : null;
  }
  const runner = words[0].replaceAll("\\", "/")
    .match(/^(?:(?:\.\/)?node_modules\/\.bin\/)?([^/]+?)(?:\.cmd)?$/i)?.[1].toLowerCase();
  return runner && Object.hasOwn(LOCAL_NODE_TEST_RUNNER_PACKAGES, runner) ? { runner, args: words.slice(1) } : null;
}

// Node's lookup order, read directly so an exports map cannot hide the bin
// the package declares.
function installedRunnerBin(root, runner) {
  const require = createRequire(path.join(root, "package.json"));
  for (const name of RUNNER_PACKAGES[runner]) {
    const directory = (require.resolve.paths(name) || []).map((base) => path.join(base, name))
      .find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
    if (!directory) continue;
    try {
      const { bin } = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      const relative = typeof bin === "string" ? (name.split("/").pop() === runner ? bin : null) : bin?.[runner];
      const script = typeof relative === "string" ? path.resolve(directory, relative) : null;
      if (script?.startsWith(`${directory}${path.sep}`) && fs.statSync(script).isFile()) return script;
    } catch { /* unreadable manifest or bin: try the next provider */ }
  }
  return null;
}

// Vitest keeps its own file adapter in vitest-command.js. Every other runner
// runs its installed bin under this Node; a missing one is unavailable.
export function resolveLocalNodeRunnerCommand(cwd, validation) {
  if (!validation?.ok) return validation;
  let invocation;
  try { invocation = nodeRunnerCommand(validation.execution_command); } catch { return validation; }
  if (!invocation || invocation.runner === "vitest") return validation;
  if (!cwd) return { ok: false, reason: "test_dependency_unavailable" };
  const bin = installedRunnerBin(path.resolve(cwd, validation.cwd_relative || "."), invocation.runner);
  if (!bin) return { ok: false, reason: "test_dependency_unavailable" };
  const quote = (arg) => `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return { ...validation,
    execution_command: [process.execPath, bin, ...invocation.args].map(quote).join(" "),
    repository_validated: true, repository_runner: true };
}
