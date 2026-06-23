// @ts-check
//
// Native ATLAS v2 usage accounting. This intentionally records compact local
// events rather than depending on the original ATLAS token accumulator.

import { okEnvelope, errorEnvelope } from "./envelope.js";

/**
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").UsageStatsParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
export function usageStats({ versionId, params, ledger, repoId }) {
  const db = ledgerDb(ledger);
  if (!db) return ledgerUnavailable("usage.stats", versionId);
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  const scope = ["session", "history", "both"].includes(String(params.scope || ""))
    ? String(params.scope)
    : "both";
  const since = typeof params.since === "string" && params.since.trim() ? params.since.trim() : null;
  const limit = clampInt(params.limit, 1, 100, 20);
  const aggregateLimit = clampInt(params.aggregateLimit, 1, 10000, 1000);
  const snapshotRows = readUsageRows(db, { repoId: effectiveRepoId, since, limit });
  const aggregateSourceRows = readUsageRows(db, { repoId: effectiveRepoId, since, limit: aggregateLimit });
  const aggregate = aggregateRows(aggregateSourceRows);
  const totalMatchingCalls = countUsageRows(db, { repoId: effectiveRepoId, since });
  aggregate.totalCalls = totalMatchingCalls;
  aggregate.truncated = totalMatchingCalls > aggregateSourceRows.length;
  aggregate.sampledCalls = aggregateSourceRows.length;
  const snapshots = snapshotRows.map((row) => usageSnapshot(row));
  const toolBreakdown = aggregateToolBreakdown(aggregateSourceRows);
  const response = {};
  if (scope === "session" || scope === "both") {
    response.session = {
      sessionId: "native-v2",
      repoId: effectiveRepoId,
      timestamp: new Date().toISOString(),
      ...aggregate,
      toolBreakdown,
      tokenAccounting: tokenAccountingMethod(),
    };
  }
  if (scope === "history" || scope === "both") {
    response.history = {
      snapshots,
      aggregate: {
        ...aggregate,
        topToolsBySavings: topToolsBySavings(toolBreakdown),
        tokenAccounting: tokenAccountingMethod(),
      },
    };
  }
  response.formattedSummary = formatSummary(aggregate);
  return okEnvelope({
    action: "usage.stats",
    versionId,
    data: response,
  });
}

/**
 * Best-effort usage recorder called by dispatch after a native v2 action runs.
 *
 * @param {{
 *   ledger?: import("../contracts/api.js").Ledger,
 *   action: string,
 *   repoId?: string | null,
 *   versionId?: string | null,
 *   startedAt: number,
 *   envelope: any,
 *   taskType?: string | null,
 * }} args
 */
