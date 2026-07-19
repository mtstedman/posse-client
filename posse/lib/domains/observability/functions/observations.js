import { AsyncLocalStorage } from "async_hooks";
import fs from "fs";
import path from "path";
import { assertTestContext } from "../../runtime/functions/test-context.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { TOOL_CATALOG, TOOL_OBSERVATION_ALIASES } from "../../integrations/functions/deterministic-mcp/tool-descriptors.js";
import { isPosseMcpGatewaySurfaceName, stripPosseMcpGatewayPrefix } from "../../integrations/functions/mcp-gateway.js";
import { redactBridgeValue, redactString } from "../../bridge/functions/redaction.js";
import { canonicalAtlasToolUseActionName, formatAtlasToolDisplayName } from "../../../shared/tools/functions/mcp-surface.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import { getRuntimeLogDir } from "../../runtime/functions/paths.js";
import { markTelemetryRowsMirrored, pruneTelemetryTableToTail } from "../../../shared/telemetry/functions/db-tail.js";
import { appendRunTelemetry, getRunTelemetryStartedAt, readRunTelemetryEntries } from "../../../shared/telemetry/functions/run-telemetry.js";

let _fd = null;
let _currentDate = "";
let _streamDisabledUntilMs = 0;
let _streamLastFailure = null;
const OBSERVATION_STREAM_RETRY_MS = 30_000;
const defaultStreamWriter = (fd, line) => fs.writeSync(fd, line);
let _streamWriter = defaultStreamWriter;
const _observationContextStorage = new AsyncLocalStorage();
const TOOL_REPLAY_DEDUPE_WINDOW_MS = 1500;
const TOOL_REPLAY_BUCKET_MAX = 256;
const TOOL_REPLAY_MAX_BUCKETS = 512;
const _recentToolReplay = new Map(); // jobId -> Map<fingerprint, atMs>

function _trimToolReplayBucket(bucket, now) {
  if (!bucket) return;
  const ttlMs = TOOL_REPLAY_DEDUPE_WINDOW_MS * 4;
  for (const [fingerprint, atMs] of bucket) {
    if ((now - Number(atMs || 0)) > ttlMs) bucket.delete(fingerprint);
  }
  while (bucket.size > TOOL_REPLAY_BUCKET_MAX) {
    const oldest = bucket.keys().next().value;
    if (oldest == null) break;
    bucket.delete(oldest);
  }
}

function _pruneToolReplayBuckets(now, activeBucketKey = null) {
  if (TOOL_REPLAY_DEDUPE_WINDOW_MS <= 0) {
    _recentToolReplay.clear();
    return;
  }
  for (const [bucketKey, bucket] of _recentToolReplay) {
    _trimToolReplayBucket(bucket, now);
    if (bucket.size === 0 && bucketKey !== activeBucketKey) {
      _recentToolReplay.delete(bucketKey);
    }
  }
  if (_recentToolReplay.size <= TOOL_REPLAY_MAX_BUCKETS) return;
  for (const bucketKey of _recentToolReplay.keys()) {
    if (_recentToolReplay.size <= TOOL_REPLAY_MAX_BUCKETS) break;
    if (bucketKey === activeBucketKey) continue;
    _recentToolReplay.delete(bucketKey);
  }
}

function _rememberToolReplayFingerprint(bucketKey, fingerprint, now = Date.now()) {
  if (TOOL_REPLAY_DEDUPE_WINDOW_MS <= 0) return true;
  let replayBucket = _recentToolReplay.get(bucketKey);
  if (!replayBucket) {
    replayBucket = new Map();
  } else {
    _recentToolReplay.delete(bucketKey);
  }
  _recentToolReplay.set(bucketKey, replayBucket);
  const lastAt = Number(replayBucket.get(fingerprint) || 0);
  if (lastAt > 0 && (now - lastAt) <= TOOL_REPLAY_DEDUPE_WINDOW_MS) {
    _pruneToolReplayBuckets(now, bucketKey);
    return false;
  }
  replayBucket.set(fingerprint, now);
  _pruneToolReplayBuckets(now, bucketKey);
  return true;
}

