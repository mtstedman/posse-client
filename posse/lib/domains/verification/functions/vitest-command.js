import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { parseCommandArguments } from "../../../shared/scope/functions/test-command.js";
import { javascriptTestRunner } from "../../../shared/tools/functions/toolkit/javascript-test-runner.js";

// npx is recognized as syntax only. Verification must never install a runner
// or resolve a different version from the network.
export function vitestCommandArgs(command) {
  const words = parseCommandArguments(command);
  const executable = words[0].replaceAll("\\", "/");
  if (/^(?:npx|npx\.cmd|npx\.exe)$/i.test(executable)) {
    words.shift();
    if (words[0] === "--no-install") words.shift();
    return words[0] === "vitest" ? words.slice(1) : null;
  }
  return /^(?:vitest(?:\.cmd)?|(?:\.\/)?node_modules\/\.bin\/vitest(?:\.cmd)?)$/i.test(executable)
    ? words.slice(1) : null;
}

export function resolveLocalVitestCommand(cwd, validation) {
  if (!validation?.ok) return validation;
  const args = vitestCommandArgs(validation.execution_command);
  if (!args) return validation;
  if (!cwd) return { ok: false, reason: "test_dependency_unavailable" };
  const root = path.resolve(cwd, validation.cwd_relative || ".");
  try {
    const files = args.slice(1);
    if (files.length && files.every((file) => !file.startsWith("-")
      && !/[*?\[\]{}]/.test(file) && /\.[cm]?[jt]sx?$/.test(file))) {
      // Explicit file selections use the same framework adapter as the
      // run_unit_test tool, changed-test checks and final-review receipts.
      // Keep missing files in the selection: baseline/candidate verification
      // must report their absence instead of silently narrowing coverage.
      const paths = files.map((file) => path.relative(cwd, path.resolve(root, file)).replaceAll("\\", "/"));
      for (const file of paths) {
        if (!fs.existsSync(path.resolve(cwd, file))) continue;
        const invocation = javascriptTestRunner(cwd, file, fs.readFileSync(path.resolve(cwd, file), "utf8"));
        if (invocation.runner !== "vitest") {
          return { ok: false, reason: invocation.reason || "test_loader_resolution_mismatch" };
        }
      }
      return { ...validation, unit_test_paths: [...new Set(paths)], repository_validated: true, repository_runner: true };
    }
    const require = createRequire(path.join(root, "package.json"));
    const cli = require.resolve("vitest/vitest.mjs");
    if (!fs.statSync(cli).isFile()) return { ok: false, reason: "test_dependency_unavailable" };
    const quote = (arg) => `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    return { ...validation,
      execution_command: [process.execPath, cli, ...args].map(quote).join(" "),
      repository_validated: true, repository_runner: true };
  } catch {
    return { ok: false, reason: "test_dependency_unavailable" };
  }
}