export function recordAtlasUsageEvent({ ledger, action, repoId, versionId, startedAt, envelope, taskType = null }) {
  if (action === "usage.stats") return;
  const db = ledgerDb(ledger);
  if (!db) return;
  try {
    const ok = envelope?.ok === true ? 1 : 0;
    const resultBytes = Buffer.byteLength(JSON.stringify(envelope?.data ?? envelope?.error ?? {}), "utf8");
    const recordedAction = String(envelope?.action || action || "unknown");
    db.prepare(
      `INSERT INTO usage_events
         (ts, repo_id, action, ok, duration_ms, result_bytes, version_id, task_type, error_code)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      effectiveRepo(repoId, null),
      recordedAction,
      ok,
      Math.max(0, Date.now() - startedAt),
      resultBytes,
      versionId || null,
      taskType || null,
      envelope?.ok === false ? String(envelope?.error?.code || "error") : null,
    );
  } catch {
    // Usage accounting must never affect tool execution.
  }
}

function ledgerDb(ledger) {
  return typeof /** @type {any} */ (ledger)?._unsafeDb === "function"
    ? /** @type {any} */ (ledger)._unsafeDb()
    : null;
}

function ledgerUnavailable(action, versionId) {
  return errorEnvelope({
    action: /** @type {any} */ (action),
    versionId,
    code: "ledger_unavailable",
    message: `${action} requires a ledger-backed ATLAS context`,
  });
}

function effectiveRepo(ctxRepoId, paramRepoId) {
  const text = String(paramRepoId || ctxRepoId || "default").trim();
  return text || "default";
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function readUsageRows(db, { repoId, since, limit }) {
  const params = [repoId];
  let where = "WHERE repo_id = ?";
  if (since) {
    where += " AND ts >= ?";
    params.push(since);
  }
  params.push(limit);
  return db.prepare(
    `SELECT * FROM usage_events
     ${where}
     ORDER BY ts DESC
     LIMIT ?`,
  ).all(...params);
}

function countUsageRows(db, { repoId, since }) {
  const params = [repoId];
  let where = "WHERE repo_id = ?";
  if (since) {
    where += " AND ts >= ?";
    params.push(since);
  }
  const row = db.prepare(`SELECT COUNT(*) AS total FROM usage_events ${where}`).get(...params);
  return Number(row?.total || 0);
}

function aggregateRows(rows) {
  const totalAtlasTokens = rows.reduce((sum, row) => sum + estimateAtlasTokens(row), 0);
  const totalRawEquivalent = rows.reduce((sum, row) => sum + estimateRawEquivalent(row), 0);
  const totalSavedTokens = Math.max(0, totalRawEquivalent - totalAtlasTokens);
  const durations = rows.map((row) => Number(row.duration_ms || 0)).filter((n) => Number.isFinite(n));
  const okCalls = rows.filter((row) => Number(row.ok || 0) === 1).length;
  const errorCalls = rows.length - okCalls;
  return {
    totalAtlasTokens,
    totalRawEquivalent,
    totalSavedTokens,
    overallSavingsPercent: totalRawEquivalent > 0
      ? Math.round((totalSavedTokens / totalRawEquivalent) * 100)
      : 0,
    totalCalls: rows.length,
    okCalls,
    errorCalls,
    errorRatePercent: rows.length > 0 ? Math.round((errorCalls / rows.length) * 100) : 0,
    totalDurationMs: durations.reduce((sum, n) => sum + n, 0),
    avgDurationMs: durations.length > 0 ? Math.round(durations.reduce((sum, n) => sum + n, 0) / durations.length) : 0,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    byTaskType: aggregateByTaskType(rows),
    sessionCount: rows.length > 0 ? 1 : 0,
  };
}

function aggregateToolBreakdown(rows) {
  const byTool = new Map();
  for (const row of rows) {
    const tool = String(row.action || "unknown");
    const current = byTool.get(tool) || {
      tool,
      atlasTokens: 0,
      rawEquivalent: 0,
      savedTokens: 0,
      callCount: 0,
      okCount: 0,
      errorCount: 0,
      totalDurationMs: 0,
    };
    const atlasTokens = estimateAtlasTokens(row);
    const rawEquivalent = estimateRawEquivalent(row);
    current.atlasTokens += atlasTokens;
    current.rawEquivalent += rawEquivalent;
    current.savedTokens += Math.max(0, rawEquivalent - atlasTokens);
    current.callCount += 1;
    if (Number(row.ok || 0) === 1) current.okCount += 1;
    else current.errorCount += 1;
    current.totalDurationMs += Number(row.duration_ms || 0);
    byTool.set(tool, current);
  }
  return [...byTool.values()]
    .map((entry) => ({
      ...entry,
      avgDurationMs: entry.callCount > 0 ? Math.round(entry.totalDurationMs / entry.callCount) : 0,
      savingsPercent: entry.rawEquivalent > 0 ? Math.round((entry.savedTokens / entry.rawEquivalent) * 100) : 0,
    }))
    .sort((a, b) => b.savedTokens - a.savedTokens);
}

function topToolsBySavings(toolBreakdown) {
  return toolBreakdown
    .map((entry) => ({
      tool: entry.tool,
      savedTokens: entry.savedTokens,
      savingsPercent: entry.savingsPercent,
      callCount: entry.callCount,
    }))
    .slice(0, 10);
}

function usageSnapshot(row) {
  const atlasTokens = estimateAtlasTokens(row);
  const rawEquivalent = estimateRawEquivalent(row);
  const savedTokens = Math.max(0, rawEquivalent - atlasTokens);
  return {
    snapshotId: String(row.id),
    sessionId: "native-v2",
    repoId: row.repo_id,
    timestamp: row.ts,
    totalAtlasTokens: atlasTokens,
    totalRawEquivalent: rawEquivalent,
    totalSavedTokens: savedTokens,
    savingsPercent: rawEquivalent > 0 ? Math.round((savedTokens / rawEquivalent) * 100) : 0,
    callCount: 1,
    action: row.action,
    ok: Number(row.ok || 0) === 1,
    durationMs: Number(row.duration_ms || 0),
    estimated: {
      method: "result_bytes/action_multiplier",
      atlasTokens,
      rawEquivalent,
    },
  };
}

function estimateAtlasTokens(row) {
  return Math.max(1, Math.ceil(Number(row.result_bytes || 0) / 4));
}

function estimateRawEquivalent(row) {
  const atlasTokens = estimateAtlasTokens(row);
  const action = String(row.action || "");
  const multiplier = rawEquivalentMultiplier(action);
  return atlasTokens * multiplier;
}

function rawEquivalentMultiplier(action) {
  if (action === "runtime.queryOutput") return 6;
  if (action === "runtime.execute") return 3;
  if (action === "workflow") return 4;
  if (action.startsWith("code.") || action === "file.read") return 4;
  if (action.startsWith("slice.") || action === "context" || action === "context.summary") return 3;
  if (action.startsWith("memory.")) return 2;
  return 2;
}

function aggregateByTaskType(rows) {
  const out = {};
  for (const row of rows) {
    const key = String(row.task_type || "unspecified");
    const current = out[key] || { calls: 0, atlasTokens: 0, rawEquivalent: 0 };
    current.calls += 1;
    current.atlasTokens += estimateAtlasTokens(row);
    current.rawEquivalent += estimateRawEquivalent(row);
    out[key] = current;
  }
  for (const entry of Object.values(out)) {
    entry.savedTokens = Math.max(0, entry.rawEquivalent - entry.atlasTokens);
  }
  return out;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return Math.round(sorted[idx]);
}

function tokenAccountingMethod() {
  return {
    method: "result_bytes/action_multiplier",
    description: "Native v2 estimates ATLAS tokens from serialized result bytes and raw-equivalent savings from action-specific multipliers.",
    confidence: "estimate",
  };
}

function formatSummary(aggregate) {
  return `Native ATLAS v2 usage: ${aggregate.totalCalls} calls, ` +
    `${aggregate.totalSavedTokens} estimated tokens saved ` +
    `(${aggregate.overallSavingsPercent}% vs raw context estimate).`;
}