function normalizeJsonText(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeObservationRow(row) {
  if (!row) return null;
  const id = Number(row.id || 0);
  return {
    id: Number.isFinite(id) && id > 0 ? id : null,
    work_item_id: row.work_item_id ?? row.wi ?? null,
    job_id: row.job_id ?? row.job ?? null,
    attempt_id: row.attempt_id ?? row.attempt ?? null,
    observation_type: row.observation_type ?? row.type ?? null,
    summary: row.summary ?? null,
    detail_json: row.detail_json ?? null,
    created_at: row.created_at || row.t || null,
  };
}

function observationSortValue(row) {
  if (row?.id != null) return Number(row.id);
  return Date.parse(row?.created_at || "") || 0;
}

function observationKey(row) {
  if (row?.id != null) return `id:${row.id}`;
  return [
    row?.created_at || "",
    row?.work_item_id ?? "",
    row?.job_id ?? "",
    row?.attempt_id ?? "",
    row?.observation_type || "",
    row?.summary || "",
  ].join("|");
}

function mergeObservationRows(rows, order = "desc", limit = 100) {
  const deduped = new Map();
  for (const raw of rows || []) {
    const row = normalizeObservationRow(raw);
    if (!row?.observation_type) continue;
    deduped.set(observationKey(row), row);
  }
  const sorted = [...deduped.values()].sort((a, b) => {
    const delta = observationSortValue(a) - observationSortValue(b);
    return order === "asc" ? delta : -delta;
  });
  const max = limit == null ? sorted.length : Math.max(0, Number(limit) || 0);
  return sorted.slice(0, max);
}

function matchesNumber(value, expected) {
  if (expected == null) return true;
  return Number(value) === Number(expected);
}

function readObservationFileRows({
  jobId = null,
  workItemId = null,
  typePrefix = null,
  excludeTypeSuffix = null,
  limit = 100,
  order = "desc",
} = {}) {
  return readRunTelemetryEntries("observations", {
    limit,
    order,
    predicate: (entry) => {
      const type = String(entry.observation_type ?? entry.type ?? "");
      if (!matchesNumber(entry.job_id ?? entry.job, jobId)) return false;
      if (!matchesNumber(entry.work_item_id ?? entry.wi, workItemId)) return false;
      if (typePrefix && !type.startsWith(typePrefix)) return false;
      if (excludeTypeSuffix
        && [].concat(excludeTypeSuffix).some((suffix) => suffix && type.endsWith(suffix))) {
        return false;
      }
      return true;
    },
  }).map(normalizeObservationRow).filter(Boolean);
}

// Harness-origin ATLAS work is recorded with the agent's job_id so operator
// analytics can join it to the run — but it is NOT an agent tool invocation.
// Keep it out of the agent-facing tool feed and per-job tool counts:
//   .prefetch      — handoff/prefetch warms (tool.atlas.prefetch)
//   .autofeedback  — finalizer-driven auto-feedback (tool.atlas.autofeedback)
// (The admin ATLAS report still queries job_observations directly by these
// types, so analytics are intact.)
const HARNESS_SYSTEM_TYPE_SUFFIXES = Object.freeze([".prefetch", ".autofeedback"]);
// Recent tool invocations are the agent-facing tool lane. Harness/system ATLAS
// rows stay queryable through the admin ATLAS report, but they should not read
// like agent tool calls in the live/recent feed.
const DISPLAY_TOOL_EXCLUDE_SUFFIXES = HARNESS_SYSTEM_TYPE_SUFFIXES;
const TOOL_OUTCOMES = new Set(["succeeded", "rejected", "failed"]);

function normalizedToolOutcome(value, { ok = null, status = "", error = "" } = {}) {
  const explicit = String(value || "").trim().toLowerCase();
  if (TOOL_OUTCOMES.has(explicit)) return explicit;
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (["succeeded", "success", "completed"].includes(normalizedStatus)) return "succeeded";
  if (["rejected", "denied", "cancelled", "canceled"].includes(normalizedStatus)) return "rejected";
  if (["failed", "error"].includes(normalizedStatus) || error) return "failed";
  if (ok === true) return "succeeded";
  if (ok === false) return "failed";
  return null;
}

function _rowDetailObject(row) {
  if (row && row.detail && typeof row.detail === "object") return row.detail;
  const json = row?.detail_json;
  if (typeof json === "string" && json) {
    try { return JSON.parse(json); } catch { return null; }
  }
  return null;
}

// Collapse the start/finish invocation pair (two append-only rows correlated by
// `inv` in detail) into one display row. A "<type>.started" row whose `inv` also
// has a finish row is dropped (the finish wins, carrying the measured duration);
// a started row with no finish yet is kept and surfaced as in-flight, with its
// type normalized back to the base "<type>" so it reads as the running tool.
// Rows with no `inv` (uninstrumented tools, atlas, etc.) pass straight through.
function _collapseToolInvocationRows(rows) {
  const finishedInv = new Set();
  for (const row of rows) {
    const type = String(row?.observation_type || "");
    if (type.endsWith(".started")) continue;
    const inv = _rowDetailObject(row)?.inv;
    if (inv) finishedInv.add(String(inv));
  }
  const out = [];
  for (const row of rows) {
    const type = String(row?.observation_type || "");
    const detail = _rowDetailObject(row);
    const inv = detail?.inv != null ? String(detail.inv) : null;
    if (type.endsWith(".started")) {
      if (inv && finishedInv.has(inv)) continue; // finish row supersedes it
      out.push({ ...row, observation_type: type.slice(0, -".started".length), _inFlight: true, _durationMs: null, _ok: null });
    } else {
      const outcome = normalizedToolOutcome(detail?.outcome, {
        ok: typeof detail?.ok === "boolean" ? detail.ok : null,
        status: detail?.status,
        error: detail?.error,
      });
      out.push({
        ...row,
        _inFlight: false,
        _durationMs: Number.isFinite(detail?.duration_ms) ? detail.duration_ms : null,
        // finishToolInvocation persists the real outcome in detail.ok; surface it
        // so consumers don't have to sniff the summary text for "failed". Absent
        // (null) means the row never recorded an outcome (legacy/replay row).
        _ok: typeof detail?.ok === "boolean" ? detail.ok : null,
        _outcome: outcome,
        _error: typeof detail?.error === "string" ? detail.error : null,
        _rejectionReason: typeof detail?.rejection_reason === "string"
          ? detail.rejection_reason
          : null,
      });
    }
  }
  return out;
}

function enrichToolInvocationRows(db, rows, { includeUnscoped = true } = {}) {
  const jobStmt = db.prepare(`SELECT job_type, provider, status, work_item_id FROM jobs WHERE id = ?`);
  const workItemStmt = db.prepare(`SELECT id FROM work_items WHERE id = ?`);
  const enriched = [];
  for (const row of rows) {
    const job = row.job_id == null ? null : jobStmt.get(row.job_id);
    const resolvedWorkItemId = row.work_item_id ?? job?.work_item_id ?? null;
    const hasLiveJob = row.job_id != null && !!job;
    const hasLiveWorkItem = resolvedWorkItemId != null && !!workItemStmt.get(resolvedWorkItemId);
    if (!includeUnscoped && !hasLiveJob && !hasLiveWorkItem) continue;
    enriched.push({
      job_id: row.job_id,
      work_item_id: resolvedWorkItemId,
      observation_type: row.observation_type,
      summary: row.summary,
      created_at: row.created_at,
      job_type: job?.job_type ?? null,
      provider: job?.provider ?? null,
      status: job?.status ?? null,
      in_flight: !!row._inFlight,
      duration_ms: row._durationMs ?? null,
      ok: typeof row._ok === "boolean" ? row._ok : null,
      outcome: row._outcome ?? null,
      error: row._error ?? null,
      rejection_reason: row._rejectionReason ?? null,
    });
  }
  return enriched;
}

function _closeStream() {
  if (_fd == null) return;
  try { fs.closeSync(_fd); } catch { /* ignore */ }
  _fd = null;
  _currentDate = "";
}

function _noteStreamFailure(err, phase) {
  _closeStream();
  const nowMs = Date.now();
  _streamDisabledUntilMs = nowMs + OBSERVATION_STREAM_RETRY_MS;
  _streamLastFailure = {
    phase,
    at: new Date(nowMs).toISOString(),
    message: String(err?.message || err || "unknown observation stream failure"),
    code: err?.code || null,
    retry_at: new Date(_streamDisabledUntilMs).toISOString(),
  };
  log.warn("observability", "Observation file log temporarily disabled", {
    phase,
    error: _streamLastFailure.message,
    code: _streamLastFailure.code,
    retryMs: OBSERVATION_STREAM_RETRY_MS,
  });
}

function _ensureStream() {
  if (_streamDisabledUntilMs > 0 && Date.now() < _streamDisabledUntilMs) {
    return false;
  }
  const logDir = getRuntimeLogDir();
  const today = new Date().toISOString().slice(0, 10);
  if (_fd != null && _currentDate === today) return true;
  _closeStream();
  try {
    fs.mkdirSync(logDir, { recursive: true });
    _fd = fs.openSync(path.join(logDir, `observations-${today}.log`), "a");
    _currentDate = today;
    _streamDisabledUntilMs = 0;
    _streamLastFailure = null;
    return true;
  } catch (err) {
    _noteStreamFailure(err, "open");
    return false;
  }
}

function _writeStreamEntry(entry, phase = "write") {
  if (!_ensureStream()) return false;
  try {
    _streamWriter(_fd, JSON.stringify(entry) + "\n");
    return true;
  } catch (err) {
    _noteStreamFailure(err, phase);
    return false;
  }
}

function _isForeignKeyConstraintError(err) {
  return /FOREIGN KEY constraint failed/i.test(String(err?.message || err || ""));
}

function _nullableIntegerId(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function _insertObservationRow(db, {
  work_item_id,
  job_id,
  attempt_id,
  observation_type,
  summary,
  detailJson,
  createdAt,
}) {
  return db.prepare(`
    INSERT INTO job_observations (work_item_id, job_id, attempt_id, observation_type, summary, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(work_item_id, job_id, attempt_id, observation_type, summary, detailJson, createdAt);
}

function _resolveObservationScopeForInsert(db, {
  work_item_id = null,
  job_id = null,
  attempt_id = null,
} = {}) {
  let workItemId = _nullableIntegerId(work_item_id);
  let jobId = _nullableIntegerId(job_id);
  let attemptId = _nullableIntegerId(attempt_id);

  if (attemptId != null) {
    const attemptRow = db.prepare(`SELECT id, job_id FROM job_attempts WHERE id = ?`).get(attemptId);
    if (!attemptRow) {
      attemptId = null;
    } else if (jobId == null) {
      jobId = Number(attemptRow.job_id);
    } else if (Number(attemptRow.job_id) !== jobId) {
      attemptId = null;
    }
  }

  if (jobId != null) {
    const jobRow = db.prepare(`SELECT id, work_item_id FROM jobs WHERE id = ?`).get(jobId);
    if (!jobRow) {
      jobId = null;
      attemptId = null;
    } else if (workItemId == null) {
      workItemId = Number(jobRow.work_item_id);
    } else if (Number(jobRow.work_item_id) !== workItemId) {
      workItemId = Number(jobRow.work_item_id);
    }
  }

  if (workItemId != null) {
    const wiRow = db.prepare(`SELECT id FROM work_items WHERE id = ?`).get(workItemId);
    if (!wiRow) workItemId = null;
  }

  return {
    work_item_id: workItemId,
    job_id: jobId,
    attempt_id: attemptId,
  };
}

export function recordObservation({
  work_item_id = null,
  job_id = null,
  attempt_id = null,
  observation_type,
  summary,
  detail = null,
} = {}) {
  if (!observation_type || !summary) return false;

  try {
    const db = getDb();
    const detailJson = normalizeJsonText(detail);
    const createdAt = nowIso();
    let scope = { work_item_id, job_id, attempt_id };

    let info;
    try {
      info = _insertObservationRow(db, { ...scope, observation_type, summary, detailJson, createdAt });
    } catch (err) {
      if (!_isForeignKeyConstraintError(err)) throw err;
      scope = _resolveObservationScopeForInsert(db, scope);
      info = _insertObservationRow(db, { ...scope, observation_type, summary, detailJson, createdAt });
    }

    const row = {
      id: Number(info.lastInsertRowid),
      work_item_id: scope.work_item_id,
      job_id: scope.job_id,
      attempt_id: scope.attempt_id,
      observation_type,
      summary,
      detail_json: detailJson,
      created_at: createdAt,
    };

    const mirrored = appendRunTelemetry("observations", {
      ...row,
      detail,
    });

    _writeStreamEntry({
      id: row.id,
      t: createdAt,
      wi: row.work_item_id,
      job: row.job_id,
      attempt: row.attempt_id,
      type: observation_type,
      summary,
      detail,
      detail_json: detailJson,
    });
    if (mirrored) {
      markTelemetryRowsMirrored("job_observations", [row.id]);
      try { pruneTelemetryTableToTail(db, "job_observations"); } catch { /* best effort */ }
    }
    return true;
  } catch (err) {
    appendRunTelemetry("observations", {
      created_at: nowIso(),
      work_item_id,
      job_id,
      attempt_id,
      observation_type: "observation.record_failed",
      summary: `Failed to record observation: ${String(err?.message || err).slice(0, 160)}`,
      original_type: observation_type,
    });
    _writeStreamEntry({
      t: nowIso(),
      wi: work_item_id,
      job: job_id,
      attempt: attempt_id,
      type: "observation.record_failed",
      summary: `Failed to record observation: ${String(err?.message || err).slice(0, 160)}`,
      original_type: observation_type,
    }, "record_failed");
    return false;
  }
}

export function runWithObservationContext(context = {}, fn) {
  return _observationContextStorage.run({
    work_item_id: context.work_item_id ?? null,
    job_id: context.job_id ?? null,
    attempt_id: context.attempt_id ?? null,
    role: context.role ?? null,
  }, fn);
}

/** Set observation context for all subsequent calls in the current async scope (no callback needed). */
export function enterObservationContext(context = {}) {
  _observationContextStorage.enterWith({
    work_item_id: context.work_item_id ?? null,
    job_id: context.job_id ?? null,
    attempt_id: context.attempt_id ?? null,
    role: context.role ?? null,
  });
}

export function getObservationContext() {
  return _observationContextStorage.getStore() || null;
}

function _truncate(value, max = 120) {
  const text = redactString(String(value || "")).trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function _normalizePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function _normalizePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function _normalizeCatalogToolName(toolName = "") {
  const lower = String(toolName || "").trim().toLowerCase();
  let name = stripPosseMcpGatewayPrefix(lower);
  return TOOL_OBSERVATION_ALIASES[name] || name;
}

const CATALOG_DETERMINISTIC_TOOL_NAMES = new Set(
  Object.values(TOOL_CATALOG)
    .filter((entry) => entry?.schema && entry.gateTier !== "atlas")
    .map((entry) => entry.name)
);

function _firstInputValue(input = {}, keys = []) {
  for (const key of keys || []) {
    const value = input?.[key];
    if (value == null) continue;
    if (Array.isArray(value)) {
      const first = value.find((entry) => entry != null && String(entry).trim() !== "");
      if (first != null) return String(first);
      continue;
    }
    if (String(value).trim() !== "") return String(value);
  }
  return "";
}

function _normalizedWebToolKind(toolName = "") {
  const normalized = String(toolName || "")
    .trim()
    .toLowerCase()
    .replace(/^tools[._-]/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (["webfetch", "web_fetch", "web_fetch_call"].includes(normalized)) return "fetch";
  if (["websearch", "web_search", "web_search_call", "web_search_preview"].includes(normalized)) return "search";
  return null;
}

export function isWebToolName(toolName = "") {
  return !!_normalizedWebToolKind(toolName);
}

function _pathTarget(input = {}, spec = {}) {
  const direct = _firstInputValue(input, spec.pathKeys || []);
  if (direct) return direct;
  for (const key of spec.arrayPathKeys || []) {
    const values = Array.isArray(input?.[key]) ? input[key].filter(Boolean) : [];
    if (values.length === 0) continue;
    return values.length === 1 ? String(values[0]) : `${values[0]} +${values.length - 1}`;
  }
  return "";
}

function _catalogDetail({ spec, cwdNorm, tool, catalogName, extra = {} }) {
  return {
    cwd: cwdNorm || null,
    tool_name: tool,
    catalog_name: catalogName,
    kind: spec.kind || "deterministic",
    ...extra,
  };
}

function _summarizeCatalogToolUse(tool, input = {}, cwdNorm = null, rel = (value) => _normalizePath(value)) {
  const catalogName = _normalizeCatalogToolName(tool);
  const entry = TOOL_CATALOG[catalogName];
  if (!entry || entry.gateTier === "atlas") return null;
  const spec = entry.observation;
  if (!spec) throw new Error(`Missing observation spec for deterministic tool ${catalogName}`);

  if (spec.format === "command") {
    const command = _truncate(input[spec.commandKey || "command"] || "", 140);
    if (!command) return null;
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${command}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { command: input[spec.commandKey || "command"] || "" } }),
    };
  }

  if (spec.format === "file") {
    const rawPath = _pathTarget(input, spec);
    const filePath = rel(rawPath);
    if (!filePath && spec.requireTarget) return null;
    const offset = spec.includeRange ? _normalizePositiveInt(input.offset, 1) : null;
    const limit = spec.includeRange ? _normalizePositiveInt(input.limit, 2000) : null;
    const rangeHint = spec.includeRange && (offset !== 1 || limit !== 2000) ? ` [${offset}+${limit}]` : "";
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(filePath || ".", 140)}${rangeHint}`,
      detail: _catalogDetail({
        spec,
        input,
        cwdNorm,
        tool,
        catalogName,
        extra: {
          path: _normalizePath(rawPath),
          ...(spec.includeRange ? { offset, limit } : {}),
          ...(spec.pair ? { pair: spec.pair } : {}),
        },
      }),
    };
  }

  if (spec.format === "edit") {
    const rawPath = _pathTarget(input, spec);
    const filePath = rel(rawPath);
    if (!filePath && spec.requireTarget) return null;
    const changed = _truncate(input.old_string || "", 60);
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(filePath || ".", 140)}${changed ? ` (${changed})` : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { path: _normalizePath(rawPath) } }),
    };
  }

  if (spec.format === "list") {
    const target = rel(_firstInputValue(input, spec.targetKeys || []));
    const pattern = _truncate(input.pattern || "", 80);
    if (!target) return null;
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(target, 100)}${pattern ? ` (${pattern})` : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { path: _normalizePath(input.path || input.directory || ""), pattern: input.pattern || null } }),
    };
  }

  if (spec.format === "search") {
    const target = rel(_firstInputValue(input, spec.targetKeys || []));
    const pattern = _truncate(input.pattern || "", 60);
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(target || ".", 100)}${pattern ? ` (${pattern})` : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { path: _normalizePath(input.path || input.directory || input.file_path || ""), pattern: input.pattern || null } }),
    };
  }

  if (spec.format === "resize_image") {
    const rawPath = _pathTarget(input, spec);
    const filePath = rel(rawPath);
    const width = Number.isFinite(Number(input.width)) ? Number(input.width) : null;
    const height = Number.isFinite(Number(input.height)) ? Number(input.height) : null;
    const dims = width && height ? `${width}x${height}` : width ? `${width}w` : height ? `${height}h` : "";
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(filePath || ".", 120)}${dims ? ` -> ${dims}` : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { path: _normalizePath(rawPath), output_path: _normalizePath(input.output_path || ""), width, height } }),
    };
  }

  if (spec.format === "generate_image") {
    const rawPath = _pathTarget(input, spec);
    const filePath = rel(rawPath);
    const size = _truncate(input.size || "", 20);
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(filePath || ".", 120)}${size ? ` (${size})` : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { path: _normalizePath(rawPath), size: input.size || null, quality: input.quality || null } }),
    };
  }

  if (spec.format === "artifact_output") {
    const root = input[spec.rootKey || "output_root"] || ".";
    const rootPath = rel(root);
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(rootPath || ".", 120)}${spec.includeDryRun && input.dry_run === true ? " (dry-run)" : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { output_root: _normalizePath(root), task_mode: input.task_mode || "image", ...(spec.includeDryRun ? { dry_run: input.dry_run === true } : {}) } }),
    };
  }

  if (spec.format === "move_copy") {
    const srcRaw = input[spec.sourceKey || "source"] || "";
    const dstRaw = input[spec.destinationKey || "destination"] || "";
    const src = rel(srcRaw);
    const dst = rel(dstRaw);
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(src, 60)} -> ${_truncate(dst, 60)}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { source: _normalizePath(srcRaw), destination: _normalizePath(dstRaw) } }),
    };
  }

  if (spec.format === "chain_verdict") {
    const rawPath = _pathTarget(input, spec);
    const filePath = rel(rawPath);
    const verdict = _truncate(input.verdict || "", 20);
    const summary = _truncate(input.summary || "", 80);
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(filePath, 80)} -> ${verdict}${summary ? ` (${summary})` : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { path: _normalizePath(rawPath), verdict: input.verdict || null, summary: input.summary || null, pair: spec.pair || null } }),
    };
  }

  if (spec.format === "reencode_image") {
    const rawPath = _pathTarget(input, spec);
    const filePath = rel(rawPath);
    const outputPath = rel(input.output_path || "");
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(filePath, 120)}${outputPath ? ` -> ${_truncate(outputPath, 80)}` : ""}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { path: _normalizePath(rawPath), output_path: _normalizePath(input.output_path || ""), output_format: input.output_format || "png" } }),
    };
  }

  if (spec.format === "generic") {
    const target = _firstInputValue(input, spec.targetKeys || []);
    return {
      observation_type: spec.type,
      summary: `${spec.label}: ${_truncate(target || ".", 140)}`,
      detail: _catalogDetail({ spec, input, cwdNorm, tool, catalogName, extra: { input: _summarizeAtlasArgs(input) } }),
    };
  }

  throw new Error(`Unknown observation format "${spec.format}" for deterministic tool ${catalogName}`);
}

