import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { EVENT_TYPES, AGENT_ACTIVITY_PROTOCOL } from "../../../catalog/event.js";
import { RUN_MONITOR_EVENTS } from "../../../catalog/run-monitor.js";
import { scrubSecretText } from "../../../shared/telemetry/functions/logging/scrub-secret-text.js";

const visibleEvents = new Set(RUN_MONITOR_EVENTS);
const trouble = /(?:^|[._])(error|failed|failure|blocked|deadlocked|timeout|exhausted|rejected|warning|conflict|rate_limited|circuit_open|stall|wedged|abandoned|retry|retried|recovery|escalation|exceeded|violation|lost)(?:$|[._])/;

export function monitorStatePath({ runDir, workItemId = null, name = "default", stateRoot = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state") }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)) {
    throw new Error("--state must be a job/observer name (1–80 letters, digits, dots, underscores or hyphens), not a file path");
  }
  const identity = crypto.createHash("sha256").update(`${runDir}:${workItemId || "all"}`).digest("hex").slice(0, 24);
  // Preserve the original automatic cursor location for the default observer.
  const filename = name === "default" ? identity : `${name}-${identity}`;
  return path.resolve(stateRoot, "posse", "run-monitor", `${filename}.json`);
}

export function monitorText(value, limit = 280) {
  if (value == null || typeof value === "object") return "";
  const text = scrubSecretText(String(value)).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x1f\x7f\s]+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function monitorObject(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || "{}") || {}; } catch { return {}; }
}

export function projectMonitorEntry(stream, row) {
  const type = row.event_type || row.kind || row.src || stream;
  const detail = monitorObject(row.event_json || row.d);
  let message = row.message || row.msg || row.reason || type;
  let level = row.level || "info";
  if (stream === "events") {
    if (type === EVENT_TYPES.AGENT_ACTIVITY) {
      if (detail.protocol !== AGENT_ACTIVITY_PROTOCOL || !["phase", "result", "error"].includes(detail.kind)) return null;
      message = detail.summary;
      if (detail.kind === "error" || detail.status === "failed") level = "error";
    } else if (!visibleEvents.has(type) && !trouble.test(type)
      && !(type === EVENT_TYPES.JOB_CREATED && String(message).startsWith("Created human_input job:"))) return null;
    if (trouble.test(type)) level = "warn";
  } else if (stream === "runtime") {
    if (!["warn", "error", "fatal"].includes(level)) return null;
  } else if (!["boot.start", "scheduler.shutdown"].includes(type) && !trouble.test(type) && !row.error) return null;
  // Deliberately project scalar decisions, never prompts, tool bodies, context or stacks.
  const decisions = {};
  for (const key of ["question_id", "interaction_id", "parent_id", "choice_id", "outcome", "safe_reason", "action", "verdict", "status", "reason", "error"]) {
    const value = monitorText(detail[key] ?? row[key], 160);
    if (value) decisions[key] = value;
  }
  return {
    time: row.created_at || row.t || null, source: stream, type: monitorText(type, 100), level,
    work_item_id: row.work_item_id ?? row.wi ?? null, job_id: row.job_id ?? row.job ?? null,
    message: monitorText(message), ...decisions,
  };
}

export function readMonitorGates(dbPath, workItems, startedAt) {
  if (!fs.existsSync(dbPath)) throw new Error(`Gate database missing: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    // Bind the run's work-item membership as one JSON parameter, even for large runs.
    return db.prepare(`SELECT hg.*, j.work_item_id, j.title, j.payload_json
      FROM human_gates hg JOIN jobs j ON j.id = hg.gate_job_id
      WHERE j.work_item_id IN (SELECT value FROM json_each(?))
        AND (hg.gate_state IN ('open', 'resolving') OR hg.updated_at >= ?)
      ORDER BY hg.updated_at, hg.gate_job_id`).all(JSON.stringify(workItems), startedAt || "").map((row) => {
      const payload = monitorObject(row.payload_json);
      const resolution = monitorObject(row.resolution_payload_json);
      return {
        source: "gates", type: "human_gate", time: row.updated_at,
        work_item_id: row.work_item_id, job_id: row.gate_job_id,
        generation: row.generation, state: row.gate_state,
        message: monitorText(payload.question || payload.prompt || row.title),
        action: monitorText(row.resolution_action || resolution.action, 100),
        answer: monitorText(resolution.answer || resolution.answer_text || resolution.choice_id || resolution.decision),
        resolved_by: monitorText(resolution.source, 100),
        ...(resolution.unattended != null ? { unattended: resolution.unattended === true } : {}),
        error: monitorText(row.resolution_error),
        choices: Array.isArray(monitorObject(row.allowed_actions_json))
          ? monitorObject(row.allowed_actions_json).slice(0, 12).map((choice) => monitorText(choice, 80)) : [],
      };
    });
  } finally { db.close(); }
}

export function selectMonitorRun(runsRoot, runId = null) {
  if (runId && (path.basename(runId) !== runId || runId === "." || runId === "..")) throw new Error("--run must be a run directory name");
  if (runId) return fs.realpathSync(path.join(runsRoot, runId));
  const candidates = fs.readdirSync(runsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
    try {
      const dir = path.join(runsRoot, entry.name);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
      // Other CLI invocations also write telemetry. Prefer scheduler lifecycles.
      return [{ dir, manifest }];
    } catch { return []; }
  });
  const schedulerRuns = candidates.filter(({ manifest }) => manifest.lifecycle_began_at || manifest.boot_owner_id);
  const selected = (schedulerRuns.length ? schedulerRuns : candidates)
    .sort((a, b) => String(b.manifest.started_at).localeCompare(String(a.manifest.started_at)))[0];
  if (!selected) throw new Error(`No run manifests found in ${runsRoot}`);
  return fs.realpathSync(selected.dir);
}

export function renderMonitorCheck(report) {
  const lines = [`Run ${report.run_id}: ${report.items.length ? `${report.items.length} new signals` : "no new signals"}${report.more ? "; backlog remains — check again" : ""}`];
  for (const item of report.items) {
    const scope = [item.work_item_id != null ? `WI#${item.work_item_id}` : "", item.job_id != null ? `job#${item.job_id}` : ""].filter(Boolean).join(" ");
    const details = Object.entries(item).filter(([key, value]) => !["time", "source", "type", "level", "work_item_id", "job_id", "message"].includes(key) && value !== "" && value != null && (!Array.isArray(value) || value.length))
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : value}`).join(" ");
    lines.push(`${monitorText(item.time, 30)} ${item.level || "info"} ${scope} ${item.type}: ${item.message}${details ? ` [${details}]` : ""}`.trim());
  }
  return `${lines.join("\n")}\n`;
}
