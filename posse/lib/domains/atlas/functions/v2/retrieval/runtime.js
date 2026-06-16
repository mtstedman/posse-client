// @ts-check
//
// Native governed runtime actions. Execution is disabled by default and
// controlled by the native ATLAS policy stored in the ledger.

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { randomBytes, createHash } from "crypto";
import { okEnvelope, errorEnvelope } from "./envelope.js";
import { getEffectivePolicy } from "./policy.js";
import { redactSecretsAsync } from "./redaction.js";
import { ATLAS_RUNTIME_SPECS } from "../contracts/runtimes.js";

/** @typedef {import("../contracts/tool-params.js").RuntimeExecuteParams} RuntimeExecuteParams */
/** @typedef {import("../contracts/tool-params.js").RuntimeQueryOutputParams} RuntimeQueryOutputParams */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_LINES = 80;
const MAX_RESPONSE_LINES = 1000;
const MAX_EXCERPTS = 50;
const MAX_CONTEXT_LINES = 10;
const IS_WINDOWS = process.platform === "win32";
const RUNTIME_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
]);

const RUNTIME_DESCRIPTORS = Object.freeze(ATLAS_RUNTIME_SPECS.map(runtimeDescriptorFromSpec));

const RUNTIME_BY_ALIAS = new Map();
for (const descriptor of RUNTIME_DESCRIPTORS) {
  for (const alias of descriptor.aliases) {
    RUNTIME_BY_ALIAS.set(runtimeKey(alias), descriptor);
  }
}

/**
 * @param {{
 *   versionId: string,
 *   params: RuntimeExecuteParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoRoot?: string,
 *   repoId?: string | null,
 * }} args
 */
