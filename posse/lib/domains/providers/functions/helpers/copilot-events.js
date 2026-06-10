// lib/domains/providers/functions/helpers/copilot-events.js
//
// JSONL event normalizer for the GitHub Copilot CLI provider.
//
// Copilot CLI emits one JSON object per line when invoked with
// `--output-format json`. Each event has a stable envelope:
//
//   { "type": "session.warning",
//     "data": { ... event-specific payload ... },
//     "id":        "<uuid>",
//     "timestamp": "<iso-8601>",
//     "parentId":  "<uuid>",
//     "ephemeral": true | false }
//
// This module:
//   1. Parses raw JSONL lines safely (returning null for malformed input).
//   2. Maps known `type` strings into Posse's internal event vocabulary
//      so worker / line-consumer code doesn't need provider-specific
//      branching.
//   3. Aggregates assistant-text fragments, tool-use calls, and usage
//      stats into a single Accumulator that the provider's callProvider
//      can read at end-of-stream.
//
// The exact set of `type` values Copilot CLI emits is partly inferred —
// the policy-blocked probe captured only `session.warning` and
// `session.mcp_server_status_changed`. The mapping below covers those
// plus best-effort patterns inferred from the Codex / Claude Code event
// vocabularies for the categories we know must exist (message text,
// tool calls, usage, completion). Unknown event types are kept verbatim
// in the accumulator's `unknown` list so an operator can grep them out
// of artifacts later and we can tighten the map.
//
// EVERY caller MUST treat the accumulator as a hint, not a source of
// truth. The Codex consumer falls back to "everything to stdout was the
// agent's output" when JSONL parsing misses something — copy that
// posture.

/**
 * @typedef {Object} CopilotRawEvent
 * @property {string} type
 * @property {any} [data]
 * @property {string} [id]
 * @property {string} [timestamp]
 * @property {string} [parentId]
 * @property {boolean} [ephemeral]
 */

/**
 * @typedef {Object} NormalizedToolCall
 * @property {string} name                Tool identifier the agent called.
 * @property {string} [id]                Tool-call id, when present.
 * @property {Record<string, unknown>} [input]
 * @property {string} [status]            "started" | "succeeded" | "failed" | "denied" | "unknown".
 * @property {string} [resultText]        Tool output (truncated by the writer).
 */

/**
 * @typedef {Object} CopilotAccumulator
 * @property {string} text                Concatenated assistant text fragments.
 * @property {NormalizedToolCall[]} toolUses
 * @property {Array<{type: string, message: string, severity?: string}>} warnings
 * @property {Array<{server: string, status: string}>} mcpStatusEvents
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {string | null} sessionId
 * @property {string | null} completionReason
 * @property {Array<{type: string, raw: any}>} unknown
 * @property {Array<{type: string, message: string}>} errors
 */

/**
 * @returns {CopilotAccumulator}
 */
export function createAccumulator() {
  return {
    text: "",
    toolUses: [],
    warnings: [],
    mcpStatusEvents: [],
    inputTokens: 0,
    outputTokens: 0,
    sessionId: null,
    completionReason: null,
    unknown: [],
    errors: [],
  };
}

/**
 * Safe-parse one line from the JSONL stream. Returns the raw event
 * object when the line is valid JSON with at least a string `type`;
 * returns null otherwise (so callers can treat the line as plain text).
 *
 * @param {string} line
 * @returns {CopilotRawEvent | null}
 */
export function parseCopilotLine(line) {
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed.type !== "string") return null;
    return /** @type {CopilotRawEvent} */ (parsed);
  } catch {
    return null;
  }
}

/**
 * Map a parsed event into Posse's internal categories and merge it into
 * `acc`. Returns the normalized "kind" string so callers (notably the
 * stdout line-consumer) can route events without re-parsing.
 *
 * Recognized kinds (stable identifiers; do not rename without updating
 * the worker line-consumer too):
 *   "text"          — append data.text to acc.text
 *   "tool_call"     — push or update acc.toolUses entry
 *   "tool_result"   — update most-recent matching tool call's resultText/status
 *   "session_info"  — record sessionId for resume support
 *   "usage"         — accumulate inputTokens/outputTokens
 *   "warning"       — push to acc.warnings (informational; no output effect)
 *   "mcp_status"    — push to acc.mcpStatusEvents
 *   "error"         — push to acc.errors (caller decides whether to surface)
 *   "completed"     — set acc.completionReason
 *   "unknown"       — push to acc.unknown for later analysis
 *
 * @param {CopilotRawEvent} event
 * @param {CopilotAccumulator} acc
 * @returns {string}            One of the kinds above.
 */
