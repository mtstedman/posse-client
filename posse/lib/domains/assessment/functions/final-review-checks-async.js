import { implicitTypechecks, runImplicitTypechecks } from "../../verification/functions/implicit-typechecks.js";
import { groupVerificationFiles } from "../../../shared/tools/functions/toolkit/verification-readiness.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FINAL_REVIEW_CHECKS, FINAL_REVIEW_TEST_TIMEOUT_MS } from "../../../catalog/final-review.js";
import { runProcessAsync } from "../../../shared/tools/functions/toolkit/scoped-runners.js";

// Scoped verifiers include synchronous language tools. Isolate the whole
// check in a child process so cancellation can kill its process tree as well
// as keep the orchestrator's lease renewals and tool routing responsive.
export async function runChangedFileChecksAsync(cwd, change, { signal = null, timeoutMs = FINAL_REVIEW_TEST_TIMEOUT_MS } = {}) {
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
    const implicit = await runImplicitTypechecks(cwd, files, { signal, timeoutMs });
    if (!implicit.length) return scoped;
    return { ...(scoped || { status: "passed", files: [], introduced: [], inChanged: [], elsewhere: [] }),
      implicit_typechecks: implicit };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
