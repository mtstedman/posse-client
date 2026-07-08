// lib/domains/providers/functions/codex/stream-events.js

import { appendBoundedText } from "../../../../shared/format/functions/bounded-text.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { _extractCodexEventBody } from "./session.js";

const CODEX_STREAM_CAPTURE_MAX_CHARS = 4 * 1024 * 1024;

export function appendBoundedCodexOutput(current, text, maxChars = CODEX_STREAM_CAPTURE_MAX_CHARS) {
  return appendBoundedText(current, text, maxChars);
}

export function __testAppendBoundedCodexOutput(current, text, maxChars) {
  return appendBoundedCodexOutput(current, text, maxChars);
}

export function __testBuildCloseStats({
  role,
  modelTier,
  reasoningEffort,
  modelName,
  totalInputTokens,
  totalOutputTokens,
  totalCachedInputTokens = null,
  longContextInputTokens = null,
  durationMs,
  finalOutput,
  stdout,
  code,
  atlasMethod = "baseline",
  toolUses = [],
  toolUsesLoggedByToolkit = false,
  sessionHandle = null,
  priorSessionHandle = null,
  sessionExpired = false,
  numTurns = null,
  maxTurns = null,
  maxOutputTokens = null,
  outputTruncated = false,
  outputLimitReason = null,
}) {
  return {
    role,
    modelTier,
    reasoningEffort,
    modelName,
    provider: "codex",
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cachedInputTokens: totalCachedInputTokens,
    longContextInputTokens,
    durationMs,
    outputChars: (finalOutput || stdout.trim()).length,
    exitCode: code,
    numTurns,
    maxTurns,
    maxOutputTokens,
    outputTruncated: !!outputTruncated,
    outputLimitReason: outputLimitReason || null,
    atlasMethod,
    toolUses: Array.isArray(toolUses) ? toolUses : [],
    toolUsesLoggedByToolkit: !!toolUsesLoggedByToolkit,
    sessionHandle: sessionHandle || null,
    priorSessionHandle: priorSessionHandle || null,
    sessionExpired: !!sessionExpired,
  };
}

