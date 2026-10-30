import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { RUN_MONITOR_STREAMS } from "../../../catalog/run-monitor.js";
import { monitorText, monitorEntryScope, openMonitorGateDb, projectMonitorEntry, queryMonitorGates } from "../functions/run-monitor.js";

const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const SCAN_BYTES = 8 * 1024 * 1024;

// Byte positions, not timestamps or global event IDs: multiple writers can
// append out of timestamp/ID order. An unfinished line remains unread.
function* newLines(file, cursor) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    const identity = `${stat.dev}:${stat.ino}`;
    if ((cursor.identity && cursor.identity !== identity) || stat.size < cursor.offset) {
      cursor.offset = 0;
      cursor.discarding = false;
      yield { warning: "Telemetry file replaced or truncated; reading from its beginning" };
    }
    cursor.identity = identity;
    const end = Math.min(stat.size, cursor.offset + SCAN_BYTES);
    let position = cursor.offset;
    let pending = Buffer.alloc(0);
    while (position < end) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - position));
      const count = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!count) break;
      position += count;
      pending = Buffer.concat([pending, buffer.subarray(0, count)]);
      let newline;
      while ((newline = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        cursor.offset = position - pending.length;
        if (cursor.discarding) { cursor.discarding = false; continue; }
        if (line.length > MAX_LINE_BYTES) yield { warning: "Oversized telemetry record skipped (>1 MiB)" };
        else if (line.length) {
          try { yield { row: JSON.parse(line.toString("utf8")) }; }
          catch { yield { warning: "Malformed telemetry record skipped" }; }
        }
      }
      if (pending.length > MAX_LINE_BYTES || cursor.discarding) {
        cursor.offset = position;
        pending = Buffer.alloc(0);
        if (!cursor.discarding) {
          cursor.discarding = true;
          yield { warning: "Oversized telemetry record skipped (>1 MiB)" };
        }
      }
    }
  } finally { fs.closeSync(fd); }
}

export class RunMonitor {
  constructor({ runDir, statePath, dbPath, workItemId = null, limit = 40, staleMs = 120000 }) {
    this.runDir = fs.realpathSync(runDir);
    this.statePath = statePath;
    this.dbPath = dbPath;
    this.workItemId = workItemId;
    this.limit = limit;
    this.staleMs = staleMs;
    this.gate = null;
    this.state = {
      version: 1, run_dir: this.runDir, work_item_id: workItemId,
      streams: {}, gates: {}, work_items: [], notices: {}, next_stream: 0,
    };
    if (fs.existsSync(statePath)) {
      const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (saved.version !== 1 || saved.run_dir !== this.runDir || saved.work_item_id !== workItemId
        || !saved.streams || !saved.gates || !Array.isArray(saved.work_items) || !saved.notices) {
        throw new Error("Cursor belongs to another run/filter or is invalid; use a new --state name");
      }
      for (const cursor of Object.values(saved.streams)) {
        if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error("Invalid byte cursor in state file");
      }
      this.state = saved;
    }
  }

