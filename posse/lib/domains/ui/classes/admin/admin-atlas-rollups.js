// ATLAS telemetry folders consumed by the admin "ATLAS Report" tab.
// Reads job_observations rows where detail_json carries token usage
// or reliability signals, and folds them into per-method (token
// savings) and per-action (reliability) buckets.
//
// Pure transforms over row objects — no DB access, no I/O. The admin
// TUI passes rows in; these return sorted summaries.

function parseJsonObject(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function extractAtlasTokenUsage(detailJson) {
  const detail = parseJsonObject(detailJson);
  const usage = detail?.token_usage || detail?.tokenUsage || null;
  if (!usage || typeof usage !== "object") return null;
  const atlasTokens = finiteNumber(usage.atlas_tokens ?? usage.atlasTokens);
  const rawEquivalent = finiteNumber(usage.raw_equivalent ?? usage.rawEquivalent);
  if (atlasTokens == null || rawEquivalent == null || rawEquivalent <= 0) return null;
  const savedTokens = finiteNumber(usage.saved_tokens ?? usage.savedTokens) ?? (rawEquivalent - atlasTokens);
  return {
    atlas_tokens: atlasTokens,
    raw_equivalent: rawEquivalent,
    saved_tokens: savedTokens,
  };
}

export function foldAtlasTokenSavings(rows = []) {
  const byMethod = new Map();
  const ensure = (method) => {
    const key = String(method || "unknown");
    if (!byMethod.has(key)) {
      byMethod.set(key, {
        atlas_method: key,
        measured_calls: 0,
        raw_equivalent: 0,
        atlas_tokens: 0,
        saved_tokens: 0,
        negative_calls: 0,
      });
    }
    return byMethod.get(key);
  };
  for (const row of rows) {
    const usage = extractAtlasTokenUsage(row.detail_json);
    if (!usage) continue;
    const method = row.atlas_method || (String(row.observation_type || "") === "tool.atlas.prefetch" ? "prefetch" : "unknown");
    const bucket = ensure(method);
    bucket.measured_calls += 1;
    bucket.raw_equivalent += usage.raw_equivalent;
    bucket.atlas_tokens += usage.atlas_tokens;
    bucket.saved_tokens += usage.saved_tokens;
    if (usage.saved_tokens < 0) bucket.negative_calls += 1;
  }
  return [...byMethod.values()].sort((a, b) => {
    if (b.measured_calls !== a.measured_calls) return b.measured_calls - a.measured_calls;
    return String(a.atlas_method).localeCompare(String(b.atlas_method));
  });
}

export function deriveAtlasReliabilityAction(detail = {}, row = {}) {
  const explicitAction = String(detail.action || "").trim();
  if (explicitAction) return explicitAction;

  const hasReliabilitySignal = Object.prototype.hasOwnProperty.call(detail, "ok")
    || Object.prototype.hasOwnProperty.call(detail, "status")
    || Object.prototype.hasOwnProperty.call(detail, "error")
    || Object.prototype.hasOwnProperty.call(detail, "empty")
    || Object.prototype.hasOwnProperty.call(detail, "duration_ms")
    || Object.prototype.hasOwnProperty.call(detail, "durationMs")
    || Object.prototype.hasOwnProperty.call(detail, "result_chars")
    || Object.prototype.hasOwnProperty.call(detail, "resultChars")
    || Object.prototype.hasOwnProperty.call(detail, "fallback");
  if (!hasReliabilitySignal) return null;

  const fallback = String(detail.fallback || "").trim();
  if (fallback) {
    const origin = String(
      detail.origin || (row.observation_type === "tool.atlas.prefetch" ? "prefetch" : "agent")
    ).trim();
    return origin.toLowerCase() === "prefetch" ? "prefetch.fallback" : "fallback";
  }

  const summary = String(row.summary || "").trim();
  const summaryMatch = summary.match(/^ATLAS\s+([A-Za-z0-9_.:-]+)/i);
  if (summaryMatch?.[1]) return summaryMatch[1];

  return row.observation_type === "tool.atlas.prefetch" ? "prefetch" : "unknown";
}

export function extractAtlasToolReliability(row = {}) {
  const detail = parseJsonObject(row.detail_json);
  if (!detail || typeof detail !== "object") return null;
  if (detail.kind && String(detail.kind).toLowerCase() !== "atlas") return null;

  const action = deriveAtlasReliabilityAction(detail, row);
  if (!action) return null;
  const origin = String(
    detail.origin || (row.observation_type === "tool.atlas.prefetch" ? "prefetch" : "agent")
  ).trim() || "agent";
  const status = String(detail.status || "").trim().toLowerCase();
  const errorText = String(detail.error || "").trim();
  const ok = detail.ok === true;
  const cancelled = status === "cancelled"
    || status === "canceled"
    || /user cancelled mcp tool call|cancelled|canceled/i.test(errorText);
  const failed = detail.ok === false || !!errorText || cancelled || status === "error" || status === "failed";
  const hasResultChars = Object.prototype.hasOwnProperty.call(detail, "result_chars")
    || Object.prototype.hasOwnProperty.call(detail, "resultChars");
  const resultChars = finiteNumber(detail.result_chars ?? detail.resultChars);
  const empty = detail.empty === true || (ok && hasResultChars && Number(resultChars || 0) === 0);

  return {
    action,
    origin,
    ok,
    failed,
    cancelled,
    empty,
    fallback: !!detail.fallback,
    duration_ms: finiteNumber(detail.duration_ms ?? detail.durationMs),
    result_chars: resultChars,
  };
}

export function foldAtlasToolReliability(rows = []) {
  const byAction = new Map();
  const ensure = (action, origin) => {
    const key = `${origin}\u0000${action}`;
    if (!byAction.has(key)) {
      byAction.set(key, {
        action,
        origin,
        calls: 0,
        ok_calls: 0,
        failed_calls: 0,
        cancelled_calls: 0,
        empty_calls: 0,
        fallback_calls: 0,
        duration_calls: 0,
        total_duration_ms: 0,
        result_char_calls: 0,
        total_result_chars: 0,
      });
    }
    return byAction.get(key);
  };

  for (const row of rows) {
    const entry = extractAtlasToolReliability(row);
    if (!entry) continue;
    const bucket = ensure(entry.action, entry.origin);
    bucket.calls += 1;
    if (entry.ok) bucket.ok_calls += 1;
    if (entry.failed) bucket.failed_calls += 1;
    if (entry.cancelled) bucket.cancelled_calls += 1;
    if (entry.empty) bucket.empty_calls += 1;
    if (entry.fallback) bucket.fallback_calls += 1;
    if (entry.duration_ms != null) {
      bucket.duration_calls += 1;
      bucket.total_duration_ms += entry.duration_ms;
    }
    if (entry.result_chars != null) {
      bucket.result_char_calls += 1;
      bucket.total_result_chars += entry.result_chars;
    }
  }

  return [...byAction.values()].map((row) => ({
    ...row,
    avg_duration_ms: row.duration_calls > 0 ? Math.round(row.total_duration_ms / row.duration_calls) : null,
    avg_result_chars: row.result_char_calls > 0 ? Math.round(row.total_result_chars / row.result_char_calls) : null,
  })).sort((a, b) => {
    if (b.calls !== a.calls) return b.calls - a.calls;
    if (b.failed_calls !== a.failed_calls) return b.failed_calls - a.failed_calls;
    const actionCmp = String(a.action).localeCompare(String(b.action));
    if (actionCmp !== 0) return actionCmp;
    return String(a.origin).localeCompare(String(b.origin));
  });
}

const NATIVE_DISCOVERY_OBSERVATIONS = new Set([
  "tool.search",
  "tool.read",
  "tool.list",
  "tool.chain_read",
  "tool.inspect",
  "tool.git_history",
]);

// Retention is a job-scoped KPI for fresh observations. Rows without job_id or
// attempt_id are usually from purged/cleared history and would collapse into a
// blended pseudo-job, so the fold excludes them even if callers forget to.
export function foldAtlasRetention(rows = []) {
  const scopes = new Map();
  const ensure = (row) => {
    const key = `${row.job_id ?? "job?"}\u0000${row.attempt_id ?? "attempt?"}`;
    if (!scopes.has(key)) {
      scopes.set(key, {
        key,
        work_item_id: row.work_item_id ?? null,
        job_id: row.job_id ?? null,
        attempt_id: row.attempt_id ?? null,
        prefetch_seen: false,
        prefetch_id: null,
        atlas_calls_after_prefetch: 0,
        native_discovery_after_prefetch: 0,
      });
    }
    return scopes.get(key);
  };

  const sorted = [...rows].sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
  for (const row of sorted) {
    if (row.job_id == null || row.attempt_id == null) continue;
    const type = String(row.observation_type || "");
    const scope = ensure(row);
    if (type === "tool.atlas.prefetch" && !scope.prefetch_seen) {
      scope.prefetch_seen = true;
      scope.prefetch_id = Number(row.id || 0);
      continue;
    }
    if (!scope.prefetch_seen || Number(row.id || 0) <= Number(scope.prefetch_id || 0)) continue;
    if (type === "tool.atlas") scope.atlas_calls_after_prefetch += 1;
    else if (isNativeDiscoveryObservation(row)) scope.native_discovery_after_prefetch += 1;
  }

  const scopeRows = [...scopes.values()]
    .filter((row) => row.prefetch_seen)
    .map((row) => {
      const denominator = row.atlas_calls_after_prefetch + row.native_discovery_after_prefetch;
      return {
        ...row,
        measured_calls: denominator,
        retention_pct: denominator > 0
          ? Math.round((100 * row.atlas_calls_after_prefetch) / denominator)
          : null,
      };
    })
    .filter((row) => row.measured_calls > 0)
    .sort((a, b) => {
      if (b.measured_calls !== a.measured_calls) return b.measured_calls - a.measured_calls;
      return Number(b.prefetch_id || 0) - Number(a.prefetch_id || 0);
    });

  const total = scopeRows.reduce((acc, row) => {
    acc.scopes += 1;
    acc.atlas_calls_after_prefetch += row.atlas_calls_after_prefetch;
    acc.native_discovery_after_prefetch += row.native_discovery_after_prefetch;
    acc.measured_calls += row.measured_calls;
    return acc;
  }, {
    scopes: 0,
    atlas_calls_after_prefetch: 0,
    native_discovery_after_prefetch: 0,
    measured_calls: 0,
    retention_pct: null,
  });
  total.retention_pct = total.measured_calls > 0
    ? Math.round((100 * total.atlas_calls_after_prefetch) / total.measured_calls)
    : null;
  return { total, scopes: scopeRows };
}

function isNativeDiscoveryObservation(row) {
  const type = String(row.observation_type || "");
  if (NATIVE_DISCOVERY_OBSERVATIONS.has(type)) return true;
  if (type !== "tool.bash") return false;
  const detail = parseJsonObject(row.detail_json);
  const command = String(detail?.command || detail?.args?.command || row.summary || "").toLowerCase();
  return /\b(rg|grep|find|ls|dir|cat|sed|awk|git\s+(show|grep|log|diff))\b/.test(command);
}
