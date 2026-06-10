import fs from "fs";
import path from "path";
import { isMainThread, threadId } from "node:worker_threads";

import { getRuntimeLogDir } from "../../../domains/runtime/functions/paths.js";
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

export function appendPersistentTelemetry(stream, entry = {}) {
  try {
    const filePath = getPersistentTelemetryFile(stream);
    const dir = path.dirname(filePath);
    if (!_ensuredDirs.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      _ensuredDirs.add(dir);
    }
    rotatePersistentTelemetryFileIfNeeded(filePath);
    const line = `${safeStringify({
      t: entry?.created_at || entry?.t || nowIso(),
      run_id: getRunTelemetryId(),
      pid: process.pid,
      thread_id: threadId,
      is_main_thread: isMainThread,
      cwd: process.cwd(),
      ...entry,
    })}\n`;
    try {
      fs.appendFileSync(filePath, line, "utf8");
    } catch (err) {
      if (String(err?.code || "") !== "ENOENT") throw err;
      _ensuredDirs.delete(dir);
      fs.mkdirSync(dir, { recursive: true });
      _ensuredDirs.add(dir);
      fs.appendFileSync(filePath, line, "utf8");
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
