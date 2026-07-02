import fs from "fs";
import path from "path";
import { isMainThread, threadId } from "node:worker_threads";

import { getRuntimeLogDir, safeProcessCwd } from "../../../domains/runtime/functions/paths.js";
import { getRunTelemetryId } from "./run-telemetry.js";

const MAX_PERSISTENT_LOG_BYTES = 50 * 1024 * 1024;
const MAX_PERSISTENT_LOG_ROTATIONS = 2;
const _ensuredDirs = new Set();

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
  return `${String(stream || "persistent").replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl`;
}

function nowIso() {
  return new Date().toISOString();
}

export function getPersistentTelemetryDir() {
  return path.join(getRuntimeLogDir(), "persistent");
}

export function getPersistentTelemetryFile(stream) {
  return path.join(getPersistentTelemetryDir(), streamFileName(stream));
}

// Hot paths (embedding child request pairs, per-batch add events, gate
// events) emit thousands of entries per semantic-heavy session; a
// stat+append per entry put blocking fs calls on the reader lane and the
// main-loop fallback. Entries buffer per stream and flush as ONE sync write
// per window (or immediately at the line cap / via {flush:true} for rare
// forensic-critical events). readPersistentTelemetryEntries drains the
// stream's buffer first, so read-after-write semantics are preserved.
const FLUSH_AFTER_LINES = 64;
const FLUSH_AFTER_MS = 250;
/** @type {Map<string, string[]>} filePath -> pending lines */
const _pending = new Map();
/** @type {ReturnType<typeof setTimeout> | null} */
let _flushTimer = null;
let _exitHookInstalled = false;

function _writeLines(filePath, lines) {
  if (!lines.length) return;
  const dir = path.dirname(filePath);
  if (!_ensuredDirs.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    _ensuredDirs.add(dir);
  }
  rotatePersistentTelemetryFileIfNeeded(filePath);
  const chunk = lines.join("");
  try {
    fs.appendFileSync(filePath, chunk, "utf8");
  } catch (err) {
    if (String(err?.code || "") !== "ENOENT") throw err;
    _ensuredDirs.delete(dir);
    fs.mkdirSync(dir, { recursive: true });
    _ensuredDirs.add(dir);
    fs.appendFileSync(filePath, chunk, "utf8");
  }
}

function _flushFile(filePath) {
  const lines = _pending.get(filePath);
  if (!lines || lines.length === 0) return;
  _pending.delete(filePath);
  try { _writeLines(filePath, lines); } catch { /* telemetry is best effort */ }
}

export function flushPersistentTelemetry() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  for (const filePath of [..._pending.keys()]) _flushFile(filePath);
}

function _scheduleFlush() {
  if (!_exitHookInstalled) {
    _exitHookInstalled = true;
    // Sync flush is exit-safe; crashes lose at most the last window of
    // NON-critical entries (critical ones use {flush:true} write-through).
    process.on("exit", () => { try { flushPersistentTelemetry(); } catch { /* ignore */ } });
  }
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushPersistentTelemetry();
  }, FLUSH_AFTER_MS);
  _flushTimer.unref?.();
}

export function appendPersistentTelemetry(stream, entry = {}, { flush = false } = {}) {
  try {
    const filePath = getPersistentTelemetryFile(stream);
    const line = `${safeStringify({
      t: entry?.created_at || entry?.t || nowIso(),
      run_id: getRunTelemetryId(),
      pid: process.pid,
      thread_id: threadId,
      is_main_thread: isMainThread,
      cwd: safeProcessCwd(),
      ...entry,
    })}\n`;
    const pending = _pending.get(filePath) || [];
    pending.push(line);
    _pending.set(filePath, pending);
    if (flush || pending.length >= FLUSH_AFTER_LINES) {
      _flushFile(filePath);
    } else {
      _scheduleFlush();
    }
    return true;
  } catch {
    return false;
  }
}

function rotatePersistentTelemetryFileIfNeeded(filePath) {
  let size = 0;
  try { size = fs.statSync(filePath).size || 0; } catch { return; }
  if (size < MAX_PERSISTENT_LOG_BYTES) return;
  for (let i = MAX_PERSISTENT_LOG_ROTATIONS; i >= 1; i--) {
    const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
    const to = `${filePath}.${i}`;
    try {
      if (fs.existsSync(to)) fs.rmSync(to, { force: true });
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch {
      // Rotation is best effort; append should still proceed if possible.
    }
  }
}

export function readPersistentTelemetryEntries(stream, {
  limit = 100,
  order = "desc",
  predicate = () => true,
} = {}) {
  const filePath = getPersistentTelemetryFile(stream);
  // Read-after-write: drain this stream's buffered lines before reading.
  _flushFile(filePath);
  const max = limit == null ? Infinity : Math.max(0, Number(limit) || 0);
  if (max === 0) return [];
  let lines;
  try { lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/); }
  catch { return []; }

  const out = [];
  const start = order === "asc" ? 0 : lines.length - 1;
  const end = order === "asc" ? lines.length : -1;
  const step = order === "asc" ? 1 : -1;
  for (let i = start; i !== end; i += step) {
    const raw = String(lines[i] || "").trim();
    if (!raw) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    let keep = false;
    try { keep = !!predicate(parsed); } catch { keep = false; }
    if (!keep) continue;
    out.push(parsed);
    if (out.length >= max) break;
  }
  return out;
}
