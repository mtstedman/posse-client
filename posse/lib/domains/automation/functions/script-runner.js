import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { TEST_SUBPROCESS_ENV_KEYS } from "../../../catalog/process.js";
import { SCRIPT_TOOL_INTERPRETERS, SCRIPT_TOOL_LIMITS } from "../../../catalog/custom-tools.js";
import { filterProcessEnv } from "../../../shared/platform/functions/process-env.js";
import { terminateSpawnedProcessTree } from "../../../shared/platform/functions/spawned-process.js";
import { scrubSecretText } from "../../../shared/telemetry/functions/logging/scrub-secret-text.js";
import { redactBridgeValue } from "../../bridge/functions/redaction.js";
import { redactSecretValues, scalarParamEnv } from "./script-tools.js";

const TERMINATION_GRACE_MS = 250;

// Builds the child environment from an allowlist; the owner's own environment
// (which keeps the user's credentials) never passes through.
export function scriptToolEnv(tool, input, secrets, tempDir, sourceEnv = process.env) {
  const env = filterProcessEnv(sourceEnv, { allowedKeys: TEST_SUBPROCESS_ENV_KEYS });
  for (const key of Object.keys(env)) if (["tmp", "temp", "tmpdir"].includes(key.toLowerCase())) delete env[key];
  Object.assign(env, { TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir });
  for (const item of tool.manifest.env) env[item.name] = item.secret ? secrets[item.name] ?? "" : item.default ?? "";
  Object.assign(env, { POSSE_TOOL_NAME: tool.manifest.name, POSSE_TOOL_DIR: tool.dir, POSSE_TOOL_EFFECT: tool.manifest.effect });
  return Object.assign(env, scalarParamEnv(input));
}

// Runs one script tool. Arguments arrive only as data — JSON on stdin and
// PARAM_* variables — never on a command line. Returns a redacted result; an
// abort of `signal` rejects with the signal's reason after the tree is killed.
export async function runScriptTool(tool, input, { secrets = {}, signal = null, sourceEnv = process.env } = {}) {
  signal?.throwIfAborted();
  const interpreter = SCRIPT_TOOL_INTERPRETERS[tool.manifest.interpreter];
  const [program, args] = interpreter ? [interpreter, [tool.entryPath]] : [tool.entryPath, []];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-tool-"));
  const started = performance.now();
  try {
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(program, args, {
          cwd: tool.dir, env: scriptToolEnv(tool, input, secrets, tempDir, sourceEnv),
          stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true, shell: false,
        });
      } catch (error) { reject(Object.assign(new Error(`Could not start ${tool.manifest.name}: ${error.message}`), { code: "script_invalid" })); return; }
      const limit = tool.manifest.max_output_bytes;
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), truncated = false, timedOut = false, aborted = false, settled = false;
      const terminate = () => {
        terminateSpawnedProcessTree(child, { processGroup: process.platform !== "win32" });
        setTimeout(() => terminateSpawnedProcessTree(child, { processGroup: process.platform !== "win32", force: true }), TERMINATION_GRACE_MS).unref?.();
      };
      const timer = setTimeout(() => { timedOut = true; terminate(); }, tool.manifest.timeout_seconds * 1000);
      const onAbort = () => { aborted = true; terminate(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", chunk => {
        const room = limit - stdout.length;
        if (chunk.length > room) truncated = true;
        if (room > 0) stdout = Buffer.concat([stdout, chunk.subarray(0, room)]);
      });
      child.stderr.on("data", chunk => {
        stderr = Buffer.concat([stderr, chunk]);
        if (stderr.length > SCRIPT_TOOL_LIMITS.STDERR_TAIL_BYTES) stderr = stderr.subarray(stderr.length - SCRIPT_TOOL_LIMITS.STDERR_TAIL_BYTES);
      });
      // A script that never reads stdin closes the pipe; that is not an error.
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(input ?? {}));
      const finish = (code, failure) => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
        if (aborted) { reject(signal.reason ?? Object.assign(new Error("Run canceled"), { code: "canceled" })); return; }
        if (failure) { reject(Object.assign(new Error(`Could not start ${tool.manifest.name}: ${failure.message}`), { code: failure.code === "ENOENT" ? "script_unavailable" : "script_invalid" })); return; }
        const out = redactSecretValues(stdout.toString("utf8"), secrets), err = redactSecretValues(stderr.toString("utf8"), secrets);
        // JSON output is redacted structurally (sensitive keys, token-shaped
        // strings); pattern scrubbing raw JSON text would corrupt it.
        let output, outputJson;
        const trimmed = out.text.trim();
        if (/^[[{]/.test(trimmed)) { try { outputJson = redactBridgeValue(JSON.parse(trimmed)); output = `${JSON.stringify(outputJson)}\n`; } catch { /* text output */ } }
        if (output === undefined) output = scrubSecretText(out.text);
        const errorText = scrubSecretText(err.text);
        resolve({
          ok: !timedOut && code === 0, exit_code: timedOut ? null : code, timed_out: timedOut,
          output, ...(outputJson !== undefined ? { output_json: outputJson } : {}), stderr: errorText.trim(), truncated,
          redacted: out.redacted || err.redacted || output !== out.text || errorText !== err.text,
          duration_ms: Math.round(performance.now() - started),
        });
      };
      child.once("error", error => finish(null, error));
      child.once("close", code => finish(code, null));
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