function normalizeTurnCount(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

export function extractTurnCountFromEvent(msg) {
  if (!msg || typeof msg !== "object") return null;
  const candidates = [
    msg.num_turns,
    msg.numTurns,
    msg.turn_count,
    msg.turnCount,
    msg.turns_used,
    msg.turnsUsed,
    msg.metrics?.num_turns,
    msg.metrics?.numTurns,
    msg.metrics?.turn_count,
    msg.metrics?.turnCount,
    msg.usage?.num_turns,
    msg.usage?.numTurns,
    msg.usage?.turn_count,
    msg.usage?.turnCount,
  ];
  for (const candidate of candidates) {
    const count = normalizeTurnCount(candidate);
    if (count != null) return count;
  }
  return null;
}

export function __testClassifyCodexStderrLine(line) {
  const text = String(line || "").trim();
  if (!text) return { kind: "empty", display: null };
  if (
    /The token '&&' is not a valid statement separator in this version/i.test(text) ||
    /Missing file specification after redirection operator/i.test(text) ||
    /The '<' operator is reserved for future use/i.test(text) ||
    /The 'from' keyword is not supported in this version of the language/i.test(text) ||
    /Missing expression after ','/i.test(text) ||
    /Unexpected token 'encoding='utf-8'' in expression or statement/i.test(text) ||
    /Missing closing '\)' in expression/i.test(text) ||
    /^At line:\d+\s+char:\d+/i.test(text) ||
    /^\+\s+~+/i.test(text) ||
    /^['"`].*operator\./i.test(text) ||
    /FullyQualifiedErrorId\s*:\s*InvalidEndOfLine/i.test(text) ||
    /CategoryInfo\s*:\s*ParserError/i.test(text)
  ) {
    return {
      kind: "powershell_parser_nonfatal",
      dedupeKey: "powershell_parser_nonfatal",
      display: `${C.dim}[tool] Codex generated Unix-style shell syntax for PowerShell; the command failed before running${C.reset}`,
    };
  }
  if (/codex_core::tools::router: error=/i.test(text)) {
    const exitMatch = text.match(/exit[_ ]code["=: ]+(\d+)/i);
    const exitCode = exitMatch ? exitMatch[1] : null;
    return {
      kind: "tool_router_nonfatal",
      dedupeKey: "tool_router_nonfatal",
      display: `${C.dim}[tool] Codex internal command returned non-zero${exitCode ? ` (exit ${exitCode})` : ""}; agent may continue${C.reset}`,
    };
  }
  if (
    /codex_core::plugins::startup_sync/i.test(text) ||
    /codex_core::plugins::manager: failed to warm featured plugin ids cache/i.test(text) ||
    /codex_core::plugins::manifest: ignoring interface\.defaultPrompt/i.test(text) ||
    /codex_protocol::openai_models: Model personality requested/i.test(text) ||
    /codex_core::shell_snapshot: Failed to create shell snapshot for powershell/i.test(text)
  ) {
    return { kind: "noise", dedupeKey: "noise", display: null };
  }
  return {
    kind: "stderr_nonfatal",
    dedupeKey: "codex_stderr_nonfatal",
    display: `${C.dim}[tool] Codex emitted shell/tool stderr; details suppressed${C.reset}`,
  };
}

function _stringifyCodexCommand(command) {
  if (Array.isArray(command)) return command.filter((p) => p != null).map(String).join(" ");
  if (command == null) return "";
  return String(command);
}

function _parseCodexToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function _compactObject(obj = {}) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value != null && value !== ""));
}

function _pickFirstString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function _extractCodexMcpToolUse(body = {}) {
  const invocation = body.invocation || body.tool_call || body.toolCall || body.call || body;
  const toolName = _pickFirstString(
    invocation?.tool,
    invocation?.name,
    invocation?.tool_name,
    invocation?.toolName,
    invocation?.server_tool_name,
    invocation?.serverToolName,
    body.tool,
    body.name,
    body.tool_name,
    body.toolName,
    body.server_tool_name,
    body.serverToolName,
  );
  if (!toolName) return null;
  const args = invocation?.arguments
    ?? invocation?.args
    ?? invocation?.input
    ?? body.arguments
    ?? body.args
    ?? body.input
    ?? {};
  return {
    tool: toolName,
    input: (args && typeof args === "object") ? args : _parseCodexToolArguments(args),
    call_id: invocation?.call_id || invocation?.callId || invocation?.id || body.call_id || body.callId || body.id || null,
  };
}

function _extractCodexWebToolUse(body = {}, type = "") {
  const action = body.action && typeof body.action === "object" ? body.action : {};
  const query = body.query || body.search_query || action.query || action.search_query || null;
  const url = body.url || body.uri || action.url || action.uri || null;
  const callId = body.call_id || body.callId || body.id || null;
  if (/web_fetch|webfetch|open_page|open_url/i.test(type) || url) {
    return {
      tool: "web_fetch",
      input: _compactObject({ url, query }),
      call_id: callId,
    };
  }
  return {
    tool: "web_search",
    input: _compactObject({ query, url }),
    call_id: callId,
  };
}

function _parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

function _extractCodexOutputText(value) {
  const parsed = _parseMaybeJson(value);
  if (parsed !== value) return _extractCodexOutputText(parsed);
  if (Array.isArray(parsed)) {
    return parsed.map((item) => _extractCodexOutputText(item)).filter(Boolean).join("\n");
  }
  if (parsed && typeof parsed === "object") {
    for (const key of ["text", "output", "message", "error"]) {
      if (typeof parsed[key] === "string" && parsed[key].trim()) return parsed[key].trim();
    }
    if (Array.isArray(parsed.content)) return _extractCodexOutputText(parsed.content);
  }
  return typeof value === "string" ? value.trim() : "";
}

export function _extractCodexToolUse(msg) {
  const body = _extractCodexEventBody(msg);
  if (!body) return null;
  const type = String(body.type || "").toLowerCase();
  if (type === "exec_command_begin" || type === "exec_command_start") {
    const command = _stringifyCodexCommand(body.command ?? body.cmd ?? body.argv);
    if (!command) return null;
    return { tool: "shell", input: { command, cwd: body.cwd || null } };
  }
  if (type === "patch_apply_begin" || type === "apply_patch_begin" || type === "apply_patch") {
    const changes = body.changes && typeof body.changes === "object" ? body.changes : null;
    if (!changes) return null;
    const results = [];
    for (const [pathKey, op] of Object.entries(changes)) {
      let changeKind = "update";
      if (op && typeof op === "object") {
        if ("add" in op) changeKind = "add";
        else if ("delete" in op) changeKind = "delete";
        else if ("update" in op) changeKind = "update";
      }
      results.push({ tool: "apply_patch", input: { file_path: pathKey, change_kind: changeKind } });
    }
    return results.length > 0 ? results : null;
  }
  if (/^web_.*(?:call|begin|start)?$/.test(type) || type === "web_search" || type === "web_fetch") {
    return _extractCodexWebToolUse(body, type);
  }
  if (type === "function_call" || type === "tool_call") {
    const toolName = body.name || body.tool || body.tool_name || body.toolName;
    if (!toolName) return null;
    return {
      tool: String(toolName),
      input: _parseCodexToolArguments(body.arguments ?? body.args ?? body.input),
      call_id: body.call_id || body.callId || body.id || null,
    };
  }
  if (type === "function_call_output" || type === "tool_call_output") {
    const outputText = _extractCodexOutputText(body.output ?? body.result ?? body.content);
    if (/user cancelled MCP tool call/i.test(outputText)) {
      return {
        _codexToolOutput: true,
        call_id: body.call_id || body.callId || body.id || null,
        status: "cancelled",
        error: "user cancelled MCP tool call",
        output: outputText,
      };
    }
    return null;
  }
  if (type === "mcp_tool_call" || type === "mcp_tool_call_begin" || type === "mcp_tool_begin") {
    return _extractCodexMcpToolUse(body);
  }
  return null;
}

export function __testExtractCodexToolUse(msg) {
  return _extractCodexToolUse(msg);
}

export function _appendCodexToolUse(toolUses, extracted) {
  if (!extracted) return;
  const entries = Array.isArray(extracted) ? extracted : [extracted];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry._codexToolOutput) {
      const callId = entry.call_id || entry.callId || null;
      const existing = callId
        ? [...toolUses].reverse().find((toolUse) => (toolUse.call_id || toolUse.callId || null) === callId)
        : null;
      if (existing) {
        existing.status = entry.status || existing.status || null;
        existing.error = entry.error || existing.error || null;
        existing.output = entry.output || existing.output || null;
      }
      continue;
    }
    toolUses.push(entry);
  }
}

