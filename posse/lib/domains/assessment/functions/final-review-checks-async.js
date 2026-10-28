import { implicitTypechecks, runImplicitTypechecks } from "../../verification/functions/implicit-typechecks.js";
import { groupVerificationFiles } from "../../../shared/tools/functions/toolkit/verification-readiness.js";
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
// count before the agent edited anything; the final review compares to it.
function preDevProjectDiagnosticCount(change, jobId = null) {
  const inline = change?.pre_dev_typecheck?.project_diagnostic_count ?? change?.baseline_project_diagnostic_count;
  if (Number.isInteger(inline)) return inline;
  if (!Number.isInteger(Number(jobId))) return null;
  try {
    const row = getDb().prepare(`SELECT detail_json FROM job_observations
      WHERE job_id = ? AND observation_type = 'verification.pre_dev_typecheck' ORDER BY id DESC LIMIT 1`).get(Number(jobId));
    const count = row ? JSON.parse(row.detail_json || "{}")?.project_diagnostic_count : null;
    return Number.isInteger(count) ? count : null;
  } catch { return null; }
}

export async function runChangedFileChecksAsync(cwd, change, { signal = null, jobId = null, timeoutMs = FINAL_REVIEW_TEST_TIMEOUT_MS } = {}) {
  signal?.throwIfAborted();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "posse-review-checks-"));
  const input = path.join(dir, "input.json");
  const output = path.join(dir, "output.json");
  try {
    const files = (change?.files || []).map(file => file.path);
    const configured = implicitTypechecks(cwd, files);
    const covered = new Set(configured.map(check => check.cwd));
    const allRootsCovered = groupVerificationFiles(cwd, files).every(group => covered.has(group.root));
    const checkKinds = allRootsCovered ? FINAL_REVIEW_CHECKS.filter(check => check !== "typecheck") : FINAL_REVIEW_CHECKS;
    await fs.writeFile(input, JSON.stringify({ cwd, change, checkKinds }));
    const result = await runProcessAsync(process.execPath, [
      fileURLToPath(new URL("./final-review-checks-process.mjs", import.meta.url)), input, output,
    ], cwd, { signal, timeoutMs });
    signal?.throwIfAborted();
    if (result.exitCode !== 0 || result.timedOut || result.error) {
      throw new Error(result.timedOut ? "changed-file checks timed out" : result.error || result.stderr || "changed-file checks process failed");
    }
    const scoped = JSON.parse(await fs.readFile(output, "utf8"));
    const implicit = await runImplicitTypechecks(cwd, files, { signal, timeoutMs, baselineProjectDiagnosticCount: preDevProjectDiagnosticCount(change, jobId) });
    if (!implicit.length) return scoped;
    return { ...(scoped || { status: "passed", files: [], introduced: [], inChanged: [], elsewhere: [] }),
      implicit_typechecks: implicit };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
