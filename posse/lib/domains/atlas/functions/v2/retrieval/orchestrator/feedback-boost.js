// @ts-check
//
// Feedback boost. Reads aggregate feedback counts from the ledger and
// adjusts fused scores based on prior agent.feedback signals.
//
// Boost formula (intentionally simple — easy to tune later):
//   netSignal = useful_signal - missing_signal
//   multiplier = 1 + (BOOST_PER_SIGNAL * clamp(netSignal, -3, +3))
//
// We cap netSignal so a small number of strong opinions don't run away
// with the ranking. BOOST_PER_SIGNAL is small so a few signals nudge
// rather than dominate the fused order.
//
// Decay: when `halfLifeDays` is set on buildFeedbackIndex, signals
// contribute `exp(-age_days / halfLifeDays)` to the sum instead of 1.
// The plan called this out as a future tuning — the v1 default is
// equal-weight (no decay), but callers can opt in.

import { symbolIdOf } from "../cards.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../../../../catalog/event.js";
import { logEvent } from "../../../../../queue/functions/events.js";

/** @typedef {import("../../contracts/api.js").Ledger} Ledger */
/** @typedef {import("../../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../../contracts/api.js").FeedbackAggregate} FeedbackAggregate */
/** @typedef {import("./rrf.js").FusedEntry<ViewSymbol>} FusedSymbolEntry */

/** Each clamped signal step shifts the multiplier by this much. */
export const BOOST_PER_SIGNAL = 0.15;

/** Hard clamp on the net-signal contribution; protects against runaways. */
const MAX_ABS_SIGNAL = 3;

/**
 * Build an index keyed by symbolId from the ledger's aggregate. The
 * orchestrator passes this to {@link applyFeedbackBoost}. Returns null
 * when no ledger is available so callers can skip the boost cheaply.
 *
 * @param {{ ledger?: Ledger, taskType?: string, taskText?: string, sinceTs?: string, halfLifeDays?: number }} args
 * @returns {Map<string, FeedbackAggregate> | null}
 */
export function buildFeedbackIndex({ ledger, taskType, taskText, sinceTs, halfLifeDays }) {
  if (!ledger || typeof ledger.recentFeedback !== "function") return null;
  try {
    const rows = ledger.recentFeedback({
      taskType,
      taskText,
      sinceTs,
      halfLifeDays,
      onTaskTextMatch: emitFeedbackTaskTextMatch,
    });
    /** @type {Map<string, FeedbackAggregate>} */
    const map = new Map();
    for (const r of rows) {
      const id = `${r.content_hash}:${r.local_id}`;
      // If a taskType filter was passed and that produces zero rows
      // for the symbol, the GROUP BY would have omitted the row anyway,
      // so we don't need to merge.
      map.set(id, r);
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * @param {{ taskText: string, prior_task_text: string | null, score: number | null, included_in_filter: boolean, threshold: number, reason?: string }} detail
 */
function emitFeedbackTaskTextMatch(detail) {
  try {
    logEvent({
      event_type: EVENT_TYPES.ATLAS_FEEDBACK_TASK_TEXT_MATCH,
      actor_type: EVENT_ACTORS.ATLAS,
      message: "ATLAS feedback task-text filter evaluated",
      event_json: detail,
    });
  } catch {
    // Feedback boosts should remain pure-ranking behavior when the host event
    // DB is unavailable (for example in isolated ATLAS tests).
  }
}

/**
 * Apply the boost multiplier to fused entries in place and return them.
 * No-op when feedbackIndex is null or empty.
 *
 * When the aggregate carries decayed weights (set by the ledger when
 * `halfLifeDays` was requested), the boost uses them in place of the
 * raw counts. Otherwise it falls back to the count-based path.
 *
 * @param {FusedSymbolEntry[]} fused
 * @param {Map<string, FeedbackAggregate> | null} feedbackIndex
 * @returns {FusedSymbolEntry[]}
 */
export function applyFeedbackBoost(fused, feedbackIndex) {
  if (!feedbackIndex || feedbackIndex.size === 0) return fused;
  for (const entry of fused) {
    const agg = feedbackIndex.get(entry.id);
    if (!agg) continue;
    const useful = agg.useful_weight ?? agg.useful_count;
    const missing = agg.missing_weight ?? agg.missing_count;
    const net = clampSignal(useful - missing);
    const multiplier = 1 + BOOST_PER_SIGNAL * net;
    if (multiplier === 1) continue;
    entry.score *= multiplier;
    /** @type {any} */ (entry).feedback = {
      useful_count: agg.useful_count,
      missing_count: agg.missing_count,
      useful_weight: agg.useful_weight,
      missing_weight: agg.missing_weight,
      multiplier,
    };
  }
  // Re-sort under the new scores; tie-break on id for determinism.
  fused.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id.localeCompare(b.id);
  });
  return fused;
}

/**
 * For convenience when looking up by ViewSymbol rather than id string.
 *
 * @param {Map<string, FeedbackAggregate>} feedbackIndex
 * @param {ViewSymbol} symbol
 * @returns {FeedbackAggregate | null}
 */
export function feedbackForSymbol(feedbackIndex, symbol) {
  if (!feedbackIndex) return null;
  return feedbackIndex.get(symbolIdOf(symbol)) ?? null;
}

/** @param {number} n */
function clampSignal(n) {
  if (n > MAX_ABS_SIGNAL) return MAX_ABS_SIGNAL;
  if (n < -MAX_ABS_SIGNAL) return -MAX_ABS_SIGNAL;
  return n;
}