export async function runtimeExecute({ versionId, params, ledger, repoRoot, repoId }) {
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  const policy = getEffectivePolicy(ledger, effectiveRepoId);
  if (policy.runtimeEnabled !== true) {
    return deniedEnvelope({
      versionId,
      reason: "runtime_disabled",
      message: "runtime.execute is disabled by native ATLAS policy; enable policy.runtimeEnabled for this repo first.",
    });
  }
  if (!repoRoot) {
    return errorEnvelope({
      action: "runtime.execute",
      versionId,
      code: "repo_root_required",
      message: "runtime.execute requires a repoRoot dispatch context",
    });
  }

  const cwd = resolveContainedCwd(repoRoot, params.relativeCwd || ".");
  if (!cwd) {
    return deniedEnvelope({
      versionId,
      reason: "cwd_outside_repo",
      message: "relativeCwd must stay inside the repository root.",
    });
  }

  const runtime = String(params.runtime || "").trim().toLowerCase();
  const command = resolveCommand({ runtime, executable: params.executable });
  if (!command.ok) {
    return deniedEnvelope({
      versionId,
      reason: command.code,
      message: command.message,
    });
  }

  let tempFile = null;
  const userArgs = Array.isArray(params.args) ? params.args.map(String) : [];
  let spawnArgs = [...userArgs];
  let auditArgs = [...userArgs];
  let displayArgs = [...userArgs];
  const codeHash = typeof params.code === "string" && params.code.length > 0
    ? auditHash({ code: params.code })
    : null;
  const artifactRoot = runtimeArtifactRoot(repoRoot);
  try {
    if (typeof params.code === "string" && params.code.length > 0) {
      fs.mkdirSync(path.join(artifactRoot, "tmp"), { recursive: true });
      tempFile = path.join(artifactRoot, "tmp", `${Date.now()}-${randomBytes(4).toString("hex")}${command.descriptor.extension}`);
      fs.writeFileSync(tempFile, params.code, "utf8");
      spawnArgs = command.descriptor.codeArgs(tempFile, userArgs);
      auditArgs = ["<code>", ...userArgs];
      displayArgs = ["<code>", ...userArgs];
    }
  } catch (err) {
    return errorEnvelope({
      action: "runtime.execute",
      versionId,
      code: "tempfile_failed",
      message: `Could not prepare runtime code file: ${err?.message || String(err)}`,
    });
  }

  const startedAt = Date.now();
  const timeoutMs = clampInt(params.timeoutMs, 100, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const result = await runProcess({
    executable: command.executable,
    args: spawnArgs,
    cwd,
    timeoutMs,
    env: scrubbedRuntimeEnv(),
  });
  const durationMs = Date.now() - startedAt;
  const [stdout, stderr] = await Promise.all([
    redactSecretsAsync(result.stdout),
    redactSecretsAsync(result.stderr),
  ]);
  const status = result.timedOut
    ? "timeout"
    : result.exitCode === 0
      ? "success"
      : "failure";
  let artifactHandle = null;
  if (params.persistOutput !== false) {
    artifactHandle = writeRuntimeArtifact({
      repoRoot,
      repoId: effectiveRepoId,
      runtime: command.descriptor.name,
      executable: command.executable,
      args: displayArgs,
      relativeCwd: params.relativeCwd || ".",
      status,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs,
      stdout,
      stderr,
      truncated: result.truncated,
    });
  }

  const maxLines = clampInt(params.maxResponseLines, 10, MAX_RESPONSE_LINES, DEFAULT_MAX_RESPONSE_LINES);
  const outputMode = ["minimal", "summary", "intent"].includes(String(params.outputMode || ""))
    ? String(params.outputMode)
    : "minimal";
  const excerpts = params.queryTerms && params.queryTerms.length > 0
    ? findExcerpts({ stdout, stderr, queryTerms: params.queryTerms, maxExcerpts: 10, contextLines: 2, stream: "both" }).excerpts
    : [];
  const data = {
    status,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs,
    stdoutSummary: outputMode === "summary" ? summarizeHeadTail(stdout, maxLines) : "",
    stdoutPreview: outputMode === "minimal" ? preview(stdout) : undefined,
    stderrSummary: outputMode === "summary" ? summarizeTail(stderr, Math.max(1, Math.floor(maxLines / 4))) : "",
    artifactHandle,
    ...(outputMode === "intent" || excerpts.length > 0 ? { excerpts } : {}),
    truncation: {
      stdoutTruncated: result.truncated.stdout,
      stderrTruncated: result.truncated.stderr,
      totalStdoutBytes: result.stdoutBytes,
      totalStderrBytes: result.stderrBytes,
    },
    policyDecision: {
      auditHash: auditHash({
        effectiveRepoId,
        runtime: command.descriptor.name,
        executable: command.executable,
        args: auditArgs,
        codeHash,
        cwd: path.relative(path.resolve(repoRoot), cwd).replace(/\\/g, "/") || ".",
        timeoutMs,
      }),
    },
    command: {
      runtime: command.descriptor.name,
      executable: command.executable,
      args: displayArgs,
      relativeCwd: params.relativeCwd || ".",
    },
  };
  if (data.stdoutPreview === undefined) delete data.stdoutPreview;
  try { if (tempFile) fs.rmSync(tempFile, { force: true }); } catch { /* best effort */ }
  return okEnvelope({ action: "runtime.execute", versionId, data });
}

/**
 * @param {{
 *   versionId: string,
 *   params: RuntimeQueryOutputParams,
 *   repoRoot?: string,
 * }} args
 */
export function runtimeQueryOutput({ versionId, params, repoRoot }) {
  if (!repoRoot) {
    return errorEnvelope({
      action: "runtime.queryOutput",
      versionId,
      code: "repo_root_required",
      message: "runtime.queryOutput requires a repoRoot dispatch context",
    });
  }
  const artifact = readRuntimeArtifact(repoRoot, params.artifactHandle);
  if (!artifact) {
    return errorEnvelope({
      action: "runtime.queryOutput",
      versionId,
      code: "artifact_not_found",
      message: `No runtime artifact found for handle ${params.artifactHandle}`,
    });
  }
  const queryTerms = Array.isArray(params.queryTerms) ? params.queryTerms.map(String).filter(Boolean) : [];
  if (queryTerms.length === 0) {
    return errorEnvelope({
      action: "runtime.queryOutput",
      versionId,
      code: "query_terms_required",
      message: "runtime.queryOutput requires at least one query term",
    });
  }
  const found = findExcerpts({
    stdout: String(artifact.stdout || ""),
    stderr: String(artifact.stderr || ""),
    queryTerms,
    maxExcerpts: clampInt(params.maxExcerpts, 1, MAX_EXCERPTS, 10),
    contextLines: clampInt(params.contextLines, 0, MAX_CONTEXT_LINES, 3),
    stream: ["stdout", "stderr", "both"].includes(String(params.stream || "")) ? String(params.stream) : "both",
  });
  return okEnvelope({
    action: "runtime.queryOutput",
    versionId,
    data: {
      artifactHandle: params.artifactHandle,
      excerpts: found.excerpts,
      totalLines: found.totalLines,
      totalBytes: Buffer.byteLength(`${artifact.stdout || ""}${artifact.stderr || ""}`, "utf8"),
      searchedStreams: found.searchedStreams,
    },
  });
}

function deniedExecution({ reason, message }) {
  return {
    status: "denied",
    exitCode: null,
    signal: null,
    durationMs: 0,
    stdoutSummary: "",
    stderrSummary: "",
    artifactHandle: null,
    excerpts: [],
    truncation: {
      stdoutTruncated: false,
      stderrTruncated: false,
      totalStdoutBytes: 0,
      totalStderrBytes: 0,
    },
    policyDecision: {
      auditHash: auditHash({ reason, message }),
      deniedReasons: [reason],
    },
  };
}

function deniedEnvelope({ versionId, reason, message }) {
  return errorEnvelope({
    action: "runtime.execute",
    versionId,
    code: reason,
    message,
    details: deniedExecution({ reason, message }),
  });
}

function resolveCommand({ runtime, executable }) {
  const descriptor = RUNTIME_BY_ALIAS.get(runtimeKey(runtime));
  if (!descriptor) {
    return { ok: false, code: "runtime_not_allowed", message: `Unsupported runtime: ${runtime || "<missing>"}` };
  }
  const chosen = String(executable || descriptor.command).trim();
  if (!chosen || /[\\/]/.test(chosen) || /^[A-Za-z]:/.test(chosen)) {
    return { ok: false, code: "executable_path_not_allowed", message: "runtime executable must be a PATH command name, not a path" };
  }
  if (executable && !descriptor.allowsExecutable(chosen)) {
    return {
      ok: false,
      code: "executable_not_compatible",
      message: `Executable ${chosen} is not registered for runtime ${descriptor.name}`,
    };
  }
  return { ok: true, executable: chosen, descriptor };
}

function resolveContainedCwd(repoRoot, relativeCwd) {
  const root = path.resolve(repoRoot);
  const target = path.resolve(root, String(relativeCwd || "."));
  const rootCmp = normalizePathForCompare(root);
  const targetCmp = normalizePathForCompare(target);
  if (targetCmp !== rootCmp && !targetCmp.startsWith(rootCmp + path.sep)) return null;
  return target;
}

function normalizePathForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function runProcess({ executable, args, cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutStoredBytes = 0;
    let stderrStoredBytes = 0;
    const truncated = { stdout: false, stderr: false };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* no-op */ }
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      const appended = appendLimited(stdout, stdoutStoredBytes, chunk);
      stdout = appended.text;
      stdoutStoredBytes = appended.bytes;
      truncated.stdout ||= appended.truncated;
    });
    child.stderr?.on("data", (chunk) => {
      stderrBytes += chunk.length;
      const appended = appendLimited(stderr, stderrStoredBytes, chunk);
      stderr = appended.text;
      stderrStoredBytes = appended.bytes;
      truncated.stderr ||= appended.truncated;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      const errChunk = Buffer.from(`${stderr ? "\n" : ""}${err.message}`, "utf8");
      stderrBytes += errChunk.length;
      const appended = appendLimited(stderr, stderrStoredBytes, errChunk);
      stderr = appended.text;
      stderrStoredBytes = appended.bytes;
      truncated.stderr ||= appended.truncated;
      if (!stderr.includes(err.message)) {
        stderr = appendRequiredTail(stderr, `[process error] ${err.message}`);
        stderrStoredBytes = Buffer.byteLength(stderr, "utf8");
        truncated.stderr = true;
      }
      resolve({
        exitCode: 127,
        signal: null,
        timedOut: false,
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
        truncated,
      });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
        truncated,
      });
    });
  });
}

