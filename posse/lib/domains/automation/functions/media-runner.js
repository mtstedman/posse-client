import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { TEST_SUBPROCESS_ENV_KEYS } from "../../../catalog/process.js";
import { SCRIPT_TOOL_MEDIA_FORMATS, SCRIPT_TOOL_MEDIA_LOCAL_PROVIDER } from "../../../catalog/custom-tools.js";
import { filterProcessEnv } from "../../../shared/platform/functions/process-env.js";
import { SpawnedProcessTerminator } from "../../../shared/platform/classes/SpawnedProcessTerminator.js";
import { scrubSecretText } from "../../../shared/telemetry/functions/logging/scrub-secret-text.js";
import { demand } from "./policy.js";
import { localMediaModel } from "./script-tools.js";

const POSSE_ENTRY = fileURLToPath(new URL("../../../../orchestrator.js", import.meta.url));
const STDERR_TAIL_BYTES = 4 * 1024;
// Arguments that name the file or carry the prompt; the rest are model
// settings (size, steps, seed, ...) passed through to a local model.
const RESERVED_ARGUMENTS = ["prompt", "filename"];

// The child is Posse's own CLI, not operator code, so it keeps Posse's own
// settings (the key that authorizes the native runtime, model and binary
// roots) on top of the plain process environment a script tool gets.
function localGenerationEnv(sourceEnv = process.env) {
  const env = filterProcessEnv(sourceEnv, { allowedKeys: TEST_SUBPROCESS_ENV_KEYS });
  for (const [key, value] of Object.entries(sourceEnv)) if (key.startsWith("POSSE_")) env[key] = value;
  return env;
}

// Local models run through `posse local` in a child process: it owns model
// discovery, capability checks and GPU selection, and a child can be stopped
// on timeout or cancel without disturbing the owner. It works from a
// scratch directory so nothing but the result lands in the output folder.
async function generateLocal({ generate, prompt, parameters, file, format, timeoutMs, signal }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "posse-media-"));
  try {
    return await spawnLocalGeneration({ generate, prompt, parameters, file, format, timeoutMs, signal, scratch });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function spawnLocalGeneration({ generate, prompt, parameters, file, format, timeoutMs, signal, scratch }) {
  const model = localMediaModel(generate.kind, generate.model);
  const args = [POSSE_ENTRY, "local", "--model", model.slug, "--format", format, "--output", file, "--quiet", "--non-interactive",
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

// API image models run through the same executor the built-in image tool
// uses, with Posse's own provider credentials, budget and telemetry.
async function generateRemote({ generate, prompt, file, timeoutMs }) {
  const { execGenerateImageInternal } = await import("../../providers/functions/shared/image-generate-internal.js");
  const message = await execGenerateImageInternal({ prompt, filename: path.basename(file), provider: generate.provider }, {
    cwd: path.dirname(file), scopePredicates: { canCreate: () => true },
    imageProvider: generate.provider, imageModel: generate.model, imageTimeoutMs: timeoutMs,
  });
  const failed = typeof message !== "string" || /^error\b/i.test(message.trim());
  return { ok: !failed, timedOut: false, exitCode: failed ? 1 : 0, detail: failed ? scrubSecretText(String(message ?? "")).trim() : "" };
}

export const defaultMediaGenerators = Object.freeze({ local: generateLocal, remote: generateRemote });

function fileStamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// Runs one media tool: creates its folder, generates into a new uniquely
// named file there, and reports that file. The result has a script run's
// shape so tests, publication and run records treat both kinds alike.
export async function runMediaTool(tool, input, { signal = null, generators = defaultMediaGenerators, now = Date.now } = {}) {
  signal?.throwIfAborted();
  const generate = tool.manifest.generate, started = performance.now();
  const format = SCRIPT_TOOL_MEDIA_FORMATS[generate.kind];
  const prompt = String(input?.prompt ?? "");
  demand(prompt.trim().length > 0, `${tool.manifest.name} needs a prompt`, "invalid_request");
  try { fs.mkdirSync(generate.folder, { recursive: true, mode: 0o700 }); } catch (error) {
    demand(false, `${tool.manifest.name}: cannot create its output folder ${generate.folder} (${error.code || error.message})`, "script_invalid");
  }
  const folder = fs.realpathSync(generate.folder);
  demand(fs.statSync(folder).isDirectory(), `${tool.manifest.name}: output folder ${generate.folder} is not a folder`, "script_invalid");
  const base = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/.test(String(input?.filename ?? "")) ? input.filename : tool.manifest.name.replace(/[^A-Za-z0-9_-]/g, "-");
  const file = path.join(folder, `${base}-${fileStamp(now())}-${randomBytes(3).toString("hex")}.${format}`);
  const parameters = Object.fromEntries(Object.entries(input || {}).filter(([key]) => !RESERVED_ARGUMENTS.includes(key)));
  const run = generate.provider === SCRIPT_TOOL_MEDIA_LOCAL_PROVIDER ? generators.local : generators.remote;
  const outcome = await run({ generate, prompt, parameters, file, format, timeoutMs: tool.manifest.timeout_seconds * 1000, signal });
  const result = (ok, detail, fields = {}) => ({
    ok, exit_code: outcome.timedOut ? null : ok ? 0 : outcome.exitCode ?? 1, timed_out: outcome.timedOut === true,
    truncated: false, redacted: false, stderr: detail, duration_ms: Math.round(performance.now() - started), ...fields,
  });
  // A failed or stopped generation must not leave a partial file behind.
  const discard = () => { try { fs.rmSync(file, { force: true }); } catch {} };
  if (!outcome.ok) {
    discard();
    return result(false, outcome.detail || (outcome.timedOut ? "generation timed out" : "generation failed"), { output: "" });
  }
  let info = null;
  try { info = fs.lstatSync(file); } catch { /* reported below */ }
  if (!info?.isFile() || info.size === 0 || path.dirname(fs.realpathSync(file)) !== folder) {
    discard();
    return result(false, `the ${generate.kind} model reported success but wrote no file in ${folder}`, { output: "" });
  }
  const outputJson = { path: file, format, bytes: info.size, kind: generate.kind, provider: generate.provider, model: generate.model };
  return result(true, "", { output: `${JSON.stringify(outputJson)}\n`, output_json: outputJson });
}
