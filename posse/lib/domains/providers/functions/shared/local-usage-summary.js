// @ts-check
//
// Shared local token-usage summary helpers for OpenAI-compatible providers.
// Both Codex and OpenAI derive their "posse-agent-calls" usage view from the
// same agent_calls query and the same per-window rollup; the only per-provider
// differences are the window definitions, the provider match, and the
// surrounding summary object (which stays in each provider file).

import { getDb } from "../../../../shared/storage/functions/index.js";

/**
 * @typedef {{ key: string, label: string, durationMs: number }} UsageWindowDef
 * @typedef {{ timestampMs: number, totalTokens: number }} UsageEntry
 */

/**
 * Roll loaded usage entries up into per-window totals/limits/reset times.
 *
 * @param {UsageEntry[]} entries
 * @param {number} nowMs
 * @param {Record<string, number | null | undefined> | null | undefined} limits
 * @param {UsageWindowDef[]} windowDefs
 * @returns {Array<{ key: string, label: string, durationMs: number, usedTokens: number, limitTokens: number | null, remainingTokens: number | null, resetAt: string | null }>}
 */
export function summarizeUsageEntries(entries, nowMs, limits, windowDefs) {
  return windowDefs.map((def) => {
    const cutoff = nowMs - def.durationMs;
    const matching = entries.filter((entry) => entry.timestampMs >= cutoff);
    const usedTokens = matching.reduce((sum, entry) => sum + entry.totalTokens, 0);
    const oldestTs = matching.reduce((min, entry) => Math.min(min, entry.timestampMs), Number.POSITIVE_INFINITY);
    const limitTokens = limits?.[def.key] ?? null;
    const remainingTokens = limitTokens == null ? null : Math.max(0, limitTokens - usedTokens);
    const resetAt = Number.isFinite(oldestTs) ? new Date(oldestTs + def.durationMs).toISOString() : null;
    return {
      key: def.key,
      label: def.label,
      durationMs: def.durationMs,
      usedTokens,
      limitTokens,
      remainingTokens,
      resetAt,
    };
  });
}

/**
 * Load this provider's positive-token agent_calls rows within the widest
 * window, mapped to `{ timestampMs, totalTokens }`. Best-effort: any DB
 * failure yields an empty list rather than throwing.
 *
 * @param {{
 *   nowMs: number,
 *   windowDefs: UsageWindowDef[],
 *   provider: string,
 *   normalizeProvider?: boolean,
 * }} args
 * @returns {UsageEntry[]}
 */
export function loadUsageEntries({ nowMs, windowDefs, provider, normalizeProvider = false }) {
  try {
    const weekWindow = windowDefs.find((def) => def.key === "week")?.durationMs || (7 * 24 * 60 * 60 * 1000);
    const oldestRelevantIso = new Date(nowMs - weekWindow).toISOString();
    const db = getDb();
    // provider is a fixed internal constant; bind it as a parameter and only
    // vary the column expression (Codex stores mixed-case/whitespace values).
    const providerExpr = normalizeProvider ? "LOWER(TRIM(provider))" : "provider";
    const rows = db.prepare(`
      SELECT created_at, input_tokens, output_tokens
      FROM agent_calls
      WHERE ${providerExpr} = ?
        AND created_at >= ?
        AND COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0
      ORDER BY created_at ASC
    `).all(provider, oldestRelevantIso);

    return rows.flatMap((row) => {
      const timestampMs = Date.parse(row.created_at);
      const totalTokens = (row.input_tokens || 0) + (row.output_tokens || 0);
      if (!Number.isFinite(timestampMs) || totalTokens <= 0) return [];
      return [{ timestampMs, totalTokens }];
    });
  } catch {
    return [];
  }
}
