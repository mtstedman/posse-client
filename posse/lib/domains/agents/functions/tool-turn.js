import { createHash } from "node:crypto";

import { parseLocalToolCall } from "../../providers/functions/posse-local/tool-protocol.js";

const SIMULATED_RESULT = /^(?:\{\s*"role"\s*:\s*"tool"|\{\s*"type"\s*:\s*"tool_result"|<tool_result\b)/i;
const SIMULATED_RESULT_ANYWHERE = /(?:\{\s*"role"\s*:\s*"tool"|\{\s*"type"\s*:\s*"tool_result"|<tool_result\b)/i;
const SIMULATED_REQUEST_ANYWHERE = /<(?:invoke|function_calls|tool_call)\b/i;
const REQUEST_ENVELOPE = /^(?:\[\s*)?\{\s*"(?:name|tool)"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*"(?:arguments|content)"\s*:/;

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

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

const TRANSCRIPT_MESSAGE_KEYS = new Set(["role", "content", "tool_calls"]);
const TRANSCRIPT_CALL_KEYS = new Set(["id", "name", "arguments"]);

// Prompt-only providers see their earlier requests rendered as
// {"role":"assistant","content":"","tool_calls":[{id,name,arguments}]}
// (renderConversation), and some reply in that shape. A message object of
// that form (a role, a tool_calls array, optional content, nothing else) is a
// request batch when it is the assistant's and every call is complete,
// otherwise an unexecutable imitation ([]). Echoed call ids are dropped; the
// runtime assigns its own. Returns null for any other text, so a JSON answer
// that merely lists tool calls stays an answer.
function transcriptToolCalls(text) {
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!plainObject(parsed) || typeof parsed.role !== "string" || !Array.isArray(parsed.tool_calls)
    || !Object.keys(parsed).every(key => TRANSCRIPT_MESSAGE_KEYS.has(key))) return null;
  const message = parsed.role === "assistant" && (parsed.content === undefined || typeof parsed.content === "string");
  const calls = parsed.tool_calls.map(item => {
    const call = plainObject(item);
    const name = typeof call?.name === "string" ? call.name.trim() : "";
    if (!name || !plainObject(call.arguments) || !Object.keys(call).every(key => TRANSCRIPT_CALL_KEYS.has(key))) return null;
    return { name, arguments: call.arguments, raw: JSON.stringify({ name, arguments: call.arguments }) };
  });
  return message && calls.length && calls.every(Boolean) ? calls : [];
}

function exactToolCalls(text) {
  const transcript = transcriptToolCalls(text);
  if (transcript) return transcript.length ? transcript : null;
  const single = parseLocalToolCall(text);
  if (single) return [single];
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length < 2) return null;
  const calls = parsed.map(item => parseLocalToolCall(JSON.stringify(item)));
  return calls.every(Boolean) ? calls : null;
}

// Recover only a missing root-object terminator. Strict JSON parsing must
// succeed after that one byte, so argument strings and nested values must
// already be complete. Never fill in argument values or nested delimiters.
function missingRootTerminator(text) {
  if (!text.startsWith("{") || !text.endsWith("}") || !REQUEST_ENVELOPE.test(text)) return null;
  const completed = text + "}";
  try { JSON.parse(completed); } catch { return null; }
  const call = parseLocalToolCall(completed);
  return call ? [call] : null;
}

// A batch can contain the same redundant call terminator accepted for a
// single request. Remove at most one unmatched brace per complete array
// member, never a delimiter inside arguments. The entire repaired batch must
// then parse strictly as tool calls; authorization remains the caller's job.
function redundantBatchTerminator(text) {
  if (!text.startsWith("[") || !text.endsWith("]") || !REQUEST_ENVELOPE.test(text)) return null;
  const stack = [];
  const removed = new Set();
  let quoted = false, escaped = false, previous = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") {
      if (stack.at(-1) === char) stack.pop();
      else if (char === "}" && stack.length === 1 && stack[0] === "]" &&
          previous === "}" && /^\s*[,\]]/.test(text.slice(index + 1))) removed.add(index);
      else return null;
    }
    if (!/\s/.test(char)) previous = char;
  }
  if (quoted || stack.length || !removed.size) return null;
  return exactToolCalls(text.split("").filter((_, index) => !removed.has(index)).join(""));
}

// Codex batches show envelope slips the single-call path already forgives:
// one stray "}" after the closed array, a final "}" in place of the array's
// "]", a missing final "]", and the identical batch written twice. Each candidate changes
// only the outer envelope and must then parse strictly as tool calls, so
// argument values and nested delimiters are never filled in or altered.
function batchEnvelopeSlip(text) {
  if (!text.startsWith("[") || !REQUEST_ENVELOPE.test(text)) return null;
  const candidates = [];
  if (/\]\s*\}$/.test(text)) candidates.push(text.replace(/\s*\}$/, ""));
  if (/\}$/.test(text) && !/\]\s*\}$/.test(text)) candidates.push(text.slice(0, -1) + "]", text + "]");
  const half = text.length >> 1;
  for (let cut = half - 2; cut <= half + 2; cut++) {
    const first = text.slice(0, cut).trim();
    if (first.endsWith("]") && first === text.slice(cut).trim()) candidates.push(first);
  }
  for (const candidate of candidates) {
    const calls = exactToolCalls(candidate) || redundantBatchTerminator(candidate);
    if (calls) return calls;
  }
  return null;
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
    if (object && (parseLocalToolCall(object.body) || transcriptToolCalls(object.body))) return true;
    offset = index + (object?.body.length || 1);
  }
  return false;
}