function _resolveAtlasAction(toolName = "", input = {}) {
  return canonicalAtlasToolUseActionName(toolName, input);
}

function _isPosseGatewayMcpTool(toolName = "") {
  return isPosseMcpGatewaySurfaceName(toolName);
}

function _summarizeAtlasArgs(input = {}) {
  if (!input || typeof input !== "object") return {};
  const redactedInput = redactBridgeValue(input);
  const out = {};
  const keys = Object.keys(redactedInput || {}).slice(0, 8);
  for (const key of keys) {
    const value = redactedInput[key];
    if (value == null) out[key] = null;
    else if (typeof value === "string") out[key] = _truncate(value, 160);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 8).map((item) => _truncate(item, 80));
    else if (typeof value === "object") out[key] = "[object]";
    else out[key] = _truncate(value, 80);
  }
  return out;
}

// Per-action hint extractor. The raw args include a lot of metadata; we want
// the log to show whatever best identifies *what ATLAS is working on* for that
// action — e.g. the symbol being searched, the file being skeletonized, the
// identifiers being located. Falling back to taskText is a last resort
// because for slice.build / context the taskText is usually the job's
// own title, which operators already see in the log prefix.
export function atlasSummaryHint(input = {}, action = null) {
  if (!input || typeof input !== "object") return "";
  const args = input;
  const a = String(action || "").toLowerCase().replace(/^atlas\./, "");

  const firstArrayEntry = (arr, max = 2) => {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const head = arr.slice(0, max).map((v) => String(v).trim()).filter(Boolean).join(", ");
    const tail = arr.length > max ? ` +${arr.length - max}` : "";
    return head ? `${head}${tail}` : null;
  };

  if (a === "symbol.search") {
    const q = args.query || args.pattern;
    if (q) return _truncate(q, 80);
  }

  if (a === "symbol.card") {
    const ids = Array.isArray(args.symbolIds) ? args.symbolIds
      : (args.symbolId ? [args.symbolId] : []);
    if (ids.length > 0) {
      const tail = ids.length > 1 ? ` +${ids.length - 1}` : "";
      return `${String(ids[0]).slice(0, 12)}${tail}`;
    }
    const refs = Array.isArray(args.symbolRefs) ? args.symbolRefs
      : (args.symbolRef ? [args.symbolRef] : []);
    if (refs.length > 0) {
      const first = refs[0] || {};
      const label = first.name || first.file || first.symbolId || "";
      const tail = refs.length > 1 ? ` +${refs.length - 1}` : "";
      return label ? `${_truncate(label, 60)}${tail}` : "";
    }
  }

  if (a === "slice.build" || a === "slice.refresh") {
    const entries = firstArrayEntry(args.entrySymbols);
    if (entries) return `entries: ${_truncate(entries, 60)}`;
    const files = firstArrayEntry(args.editedFiles, 1);
    if (files) return `files: ${_truncate(files, 60)}`;
    if (args.failingTestPath) return `failing: ${_truncate(args.failingTestPath, 60)}`;
    if (args.sliceHandle) return `handle: ${_truncate(args.sliceHandle, 40)}`;
    // Deliberately DON'T fall back to taskText here: for slice.build the
    // taskText is almost always the job's own title, which the operator
    // already sees in the log prefix — echoing it back is noise. If nothing
    // targeted was provided, the summary just shows the bare action name.
    return "";
  }

  if (a === "tree.scope" || a === "tree.expand") {
    // Seeds are the load-bearing input — show them, not the task text, so a
    // seeded scope never reads like a raw text search in the invocation log.
    const seeds = firstArrayEntry(args.paths && args.paths.length ? args.paths : args.editedFiles, 1);
    if (seeds) return `seeds: ${_truncate(seeds, 60)}`;
    const symbols = firstArrayEntry(args.symbolIds, 1);
    if (symbols) return `seeds: ${_truncate(symbols, 24)}`;
    if (args.taskText) return "task-text only (no seeds)";
    return "";
  }

  if (a === "tree.branch") {
    const focus = args.path || args.nodeId || (args.symbolId ? `sym:${String(args.symbolId).slice(0, 8)}` : null);
    if (focus) return _truncate(String(focus), 80);
  }

  if (a === "code.skeleton" || a === "code.lens" || a === "code.window") {
    const loc = args.file || (args.symbolId ? `sym:${String(args.symbolId).slice(0, 8)}` : null);
    const ids = firstArrayEntry(args.identifiersToFind, 3);
    const parts = [loc, ids].filter(Boolean);
    if (parts.length > 0) return _truncate(parts.join(" → "), 80);
  }

  if (a === "context" || a === "agent.context") {
    if (args.taskText) return _truncate(String(args.taskText).split(/\r?\n/)[0], 80);
  }

  if (a === "file.read") {
    const parts = [];
    if (args.filePath) parts.push(args.filePath);
    if (args.search) parts.push(`search='${_truncate(args.search, 40)}'`);
    if (parts.length > 0) return _truncate(parts.join(" "), 80);
  }

  if (a === "review.delta" || a === "review.analyze") {
    if (args.fromVersion && args.toVersion) return `${args.fromVersion}->${args.toVersion}`;
    if (args.versionId) return _truncate(args.versionId, 40);
  }

  if (a === "repo.status" || a === "repo.overview") {
    if (args.repoId) return _truncate(args.repoId, 80);
  }

  if (a === "memory.store") {
    if (args.title) return _truncate(String(args.title), 80);
    const anchors = firstArrayEntry(args.fileRelPaths, 1)
      || (Array.isArray(args.symbolIds) && args.symbolIds.length
        ? `${args.symbolIds.length} symbol${args.symbolIds.length === 1 ? "" : "s"}`
        : null);
    if (anchors) return _truncate(anchors, 80);
  }

  if (a === "memory.feedback") {
    const parts = [];
    if (args.verdict) parts.push(String(args.verdict));
    if (args.memoryId) parts.push(_truncate(String(args.memoryId), 24));
    if (parts.length > 0) return parts.join(" ");
  }

  if (a === "memory.get" || a === "memory.surface") {
    // Memory retrieval is anchored on exact files/symbols (and optional domain
    // filters) — surface those so the log shows WHAT was probed, not a bare
    // "memory.get". The generic fallback below only knows singular query/file
    // keys, so these array-shaped anchors would otherwise read as no detail.
    const files = firstArrayEntry(args.fileRelPaths, 2);
    const symbolCount = Array.isArray(args.symbolIds) ? args.symbolIds.length : 0;
    const domains = firstArrayEntry(args.domains, 3);
    const parts = [];
    if (files) parts.push(files);
    else if (symbolCount > 0) parts.push(`${symbolCount} symbol${symbolCount === 1 ? "" : "s"}`);
    if (domains) parts.push(`[${domains}]`);
    if (parts.length > 0) return _truncate(parts.join(" "), 80);
  }

  // Generic fallback — mirrors the original priority order but ordered so
  // action-specific hints above run first.
  const candidates = [
    args.query,
    args.pattern,
    args.symbolId,
    args.file,
    args.filePath,
    args.taskText,
    args.sliceHandle,
    args.versionId,
    args.fromVersion && args.toVersion ? `${args.fromVersion}->${args.toVersion}` : null,
  ];
  const first = candidates.find((value) => value != null && String(value).trim() !== "");
  return first ? _truncate(String(first).split(/\r?\n/)[0], 80) : "";
}

