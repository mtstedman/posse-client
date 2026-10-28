import fs from "node:fs";
import path from "node:path";
import { groupVerificationFiles, packageManagerRun } from "../../../shared/tools/functions/toolkit/verification-readiness.js";
import { runProcessAsync } from "../../../shared/tools/functions/toolkit/scoped-runners.js";

// Use the same package roots and configured script as pre_dev_typecheck.
// A script is required even if the planner omitted it from test_command.
export function implicitTypechecks(cwd, files = []) {
  return groupVerificationFiles(cwd, files).flatMap(group => {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(group.root, "package.json"), "utf8")); } catch { return []; }
    if (!pkg.scripts?.typecheck?.trim()) return [];
    const invocation = packageManagerRun(group.package_manager || "npm", "typecheck");
    const command = [invocation.command, ...invocation.args].join(" ");
    return [{ ...invocation, cwd: group.root, root: group.root_relative,
      declared_command: group.root_relative === "." ? command : `cd "${group.root_relative}" && ${command}` }];
  });
}

export async function runImplicitTypechecks(cwd, files, options = {}) {
  const results = [];
  for (const check of implicitTypechecks(cwd, files)) {
    const result = await runProcessAsync(check.command, check.args, check.cwd, options);
    options.signal?.throwIfAborted();
    if (result.timedOut || result.error || result.signal || [127, 9009].includes(result.exitCode)) {
      throw new Error(`Required typecheck unavailable: ${check.declared_command}: ${result.error || result.stderr || "process interrupted"}`);
    }
    results.push({ command: check.declared_command, status: result.exitCode === 0 ? "passed" : "failed",
      exit_code: result.exitCode, output: [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-6000) });
  }
  return results;
}