export function normalizeCopilotEvent(event, acc) {
  if (!event || typeof event.type !== "string") {
    return "unknown";
  }
  const type = event.type;
  const data = event.data || {};

  // --- text / message events -------------------------------------------------
  // Inferred shapes — confirm against real successful output once the
  // policy gate is open. Cover the most common naming conventions.
  if (type === "message.delta" || type === "message.text" || type === "text"
    || type === "message.output_text.delta" || type === "response.output_text.delta") {
    const fragment = typeof data.text === "string"
      ? data.text
      : (typeof data.delta === "string" ? data.delta : (typeof data.content === "string" ? data.content : ""));
    if (fragment) acc.text += fragment;
    return "text";
  }
  if (type === "message.complete" || type === "message.completed" || type === "response.output_text.done") {
    const finalText = typeof data.text === "string" ? data.text : (typeof data.content === "string" ? data.content : "");
    // If we already streamed deltas, prefer the streamed concatenation
    // (it preserves intermediate state). Use `text` only when delta
    // events didn't fire.
    if (finalText && !acc.text) acc.text = finalText;
    return "text";
  }

  // --- tool calls ------------------------------------------------------------
  if (type === "tool.call" || type === "tool_call" || type === "tool_use" || type === "response.tool_call") {
    /** @type {NormalizedToolCall} */
    const call = {
      name: String(data.name || data.tool || data.tool_name || "unknown_tool"),
      id: data.id || data.call_id || data.toolUseId || undefined,
      input: data.input || data.arguments || data.params || undefined,
      status: "started",
    };
    acc.toolUses.push(call);
    return "tool_call";
  }
  if (type === "tool.result" || type === "tool_result" || type === "response.tool_result") {
    const id = data.id || data.call_id || data.toolUseId || null;
    const statusFromEvent = typeof data.status === "string" ? data.status
      : (data.error ? "failed" : "succeeded");
    const resultText = typeof data.output === "string" ? data.output
      : (typeof data.result === "string" ? data.result : "");
    // Match the most recent open call by id, or fall back to the last
    // open call if the result lacks an explicit id.
    let target = null;
    if (id) target = acc.toolUses.find((c) => c.id === id) || null;
    if (!target) {
      for (let i = acc.toolUses.length - 1; i >= 0; i--) {
        if (acc.toolUses[i].status === "started") { target = acc.toolUses[i]; break; }
      }
    }
    if (target) {
      target.status = statusFromEvent;
      if (resultText) target.resultText = resultText;
    } else {
      // Orphaned result — record as best-effort.
      acc.toolUses.push({
        name: String(data.tool || data.name || "unknown_tool"),
        id: id || undefined,
        status: statusFromEvent,
        resultText: resultText || undefined,
      });
    }
    return "tool_result";
  }

  // --- session / control -----------------------------------------------------
  if (type === "session.created" || type === "session.start" || type === "session.started") {
    const sid = data.sessionId || data.session_id || data.id || null;
    if (sid) acc.sessionId = String(sid);
    return "session_info";
  }
  if (type === "session.completed" || type === "session.end" || type === "session.finished") {
    acc.completionReason = String(data.reason || data.status || "completed");
    return "completed";
  }
  if (type === "session.mcp_server_status_changed") {
    acc.mcpStatusEvents.push({
      server: String(data.serverName || data.server || "unknown"),
      status: String(data.status || "unknown"),
    });
    return "mcp_status";
  }
  if (type === "session.warning" || type === "warning") {
    acc.warnings.push({
      type: String(data.warningType || data.kind || "general"),
      message: String(data.message || ""),
      severity: typeof data.severity === "string" ? data.severity : "warn",
    });
    return "warning";
  }
  if (type === "session.error" || type === "error" || type === "response.error") {
    acc.errors.push({
      type: String(data.code || data.errorType || "error"),
      message: String(data.message || ""),
    });
    return "error";
  }

  // --- usage / token accounting ----------------------------------------------
  if (type === "session.usage" || type === "usage" || type === "response.usage") {
    const inputTokens = Number(data.inputTokens ?? data.input_tokens ?? data.promptTokens ?? data.prompt_tokens ?? 0);
    const outputTokens = Number(data.outputTokens ?? data.output_tokens ?? data.completionTokens ?? data.completion_tokens ?? 0);
    if (Number.isFinite(inputTokens) && inputTokens > 0) acc.inputTokens += inputTokens;
    if (Number.isFinite(outputTokens) && outputTokens > 0) acc.outputTokens += outputTokens;
    return "usage";
  }

  acc.unknown.push({ type, raw: event });
  return "unknown";
}

/**
 * Process one raw line from Copilot's stdout. Convenience wrapper that
 * parses + normalizes in one step. Returns `null` when the line wasn't
 * parseable JSONL — callers should treat such lines as plain text and
 * append to a fallback buffer (mirrors codex's stdout handling).
 *
 * @param {string} line
 * @param {CopilotAccumulator} acc
 * @returns {{ kind: string, event: CopilotRawEvent } | null}
 */
export function consumeCopilotLine(line, acc) {
  const event = parseCopilotLine(line);
  if (!event) return null;
  const kind = normalizeCopilotEvent(event, acc);
  return { kind, event };
}

/**
 * Pull the final agent output from the accumulator. Prefers streamed
 * text; falls back to nothing (caller should use its own plain-text
 * buffer when the accumulator is empty — this is the safety valve for
 * stream-format mismatches).
 *
 * @param {CopilotAccumulator} acc
 * @returns {string}
 */
export function finalOutput(acc) {
  return (acc?.text || "").trim();
}