function scrubbedRuntimeEnv(source = process.env) {
  const allowed = new Set(RUNTIME_ENV_ALLOWLIST.map((key) => key.toLowerCase()));
  const env = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!allowed.has(key.toLowerCase()) || value == null) continue;
    env[key] = String(value);
  }
  return env;
}

function appendLimited(current, storedBytes, chunk) {
  if (storedBytes >= MAX_OUTPUT_BYTES) {
    return { text: current, bytes: storedBytes, truncated: true };
  }
  const remaining = MAX_OUTPUT_BYTES - storedBytes;
  if (chunk.length <= remaining) {
    return {
      text: current + chunk.toString("utf8"),
      bytes: storedBytes + chunk.length,
      truncated: false,
    };
  }
  return {
    text: current + chunk.subarray(0, remaining).toString("utf8"),
    bytes: MAX_OUTPUT_BYTES,
    truncated: true,
  };
}

function appendRequiredTail(current, message) {
  const suffix = `${current ? "\n" : ""}${String(message || "")}`;
  const suffixBytes = Buffer.from(suffix, "utf8");
  if (suffixBytes.length >= MAX_OUTPUT_BYTES) {
    return suffixBytes.subarray(suffixBytes.length - MAX_OUTPUT_BYTES).toString("utf8");
  }
  const currentBytes = Buffer.from(String(current || ""), "utf8");
  const keep = Math.max(0, MAX_OUTPUT_BYTES - suffixBytes.length);
  return Buffer.concat([
    currentBytes.subarray(Math.max(0, currentBytes.length - keep)),
    suffixBytes,
  ]).toString("utf8");
}

