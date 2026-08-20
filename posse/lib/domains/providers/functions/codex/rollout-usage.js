import fs from "node:fs";
import path from "node:path";

function token(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

const USAGE_FIELDS = Object.freeze([
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningOutputTokens",
  "longContextInputTokens",
]);

export function reconcileCodexFreshSessionUsage(streamUsage = {}, rolloutUsage = {}) {
  const usage = {};
  const mismatches = [];

  for (const field of USAGE_FIELDS) {
    const streamValue = token(streamUsage?.[field]);
    const rolloutValue = token(rolloutUsage?.[field]);
    if (streamValue != null && rolloutValue != null && streamValue !== rolloutValue) {
      mismatches.push({ field, streamValue, rolloutValue });
    }
    // A complete rollout is the authoritative close-time source. Stream
    // totals remain useful for progress and mismatch diagnostics, but mixing
    // their maxima into recovered request segments creates a call total that
    // no single ordinal space can prove.
    usage[field] = rolloutValue ?? streamValue;
  }

  return {
    usage,
    mismatches,
    source: "codex_rollout",
  };
}

function dayDirectories(startedAtMs) {
  const timestamp = Number(startedAtMs);
  if (!Number.isFinite(timestamp)) return [];
  return [-1, 0, 1].map((offset) => {
    const date = new Date(timestamp + offset * 86_400_000);
    return [
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    ];
  });
}

export function parseCodexRolloutUsage(text, { expectedSessionHandle = null } = {}) {
  let sessionHandle = null;
  let usage = null;
  let malformedLines = 0;
  let previousTotalInputTokens = null;
  let previousTotalOutputTokens = null;
  let previousTotalCachedInputTokens = null;
  let longContextInputTokens = null;
  const segments = [];

  for (const line of String(text || "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    const payload = row?.payload || {};
    if (row?.type === "session_meta") {
      sessionHandle = String(payload.session_id || payload.id || "").trim() || sessionHandle;
    }
    if (row?.type !== "event_msg" || payload.type !== "token_count") continue;
    const total = payload?.info?.total_token_usage;
    const inputTokens = token(total?.input_tokens);
    const outputTokens = token(total?.output_tokens);
    if (inputTokens == null || outputTokens == null) continue;
    const cachedInputTokens = token(total?.cached_input_tokens);
    const reasoningOutputTokens = token(total?.reasoning_output_tokens);
    const lastInputTokens = token(payload?.info?.last_token_usage?.input_tokens);
    const lastOutputTokens = token(payload?.info?.last_token_usage?.output_tokens);
    const lastCachedInputTokens = token(payload?.info?.last_token_usage?.cached_input_tokens);
    const inputSegment = lastInputTokens ?? (
      previousTotalInputTokens == null || inputTokens < previousTotalInputTokens
        ? inputTokens
        : inputTokens - previousTotalInputTokens
    );
    const outputSegment = lastOutputTokens ?? (
      previousTotalOutputTokens == null || outputTokens < previousTotalOutputTokens
        ? outputTokens
        : outputTokens - previousTotalOutputTokens
    );
    const cachedSegment = lastCachedInputTokens ?? (
      cachedInputTokens == null
        ? 0
        : (previousTotalCachedInputTokens == null || cachedInputTokens < previousTotalCachedInputTokens
          ? cachedInputTokens
          : cachedInputTokens - previousTotalCachedInputTokens)
    );
    const totalChanged = inputTokens !== previousTotalInputTokens || outputTokens !== previousTotalOutputTokens;
    previousTotalInputTokens = inputTokens;
    previousTotalOutputTokens = outputTokens;
    previousTotalCachedInputTokens = cachedInputTokens;
    longContextInputTokens = Math.max(longContextInputTokens ?? 0, inputSegment);
    if (totalChanged && inputSegment != null && outputSegment != null) {
      segments.push({
        inputTokens: inputSegment,
        outputTokens: outputSegment,
        cachedInputTokens: cachedSegment ?? 0,
        cacheCreationInputTokens: 0,
        requestContextInputTokens: inputSegment,
      });
    }
    usage = {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens,
      longContextInputTokens,
    };
  }

  const expected = String(expectedSessionHandle || "").trim();
  if (expected && sessionHandle !== expected) return null;
  const segmentTotals = segments.reduce((totals, segment) => ({
    inputTokens: totals.inputTokens + segment.inputTokens,
    outputTokens: totals.outputTokens + segment.outputTokens,
    cachedInputTokens: totals.cachedInputTokens + segment.cachedInputTokens,
  }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  const complete = malformedLines === 0
    && usage != null
    && segments.length > 0
    && segmentTotals.inputTokens === usage.inputTokens
    && segmentTotals.outputTokens === usage.outputTokens
    && segmentTotals.cachedInputTokens === (usage.cachedInputTokens ?? 0);
  // token_count rows are cumulative snapshots within one `codex exec` turn,
  // not CLI-turn boundaries. Request cardinality is reported separately.
  return {
    sessionHandle,
    usage,
    segments,
    numTurns: usage ? 1 : null,
    providerRequestCount: segments.length,
    malformedLines,
    complete,
  };
}

function sumSegments(segments) {
  const usage = (segments || []).reduce((totals, segment) => ({
    inputTokens: totals.inputTokens + (token(segment?.inputTokens) ?? 0),
    outputTokens: totals.outputTokens + (token(segment?.outputTokens) ?? 0),
    cachedInputTokens: totals.cachedInputTokens + (token(segment?.cachedInputTokens) ?? 0),
    longContextInputTokens: Math.max(
      totals.longContextInputTokens ?? 0,
      token(segment?.requestContextInputTokens) ?? token(segment?.inputTokens) ?? 0,
    ),
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    longContextInputTokens: null,
  });
  return usage;
}

/**
 * Select only provider requests appended after a resumed-session baseline.
 * Both snapshots use the same durable rollout ordinal space; historical
 * requests are never projected into the new agent call.
 */
export function sliceCodexResumedSessionUsage(baseline, current) {
  if (!baseline || !current || baseline.complete !== true || current.complete !== true) return null;
  if (baseline.sessionHandle !== current.sessionHandle) return null;
  if ((current.segments?.length || 0) < (baseline.segments?.length || 0)) return null;
  const segments = current.segments.slice(baseline.segments.length);
  if (segments.length === 0) return null;
  const usage = sumSegments(segments);
  const currentReasoning = token(current.usage?.reasoningOutputTokens);
  const baselineReasoning = token(baseline.usage?.reasoningOutputTokens);
  usage.reasoningOutputTokens = currentReasoning == null
    ? null
    : Math.max(0, currentReasoning - (baselineReasoning ?? 0));
  return {
    ...current,
    usage,
    segments,
    numTurns: 1,
    providerRequestCount: segments.length,
    complete: true,
    resumedFromProviderRequestCount: baseline.segments.length,
  };
}

export function findCodexRolloutFile(codexHome, sessionHandle, startedAtMs) {
  const home = String(codexHome || "").trim();
  const handle = String(sessionHandle || "").trim();
  if (!home || !/^[a-z0-9-]{16,80}$/iu.test(handle)) return null;
  for (const parts of dayDirectories(startedAtMs)) {
    const directory = path.join(home, "sessions", ...parts);
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    const match = entries.find((entry) => entry.isFile() && entry.name.endsWith(`-${handle}.jsonl`));
    if (match) return path.join(directory, match.name);
  }
  // A resumed session can be older than the call's start date. Search the
  // bounded YYYY/MM/DD rollout hierarchy only when the fast date lookup did
  // not find it.
  const sessionsRoot = path.join(home, "sessions");
  let years = [];
  try { years = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { return null; }
  for (const year of years) {
    if (!year.isDirectory() || !/^\d{4}$/u.test(year.name)) continue;
    let months = [];
    try { months = fs.readdirSync(path.join(sessionsRoot, year.name), { withFileTypes: true }); } catch { continue; }
    for (const month of months) {
      if (!month.isDirectory() || !/^\d{2}$/u.test(month.name)) continue;
      let days = [];
      try { days = fs.readdirSync(path.join(sessionsRoot, year.name, month.name), { withFileTypes: true }); } catch { continue; }
      for (const day of days) {
        if (!day.isDirectory() || !/^\d{2}$/u.test(day.name)) continue;
        const directory = path.join(sessionsRoot, year.name, month.name, day.name);
        let entries = [];
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
        const match = entries.find((entry) => entry.isFile() && entry.name.endsWith(`-${handle}.jsonl`));
        if (match) return path.join(directory, match.name);
      }
    }
  }
  return null;
}

export function recoverCodexRolloutUsage({ codexHome, sessionHandle, startedAtMs } = {}) {
  const file = findCodexRolloutFile(codexHome, sessionHandle, startedAtMs);
  if (!file) return null;
  try {
    const parsed = parseCodexRolloutUsage(fs.readFileSync(file, "utf8"), {
      expectedSessionHandle: sessionHandle,
    });
    return parsed?.usage ? { ...parsed, file: path.basename(file), filePath: file } : null;
  } catch {
    return null;
  }
}