// Internal alias preserves the existing call sites.
const _atlasSummaryHint = atlasSummaryHint;

function _summarizeToolUse(toolUse, cwd = null) {
  if (!toolUse?.tool) return null;
  const input = toolUse.input || {};
  const rawTool = String(toolUse.tool);
  const posseGatewayMcp = _isPosseGatewayMcpTool(rawTool);
  const atlasAction = _resolveAtlasAction(rawTool, input);
  // When a Claude/Codex tool_use event targets the Posse MCP gateway, the
  // gateway subprocess has already recorded the invocation with enriched
  // context (chain-state path for chain_verdict, etc.). Recording again on the
  // parent side would double-count every successful call. The exception is an
  // ATLAS call Codex cancelled before the subprocess saw it; then provider
  // replay is the only evidence.
  if (posseGatewayMcp) {
    if (!atlasAction) return null;
    if (!toolUse.status && !toolUse.error) return null;
  }
  const tool = rawTool;
  const toolLower = tool.toLowerCase();
  const webToolKind = _normalizedWebToolKind(tool);
  const cwdNorm = cwd ? _normalizePath(cwd).replace(/\/+$/, "") : null;
  const rel = (target) => {
    const norm = _normalizePath(target);
    if (!cwdNorm || !norm.startsWith(cwdNorm)) return norm;
    const sliced = norm.slice(cwdNorm.length).replace(/^\/+/, "");
    return sliced || ".";
  };

  const catalogSummary = _summarizeCatalogToolUse(tool, input, cwdNorm, rel);
  if (catalogSummary) return catalogSummary;

  if (webToolKind === "fetch") {
    const url = _firstInputValue(input, ["url", "uri", "href", "page_url"]);
    return {
      observation_type: "tool.web_fetch",
      summary: `WebFetch: ${_truncate(url || "(unknown URL)", 140)}`,
      detail: {
        kind: "web",
        tool_name: tool,
        url: url || null,
        cwd: cwdNorm || null,
      },
    };
  }

  if (webToolKind === "search") {
    const query = _firstInputValue(input, ["query", "q", "search", "search_query"]);
    return {
      observation_type: "tool.web_search",
      summary: `WebSearch: ${_truncate(query || "(unknown query)", 140)}`,
      detail: {
        kind: "web",
        tool_name: tool,
        query: query || null,
        cwd: cwdNorm || null,
      },
    };
  }

  if (tool === "MultiEdit") {
    const filePath = rel(input.file_path || "");
    const count = Array.isArray(input.edits) ? input.edits.length : 0;
    if (!filePath) return null;
    return {
      observation_type: "tool.multiedit",
      summary: `MultiEdit: ${_truncate(filePath, 140)} (${count} edit${count === 1 ? "" : "s"})`,
      detail: { file_path: _normalizePath(input.file_path || ""), edit_count: count, cwd: cwdNorm || null },
    };
  }
  if (toolLower === "apply_patch") {
    const filePath = rel(input.file_path || input.path || "");
    const changeKind = _truncate(input.change_kind || "", 20);
    if (!filePath) return null;
    return {
      observation_type: "tool.apply_patch",
      summary: `apply_patch: ${_truncate(filePath, 120)}${changeKind ? ` (${changeKind})` : ""}`,
      detail: {
        file_path: _normalizePath(input.file_path || input.path || ""),
        change_kind: input.change_kind || null,
        cwd: cwdNorm || null,
        tool_name: tool,
        kind: "system_call",
      },
    };
  }
  if (atlasAction) {
    const hint = _atlasSummaryHint(input, atlasAction);
    const displayName = formatAtlasToolDisplayName(atlasAction) || `atlas ${atlasAction}`;
    const status = String(toolUse.status || "").trim().toLowerCase();
    const rejectedStatus = ["rejected", "denied", "cancelled", "canceled"].includes(status);
    const rawErrorText = String(toolUse.error || "").trim();
    const errorText = rejectedStatus ? "" : rawErrorText;
    const rejectionText = String(toolUse.rejection || (rejectedStatus ? rawErrorText : "")).trim();
    const outcome = normalizedToolOutcome(toolUse.outcome, {
      status,
      error: errorText,
    });
    const statusSuffix = rejectedStatus
      ? " rejected"
      : (errorText ? " failed" : "");
    const diagnosticText = errorText || rejectionText;
    const errorSuffix = diagnosticText ? `: ${_truncate(diagnosticText, 80)}` : "";
    // Tool-use stream observations are always agent-initiated — prefetch
    // flows through _recordAtlasToolObservation directly and never becomes a
    // tool_use event on the wire.
    const observationType = atlasAction === "buffer.push" ? "atlas.buffer_push" : "tool.atlas";
    return {
      observation_type: observationType,
      summary: `${displayName}${hint ? ` (${hint})` : ""}${statusSuffix}${errorSuffix}`,
      detail: {
        kind: "atlas",
        origin: "agent",
        action: atlasAction,
        args: _summarizeAtlasArgs(input),
        cwd: cwdNorm || null,
        tool_name: tool,
        transport: toolLower.startsWith("mcp__") ? "mcp" : null,
        status: status || (errorText ? "error" : null),
        ok: status || errorText ? false : null,
        outcome,
        error: errorText || null,
        rejection_reason: rejectionText || null,
      },
    };
  }
  return null;
}

