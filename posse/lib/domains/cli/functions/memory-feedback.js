// Shared memory-review operations: the single implementation behind both the
// `posse admin memory ...` commands and the TUI review screen's memory
// actions, so the review UI can never advertise an action the system does not
// actually perform.

import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { callAtlasMemoryAction } from "../../integrations/functions/atlas-memory.js";
import { logEvent } from "../../queue/functions/index.js";

export const MEMORY_FEEDBACK_ACTIONS = Object.freeze(["note", "suppress", "correct", "flag"]);

/**
 * @param {string} action
 * @param {string} memoryId
 * @param {unknown} [detail]
 */
export function recordMemoryFeedbackEvent(action, memoryId, detail = null) {
  try {
    logEvent({
      event_type: EVENT_TYPES.KAIZEN_MEMORY_FEEDBACK,
      actor_type: EVENT_ACTORS.HUMAN,
      message: `Memory ${action}: ${memoryId}`,
      event_json: JSON.stringify({
        action,
        memory_id: memoryId,
        detail,
        review_visible: true,
      }),
    });
  } catch {
    // Feedback logging is best effort; the operation result still matters.
  }
}

/**
 * Record a human review note. Observability only — ATLAS confidence and the
 * memory row are not changed.
 *
 * @param {string} memoryId
 * @param {{ detail?: unknown }} [opts]
 * @returns {{ ok: boolean }}
 */
export function applyMemoryNote(memoryId, { detail = null } = {}) {
  recordMemoryFeedbackEvent("note", memoryId, detail);
  return { ok: true };
}

/**
 * Soft-delete the memory (it stops surfacing AND stops being queryable as
 * active). The deliberate "this should not exist" action, routed through the
 * memory.feedback suppress verdict — the only removal route ATLAS implements.
 *
 * @param {string} memoryId
 * @param {{ cwd?: string, detail?: unknown }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function applyMemorySuppress(memoryId, { cwd = process.cwd(), detail = null, memoryClient = null } = {}) {
  const result = await callAtlasMemoryAction("memory.feedback", {
    memoryId,
    verdict: "suppress",
    ...(detail ? { detail: String(detail).slice(0, 500) } : {}),
  }, { cwd, memoryClient }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  if (!result?.ok) {
    return { ok: false, error: String(result?.error || result?.skipped || "ATLAS memory unavailable") };
  }
  recordMemoryFeedbackEvent("suppress", memoryId, detail);
  return { ok: true };
}

/** How human flag reasons map onto the ATLAS evidence verdicts. */
const FLAG_REASON_TO_VERDICT = Object.freeze({
  contradicted: "wrong",
  wrong: "wrong",
  duplicate: "duplicate",
});

/**
 * Flag the memory stale with an evidence reason (it stops auto-surfacing but
 * stays queryable and correctable). Gentler than suppress. Routed through the
 * memory.feedback evidence verdicts; the human-facing reason rides along in
 * detail and the local review event.
 *
 * @param {string} memoryId
 * @param {{ cwd?: string, reason?: string, detail?: string | null }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function applyMemoryFlag(memoryId, { cwd = process.cwd(), reason = "manual", detail = null, memoryClient = null } = {}) {
  const normalizedReason = String(reason || "manual").trim().toLowerCase();
  const verdict = FLAG_REASON_TO_VERDICT[normalizedReason] || "stale";
  const detailText = [
    `flag reason: ${normalizedReason}`,
    ...(detail ? [String(detail)] : []),
  ].join(" — ").slice(0, 500);
  const result = await callAtlasMemoryAction("memory.feedback", {
    memoryId,
    verdict,
    detail: detailText,
  }, { cwd, memoryClient }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  if (!result?.ok) {
    return { ok: false, error: String(result?.error || result?.skipped || "ATLAS memory unavailable") };
  }
  recordMemoryFeedbackEvent("flag", memoryId, { reason: normalizedReason, verdict, detail });
  return { ok: true };
}

/**
 * Store a correction memory, then suppress the memory it corrects. The
 * suppression result is checked: a correction that leaves the wrong memory
 * surfacing must not report success.
 *
 * @param {string} memoryId
 * @param {string} replacement
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, correctionMemoryId?: string | null }>}
 */
export async function applyMemoryCorrection(memoryId, replacement, { cwd = process.cwd(), memoryClient = null } = {}) {
  const text = String(replacement || "").trim();
  if (!text) return { ok: false, error: "Correction text is required." };
  const stored = await callAtlasMemoryAction("memory.store", {
    title: `Correction for ${memoryId}`.slice(0, 120),
    content: [
      `Correction for prior memory ${memoryId}:`,
      "",
      text,
      "",
      "Source: human review memory correction.",
    ].join("\n").slice(0, 1200),
  }, { cwd, memoryClient }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  if (!stored?.ok) {
    return { ok: false, error: String(stored?.error || stored?.skipped || "ATLAS memory unavailable") };
  }
  const correctionMemoryId = stored?.json?.memoryId || stored?.json?.memory_id || null;
  const suppressed = await applyMemorySuppress(memoryId, {
    cwd,
    memoryClient,
    detail: `superseded by correction ${correctionMemoryId || "(unknown id)"}`,
  });
  if (!suppressed.ok) {
    return {
      ok: false,
      error: `Correction stored as ${correctionMemoryId || "(unknown id)"}, but suppressing ${memoryId} failed: ${suppressed.error}`,
      correctionMemoryId,
    };
  }
  recordMemoryFeedbackEvent("correct", memoryId, text);
  return { ok: true, correctionMemoryId };
}

/**
 * Uniform entry point for review surfaces: apply one memory review action.
 *
 * @param {{ action: string, memoryId: string, replacement?: string, reason?: string, detail?: string | null, cwd?: string }} args
 * @returns {Promise<{ ok: boolean, error?: string, correctionMemoryId?: string | null }>}
 */
export async function applyMemoryReviewAction({ action, memoryId, replacement = "", reason = "manual", detail = null, cwd = process.cwd(), memoryClient = null } = {}) {
  const normalized = String(action || "").trim().toLowerCase();
  const id = String(memoryId || "").trim();
  if (!id) return { ok: false, error: "memoryId is required" };
  if (normalized === "note") return applyMemoryNote(id, { detail });
  if (normalized === "suppress") return applyMemorySuppress(id, { cwd, detail, memoryClient });
  if (normalized === "flag") return applyMemoryFlag(id, { cwd, reason, detail, memoryClient });
  if (normalized === "correct") return applyMemoryCorrection(id, replacement, { cwd, memoryClient });
  return { ok: false, error: `Unknown memory action: ${normalized}` };
}