function runtimeArtifactRoot(repoRoot) {
  return path.join(path.resolve(repoRoot), ".posse", "atlas", "runtime-artifacts");
}

function writeRuntimeArtifact(input) {
  const handle = `rt_${Date.now()}_${randomBytes(8).toString("hex")}`;
  const dir = runtimeArtifactRoot(input.repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${handle}.json`);
  fs.writeFileSync(file, JSON.stringify({
    handle,
    repoId: input.repoId,
    runtime: input.runtime,
    executable: input.executable,
    args: input.args,
    relativeCwd: input.relativeCwd,
    status: input.status,
    exitCode: input.exitCode,
    signal: input.signal,
    durationMs: input.durationMs,
    stdout: input.stdout,
    stderr: input.stderr,
    truncated: input.truncated,
    createdAt: new Date().toISOString(),
  }, null, 2), "utf8");
  return handle;
}

function readRuntimeArtifact(repoRoot, handle) {
  const text = String(handle || "");
  if (!/^[A-Za-z0-9_.-]+$/.test(text) || text.includes("..")) return null;
  const file = path.join(runtimeArtifactRoot(repoRoot), `${text}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function findExcerpts({ stdout, stderr, queryTerms, maxExcerpts, contextLines, stream }) {
  const lowerTerms = queryTerms.map((term) => String(term).toLowerCase()).filter(Boolean);
  const excerpts = [];
  const searchedStreams = [];
  let totalLines = 0;
  const visit = (content, source) => {
    if (!content || (stream !== "both" && stream !== source)) return;
    searchedStreams.push(source);
    const lines = String(content).split(/\r?\n/);
    totalLines += lines.length;
    for (let i = 0; i < lines.length && excerpts.length < maxExcerpts; i += 1) {
      const lower = lines[i].toLowerCase();
      if (!lowerTerms.some((term) => lower.includes(term))) continue;
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length - 1, i + contextLines);
      excerpts.push({
        lineStart: start + 1,
        lineEnd: end + 1,
        content: lines.slice(start, end + 1).map(truncateLine).join("\n"),
        source,
      });
      i = end;
    }
  };
  visit(stdout, "stdout");
  visit(stderr, "stderr");
  return { excerpts, totalLines, searchedStreams };
}

function summarizeHeadTail(text, maxLines) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines.length <= maxLines) return lines.map(truncateLine).join("\n");
  const head = Math.ceil(maxLines / 2);
  const tail = Math.floor(maxLines / 2);
  return [
    ...lines.slice(0, head).map(truncateLine),
    `... (${lines.length - head - tail} lines omitted) ...`,
    ...lines.slice(-tail).map(truncateLine),
  ].join("\n");
}

