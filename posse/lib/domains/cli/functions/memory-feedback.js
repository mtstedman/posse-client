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
 * active). The deliberate "this should not exist" action.
 *
 * @param {string} memoryId
 * @param {{ cwd?: string, detail?: unknown }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function applyMemorySuppress(memoryId, { cwd = process.cwd(), detail = null } = {}) {
  const result = await callAtlasMemoryAction("memory.remove", {
    memoryId,
    deleteFile: false,
  }, { cwd }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  if (!result?.ok) {
    return { ok: false, error: String(result?.error || result?.skipped || "ATLAS memory unavailable") };
  }
  recordMemoryFeedbackEvent("suppress", memoryId, detail);
  return { ok: true };
}

/**
 * Flag the memory stale with an evidence reason (it stops auto-surfacing but
 * stays queryable and correctable). Gentler than suppress.
 *
 * @param {string} memoryId
 * @param {{ cwd?: string, reason?: string, detail?: string | null }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function applyMemoryFlag(memoryId, { cwd = process.cwd(), reason = "manual", detail = null } = {}) {
  const result = await callAtlasMemoryAction("memory.flag", {
    memoryId,
    reason,
    ...(detail ? { detail: String(detail) } : {}),
  }, { cwd }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  if (!result?.ok) {
    return { ok: false, error: String(result?.error || result?.skipped || "ATLAS memory unavailable") };
  }
  recordMemoryFeedbackEvent("flag", memoryId, { reason, detail });
  return { ok: true };
}

/**
 * Store a correction memory, then soft-delete the memory it corrects.
 *
 * @param {string} memoryId
 * @param {string} replacement
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, correctionMemoryId?: string | null }>}
 */
export async function applyMemoryCorrection(memoryId, replacement, { cwd = process.cwd() } = {}) {
  const text = String(replacement || "").trim();
  if (!text) return { ok: false, error: "Correction text is required." };
  const stored = await callAtlasMemoryAction("memory.store", {
    type: "decision",
    title: `Correction for ${memoryId}`.slice(0, 120),
    content: [
      `Correction for prior memory ${memoryId}:`,
      "",
      text,
      "",
      "Source: human review memory correction.",
    ].join("\n"),
    tags: ["posse-kaizen", "correction"],
    confidence: 0.95,
  }, { cwd }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  if (!stored?.ok) {
    return { ok: false, error: String(stored?.error || stored?.skipped || "ATLAS memory unavailable") };
  }
  await callAtlasMemoryAction("memory.remove", { memoryId, deleteFile: false }, { cwd }).catch(() => null);
  recordMemoryFeedbackEvent("correct", memoryId, text);
  return {
    ok: true,
    correctionMemoryId: stored?.json?.memoryId || stored?.json?.memory_id || null,
  };
}

/**
 * Uniform entry point for review surfaces: apply one memory review action.
 *
 * @param {{ action: string, memoryId: string, replacement?: string, reason?: string, detail?: string | null, cwd?: string }} args
 * @returns {Promise<{ ok: boolean, error?: string, correctionMemoryId?: string | null }>}
 */
export async function applyMemoryReviewAction({ action, memoryId, replacement = "", reason = "manual", detail = null, cwd = process.cwd() } = {}) {
  const normalized = String(action || "").trim().toLowerCase();
  const id = String(memoryId || "").trim();
  if (!id) return { ok: false, error: "memoryId is required" };
  if (normalized === "note") return applyMemoryNote(id, { detail });
  if (normalized === "suppress") return applyMemorySuppress(id, { cwd, detail });
  if (normalized === "flag") return applyMemoryFlag(id, { cwd, reason, detail });
  if (normalized === "correct") return applyMemoryCorrection(id, replacement, { cwd });
  return { ok: false, error: `Unknown memory action: ${normalized}` };
}