// Result-side stats for native read tools, merged into the completion
// observation via extraDetail. The request-side offset/limit alone cannot
// distinguish a full read of a small file from a default-window read of a
// large one; pricing "ATLAS vs raw reads" needs what actually came back.
const READ_RESULT_STATS_TYPES = new Set(["tool.read", "tool.chain_read"]);

export function nativeReadResultStats(tool, resultText) {
  try {
    const spec = TOOL_CATALOG[_normalizeCatalogToolName(tool)]?.observation;
    if (!spec || !READ_RESULT_STATS_TYPES.has(spec.type)) return null;
    if (typeof resultText !== "string" || resultText === "" || /^Error:/i.test(resultText)) return null;
    const structured = _structuredReadStats(resultText);
    if (structured) return structured;
    // Plain numbered-lines format: execReadFile appends "... (N more lines)"
    // when the window ends before the file does.
    const marker = /\n\.\.\. \((\d+) more lines\)$/.exec(resultText);
    let lines = 1;
    for (let i = 0; i < resultText.length; i += 1) {
      if (resultText.charCodeAt(i) === 10) lines += 1;
    }
    return {
      result_chars: resultText.length,
      result_lines: marker ? lines - 1 : lines,
      truncated: !!marker,
      ...(marker ? { remaining_lines: Number(marker[1]) } : {}),
    };
  } catch {
    return null;
  }
}