  check(now = Date.now()) {
    const state = this.state;
    const items = [];
    let more = false;
    const notice = (key, message, level = "warn") => {
      if (state.notices[key] === message) return;
      if (items.length >= this.limit) { more = true; return; }
      state.notices[key] = message;
      items.push({ source: "monitor", type: key, level, message });
    };
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(this.runDir, "manifest.json"), "utf8")); }
    catch {
      // The writer replaces manifest contents in place. A reader can briefly
      // see an incomplete JSON document; retain every cursor and retry later.
      notice("manifest_read", "Run manifest unavailable or incomplete; retrying on next check");
      return { run_id: path.basename(this.runDir), run_dir: this.runDir, items, more: true };
    }
    if (state.notices.manifest_read) {
      notice("manifest_read", "Run manifest available", "info");
    }
    const heartbeat = Date.parse(manifest.last_heartbeat_at || manifest.lifecycle_began_at || manifest.started_at);
    if (manifest.ended_at) notice("run_status", `Run ended; clean_exit=${manifest.clean_exit === true}; exit_code=${manifest.exit_code ?? "unknown"}`, manifest.clean_exit ? "info" : "error");
    else if (manifest.scheduler_clean_shutdown_at) notice("run_status", `Scheduler stopped: ${monitorText(manifest.scheduler_shutdown_reason)}`, "info");
    else if (Number.isFinite(heartbeat) && now - heartbeat > this.staleMs) notice("run_status", "Heartbeat stale; run may be stalled or gone (not proof of failure)");
    else notice("run_status", "Run active", "info");

    const workItems = new Set(state.work_items);
    const streamLimit = this.limit - Math.max(1, Math.floor(this.limit / 4));
    const start = state.next_stream;
    for (let index = 0; index < RUN_MONITOR_STREAMS.length; index++) {
      const stream = RUN_MONITOR_STREAMS[(start + index) % RUN_MONITOR_STREAMS.length];
      const cursor = state.streams[stream] ||= { offset: 0, seen_exports: [] };
      const file = path.join(this.runDir, `${stream}.jsonl`);
      // Share the output budget across sources so a busy event stream cannot
      // hide runtime errors. The starting source rotates between checks.
      const budget = Math.max(1, Math.floor((streamLimit - items.length) / (RUN_MONITOR_STREAMS.length - index)));
      let emitted = 0;
      if (items.length < streamLimit) for (const entry of newLines(file, cursor)) {
        if (entry.warning) {
          items.push({ source: stream, type: "telemetry_read_warning", level: "warn", message: entry.warning });
          emitted++;
        } else if (entry.row && typeof entry.row === "object") {
          const row = entry.row;
          // Export retries can append the same DB event twice after a crash.
          // Bound the retry window rather than retaining every event forever.
          if (row.export_id && cursor.seen_exports.includes(row.export_id)) continue;
          if (row.export_id) cursor.seen_exports = [...cursor.seen_exports.slice(-2047), row.export_id];
          const wi = monitorEntryScope(row).work_item_id;
          if (wi != null && (this.workItemId == null || Number(wi) === this.workItemId)) workItems.add(Number(wi));
          if (this.workItemId != null && wi != null && Number(wi) !== this.workItemId) continue;
          const projected = projectMonitorEntry(stream, row);
          if (projected) { items.push(projected); emitted++; }
        }
        if (emitted >= budget || items.length >= streamLimit) break;
      }
      try { if (fs.statSync(file).size > cursor.offset) more = true; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    state.next_stream = (start + 1) % RUN_MONITOR_STREAMS.length;
    state.work_items = [...workItems];
    if (this.workItemId != null) workItems.add(this.workItemId);
    try {
      const gates = queryMonitorGates(this.gateDb(), [...workItems], manifest.started_at);
      if (state.notices.gate_source) notice("gate_source", "Gate database available", "info");
      for (const gate of gates) {
        const { time: _time, ...meaning } = gate;
        const fingerprint = crypto.createHash("sha256").update(JSON.stringify(meaning)).digest("hex");
        if (state.gates[gate.job_id] === fingerprint) continue;
        if (items.length >= this.limit) { more = true; break; }
        items.push(gate);
        state.gates[gate.job_id] = fingerprint;
      }
    } catch (error) {
      // Drop the handle so the next check reopens once the database is back.
      this.dispose();
      notice("gate_source", `Gate state unavailable: ${monitorText(error.message)}`);
    }
    return { run_id: manifest.run_id || path.basename(this.runDir), run_dir: this.runDir, items, more };
  }

  // One read-only gate handle for the monitor's lifetime, opened lazily so a
  // missing database stays a per-check notice. A replaced database file (new
  // inode) is reopened rather than read through the stale handle.
  gateDb() {
    if (this.gate) {
      let stat = null;
      try { stat = fs.statSync(this.dbPath); } catch { /* fall through to reopen */ }
      if (stat && `${stat.dev}:${stat.ino}` === this.gate.identity) return this.gate.db;
      this.dispose();
    }
    this.gate = openMonitorGateDb(this.dbPath);
    return this.gate.db;
  }

  dispose() {
    const gate = this.gate;
    this.gate = null;
    if (gate) try { gate.db.close(); } catch { /* already closed */ }
  }

  save() {
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, this.statePath);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* rename consumed it */ }
    }
  }
}
