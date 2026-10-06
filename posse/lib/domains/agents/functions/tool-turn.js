import { parseLocalToolCall } from "../../providers/functions/posse-local/tool-protocol.js";

const SIMULATED_RESULT = /^(?:\{\s*"role"\s*:\s*"tool"|\{\s*"type"\s*:\s*"tool_result"|<tool_result\b)/i;
const SIMULATED_RESULT_ANYWHERE = /(?:\{\s*"role"\s*:\s*"tool"|\{\s*"type"\s*:\s*"tool_result"|<tool_result\b)/i;

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

/** Accept one leading tool call only when the rest is a simulated tool result. */
export function parseAgentToolTurn(output) {
  const text = String(output || "").trim();
  const exact = parseLocalToolCall(text);
  if (exact) return { call: exact, malformed: false };
  const leading = leadingJsonObject(text);
  const firstCall = leading ? parseLocalToolCall(leading.body) : null;
  if (firstCall && SIMULATED_RESULT.test(leading.rest)) return { call: firstCall, malformed: true };
  return { call: null, malformed: Boolean(firstCall || SIMULATED_RESULT_ANYWHERE.test(text)) };
}