function _structuredReadStats(text) {
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || parsed.ok !== true) return null;
    if (typeof parsed.returnedLines !== "number" && typeof parsed.totalLines !== "number") return null;
    return {
      result_chars: text.length,
      ...(typeof parsed.returnedLines === "number" ? { result_lines: parsed.returnedLines } : {}),
      truncated: parsed.truncated === true,
      ...(typeof parsed.totalLines === "number" ? { total_lines: parsed.totalLines } : {}),
    };
  } catch {
    return null;
  }
}

export function recordToolInvocation({
  tool = null,
  input = null,
  cwd = null,
  work_item_id = undefined,
  job_id = undefined,
  attempt_id = undefined,
  extraDetail = null,
} = {}) {
  const summary = _summarizeToolUse({ tool, input }, cwd);
  if (!summary) return;
  const context = getObservationContext() || {};
  const detail = extraDetail && typeof extraDetail === "object"
    ? { ...(summary.detail || {}), ...extraDetail }
    : summary.detail;
  recordObservation({
    work_item_id: work_item_id ?? context.work_item_id ?? null,
    job_id: job_id ?? context.job_id ?? null,
    attempt_id: attempt_id ?? context.attempt_id ?? null,
    observation_type: summary.observation_type,
    summary: summary.summary,
    detail,
  });
}

let _toolInvocationSeq = 0;

// Begin a tool invocation: write an append-only "<type>.started" observation the
// moment the request is made (not just when it finishes), so the telemetry — and
// the live monitor — can see in-flight tools. Returns a correlation token to pass
// to finishToolInvocation; null when the tool isn't summarizable. Recording must
// never break tool execution, so this is fully guarded.
export function beginToolInvocation({
  tool = null,
  input = null,
  cwd = null,
  work_item_id = undefined,
  job_id = undefined,
  attempt_id = undefined,
} = {}) {
  try {
    const summary = _summarizeToolUse({ tool, input }, cwd);
    if (!summary) return null;
    const context = getObservationContext() || {};
    const resolvedJobId = job_id ?? context.job_id ?? null;
    const startedAtMs = Date.now();
    const inv = `${resolvedJobId ?? "g"}-${startedAtMs}-${++_toolInvocationSeq}`;
    recordObservation({
      work_item_id: work_item_id ?? context.work_item_id ?? null,
      job_id: resolvedJobId,
      attempt_id: attempt_id ?? context.attempt_id ?? null,
      observation_type: `${summary.observation_type}.started`,
      summary: summary.summary,
      detail: { ...(summary.detail && typeof summary.detail === "object" ? summary.detail : {}), inv, phase: "start" },
    });
    return { inv, startedAtMs };
  } catch {
    return null;
  }
}