// CLI providers can emit a progress segment before their final JSON decision.
// Accept a complete trailing decision, with plain commentary before it and
// no other JSON/XML calls or simulated results. The caller still authorizes
// the issued tool and its arguments; this parser never executes anything.
function callsAfterCommentary(text) {
  if (SIMULATED_RESULT_ANYWHERE.test(text) || SIMULATED_REQUEST_ANYWHERE.test(text)) return null;
  const index = text.search(/[\[{]/);
  if (index <= 0) return null;
  const prefix = text.slice(0,index);
  // Inline-code punctuation in progress text does not introduce another
  // decision. Fences and structured prefixes remain ambiguous and rejected.
  if (/[\[\]{}<>]/.test(prefix) || /`{3}|~{3}/.test(prefix)) return null;
  const suffix = text.slice(index);
  const exact = exactToolCalls(suffix) || missingRootTerminator(suffix) || redundantBatchTerminator(suffix) || batchEnvelopeSlip(suffix);
  if (exact) return exact;
  const trailing = leadingJsonObject(suffix);
  if (!trailing || trailing.rest && trailing.rest !== trailing.body && trailing.rest !== "}") return null;
  const call = parseLocalToolCall(trailing.body);
  return call ? [call] : null;
}

/**
 * A tool call's identity for duplicate checks: its name and its arguments as
 * canonical JSON (object keys sorted at every depth, no whitespace), hashed.
 * Two calls are byte-identical when these match, whatever the key order or
 * spacing the model wrote.
 */
export function toolCallFingerprint(name, args) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : plainObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify([String(name), canonical(args ?? {})])).digest("hex");
}

/**
 * Accept one or more exact tool calls, or salvage a call before fabricated
 * results. `afterCommentary` marks calls that trailed prose: a live request
 * under the commentary-then-call rule, which the caller may still refuse to
 * run when it only repeats an executed call.
 */
export function parseAgentToolTurn(output) {
  const text = String(output || "").trim();
  if (transcriptToolCalls(text)?.length === 0) return { calls: [], malformed: true };
  const exact = exactToolCalls(text) || missingRootTerminator(text) || redundantBatchTerminator(text) || batchEnvelopeSlip(text);
  if (exact) return { calls: exact, malformed: false };
  const afterCommentary = callsAfterCommentary(text);
  if (afterCommentary) return { calls: afterCommentary, malformed: false, afterCommentary: true };
  const leading = leadingJsonObject(text);
  const firstCall = leading ? parseLocalToolCall(leading.body) : null;
  // A complete call followed only by one redundant object terminator has
  // unambiguous arguments. Normalize the envelope; the usual tool allowlist
  // and argument validation still apply. Never salvage other trailing data.
  if (firstCall && leading.rest === "}") return { calls: [firstCall], malformed: false };
  // Some CLI streams repeat the same decision in their final summary. One
  // identical retransmission is one request, never two executions.
  if (firstCall && leading.rest === leading.body) return { calls: [firstCall], malformed: false };
  if (firstCall && SIMULATED_RESULT.test(leading.rest)) return { calls: [firstCall], malformed: true };
  return { calls: [], malformed: Boolean(firstCall || REQUEST_ENVELOPE.test(text) || SIMULATED_RESULT_ANYWHERE.test(text) || SIMULATED_REQUEST_ANYWHERE.test(text) || embeddedToolCall(text)) };
}
