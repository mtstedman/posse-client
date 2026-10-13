import { parseLocalToolCall } from "../../providers/functions/posse-local/tool-protocol.js";

const SIMULATED_RESULT = /^(?:\{\s*"role"\s*:\s*"tool"|\{\s*"type"\s*:\s*"tool_result"|<tool_result\b)/i;
const SIMULATED_RESULT_ANYWHERE = /(?:\{\s*"role"\s*:\s*"tool"|\{\s*"type"\s*:\s*"tool_result"|<tool_result\b)/i;
const SIMULATED_REQUEST_ANYWHERE = /<(?:invoke|function_calls|tool_call)\b/i;

function leadingJsonObject(text) {
  if (!text.startsWith("{")) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return { body: text.slice(0, index + 1), rest: text.slice(index + 1).trim() };
  }
  return null;
}

function exactToolCalls(text) {
  const single = parseLocalToolCall(text);
  if (single) return [single];
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length < 2) return null;
  const calls = parsed.map(item => parseLocalToolCall(JSON.stringify(item)));
  return calls.every(Boolean) ? calls : null;
}

// A tool request preceded by commentary is still an unexecuted request, not
// a final answer. Skip complete non-call objects so JSON artifacts containing
// nested examples are not mistaken for requests.
function embeddedToolCall(text) {
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf("{", offset);
    if (index < 0) return false;
    const object = leadingJsonObject(text.slice(index));
    if (object && parseLocalToolCall(object.body)) return true;
    offset = index + (object?.body.length || 1);
  }
  return false;
}

// CLI providers can emit a progress segment before their final JSON decision.
// Accept only one complete trailing call, with plain commentary before it and
// no other JSON/XML calls or simulated results. The caller still authorizes
// the issued tool and its arguments; this parser never executes anything.
function callAfterCommentary(text) {
  if (SIMULATED_RESULT_ANYWHERE.test(text) || SIMULATED_REQUEST_ANYWHERE.test(text)) return null;
  const index = text.indexOf("{");
  if (index <= 0) return null;
  const prefix = text.slice(0,index);
  if (/[\[\]{}<>`]/.test(prefix)) return null;
  const trailing = leadingJsonObject(text.slice(index));
  if (!trailing || trailing.rest && trailing.rest !== trailing.body) return null;
  return parseLocalToolCall(trailing.body);
}

/** Accept one or more exact tool calls, or salvage a call before fabricated results. */
export function parseAgentToolTurn(output) {
  const text = String(output || "").trim();
  const exact = exactToolCalls(text);
  if (exact) return { calls: exact, malformed: false };
  const afterCommentary = callAfterCommentary(text);
  if (afterCommentary) return { calls: [afterCommentary], malformed: false };
  const leading = leadingJsonObject(text);
  const firstCall = leading ? parseLocalToolCall(leading.body) : null;
  // Some CLI streams repeat the same decision in their final summary. One
  // identical retransmission is one request, never two executions.
  if (firstCall && leading.rest === leading.body) return { calls: [firstCall], malformed: false };
  if (firstCall && SIMULATED_RESULT.test(leading.rest)) return { calls: [firstCall], malformed: true };
  return { calls: [], malformed: Boolean(firstCall || SIMULATED_RESULT_ANYWHERE.test(text) || SIMULATED_REQUEST_ANYWHERE.test(text) || embeddedToolCall(text)) };
}
