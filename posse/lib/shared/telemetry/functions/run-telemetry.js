import crypto from "crypto";
import fs from "fs";
import path from "path";
import { isMainThread, threadId } from "node:worker_threads";

import { getRuntimeLogDir, getRuntimeResourcesDir } from "../../../domains/runtime/functions/paths.js";

const GENERATED_RUN_STARTED_AT = new Date().toISOString();
const RUN_STARTED_AT = String(process.env.POSSE_RUN_STARTED_AT || GENERATED_RUN_STARTED_AT);
const GENERATED_RUN_ID = `${RUN_STARTED_AT.replace(/[:.]/g, "-")}-pid${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const RUN_ID = String(process.env.POSSE_RUN_ID || GENERATED_RUN_ID).replace(/[^A-Za-z0-9_.-]/g, "_");

try {
  if (!process.env.POSSE_RUN_STARTED_AT) process.env.POSSE_RUN_STARTED_AT = RUN_STARTED_AT;
  if (!process.env.POSSE_RUN_ID) process.env.POSSE_RUN_ID = RUN_ID;
} catch {
  // Environment seeding is best-effort; telemetry still works in-process.
}

const STREAM_FILES = Object.freeze({
  events: "events.jsonl",
  observations: "observations.jsonl",
  "agent-calls": "agent-calls.jsonl",
  artifacts: "artifacts.jsonl",
  diagnostics: "diagnostics.jsonl",
  heartbeats: "heartbeats.jsonl",
  jobs: "jobs.jsonl",
  memory: "memory.jsonl",
  outputs: "outputs.jsonl",
  prompts: "prompts.jsonl",
  runtime: "runtime.jsonl",
  "windows-events": "windows-events.jsonl",
});

const _streams = new Map();
const _manifestDirs = new Set();
let _exitHookInstalled = false;
let _telemetryEpoch = 0;

function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "bigint") return val.toString();
    if (val && typeof val === "object") {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    return val;
  });
}

function streamFileName(stream) {
  return STREAM_FILES[stream] || `${String(stream || "telemetry").replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl`;
}

function nowIso() {
  return new Date().toISOString();
}

function ensureExitHook() {
  if (_exitHookInstalled) return;
  _exitHookInstalled = true;
  process.on("exit", () => {
    try { closeRunTelemetry({ cleanExit: true }); } catch { /* best effort */ }
  });
}

export function getRunTelemetryId() {
  return RUN_ID;
}

export function getRunTelemetryStartedAt() {
  return RUN_STARTED_AT;
}

export function getRunTelemetryEpoch() {
  return _telemetryEpoch;
}

export function bumpRunTelemetryEpoch() {
  _telemetryEpoch += 1;
  return _telemetryEpoch;
}

export function getRunTelemetryDir() {
  return path.join(getRuntimeLogDir(), "runs", RUN_ID);
}

function ensureManifest(runDir) {
  if (_manifestDirs.has(runDir)) return;
  fs.mkdirSync(runDir, { recursive: true });
  const manifestPath = path.join(runDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    const manifest = {
      schema_version: 1,
      run_id: RUN_ID,
      started_at: RUN_STARTED_AT,
      pid: process.pid,
      thread_id: threadId,
      is_main_thread: isMainThread,
      cwd: process.cwd(),
      streams: STREAM_FILES,
      clean_exit: false,
    };
    fs.writeFileSync(manifestPath, `${safeStringify(manifest)}\n`, "utf8");
  }
  _manifestDirs.add(runDir);
}

function updateManifest(runDir, patch = {}) {
  const manifestPath = path.join(runDir, "manifest.json");
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    manifest = {
      schema_version: 1,
      run_id: RUN_ID,
      started_at: RUN_STARTED_AT,
      pid: process.pid,
      thread_id: threadId,
      is_main_thread: isMainThread,
      cwd: process.cwd(),
      streams: STREAM_FILES,
    };
  }
  try {
    fs.writeFileSync(manifestPath, `${safeStringify({ ...manifest, ...patch })}\n`, "utf8");
  } catch {
    // Best effort only.
  }
}

export function updateRunTelemetryManifest(patch = {}) {
  const runDir = getRunTelemetryDir();
  ensureManifest(runDir);
  updateManifest(runDir, patch);
}

export function listRunTelemetryManifests({ includeCurrent = true } = {}) {
  const runsRoot = path.join(getRuntimeLogDir(), "runs");
  const currentRunId = getRunTelemetryId();
  try {
    return fs.readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => includeCurrent || entry.name !== currentRunId)
      .map((entry) => {
        const filePath = path.join(runsRoot, entry.name, "manifest.json");
        let manifest = null;
        try { manifest = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { /* ignore */ }
        return manifest ? { run_id: entry.name, file_path: filePath, manifest } : null;
      })
      .filter(Boolean)
      .sort((a, b) => String(a.manifest.started_at || a.run_id).localeCompare(String(b.manifest.started_at || b.run_id)));
  } catch {
    return [];
  }
}

function openStream(stream) {
  const runDir = getRunTelemetryDir();
  const filePath = path.join(runDir, streamFileName(stream));
  const existing = _streams.get(stream);
  if (existing?.filePath === filePath && existing.fd != null) return existing;

  if (existing?.fd != null) {
    try { fs.closeSync(existing.fd); } catch { /* ignore */ }
  }

  ensureManifest(runDir);
  const fd = fs.openSync(filePath, "a");
  const next = { fd, filePath, runDir };
  _streams.set(stream, next);
  ensureExitHook();
  return next;
}

export function appendRunTelemetry(stream, entry = {}) {
  try {
    const target = openStream(stream);
    const line = safeStringify({
      t: entry?.created_at || entry?.t || nowIso(),
      run_id: RUN_ID,
      telemetry_epoch: _telemetryEpoch,
      ...entry,
    });
    fs.writeSync(target.fd, `${line}\n`);
    return true;
  } catch {
    return false;
  }
}

export function closeRunTelemetry({ cleanExit = true } = {}) {
  const dirs = new Set(_manifestDirs);
  for (const stream of _streams.values()) {
    if (stream?.runDir) dirs.add(stream.runDir);
    if (stream?.fd != null) {
      try { fs.closeSync(stream.fd); } catch { /* ignore */ }
    }
  }
  _streams.clear();
  _manifestDirs.clear();
  for (const runDir of dirs) {
    updateManifest(runDir, {
      ended_at: nowIso(),
      clean_exit: !!cleanExit,
    });
  }
}

export function listRunTelemetryFiles(stream) {
  const runsRoot = path.join(getRuntimeLogDir(), "runs");
  const fileName = streamFileName(stream);
  try {
    return fs.readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(runsRoot, entry.name, fileName))
      .filter((filePath) => fs.existsSync(filePath))
      .sort();
  } catch {
    return [];
  }
}

export function readRunTelemetryEntries(stream, {
  limit = 100,
  order = "desc",
  currentEpochOnly = true,
  predicate = () => true,
} = {}) {
  const files = currentEpochOnly
    ? [path.join(getRunTelemetryDir(), streamFileName(stream))].filter((filePath) => fs.existsSync(filePath))
    : listRunTelemetryFiles(stream);
  const orderedFiles = order === "asc" ? files : files.reverse();
  const out = [];
  const max = limit == null ? Infinity : Math.max(0, Number(limit) || 0);
  if (max === 0) return out;

  for (const filePath of orderedFiles) {
    let lines;
    try { lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/); }
    catch { continue; }

    const start = order === "asc" ? 0 : lines.length - 1;
    const end = order === "asc" ? lines.length : -1;
    const step = order === "asc" ? 1 : -1;
    for (let i = start; i !== end; i += step) {
      const raw = String(lines[i] || "").trim();
      if (!raw) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      if (currentEpochOnly) {
        if (String(parsed?.run_id || "") !== RUN_ID) continue;
        if (Number(parsed?.telemetry_epoch ?? -1) !== _telemetryEpoch) continue;
      }
      let keep = false;
      try { keep = !!predicate(parsed); } catch { keep = false; }
      if (!keep) continue;
      out.push(parsed);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function writeRunArtifactPayload({
  work_item_id = null,
  job_id = null,
  attempt_id = null,
  artifact_type = "other",
  content_long = null,
  content_json = null,
} = {}) {
  const artifactDir = path.join(
    getRuntimeResourcesDir(),
    "artifacts",
    "_payloads",
    RUN_ID,
    work_item_id == null ? "global" : `wi-${work_item_id}`,
  );
  fs.mkdirSync(artifactDir, { recursive: true });

  const stamp = nowIso().replace(/[:.]/g, "-");
  const random = crypto.randomBytes(4).toString("hex");
  const filePath = path.join(artifactDir, `artifact-${stamp}-${random}.json`);
  const payload = {
    schema_version: 1,
    run_id: RUN_ID,
    created_at: nowIso(),
    work_item_id,
    job_id,
    attempt_id,
    artifact_type,
    content_long,
    content_json,
  };
  const text = `${safeStringify(payload)}\n`;
  fs.writeFileSync(filePath, text, "utf8");
  const byte_size = Buffer.byteLength(text, "utf8");
  const sha256 = crypto.createHash("sha256").update(text).digest("hex");
  appendRunTelemetry("artifacts", {
    created_at: payload.created_at,
    work_item_id,
    job_id,
    attempt_id,
    artifact_type,
    file_path: filePath,
    sha256,
    byte_size,
  });
  return { file_path: filePath, sha256, byte_size };
}

export function readRunArtifactPayload(filePath) {
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      content_long: parsed?.content_long ?? null,
      content_json: parsed?.content_json ?? null,
    };
  } catch {
    return null;
  }
}

export function __resetRunTelemetryForTests() {
  closeRunTelemetry({ cleanExit: false });
  _manifestDirs.clear();
}
