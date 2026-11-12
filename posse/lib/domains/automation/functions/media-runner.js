import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { SCRIPT_TOOL_MEDIA_FORMATS, SCRIPT_TOOL_MEDIA_LOCAL_PROVIDER } from "../../../catalog/custom-tools.js";
import { POSSE_ENTRY, runLocalGenerationInScratch } from "../../../shared/native/functions/local-generation-child.js";
import { scrubSecretText } from "../../../shared/telemetry/functions/logging/scrub-secret-text.js";
import { demand } from "./policy.js";
import { localMediaModel } from "./script-tools.js";

// Arguments that name the file or carry the prompt; the rest are model
// settings (size, steps, seed, ...) passed through to a local model.
const RESERVED_ARGUMENTS = ["prompt", "filename"];

// Local models run through `posse local` in a child process that works and
// writes in a scratch directory: only a complete result is moved into the
// output folder, so a stopped child leaves nothing behind there.
export function createLocalGenerator({ entry = POSSE_ENTRY } = {}) {
  return async function generateLocal({ generate, prompt, parameters, file, format, timeoutMs, signal }) {
    const { slug } = localMediaModel(generate.kind, generate.model);
    return await runLocalGenerationInScratch({ slug, format, prompt, parameters, timeoutMs, signal, entry },
      produced => moveIntoPlace(produced, file));
  };
}

// The scratch directory and the output folder may be on different filesystems.
function moveIntoPlace(from, to) {
  try { fs.renameSync(from, to); } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  }
}

// API image models run through the same executor the built-in image tool
// uses, with Posse's own provider credentials, budget and telemetry.
export function createRemoteGenerator({ execute = null } = {}) {
  return async function generateRemote({ generate, prompt, file, timeoutMs, signal }) {
    const execGenerateImageInternal = execute
      || (await import("../../providers/functions/shared/image-generate-internal.js")).execGenerateImageInternal;
    const started = performance.now();
    const message = await execGenerateImageInternal({ prompt, filename: path.basename(file), provider: generate.provider }, {
      cwd: path.dirname(file), scopePredicates: { canCreate: () => true },
      imageProvider: generate.provider, imageModel: generate.model, imageTimeoutMs: timeoutMs, signal,
    });
    const failed = typeof message !== "string" || /^error\b/i.test(message.trim());
    // The executor reports its own timeout as an ordinary failure message; a
    // failure that used the whole allowance is the tool's timeout.
    const timedOut = failed && performance.now() - started >= timeoutMs;
    return { ok: !failed, timedOut, exitCode: failed && !timedOut ? 1 : failed ? null : 0, detail: failed ? scrubSecretText(String(message ?? "")).trim() : "" };
  };
}

export const defaultMediaGenerators = Object.freeze({ local: createLocalGenerator(), remote: createRemoteGenerator() });

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
  // A failed or stopped generation must not leave a partial file behind.
  const discard = () => { try { fs.rmSync(file, { force: true }); } catch {} };
  let outcome;
  try {
    outcome = await run({ generate, prompt, parameters, file, format, timeoutMs: tool.manifest.timeout_seconds * 1000, signal });
  } catch (error) {
    // Canceled, or the generator itself failed to start.
    discard();
    throw error;
  }
  const result = (ok, detail, fields = {}) => ({
    ok, exit_code: outcome.timedOut ? null : ok ? 0 : outcome.exitCode ?? 1, timed_out: outcome.timedOut === true,
    truncated: false, redacted: false, stderr: detail, duration_ms: Math.round(performance.now() - started), ...fields,
  });
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
