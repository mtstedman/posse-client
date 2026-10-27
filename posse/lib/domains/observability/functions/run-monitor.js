import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { EVENT_TYPES, AGENT_ACTIVITY_PROTOCOL, AGENT_ACTIVITY_KINDS } from "../../../catalog/event.js";
import { RUN_MONITOR_EVENTS } from "../../../catalog/run-monitor.js";
import { scrubSecretText } from "../../../shared/telemetry/functions/logging/scrub-secret-text.js";

const visibleEvents = new Set(RUN_MONITOR_EVENTS);
const trouble = /(?:^|[._])(error|failed|failure|blocked|deadlocked|timeout|exhausted|rejected|warning|conflict|rate_limited|circuit_open|stall|wedged|abandoned|retry|retried|recovery|escalation|exceeded|violation|lost|missing)(?:$|[._])/;
const failure = /(?:^|[._])(error|failed|failure|deadlocked|timeout|exhausted|rejected|violation)(?:$|[._])/;

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
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return {}; }
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

function monitorDetail(row) {
  return monitorObject(row.event_json ?? row.d ?? row.detail ?? row.detail_json);
}

function monitorId(...values) {
  for (const value of values) {
    if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) continue;
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  return null;
}

// Use the same scope resolution before filtering and when displaying a row.
// Runtime writers nest IDs in d; events/diagnostics usually put them at top level.
export function monitorEntryScope(row, detail = monitorDetail(row)) {
  return {
    work_item_id: monitorId(row.work_item_id, row.wi, detail.work_item_id, detail.wi),
    job_id: monitorId(row.job_id, row.job, detail.job_id, detail.job),
    agent_call_id: monitorId(row.agent_call_id, detail.agent_call_id),
    parent_agent_call_id: monitorId(row.parent_agent_call_id, detail.parent_agent_call_id),
    attempt_id: monitorId(row.attempt_id, detail.attempt_id),
  };
}

export function projectMonitorEntry(stream, row) {
  const type = String(row.event_type || row.observation_type || row.kind || row.src || stream);
  const detail = monitorDetail(row);
  const error = detail.error ?? row.error;
  const status = detail.status ?? row.status;
  const outcome = detail.outcome ?? row.outcome;
  const failed = detail.ok === false || row.ok === false || [status, outcome].some((value) => ["failed", "rejected", "error"].includes(value));
  let message = row.message || row.msg || row.summary || row.reason || type;
  let level = ["info", "warn", "error", "fatal"].includes(row.level) ? row.level : "info";
  if (stream === "events") {
    if (type === EVENT_TYPES.AGENT_ACTIVITY) {
      if (detail.protocol !== AGENT_ACTIVITY_PROTOCOL || !AGENT_ACTIVITY_KINDS.includes(detail.kind)) return null;
      // A model lifecycle summary may contain the delegated prompt. Show its
      // identity/status instead; commentary is a separate, bounded progress kind.
      message = detail.kind === "model"
        ? `${monitorText(detail.role ?? row.role, 40) || "Agent"} model ${monitorText(status, 40) || "activity"}`
        : (detail.summary || message);
      if (detail.kind === "error" || failed) level = "error";
    } else if (!visibleEvents.has(type) && !trouble.test(type)
      && !(type === EVENT_TYPES.JOB_CREATED && String(message).startsWith("Created human_input job:"))) return null;
  } else if (stream === "runtime") {
    if (!["warn", "error", "fatal"].includes(level)) return null;
  } else if (stream === "observations") {
    if (!type.startsWith("tool.") || type.endsWith(".started") || detail.phase === "begin" || !failed) return null;
    // Tool summaries can embed command bodies. Keep the operation identity and
    // outcome; only the explicitly bounded error fields below are projected.
    message = `${monitorText(detail.catalog_name || detail.tool_name || type, 100)} ${monitorText(outcome || status, 40) || "failed"}`;
    if (detail.recovered_from_provider_rollout === true) message = `Recovered historical failure: ${message}`;
  } else if (!["boot.start", "scheduler.shutdown"].includes(type) && !trouble.test(type) && !error && !failed) return null;
  if (level !== "fatal" && (failure.test(type) || failed || error)) level = "error";
  else if (level === "info" && trouble.test(type)) level = "warn";
  // Deliberately project scalar decisions, never prompts, tool bodies, context or stacks.
  const decisions = {};
  for (const key of ["question_id", "interaction_id", "parent_id", "choice_id", "outcome", "safe_reason", "action", "verdict", "status", "reason", "rejection_reason", "role", "provider", "model", "model_name", "phase", "label", "binary", "code", "remote_code", "tool_name", "provider_call_id", "recovery_reason"]) {
    if (key === "phase" && type === EVENT_TYPES.AGENT_ACTIVITY && detail.kind === "model") continue;
    const value = monitorText(detail[key] ?? row[key], 160);
    if (value) decisions[key] = value;
  }
  const errorText = monitorText(typeof error === "object" ? error?.message : error, 160);
  if (errorText) decisions.error = errorText;
  if (!decisions.code && error && typeof error === "object") {
    const code = monitorText(error.code, 100);
    if (code) decisions.code = code;
  }
  for (const key of ["duration_ms", "stall_ms", "queue_wait_ms"]) {
    const value = detail[key] ?? row[key] ?? (key === "duration_ms" ? detail.durationMs ?? row.durationMs : undefined);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) decisions[key] = value;
  }
  if (detail.recovered_from_provider_rollout === true) decisions.recovered_from_provider_rollout = true;
  if (type === EVENT_TYPES.AGENT_ACTIVITY) decisions.activity_kind = detail.kind;
  return {
    time: row.created_at || row.t || null, source: stream, type: monitorText(type, 100), level,
    ...monitorEntryScope(row, detail),
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
