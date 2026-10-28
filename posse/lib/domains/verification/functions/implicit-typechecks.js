import fs from "node:fs";
import path from "node:path";
import { groupVerificationFiles, packageManagerRun } from "../../../shared/tools/functions/toolkit/verification-readiness.js";
import { parseTypecheckDiagnostics, runProcessAsync } from "../../../shared/tools/functions/toolkit/scoped-runners.js";

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

// A repository may carry pre-existing type errors. The review fails only on
// diagnostics the change introduced: errors in a changed file, or more errors
// elsewhere than the pre-development baseline recorded for this job.
export async function runImplicitTypechecks(cwd, files, { baselineProjectDiagnosticCount = null, ...options } = {}) {
  const results = [];
  const changed = new Set((files || []).map(file => String(file).replace(/\\/g, "/")));
  for (const check of implicitTypechecks(cwd, files)) {
    const result = await runProcessAsync(check.command, check.args, check.cwd, options);
    options.signal?.throwIfAborted();
    if (result.timedOut || result.error || result.signal || [127, 9009].includes(result.exitCode)) {
      throw new Error(`Required typecheck unavailable: ${check.declared_command}: ${result.error || result.stderr || "process interrupted"}`);
    }
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const diagnostics = parseTypecheckDiagnostics(output).map(diagnostic => ({ ...diagnostic,
      file: String(diagnostic.file || "").replace(/\\/g, "/") }));
    const rootRelative = file => check.root && check.root !== "." ? `${check.root}/${file}` : file;
    const inChanged = diagnostics.filter(diagnostic => changed.has(rootRelative(diagnostic.file)) || changed.has(diagnostic.file));
    const elsewhere = diagnostics.length - inChanged.length;
    const grew = Number.isInteger(baselineProjectDiagnosticCount) ? elsewhere > baselineProjectDiagnosticCount : result.exitCode !== 0 && inChanged.length === 0 && diagnostics.length === 0;
    const introduced = inChanged.length > 0 || grew;
    results.push({ command: check.declared_command, status: result.exitCode === 0 ? "passed" : introduced ? "failed" : "pre_existing",
      exit_code: result.exitCode, diagnostic_count: diagnostics.length, introduced_count: inChanged.length,
      baseline_project_diagnostic_count: baselineProjectDiagnosticCount,
      output: (introduced ? inChanged.map(diagnostic => diagnostic.text || `${diagnostic.file}(${diagnostic.line ?? "?"}): ${diagnostic.code || ""} ${diagnostic.message || ""}`).join("\n") || output : output).slice(-6000) });
  }
  return results;
}
