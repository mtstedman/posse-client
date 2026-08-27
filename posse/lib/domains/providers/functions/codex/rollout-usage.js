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

export function resolveCodexCloseTurns({
  latestTurnCount = null,
  completedTurnEvents = 0,
  rolloutUsageApplied = false,
  rolloutUsage = null,
} = {}) {
  const streamed = token(latestTurnCount);
  if (streamed != null) return streamed;
  const completed = token(completedTurnEvents);
  if (completed != null && completed > 0) return completed;
  if (rolloutUsageApplied !== true) return null;
  const recovered = token(rolloutUsage?.numTurns);
  return recovered != null && recovered > 0 ? recovered : null;
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
  // Each changed durable token_count snapshot closes one provider request.
  // The live stream can omit turn.completed under pressure, so this durable
  // request count is also the close-time turn fallback.
  return {
    sessionHandle,
    usage,
    segments,
    numTurns: segments.length > 0 ? segments.length : null,
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
    numTurns: segments.length,
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

// Live per-request usage can only come from the rollout file: `codex exec
// --json` streams thread/turn/item events whose only usage payload rides the
// FINAL turn.completed — once per exec, and the agent-handoff kill usually
// drops even that. The rollout, by contrast, appends a token_count event
// after every provider request. Tailing it incrementally is what lets
// context-budget checkpoints exist while the call is still running; without
// this, every context-headroom admission fails open with reason "missing".
//
// Offset-based and allocation-bounded: each poll reads only appended bytes,
// carries a partial trailing line, and returns one usage record per new
// token_count event. A multibyte character split across polls can corrupt
// that one carried line; token_count telemetry is ASCII, so a corrupted line
// is skipped harmlessly.
export function createCodexRolloutUsageTailer({
  codexHome,
  startedAtMs = null,
  startAtEnd = false,
} = {}) {
  const POLL_READ_MAX_BYTES = 8 * 1024 * 1024;
  let sessionHandle = null;
  let filePath = null;
  let offset = 0;
  let carry = "";
  return {
    get filePath() { return filePath; },
    setSessionHandle(handle) {
      if (sessionHandle) return;
      const normalized = String(handle || "").trim();
      if (normalized) sessionHandle = normalized;
    },
    poll() {
      if (!sessionHandle) return [];
      if (!filePath) {
        filePath = findCodexRolloutFile(codexHome, sessionHandle, startedAtMs);
        if (!filePath) return [];
        if (startAtEnd) {
          // A resumed session's rollout already holds the prior calls'
          // requests; re-publishing them would transiently shrink the
          // current call's context estimate.
          try { offset = fs.statSync(filePath).size; } catch { offset = 0; }
        }
      }
      let stat;
      try { stat = fs.statSync(filePath); } catch { return []; }
      if (stat.size <= offset) return [];
      const usages = [];
      let fd = null;
      try {
        fd = fs.openSync(filePath, "r");
        const buffer = Buffer.alloc(Math.min(stat.size - offset, POLL_READ_MAX_BYTES));
        const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
        if (read <= 0) return [];
        offset += read;
        const parts = `${carry}${buffer.toString("utf8", 0, read)}`.split(/\r?\n/u);
        carry = parts.pop() || "";
        for (const raw of parts) {
          if (!raw.trim()) continue;
          let row;
          try { row = JSON.parse(raw); } catch { continue; }
          const payload = row?.payload && typeof row.payload === "object" ? row.payload : row;
          if (payload?.type !== "token_count") continue;
          const last = payload?.info?.last_token_usage;
          if (!last || typeof last !== "object") continue;
          const requestContextInputTokens = Number(last.input_tokens);
          if (!Number.isFinite(requestContextInputTokens) || requestContextInputTokens < 0) continue;
          const cachedInputTokens = Number(last.cached_input_tokens);
          usages.push({
            requestContextInputTokens,
            outputTokensSinceRequest: Math.max(0, Number(last.output_tokens) || 0),
            ...(Number.isFinite(cachedInputTokens) && cachedInputTokens >= 0
              ? { cachedInputTokens }
              : {}),
            precision: "exact",
          });
        }
      } catch {
        return usages;
      } finally {
        if (fd != null) {
          try { fs.closeSync(fd); } catch { /* best effort */ }
        }
      }
      return usages;
    },
  };
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