export function __testAppendCodexToolUseEvent(toolUses, msg) {
  _appendCodexToolUse(toolUses, _extractCodexToolUse(msg));
  return toolUses;
}

export function summarizeJsonEvent(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (typeof msg.msg === "string") return msg.msg;
  if (typeof msg.message === "string") return msg.message;
  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.output === "string") return msg.output;
  if (typeof msg.status === "string") return `[status] ${msg.status}`;
  if (typeof msg.event === "string") return `[event] ${msg.event}`;
  if (typeof msg.type === "string") return `[${msg.type}]`;
  return null;
}

function normalizeTokenCount(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function pickUsageValue(candidate, names) {
  for (const name of names) {
    const value = normalizeTokenCount(candidate?.[name]);
    if (value != null) return value;
  }
  return null;
}

function pickUsageMetric(candidate, cumulativeNames, deltaNames, ambiguousNames) {
  const cumulative = pickUsageValue(candidate, cumulativeNames);
  if (cumulative != null) return { value: cumulative, kind: "cumulative" };
  const delta = pickUsageValue(candidate, deltaNames);
  if (delta != null) return { value: delta, kind: "delta" };
  const ambiguous = pickUsageValue(candidate, ambiguousNames);
  if (ambiguous != null) return { value: ambiguous, kind: "ambiguous" };
  return { value: null, kind: null };
}

// Token usage from the codex CLI's streaming protocol. The protocol does not
// have a stable canonical schema across versions: each event may carry a
// "total" cumulative count, a delta, or an ambiguous "input_tokens" field that
// could be either. We classify each field by name (cumulative > delta >
// ambiguous) and the accumulator picks the latest cumulative if seen, the sum
// of deltas otherwise, or a heuristic over ambiguous values (treated as
// deltas if values decrease, else cumulative).
//
// Cost numbers for codex calls inherit the heuristic's accuracy; if codex
// updates its event schema, audit pickUsageMetric below first.
export function extractUsageFromEvent(msg) {
  if (!msg || typeof msg !== "object") {
    return { inputTokens: null, outputTokens: null, inputKind: null, outputKind: null };
  }
  const candidates = [msg.usage, msg.token_usage, msg.tokens, msg.metrics];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const input = pickUsageMetric(
      c,
      ["total_input_tokens", "input_tokens_total", "totalInputTokens", "inputTokensTotal", "total_prompt_tokens", "prompt_tokens_total", "promptTokensTotal"],
      ["input_tokens_delta", "delta_input_tokens", "inputTokensDelta", "input_delta_tokens", "prompt_tokens_delta", "delta_prompt_tokens", "promptTokensDelta"],
      ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]
    );
    const output = pickUsageMetric(
      c,
      ["total_output_tokens", "output_tokens_total", "totalOutputTokens", "outputTokensTotal", "total_completion_tokens", "completion_tokens_total", "completionTokensTotal"],
      ["output_tokens_delta", "delta_output_tokens", "outputTokensDelta", "output_delta_tokens", "completion_tokens_delta", "delta_completion_tokens", "completionTokensDelta"],
      ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]
    );
    const cachedInput = pickUsageMetric(
      c,
      ["total_cached_input_tokens", "cached_input_tokens_total", "totalCachedInputTokens", "cachedInputTokensTotal", "total_cached_prompt_tokens", "cached_prompt_tokens_total", "cachedPromptTokensTotal"],
      ["cached_input_tokens_delta", "delta_cached_input_tokens", "cachedInputTokensDelta", "cached_input_delta_tokens", "cached_prompt_tokens_delta", "delta_cached_prompt_tokens", "cachedPromptTokensDelta"],
      ["cached_input_tokens", "cachedInputTokens", "cached_prompt_tokens", "cachedPromptTokens", "cache_read_input_tokens", "cacheReadInputTokens"]
    );
    const inputTokens = input.value;
    const outputTokens = output.value;
    const cachedInputTokens = cachedInput.value ?? pickUsageValue(
      c?.input_tokens_details || c?.prompt_tokens_details,
      ["cached_tokens", "cachedTokens"],
    );
    if (inputTokens != null || outputTokens != null || cachedInputTokens != null) {
      const usage = {
        inputTokens,
        outputTokens,
        inputKind: input.kind,
        outputKind: output.kind,
      };
      if (cachedInputTokens != null) {
        usage.cachedInputTokens = cachedInputTokens;
        usage.cachedInputKind = cachedInput.kind || "ambiguous";
      }
      return usage;
    }
  }
  return { inputTokens: null, outputTokens: null, inputKind: null, outputKind: null };
}