function summarizeTail(text, maxLines) {
  const lines = String(text || "").split(/\r?\n/);
  return lines.slice(-maxLines).map(truncateLine).join("\n");
}

function preview(text) {
  return String(text || "").split(/\r?\n/).slice(0, 3).join("\n").slice(0, 200);
}

function truncateLine(line) {
  const text = String(line || "");
  return text.length > 500 ? `${text.slice(0, 500)}... (+${text.length - 500})` : text;
}

function auditHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function effectiveRepo(ctxRepoId, paramRepoId) {
  const text = String(paramRepoId || ctxRepoId || "default").trim();
  return text || "default";
}

/**
 * @param {{ name: string, aliases: string[], extension: string | { win32: string, unix: string }, command: { win32: string, unix: string }, codeArgs: "default" | "shell" | "go" }} spec
 */
function runtimeDescriptorFromSpec(spec) {
  const extension = typeof spec.extension === "string"
    ? spec.extension
    : IS_WINDOWS
      ? spec.extension.win32
      : spec.extension.unix;
  return runtimeDescriptor(spec.name, spec.aliases, extension, spec.command, {
    codeArgs: codeArgsForKind(spec.codeArgs),
  });
}

/**
 * @param {"default" | "shell" | "go"} kind
 * @returns {(file: string, args: string[]) => string[]}
 */
function codeArgsForKind(kind) {
  if (kind === "shell") {
    return (file, args) => IS_WINDOWS
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args]
      : [file, ...args];
  }
  if (kind === "go") {
    return (file, args) => ["run", file, ...args];
  }
  return (file, args) => [file, ...args];
}

/**
 * @param {string} name
 * @param {string[]} aliases
 * @param {string} extension
 * @param {{ win32: string, unix: string }} command
 * @param {{ codeArgs?: (file: string, args: string[]) => string[] }} [opts]
 */
function runtimeDescriptor(name, aliases, extension, command, opts = {}) {
  const runtimeAliasSet = new Set([name, ...aliases].map(runtimeKey));
  const commandName = IS_WINDOWS ? command.win32 : command.unix;
  const executableAliasSet = new Set(runtimeAliasSet);
  executableAliasSet.add(runtimeKey(commandName));
  if (IS_WINDOWS && !commandName.toLowerCase().endsWith(".exe")) {
    executableAliasSet.add(runtimeKey(`${commandName}.exe`));
  }
  return {
    name,
    aliases: [...runtimeAliasSet],
    extension,
    command: commandName,
    codeArgs: opts.codeArgs || ((file, args) => [file, ...args]),
    allowsExecutable(executable) {
      const key = runtimeKey(path.basename(String(executable || "")));
      return executableAliasSet.has(key);
    },
  };
}

/**
 * @param {string} value
 */
function runtimeKey(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