// Complete an invocation opened by beginToolInvocation: writes the normal
// completion observation (same "<type>" as before, so existing consumers are
// unchanged) correlated by `inv`, carrying ok/status and the measured duration.
// Recorded on success AND failure so an in-flight "started" row is always closed.
export function finishToolInvocation(invocation, {
  tool = null,
  input = null,
  cwd = null,
  ok = true,
  outcome = null,
  resultSummary = null,
  error = null,
  rejection = null,
  work_item_id = undefined,
  job_id = undefined,
  attempt_id = undefined,
  extraDetail = null,
} = {}) {
  try {
    const summary = _summarizeToolUse({ tool, input }, cwd);
    if (!summary) return;
    const context = getObservationContext() || {};
    const inv = invocation?.inv ?? null;
    const durationMs = invocation?.startedAtMs ? Math.max(0, Date.now() - invocation.startedAtMs) : null;
    const resolvedOutcome = normalizedToolOutcome(outcome, { ok, error });
    const detail = {
      ...(summary.detail && typeof summary.detail === "object" ? summary.detail : {}),
      ...(extraDetail && typeof extraDetail === "object" ? extraDetail : {}),
      ...(inv ? { inv } : {}),
      phase: "finish",
      ok: !!ok,
      outcome: resolvedOutcome,
      ...(durationMs != null ? { duration_ms: durationMs } : {}),
      ...(error ? { error: String(error).slice(0, 200) } : {}),
      ...(rejection ? { rejection_reason: String(rejection).slice(0, 200) } : {}),
    };
    recordObservation({
      work_item_id: work_item_id ?? context.work_item_id ?? null,
      job_id: job_id ?? context.job_id ?? null,
      attempt_id: attempt_id ?? context.attempt_id ?? null,
      observation_type: summary.observation_type,
      summary: resultSummary || (resolvedOutcome === "succeeded"
        ? summary.summary
        : `${summary.summary} — ${resolvedOutcome || "failed"}`),
      detail,
    });
  } catch { /* best effort */ }
}

export function filterProviderToolUseReplay(toolUses = [], { skipToolkitDeterministic = false } = {}) {
  if (!Array.isArray(toolUses) || toolUses.length === 0) return [];
  if (!skipToolkitDeterministic) return toolUses;
  return toolUses.filter((toolUse) => !CATALOG_DETERMINISTIC_TOOL_NAMES.has(_normalizeCatalogToolName(toolUse?.tool)));
}

