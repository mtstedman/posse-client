import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FINAL_REVIEW_TEST_TIMEOUT_MS } from "../../../catalog/final-review.js";
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
    await fs.writeFile(input, JSON.stringify({ cwd, change }));
    const result = await runProcessAsync(process.execPath, [
      fileURLToPath(new URL("./final-review-checks-process.mjs", import.meta.url)), input, output,
    ], cwd, { signal, timeoutMs });
    signal?.throwIfAborted();
    if (result.exitCode !== 0 || result.timedOut || result.error) {
      throw new Error(result.timedOut ? "changed-file checks timed out" : result.error || result.stderr || "changed-file checks process failed");
    }
    return JSON.parse(await fs.readFile(output, "utf8"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
