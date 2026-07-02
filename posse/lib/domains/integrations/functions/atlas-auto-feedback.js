// @ts-check

import { getDb } from "../../../shared/storage/functions/index.js";
import { recordObservation, runWithObservationContext } from "../../observability/functions/observations.js";
import { executeEmbeddedAtlasTool } from "./atlas-embedded.js";
import { isAtlasSymbolId } from "../../atlas/functions/v2/symbol-id.js";
import { extractAtlasResultArtifacts, normalizeAtlasActionName } from "../../atlas/functions/v2/signal-extraction.js";

const DIRECT_USEFUL_ACTIONS = new Set([
  "symbol.card",
  "code.skeleton",
  "code.lens",
  "code.window",
]);

export function resolveAtlasAutoFeedbackMode(config = null) {
  const configured = config?.autoFeedbackMode;
  const raw = String(configured || "write").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "write") return "write";
  if (raw === "dry-run" || raw === "dryrun" || raw === "preview") return "dry-run";
  return "off";
}

export function classifyAtlasAutoFeedbackEmitResult(result) {
  if (/^Error:/i.test(String(result || ""))) {
    return { ok: false, emitted: false, reason: "emit_rejected" };
  }
  return { ok: true, emitted: true, reason: null };
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
  let candidate = buildAtlasAutoFeedbackCandidate(observations, {
    jobType: job.job_type,
    taskText: job.title || "",
    outcome,
  });
  // Research concludes at file level (chain verdicts), often without any
  // ATLAS symbol evidence for the files it validated. Resolve the verdicted
  // files into symbol IDs so research conclusions persist as feedback
  // instead of evaporating at the symbol gate.
  if (!candidate.ok
    && candidate.reason === "no_useful_symbols"
    && roleForFeedback(job.job_type) === "researcher") {
    const extraUsefulSymbols = await resolveRelevantPathSymbols(observations, { cwd, config });
    if (extraUsefulSymbols.length > 0) {
      candidate = buildAtlasAutoFeedbackCandidate(observations, {
        jobType: job.job_type,
        taskText: job.title || "",
        outcome,
        extraUsefulSymbols,
      });
    }
  }
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
      origin: "auto_feedback",
      ...(config ? { config } : {}),
    };
    const result = await runWithObservationContext({
      work_item_id: job.work_item_id ?? null,
      job_id: job.id,
      attempt_id: attemptId,
      role: roleForFeedback(job.job_type),
    }, () => executeEmbeddedAtlasTool("agent.feedback", candidate.payload, executeOpts));
    const emitResult = classifyAtlasAutoFeedbackEmitResult(result);
    const resultText = String(result || "");
    recordObservation(/** @type {any} */ ({
      work_item_id: job.work_item_id ?? null,
      job_id: job.id,
      attempt_id: attemptId,
      observation_type: "atlas.feedback.emit",
      summary: emitResult.ok
        ? `ATLAS auto-feedback emitted ${candidate.payload.usefulSymbols.length} useful symbol(s)`
        : `ATLAS auto-feedback rejected: ${resultText.slice(0, 120)}`,
      detail: {
        mode,
        ok: emitResult.ok,
        useful_count: candidate.payload.usefulSymbols.length,
        version_id: candidate.diagnostics?.versionId || null,
        slice_handle: candidate.payload.sliceHandle,
        ...(emitResult.ok ? {} : { error: resultText.slice(0, 500) }),
      },
    }));
    if (!emitResult.ok) {
      return { ok: false, mode, emitted: false, reason: emitResult.reason, candidate, result };
    }
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
  extraUsefulSymbols = [],
} = {}) {
  const parsed = observations.map(normalizeObservation).filter(Boolean);
  const touchedPaths = collectTouchedPaths(parsed);
  const useful = new Set();
  for (const symbolId of Array.isArray(extraUsefulSymbols) ? extraUsefulSymbols : []) {
    if (isAtlasSymbolId(symbolId)) useful.add(symbolId);
    if (useful.size >= 40) break;
  }
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

  // No slice handle is normal under tree-first retrieval (tree.scope/
  // tree.expand surface symbols without building a slice); the ledger stores
  // feedback per symbol with a nullable slice_handle, so emit regardless.
  const payload = {
    ...(sliceHandle ? { sliceHandle } : {}),
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

// Resolve relevant-verdict file paths into symbol IDs via skeleton lookups.
// Bounded and best-effort: at most 5 files, 8 symbols each — enough to seed
// the feedback ledger without turning the finalizer into a retrieval pass.
async function resolveRelevantPathSymbols(observations, { cwd, config, maxSymbolsPerFile = 8 } = {}) {
  const parsed = observations.map(normalizeObservation).filter(Boolean);
  const paths = collectRelevantVerdictPaths(parsed);
  const out = [];
  for (const file of paths) {
    try {
      const raw = await executeEmbeddedAtlasTool("code.skeleton", { file }, {
        cwd,
        origin: "auto_feedback",
        ...(config ? { config } : {}),
      });
      if (String(raw || "").startsWith("Error:")) continue;
      const artifacts = extractAtlasResultArtifacts(raw, { action: "code.skeleton", args: { file } });
      const symbols = Array.isArray(artifacts?.symbols) ? artifacts.symbols : [];
      for (const sym of symbols.slice(0, maxSymbolsPerFile)) {
        if (isAtlasSymbolId(sym?.symbolId)) out.push(sym.symbolId);
      }
    } catch { /* best-effort; skip unresolvable files */ }
  }
  return out;
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
  const irrelevant = new Set();
  for (const obs of observations) {
    const type = String(obs.observation_type || "");
    const path = normalizeRepoPath(obs.detail?.path);
    if (!path) continue;
    if (["tool.read", "tool.edit", "tool.write", "tool.chain_read"].includes(type)) {
      out.add(path);
      continue;
    }
    // A researcher's explicit chain verdict is the research analogue of a
    // dev touching a file: "relevant" earns the file's symbols a place in
    // feedback, "irrelevant" strips the chain_read that preceded it.
    if (type === "tool.chain_verdict") {
      if (String(obs.detail?.verdict || "") === "relevant") out.add(path);
      else irrelevant.add(path);
    }
  }
  for (const path of irrelevant) out.delete(path);
  return out;
}

function collectRelevantVerdictPaths(observations, maxPaths = 5) {
  const out = [];
  const seen = new Set();
  for (const obs of observations) {
    if (String(obs.observation_type || "") !== "tool.chain_verdict") continue;
    if (String(obs.detail?.verdict || "") !== "relevant") continue;
    const path = normalizeRepoPath(obs.detail?.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= maxPaths) break;
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
