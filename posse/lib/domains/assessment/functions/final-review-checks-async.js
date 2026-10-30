import { runImplicitTypechecks } from "../../verification/functions/implicit-typechecks.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FINAL_REVIEW_CHECKS, FINAL_REVIEW_TEST_TIMEOUT_MS } from "../../../catalog/final-review.js";
import { runProcessAsync } from "../../../shared/tools/functions/toolkit/scoped-runners.js";

// Scoped verifiers include synchronous language tools. Isolate the whole
// check in a child process so cancellation can kill its process tree as well
// as keep the orchestrator's lease renewals and tool routing responsive.
// The pre-development typecheck observation records the project-wide error
// count and the per-file counts of the scoped files before the agent edited
// anything; the final review compares to both. No observation, or one whose
// typecheck was unavailable, leaves no baseline: the review then treats every
// error in a changed file as introduced.
const NO_BASELINE = Object.freeze({ projectDiagnosticCount: null, byFile: null });

function baselineFrom(summary) {
  if (!summary || typeof summary !== "object" || summary.status === "unavailable") return null;
  const projectDiagnosticCount = Number.isInteger(summary.project_diagnostic_count) ? summary.project_diagnostic_count : null;
  let byFile = summary.by_file && typeof summary.by_file === "object" ? summary.by_file : null;
  if (!byFile && Array.isArray(summary.diagnostics)) {
    byFile = {};
    for (const diagnostic of summary.diagnostics) {
      if (!diagnostic?.file) continue;
      byFile[diagnostic.file] = (byFile[diagnostic.file] || 0) + 1;
    }
  }
  return projectDiagnosticCount === null && !byFile ? null : { projectDiagnosticCount, byFile };
}

export function preDevTypecheckBaseline(change, jobId = null) {
  const inline = baselineFrom(change?.pre_dev_typecheck);
  if (inline) return inline;
  if (Number.isInteger(change?.baseline_project_diagnostic_count)) {
    return { projectDiagnosticCount: change.baseline_project_diagnostic_count, byFile: null };
  }
  if (!Number.isInteger(Number(jobId))) return NO_BASELINE;
  try {
    const row = getDb().prepare(`SELECT detail_json FROM job_observations
      WHERE job_id = ? AND observation_type = 'verification.pre_dev_typecheck' ORDER BY id DESC LIMIT 1`).get(Number(jobId));
    return (row && baselineFrom(JSON.parse(row.detail_json || "{}"))) || NO_BASELINE;
  } catch { return NO_BASELINE; }
}

export async function runChangedFileChecksAsync(cwd, change, { signal = null, jobId = null, timeoutMs = FINAL_REVIEW_TEST_TIMEOUT_MS } = {}) {
  signal?.throwIfAborted();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "posse-review-checks-"));
  const input = path.join(dir, "input.json");
  const output = path.join(dir, "output.json");
  try {
    const files = (change?.files || []).map(file => file.path);
    // The scoped typecheck attributes failures to the lines the change added;
    // the implicit project typecheck below counts errors against the pre-dev
    // baseline. Both run whatever roots the repository's typecheck scripts
    // cover: neither replaces the other's evidence.
    const checkKinds = FINAL_REVIEW_CHECKS;
    await fs.writeFile(input, JSON.stringify({ cwd, change, checkKinds }));
    const result = await runProcessAsync(process.execPath, [
      fileURLToPath(new URL("./final-review-checks-process.mjs", import.meta.url)), input, output,
    ], cwd, { signal, timeoutMs });
    signal?.throwIfAborted();
    if (result.exitCode !== 0 || result.timedOut || result.error) {
      throw new Error(result.timedOut ? "changed-file checks timed out" : result.error || result.stderr || "changed-file checks process failed");
    }
    const scoped = JSON.parse(await fs.readFile(output, "utf8"));
    const baseline = preDevTypecheckBaseline(change, jobId);
    const implicit = await runImplicitTypechecks(cwd, files, { signal, timeoutMs,
      baselineProjectDiagnosticCount: baseline.projectDiagnosticCount, baselineByFile: baseline.byFile });
    if (!implicit.length) return scoped;
    return { ...(scoped || { status: "passed", files: [], introduced: [], inChanged: [], elsewhere: [] }),
      implicit_typechecks: implicit };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
