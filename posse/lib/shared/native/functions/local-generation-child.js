// Running a local model through `posse local` in a child process. Shared by
// the media tools and the local image provider: the child owns model
// discovery, capability checks, saved defaults and GPU selection, and it can
// be stopped on timeout or cancel without disturbing the process that asked.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_SUBPROCESS_ENV_KEYS } from "../../../catalog/process.js";
import { filterProcessEnv } from "../../platform/functions/process-env.js";
import { SpawnedProcessTerminator } from "../../platform/classes/SpawnedProcessTerminator.js";
import { scrubSecretText } from "../../telemetry/functions/logging/scrub-secret-text.js";

export const POSSE_ENTRY = fileURLToPath(new URL("../../../../orchestrator.js", import.meta.url));
const STDERR_TAIL_BYTES = 4 * 1024;

// The child is Posse's own CLI, not operator code, so it keeps Posse's own
// settings (the key that authorizes the native runtime, model and binary
// roots) on top of the plain process environment a script tool gets.
function localGenerationEnv(sourceEnv = process.env) {
  const env = filterProcessEnv(sourceEnv, { allowedKeys: TEST_SUBPROCESS_ENV_KEYS });
  for (const [key, value] of Object.entries(sourceEnv)) if (key.startsWith("POSSE_")) env[key] = value;
  return env;
}

/**
 * Generates once into a scratch directory and hands the finished file to
 * `use(producedPath)` before the directory is removed. The child works and
 * writes there, so a child stopped mid-write leaves nothing anywhere else.
 * `use` runs only for a successful run that wrote its file.
 *
 * @returns {Promise<{ ok: boolean, timedOut: boolean, exitCode: number|null, detail: string, produced: boolean }>}
 *   Rejects with the signal's reason when canceled.
 */
export async function runLocalGenerationInScratch({ slug, format, prompt, parameters = {}, timeoutMs, signal = null, entry = POSSE_ENTRY }, use) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "posse-media-"));
  try {
    const produced = path.join(scratch, `result.${format}`);
    const outcome = await spawnLocalGeneration({ slug, format, prompt, parameters, file: produced, timeoutMs, signal, scratch, entry });
    const wrote = outcome.ok && fs.existsSync(produced);
    if (wrote) await use(produced);
    return { ...outcome, produced: wrote };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function spawnLocalGeneration({ slug, format, prompt, parameters, file, timeoutMs, signal, scratch, entry }) {
  const args = [entry, "local", "--model", slug, "--format", format, "--output", file, "--quiet", "--non-interactive",
    ...(Object.keys(parameters).length ? ["--parameters", JSON.stringify(parameters)] : [])];
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: scratch, env: localGenerationEnv(),
        stdio: ["pipe", "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true, shell: false,
      });
    } catch (error) { reject(Object.assign(new Error(`Could not start local generation: ${error.message}`), { code: "script_unavailable" })); return; }
    let stderr = Buffer.alloc(0), timedOut = false, aborted = false, settled = false, terminating = false;
    const terminator = new SpawnedProcessTerminator(child, { processGroup: process.platform !== "win32" });
    const finish = (code) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", onAbort); terminator.cancel();
      if (aborted) { reject(signal.reason ?? Object.assign(new Error("Run canceled"), { code: "canceled" })); return; }
      resolve({ ok: !timedOut && code === 0, timedOut, exitCode: timedOut ? null : code, detail: scrubSecretText(stderr.toString("utf8")).trim() });
    };
    const terminate = () => {
      if (settled || terminating) return;
      terminating = true;
      void terminator.terminateAndWait().then(() => finish(null));
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const onAbort = () => { aborted = true; terminate(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", chunk => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > STDERR_TAIL_BYTES) stderr = stderr.subarray(stderr.length - STDERR_TAIL_BYTES);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    child.once("error", error => { if (!settled) { settled = true; clearTimeout(timer); reject(Object.assign(new Error(`Could not start local generation: ${error.message}`), { code: "script_unavailable" })); } });
    child.once("close", code => { terminator.noteClose(); if (!terminating) finish(code); });
    if (signal?.aborted) onAbort();
  });
}
