// @ts-check

import { getDb } from "../../../shared/storage/functions/index.js";
import { recordObservation, runWithObservationContext } from "../../observability/functions/observations.js";
import { executeEmbeddedAtlasTool } from "./atlas-embedded.js";
import { isAtlasSymbolId } from "../../atlas/functions/v2/symbol-id.js";
import { normalizeAtlasActionName } from "../../atlas/functions/v2/signal-extraction.js";

const DIRECT_USEFUL_ACTIONS = new Set([
  "symbol.getCard",
  "code.getSkeleton",
  "code.getHotPath",
  "code.needWindow",
]);

export function resolveAtlasAutoFeedbackMode(config = null) {
  const configured = config?.autoFeedbackMode;
  const raw = String(configured || "write").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "write") return "write";
  if (raw === "dry-run" || raw === "dryrun" || raw === "preview") return "dry-run";
  return "off";
}

/**
 * @param {{ job?: any, attemptId?: any, cwd?: string | null, config?: any, outcome?: string | null }} [opts]
 */
export async function emitAtlasAutoFeedbackForJob({
  job,
  attemptId = null,
  cwd = null,
  config = null,
  outcome = null,
} = {}) {
  const mode = resolveAtlasAutoFeedbackMode(config);
  if (mode === "off" || !job?.id) return { ok: true, mode, emitted: false, reason: "disabled" };
  if (config && config.enabled === false) return { ok: true, mode: "off", emitted: false, reason: "atlas_disabled" };

  const observations = readJobObservations(job.id, attemptId);
  const candidate = buildAtlasAutoFeedbackCandidate(observations, {
    jobType: job.job_type,
    taskText: job.title || "",
    outcome,
  });
  if (!candidate.ok) {
    recordFeedbackObservation({ job, attemptId, mode, candidate });
    return { ok: true, mode, emitted: false, reason: candidate.reason };
  }

  recordFeedbackObservation({ job, attemptId, mode, candidate });
  if (mode === "dry-run") {
    return { ok: true, mode, emitted: false, reason: "dry-run", candidate };
  }

  try {
    const executeOpts = {
      cwd,
      origin: "agent",
      ...(config ? { config } : {}),
    };
    const result = await runWithObservationContext({
      work_item_id: job.work_item_id ?? null,
      job_id: job.id,
      attempt_id: attemptId,
      role: roleForFeedback(job.job_type),
    }, () => executeEmbeddedAtlasTool("agent.feedback", candidate.payload, executeOpts));
    recordObservation(/** @type {any} */ ({
      work_item_id: job.work_item_id ?? null,
      job_id: job.id,
      attempt_id: attemptId,
      observation_type: "atlas.feedback.emit",
      summary: `ATLAS auto-feedback emitted ${candidate.payload.usefulSymbols.length} useful symbol(s)`,
      detail: {
        mode,
        ok: !/^Error:/i.test(String(result || "")),
        useful_count: candidate.payload.usefulSymbols.length,
        version_id: candidate.diagnostics?.versionId || null,
        slice_handle: candidate.payload.sliceHandle,
      },
    }));
    return { ok: true, mode, emitted: true, candidate, result };
  } catch (err) {
    recordObservation(/** @type {any} */ ({
      work_item_id: job.work_item_id ?? null,
      job_id: job.id,
      attempt_id: attemptId,
      observation_type: "atlas.feedback.emit",
      summary: `ATLAS auto-feedback failed: ${String(err?.message || err).slice(0, 120)}`,
      detail: { mode, ok: false, error: String(err?.message || err) },
    }));
    return { ok: false, mode, emitted: false, reason: "emit_failed", error: String(err?.message || err) };
  }
}