export function codexUsageEventDedupeKey(msg) {
  if (!msg || typeof msg !== "object") return null;
  const candidates = [
    msg.event_id,
    msg.eventId,
    msg.id,
    msg.sequence_number,
    msg.sequenceNumber,
    msg.seq,
    msg.usage?.event_id,
    msg.usage?.eventId,
    msg.usage?.id,
    msg.token_usage?.event_id,
    msg.token_usage?.eventId,
    msg.token_usage?.id,
    msg.tokens?.event_id,
    msg.tokens?.eventId,
    msg.tokens?.id,
    msg.metrics?.event_id,
    msg.metrics?.eventId,
    msg.metrics?.id,
  ];
  const rawId = candidates.find((value) => value != null && String(value).trim() !== "");
  if (rawId == null) return null;
  const kind = String(msg.type || msg.event || msg.kind || "usage").trim() || "usage";
  return `${kind}:${String(rawId).trim()}`;
}

function createTokenUsageFieldAccumulator() {
  let explicitValue = null;
  let explicitSeen = false;
  let explicitPreviousCumulative = null;
  let explicitMaxSegment = null;
  const ambiguousValues = [];
  let ambiguousAsDeltas = false;

  const ambiguousTotal = () => {
    if (ambiguousValues.length === 0) return null;
    if (!ambiguousAsDeltas) return ambiguousValues[ambiguousValues.length - 1];
    return ambiguousValues.reduce((sum, value) => sum + value, 0);
  };
  const addExplicitSegment = (segment) => {
    const n = normalizeTokenCount(segment);
    if (n == null) return;
    explicitMaxSegment = Math.max(explicitMaxSegment ?? 0, n);
  };
  const ambiguousMaxSegment = () => {
    if (ambiguousValues.length === 0) return null;
    if (ambiguousAsDeltas) return Math.max(...ambiguousValues);
    let maxSegment = 0;
    let prev = null;
    for (const value of ambiguousValues) {
      const segment = prev == null || value < prev ? value : value - prev;
      maxSegment = Math.max(maxSegment, segment);
      prev = value;
    }
    return maxSegment;
  };

  return {
    add(value, kind = "ambiguous") {
      const n = normalizeTokenCount(value);
      if (n == null) return;
      if (kind === "delta") {
        explicitValue = (explicitValue ?? 0) + n;
        explicitSeen = true;
        addExplicitSegment(n);
        return;
      }
      if (kind === "cumulative") {
        explicitValue = n;
        explicitSeen = true;
        const segment = explicitPreviousCumulative == null || n < explicitPreviousCumulative
          ? n
          : n - explicitPreviousCumulative;
        explicitPreviousCumulative = n;
        addExplicitSegment(segment);
        return;
      }

      const prev = ambiguousValues.length > 0 ? ambiguousValues[ambiguousValues.length - 1] : null;
      ambiguousValues.push(n);
      if (prev != null && n < prev) ambiguousAsDeltas = true;
    },
    value() {
      return explicitSeen ? explicitValue : ambiguousTotal();
    },
    maxSegment() {
      return explicitSeen ? explicitMaxSegment : ambiguousMaxSegment();
    },
  };
}