export function recordToolUseObservations({
  work_item_id = null,
  job_id = null,
  attempt_id = null,
  tool_uses = [],
  cwd = null,
} = {}) {
  if (!Array.isArray(tool_uses) || tool_uses.length === 0) return;
  const context = getObservationContext() || {};
  const resolvedWorkItemId = work_item_id ?? context.work_item_id ?? null;
  const resolvedJobId = job_id ?? context.job_id ?? null;
  const resolvedAttemptId = attempt_id ?? context.attempt_id ?? null;
  const seen = new Set();
  const now = Date.now();
  const replayBucketKey = resolvedJobId == null ? "__global__" : String(resolvedJobId);
  for (const toolUse of tool_uses) {
    const summary = _summarizeToolUse(toolUse, cwd);
    if (!summary) continue;
    const status = String(toolUse?.status || "").trim();
    const rejectedStatus = ["rejected", "denied", "cancelled", "canceled"].includes(status.toLowerCase());
    const rawError = String(toolUse?.error || "").trim();
    const error = rejectedStatus ? "" : rawError;
    const rejection = String(toolUse?.rejection || (rejectedStatus ? rawError : "")).trim();
    const outcome = normalizedToolOutcome(toolUse?.outcome, { status, error });
    const detail = {
      ...(summary.detail && typeof summary.detail === "object" ? summary.detail : {}),
      ...(outcome ? { outcome, ok: outcome === "succeeded" } : {}),
      ...(error ? { error: error.slice(0, 200) } : {}),
      ...(rejection ? { rejection_reason: rejection.slice(0, 200) } : {}),
    };
    const key = `${summary.observation_type}|${summary.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (TOOL_REPLAY_DEDUPE_WINDOW_MS > 0 && summary.observation_type.startsWith("tool.")) {
      const fingerprint = `${summary.observation_type}|${JSON.stringify(detail)}`;
      if (!_rememberToolReplayFingerprint(replayBucketKey, fingerprint, now)) continue;
    }
    recordObservation({
      work_item_id: resolvedWorkItemId,
      job_id: resolvedJobId,
      attempt_id: resolvedAttemptId,
      observation_type: summary.observation_type,
      summary: summary.summary,
      detail,
    });
  }
}

export function __testResetToolReplayCache() {
  assertTestContext("__testResetToolReplayCache");
  _recentToolReplay.clear();
}

export function __testSetObservationStreamWriterForTests(fn = null) {
  assertTestContext("__testSetObservationStreamWriterForTests");
  _streamWriter = typeof fn === "function" ? fn : defaultStreamWriter;
}

export function __testResetObservationStreamForTests() {
  assertTestContext("__testResetObservationStreamForTests");
  _closeStream();
  _streamDisabledUntilMs = 0;
  _streamLastFailure = null;
  _streamWriter = defaultStreamWriter;
}

export function __testGetObservationStreamStateForTests() {
  return {
    disabledUntilMs: _streamDisabledUntilMs,
    lastFailure: _streamLastFailure ? { ..._streamLastFailure } : null,
    hasOpenStream: !!_fd,
  };
}

export function __testRememberToolReplayFingerprint(bucketKey, fingerprint, now = Date.now()) {
  assertTestContext("__testRememberToolReplayFingerprint");
  return _rememberToolReplayFingerprint(String(bucketKey), String(fingerprint), now);
}

export function __testToolReplayCacheStats() {
  let entries = 0;
  let maxBucketSize = 0;
  for (const bucket of _recentToolReplay.values()) {
    entries += bucket.size;
    maxBucketSize = Math.max(maxBucketSize, bucket.size);
  }
  return {
    buckets: _recentToolReplay.size,
    entries,
    maxBucketSize,
  };
}

export function getObservationsByJob(jobId, limit = 100) {
  const db = getDb();
  const cappedLimit = Math.max(0, Number(limit) || 0);
  const fileRows = readObservationFileRows({ jobId, limit: cappedLimit, order: "desc" });
  const dbRows = db.prepare(`
    SELECT * FROM job_observations
    WHERE job_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(jobId, cappedLimit);
  return mergeObservationRows([...fileRows, ...dbRows], "desc", cappedLimit);
}

/**
 * Compact per-job tool-usage profile, computed at job closeout so it survives
 * the job_observations tail prune (which reclaims a terminal job's rows after
 * a 10-min grace). Sourced from getObservationsByJob, which merges the JSONL
 * archive with the live DB — so it stays complete even if the DB tail already
 * dropped some rows. Persisted into jobs.result_json.tool_mix; this is the
 * durable answer to "which tools did this job actually call" that the A/B
 * attribution work kept losing to pruning.
 *
 * @param {number|string} jobId
 * @returns {{ toolCalls: number, byType: Record<string, number>, atlasActions: Record<string, number>, atlasPrefetchActions: Record<string, { total: number, ok: number, failed: number, cacheHits: number, firstError: string | null, sampleArgs: Record<string, unknown> | null, survey?: Record<string, unknown> }> } | null}
 */
export function summarizeJobToolMix(jobId) {
  try {
    const rows = getObservationsByJob(jobId, 5000);
    const byType = {};
    const atlasActions = {};
    const atlasPrefetchActions = {};
    let toolCalls = 0;
    for (const row of rows) {
      const type = String(row.observation_type || "");
      let detail = null;
      try { detail = JSON.parse(row.detail_json || "{}"); } catch { /* ignore */ }

      if (type === "atlas.prefetch.survey") {
        mergeAtlasSurveyPrefetchDiagnostic(atlasPrefetchActions, detail);
        continue;
      }

      if (!type.startsWith("tool.")) continue;
      if (type.endsWith(".started")) continue;          // completion half only
      if (type === "tool.chain_read") continue;         // paired with chain_verdict
      const isSystemLane = type.endsWith(".prefetch") || type.endsWith(".autofeedback");
      byType[type] = (byType[type] || 0) + 1;
      if (!isSystemLane) toolCalls += 1;                 // agent-lane calls only
      if (type.startsWith("tool.atlas") && !isSystemLane) {
        const action = detail?.action;
        if (action) atlasActions[action] = (atlasActions[action] || 0) + 1;
      } else if (type === "tool.atlas.prefetch") {
        mergeAtlasPrefetchAction(atlasPrefetchActions, detail);
      }
    }
    return { toolCalls, byType, atlasActions, atlasPrefetchActions };
  } catch {
    return null;
  }
}

function ensureAtlasPrefetchAction(out, action) {
  const name = String(action || "").trim();
  if (!name) return null;
  if (!out[name]) {
    out[name] = {
      total: 0,
      ok: 0,
      failed: 0,
      cacheHits: 0,
      firstError: null,
      sampleArgs: null,
    };
  }
  return out[name];
}

function mergeAtlasPrefetchAction(out, detail) {
  const entry = ensureAtlasPrefetchAction(out, detail?.action);
  if (!entry) return;
  entry.total += 1;
  if (detail?.ok) entry.ok += 1;
  else entry.failed += 1;
  if (detail?.cache_hit) entry.cacheHits += 1;
  if (!entry.firstError && detail?.error) entry.firstError = String(detail.error).slice(0, 240);
  if (!entry.sampleArgs && detail?.args && typeof detail.args === "object") entry.sampleArgs = detail.args;
}

function mergeAtlasSurveyPrefetchDiagnostic(out, detail) {
  const entry = ensureAtlasPrefetchAction(out, detail?.action || "code.survey");
  if (!entry) return;
  const survey = entry.survey && typeof entry.survey === "object"
    ? entry.survey
    : {
      diagnostics: 0,
      attempted: 0,
      ok: 0,
      failed: 0,
      skipped: 0,
      firstError: null,
      lastScope: null,
      lastFileCount: null,
      lastInternalEdgeCount: null,
    };
  survey.diagnostics = Number(survey.diagnostics || 0) + 1;
  if (detail?.attempted) survey.attempted = Number(survey.attempted || 0) + 1;
  else survey.skipped = Number(survey.skipped || 0) + 1;
  if (detail?.ok) survey.ok = Number(survey.ok || 0) + 1;
  else if (detail?.attempted) survey.failed = Number(survey.failed || 0) + 1;
  if (!survey.firstError && detail?.error) survey.firstError = String(detail.error).slice(0, 240);
  if (detail?.scope) survey.lastScope = detail.scope;
  if (detail?.file_count != null) survey.lastFileCount = detail.file_count;
  if (detail?.internal_edge_count != null) survey.lastInternalEdgeCount = detail.internal_edge_count;
  entry.survey = survey;
}

export function getRecentToolInvocations({ limit = 200, includeUnscoped = true, currentRunOnly = false } = {}) {
  // Both chain_read and chain_verdict live under "tool.*" now, so a single
  // prefix match is sufficient. The legacy "chain.%" branch was dropped after
  // the naming unification — historical rows are migrated in lib/db.js.
  const db = getDb();
  const cappedLimit = Math.max(0, Number(limit) || 0);
  const candidateLimit = includeUnscoped ? cappedLimit : Math.max(200, cappedLimit * 10);
  const fileRows = readObservationFileRows({ typePrefix: "tool.", excludeTypeSuffix: DISPLAY_TOOL_EXCLUDE_SUFFIXES, limit: candidateLimit, order: "desc" });
  const dbRows = currentRunOnly ? db.prepare(`
    SELECT o.*
    FROM job_observations o
    WHERE o.observation_type LIKE 'tool.%'
      AND o.observation_type NOT LIKE '%.prefetch'
      AND o.observation_type NOT LIKE '%.autofeedback'
      AND o.created_at >= ?
    ORDER BY o.id DESC
    LIMIT ?
  `).all(getRunTelemetryStartedAt(), candidateLimit) : db.prepare(`
    SELECT o.*
    FROM job_observations o
    WHERE o.observation_type LIKE 'tool.%'
      AND o.observation_type NOT LIKE '%.prefetch'
      AND o.observation_type NOT LIKE '%.autofeedback'
    ORDER BY o.id DESC
    LIMIT ?
  `).all(candidateLimit);
  return enrichToolInvocationRows(
    db,
    _collapseToolInvocationRows(mergeObservationRows([...fileRows, ...dbRows], "desc", candidateLimit)),
    { includeUnscoped },
  ).slice(0, cappedLimit);
}

export function getToolInvocationCountsByJob({ limit = 50 } = {}) {
  // chain_read is the first half of the chain_read + chain_verdict pair; we
  // exclude it here so the pair counts as ONE tool invocation (via chain_verdict).
  // The row is still persisted and shows up in getRecentToolInvocations.
  const db = getDb();
  const cappedLimit = Math.max(0, Number(limit) || 0);
  const candidateLimit = Math.max(1000, cappedLimit * 200);
  const fileRows = readObservationFileRows({ typePrefix: "tool.", excludeTypeSuffix: HARNESS_SYSTEM_TYPE_SUFFIXES, limit: candidateLimit, order: "desc" });
  const dbRows = db.prepare(`
    SELECT *
    FROM job_observations
    WHERE observation_type LIKE 'tool.%'
      AND observation_type NOT LIKE '%.prefetch'
      AND observation_type NOT LIKE '%.autofeedback'
    ORDER BY id DESC
    LIMIT ?
  `).all(candidateLimit);
  const rows = mergeObservationRows([...fileRows, ...dbRows], "desc", candidateLimit)
    .filter((row) => row.job_id != null
      && row.observation_type !== "tool.chain_read"
      && !String(row.observation_type || "").endsWith(".started")
      && !HARNESS_SYSTEM_TYPE_SUFFIXES.some((suffix) => String(row.observation_type || "").endsWith(suffix))
      && String(row.observation_type || "").startsWith("tool."));

  const groups = new Map();
  for (const row of rows) {
    const key = String(row.job_id);
    const group = groups.get(key) || {
      job_id: row.job_id,
      work_item_id: row.work_item_id,
      total: 0,
      last_at: row.created_at,
      _sort: observationSortValue(row),
      _types: new Set(),
    };
    group.total += 1;
    group._types.add(row.observation_type);
    if (observationSortValue(row) > group._sort) {
      group._sort = observationSortValue(row);
      group.last_at = row.created_at;
      group.work_item_id = row.work_item_id;
    }
    groups.set(key, group);
  }

  const jobStmt = db.prepare(`SELECT job_type, status, provider FROM jobs WHERE id = ?`);
  return [...groups.values()]
    .sort((a, b) => b._sort - a._sort)
    .slice(0, cappedLimit)
    .map((group) => {
      const job = jobStmt.get(group.job_id);
      return {
        job_id: group.job_id,
        work_item_id: group.work_item_id,
        job_type: job?.job_type ?? null,
        status: job?.status ?? null,
        provider: job?.provider ?? null,
        total: group.total,
        last_at: group.last_at,
        tool_types: [...group._types].sort().join(","),
      };
    });
}

export function closeObservationLog() {
  if (_fd) {
    try { fs.closeSync(_fd); } catch { /* ignore */ }
    _fd = null;
  }
}