export function buildAtlasAutoFeedbackCandidate(observations = [], {
  jobType = null,
  taskText = "",
  outcome = null,
} = {}) {
  const parsed = observations.map(normalizeObservation).filter(Boolean);
  const touchedPaths = collectTouchedPaths(parsed);
  const useful = new Set();
  let versionId = null;
  let sliceHandle = null;
  let atlasObservationCount = 0;
  let okAtlasObservationCount = 0;

  for (const obs of parsed) {
    const detail = obs.detail || {};
    if (detail.kind !== "atlas") continue;
    atlasObservationCount += 1;
    if (detail.ok !== true) continue;
    okAtlasObservationCount += 1;
    const action = normalizeAtlasActionName(detail.action || "");
    if (!action || action === "agent.feedback") continue;

    const artifacts = detail.atlas_artifacts && typeof detail.atlas_artifacts === "object"
      ? detail.atlas_artifacts
      : null;
    if (artifacts?.versionId) versionId = artifacts.versionId;
    if (artifacts?.sliceHandle) sliceHandle = artifacts.sliceHandle;

    const argSymbol = typeof detail.args?.symbolId === "string" && isAtlasSymbolId(detail.args.symbolId)
      ? detail.args.symbolId
      : null;
    if (argSymbol && DIRECT_USEFUL_ACTIONS.has(action)) useful.add(argSymbol);

    const symbols = Array.isArray(artifacts?.symbols) ? artifacts.symbols : [];
    for (const sym of symbols) {
      if (!isAtlasSymbolId(sym?.symbolId)) continue;
      const filePath = normalizeRepoPath(sym.filePath);
      if (DIRECT_USEFUL_ACTIONS.has(action) || (filePath && touchedPaths.has(filePath))) {
        useful.add(sym.symbolId);
      }
      if (useful.size >= 40) break;
    }
  }

  const diagnostics = {
    atlasObservationCount,
    okAtlasObservationCount,
    touchedPathCount: touchedPaths.size,
    candidateSymbolCount: useful.size,
    versionId,
    sliceHandle,
  };

  if (useful.size === 0) return skipped("no_useful_symbols", useful, diagnostics);
  if (!sliceHandle) return skipped("missing_slice_handle", useful, diagnostics);

  const payload = {
    sliceHandle,
    usefulSymbols: [...useful].slice(0, 40),
    missingSymbols: [],
    taskType: taskTypeForJobType(jobType),
    taskText: String(taskText || "").slice(0, 512),
    taskTags: taskTagsForJob({ jobType, outcome }),
  };

  return {
    ok: true,
    reason: null,
    usefulCount: useful.size,
    payload,
    diagnostics,
  };
}

function readJobObservations(jobId, attemptId = null) {
  try {
    const db = getDb();
    const rows = attemptId == null
      ? db.prepare(`
        SELECT observation_type, detail_json
        FROM job_observations
        WHERE job_id = ?
        ORDER BY id ASC
      `).all(jobId)
      : db.prepare(`
        SELECT observation_type, detail_json
        FROM job_observations
        WHERE job_id = ? AND attempt_id = ?
        ORDER BY id ASC
      `).all(jobId, attemptId);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function normalizeObservation(row) {
  if (!row || typeof row !== "object") return null;
  let detail = row.detail || null;
  if (!detail && typeof row.detail_json === "string") {
    try { detail = JSON.parse(row.detail_json); } catch { detail = null; }
  }
  return {
    observation_type: row.observation_type || row.type || null,
    detail,
  };
}

function collectTouchedPaths(observations) {
  const out = new Set();
  for (const obs of observations) {
    const type = String(obs.observation_type || "");
    if (!["tool.read", "tool.edit", "tool.write", "tool.chain_read"].includes(type)) continue;
    const path = normalizeRepoPath(obs.detail?.path);
    if (path) out.add(path);
  }
  return out;
}

function recordFeedbackObservation({ job, attemptId, mode, candidate }) {
  const ok = !!candidate?.ok;
  const usefulCount = ok ? candidate.payload.usefulSymbols.length : candidate?.usefulCount || 0;
  recordObservation(/** @type {any} */ ({
    work_item_id: job.work_item_id ?? null,
    job_id: job.id,
    attempt_id: attemptId,
    observation_type: "atlas.feedback.candidate",
    summary: ok
      ? `ATLAS auto-feedback ${mode}: ${usefulCount} useful symbol candidate(s)`
      : `ATLAS auto-feedback ${mode}: skipped (${candidate?.reason || "no_candidate"})`,
    detail: {
      mode,
      ok,
      reason: candidate?.reason || null,
      useful_count: usefulCount,
      version_id: candidate?.diagnostics?.versionId || null,
      slice_handle: candidate?.payload?.sliceHandle || candidate?.diagnostics?.sliceHandle || null,
      diagnostics: candidate?.diagnostics || null,
      emitted: mode === "write" && ok,
    },
  }));
}

function skipped(reason, useful, diagnostics = null) {
  return {
    ok: false,
    reason,
    usefulCount: useful?.size || 0,
    diagnostics,
  };
}

function normalizeRepoPath(value) {
  const text = String(value || "").trim().replace(/\\/g, "/");
  return text || null;
}

function taskTypeForJobType(jobType) {
  const type = String(jobType || "").toLowerCase();
  if (type.includes("assess") || type.includes("review")) return "review";
  if (type.includes("dev") || type.includes("fix") || type.includes("artifact")) return "implement";
  if (type.includes("plan")) return "explain";
  if (type.includes("research")) return "explain";
  return "explain";
}

function taskTagsForJob({ jobType = null, outcome = null } = {}) {
  const tags = [];
  const role = roleForFeedback(jobType);
  if (role) tags.push(`role:${role}`);
  const normalizedOutcome = String(outcome || "").trim().toLowerCase();
  if (normalizedOutcome) tags.push(`outcome:${normalizedOutcome}`);
  return tags.slice(0, 8);
}

function roleForFeedback(jobType) {
  const type = String(jobType || "").toLowerCase();
  if (type.includes("assess")) return "assessor";
  if (type.includes("plan")) return "planner";
  if (type.includes("research")) return "researcher";
  if (type.includes("fix")) return "dev";
  return type || null;
}