export function createCodexUsageAccumulator() {
  const input = createTokenUsageFieldAccumulator();
  const output = createTokenUsageFieldAccumulator();
  const cachedInput = createTokenUsageFieldAccumulator();
  const seenUsageEvents = new Set();
  const snapshot = () => ({
    inputTokens: input.value(),
    outputTokens: output.value(),
    cachedInputTokens: cachedInput.value(),
    longContextInputTokens: input.maxSegment(),
  });
  return {
    add(usage, options = {}) {
      if (!usage || typeof usage !== "object") return snapshot();
      if (usage.inputTokens == null && usage.outputTokens == null && usage.cachedInputTokens == null) return snapshot();
      const eventKey = typeof options === "string" ? options : options?.eventKey;
      const normalizedKey = eventKey == null ? "" : String(eventKey).trim();
      if (normalizedKey) {
        if (seenUsageEvents.has(normalizedKey)) return snapshot();
        seenUsageEvents.add(normalizedKey);
      }
      input.add(usage.inputTokens, usage.inputKind || "ambiguous");
      output.add(usage.outputTokens, usage.outputKind || "ambiguous");
      cachedInput.add(usage.cachedInputTokens, usage.cachedInputKind || "ambiguous");
      return snapshot();
    },
    snapshot,
    get inputTokens() {
      return input.value();
    },
    get outputTokens() {
      return output.value();
    },
    get cachedInputTokens() {
      return cachedInput.value();
    },
    get longContextInputTokens() {
      return input.maxSegment();
    },
  };
}
