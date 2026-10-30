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
// diagnostics the change introduced, judged against the pre-development
// typecheck recorded for this job (worker/functions/helpers/pre-dev-typecheck.js):
//  - in a changed file, every error counts: the pre_dev_typecheck briefing
//    showed the developer that file's existing errors so it fixes them in
//    passing (`baselineByFile` is the per-file count of those errors);
//  - elsewhere, more errors than the baseline project count less the changed
//    files' own baseline errors (the project count includes them), so fixing
//    a touched file's errors never masks a new error in a caller.
export async function runImplicitTypechecks(cwd, files, { baselineProjectDiagnosticCount = null, baselineByFile = null, ...options } = {}) {
  const results = [];
  const normalize = file => String(file).replace(/\\/g, "/");
  const changed = new Set((files || []).map(normalize));
  const baselineFiles = baselineByFile && typeof baselineByFile === "object"
    ? new Map(Object.entries(baselineByFile).map(([file, count]) => [normalize(file), Number.isInteger(count) ? count : 0]))
    : null;
  const changedBaseline = baselineFiles ? [...changed].reduce((sum, file) => sum + (baselineFiles.get(file) || 0), 0) : 0;
  const baselineElsewhere = Number.isInteger(baselineProjectDiagnosticCount)
    ? Math.max(0, baselineProjectDiagnosticCount - changedBaseline) : null;
  for (const check of implicitTypechecks(cwd, files)) {
    const result = await runProcessAsync(check.command, check.args, check.cwd, options);
    options.signal?.throwIfAborted();
    if (result.timedOut || result.error || result.signal || [127, 9009].includes(result.exitCode)) {
      throw new Error(`Required typecheck unavailable: ${check.declared_command}: ${result.error || result.stderr || "process interrupted"}`);
    }
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const diagnostics = parseTypecheckDiagnostics(output).map(diagnostic => ({ ...diagnostic, file: normalize(diagnostic.file || "") }));
    const rootRelative = file => check.root && check.root !== "." ? `${check.root}/${file}` : file;
    const changedFileOf = diagnostic => changed.has(rootRelative(diagnostic.file)) ? rootRelative(diagnostic.file)
      : changed.has(diagnostic.file) ? diagnostic.file : null;
    const inChangedByFile = new Map();
    for (const diagnostic of diagnostics) {
      const file = changedFileOf(diagnostic);
      if (!file) continue;
      if (!inChangedByFile.has(file)) inChangedByFile.set(file, []);
      inChangedByFile.get(file).push(diagnostic);
    }
    const inChanged = [...inChangedByFile.values()].flat();
    const introducedCount = inChanged.length;
    const elsewhere = diagnostics.length - inChanged.length;
    const grew = baselineElsewhere !== null ? elsewhere > baselineElsewhere : result.exitCode !== 0 && inChanged.length === 0 && diagnostics.length === 0;
    const introduced = introducedCount > 0 || grew;
    const introducedOutput = inChanged
      .map(diagnostic => diagnostic.text || `${diagnostic.file}(${diagnostic.line ?? "?"}): ${diagnostic.code || ""} ${diagnostic.message || ""}`).join("\n");
    results.push({ command: check.declared_command, status: result.exitCode === 0 ? "passed" : introduced ? "failed" : "pre_existing",
      exit_code: result.exitCode, diagnostic_count: diagnostics.length, introduced_count: introducedCount,
      baseline_project_diagnostic_count: baselineProjectDiagnosticCount,
      baseline_elsewhere_diagnostic_count: baselineElsewhere,
      output: (introduced ? introducedOutput || output : output).slice(-6000) });
  }
  return results;
}
