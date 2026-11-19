// @ts-check



export const EDIT_FILE_MAX_JSON_PATH_CHARS = 200;

export const EDIT_FILE_BLOCKED_JSON_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(Object(value), key);
}

export function parseEditJsonPath(jsonPath) {
  const raw = String(jsonPath || "").trim();
  if (!raw) return { ok: false, message: "jsonPath mode requires jsonPath." };
  if (raw.length > EDIT_FILE_MAX_JSON_PATH_CHARS) {
    return { ok: false, message: `jsonPath exceeds ${EDIT_FILE_MAX_JSON_PATH_CHARS} characters.` };
  }
  const segments = raw.split(".").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return { ok: false, message: "jsonPath mode requires at least one path segment." };
  const unsafe = segments.find((segment) => EDIT_FILE_BLOCKED_JSON_PATH_SEGMENTS.has(segment));
  if (unsafe) return { ok: false, message: `jsonPath contains unsafe segment: ${unsafe}` };
  return { ok: true, segments };
}

export function setJsonPathValue(root, segments, value) {
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (cursor == null || typeof cursor !== "object") {
      return { ok: false, message: `jsonPath segment does not resolve to an object: ${segment}` };
    }
    if (Array.isArray(cursor)) {
      if (!/^\d+$/.test(segment)) return { ok: false, message: `jsonPath array segment must be a non-negative integer: ${segment}` };
      const index = Number(segment);
      if (index < 0 || index >= cursor.length) return { ok: false, message: `jsonPath array index is out of range: ${segment}` };
      cursor = cursor[index];
    } else {
      if (!hasOwn(cursor, segment)) return { ok: false, message: `jsonPath segment was not found: ${segment}` };
      cursor = cursor[segment];
    }
  }

  const leaf = segments[segments.length - 1];
  if (cursor == null || typeof cursor !== "object") {
    return { ok: false, message: `jsonPath parent does not resolve to an object: ${leaf}` };
  }
  if (Array.isArray(cursor)) {
    if (!/^\d+$/.test(leaf)) return { ok: false, message: `jsonPath array leaf must be a non-negative integer: ${leaf}` };
    const index = Number(leaf);
    if (index < 0 || index >= cursor.length) return { ok: false, message: `jsonPath array index is out of range: ${leaf}` };
    cursor[index] = value;
    return { ok: true };
  }
  cursor[leaf] = value;
  return { ok: true };
}

export function splitReplacementLines(value) {
  const normalized = String(value ?? "").replace(/\r\n/g, "\n");
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return body.length > 0 ? body.split("\n") : [];
}

// Line breaks an edit inserts follow the text it replaces when that spans
// lines, else the file's dominant ending, so a CRLF file gains no bare LF.
export function insertedTextEol(content, replaced = "") {
  if (replaced.includes("\r\n")) return "\r\n";
  if (replaced.includes("\n")) return "\n";
  const crlf = content.split("\r\n").length - 1;
  return crlf > content.split("\n").length - 1 - crlf ? "\r\n" : "\n";
}

export function withLineEnding(value, eol) {
  return String(value ?? "").replace(/\r?\n/g, eol);
}

// Insert whole lines before 1-based `line` (or after the last one) without
// touching any existing line's own terminator.
export function insertEditableLines(content, line, lineCount, hadFinalEol, inserted, eol) {
  if (inserted.length === 0) return content;
  const text = inserted.join(eol);
  if (line <= lineCount) {
    let offset = 0;
    for (let i = 1; i < line; i += 1) offset = content.indexOf("\n", offset) + 1;
    return content.slice(0, offset) + text + eol + content.slice(offset);
  }
  if (lineCount === 0) return text + content;
  return hadFinalEol ? content + text + eol : content + eol + text;
}

// A jsonPath edit is spliced into the original text at the located value's
// offsets, so numbers, escapes, key order and layout elsewhere survive (a
// JSON.parse/stringify round trip rewrote them). The scanner assumes text
// JSON.parse has already accepted.
const JSON_WS = " \t\n\r";

function skipJsonWs(text, at) {
  let i = at;
  while (i < text.length && JSON_WS.includes(text[i])) i += 1;
  return i;
}

function jsonStringEnd(text, at) {
  for (let i = at + 1; i < text.length; i += 1) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === "\"") return i + 1;
  }
  return text.length;
}

function jsonValueEnd(text, at) {
  if (text[at] === "\"") return jsonStringEnd(text, at);
  if (text[at] !== "{" && text[at] !== "[") {
    let i = at;
    while (i < text.length && !JSON_WS.includes(text[i]) && !",]}".includes(text[i])) i += 1;
    return i;
  }
  let depth = 0;
  for (let i = at; i < text.length; i += 1) {
    if (text[i] === "\"") i = jsonStringEnd(text, i) - 1;
    else if (text[i] === "{" || text[i] === "[") depth += 1;
    else if ((text[i] === "}" || text[i] === "]") && --depth === 0) return i + 1;
  }
  return text.length;
}

// Members of the object (or elements of the array) opening at `open`.
function jsonEntries(text, open) {
  const isObject = text[open] === "{";
  const entries = [];
  let i = skipJsonWs(text, open + 1);
  while (i < text.length && text[i] !== "}" && text[i] !== "]") {
    const entry = { start: i, keyEnd: i, key: /** @type {string | null} */ (null), valueStart: i, valueEnd: i };
    if (isObject) {
      entry.keyEnd = jsonStringEnd(text, i);
      entry.key = JSON.parse(text.slice(i, entry.keyEnd));
      i = skipJsonWs(text, skipJsonWs(text, entry.keyEnd) + 1);
    }
    entry.valueStart = i;
    entry.valueEnd = jsonValueEnd(text, i);
    entries.push(entry);
    i = skipJsonWs(text, entry.valueEnd);
    if (text[i] === ",") i = skipJsonWs(text, i + 1);
  }
  return { entries, close: i };
}

function lineIndentAt(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] || "";
}

/**
 * Set `segments` to `value` in JSON `content` by replacing only the located
 * value's text (or appending the missing leaf key to its object). Refuses a
 * path whose key appears more than once in an object it passes through.
 * `setJsonPathValue` must already have vetted the path against the parse.
 */
export function spliceJsonPathValue(content, segments, value, { eol = "\n", indentUnit = "" } = {}) {
  const serialized = JSON.stringify(value, null, indentUnit);
  if (serialized === undefined) return { ok: false, message: "jsonValue must be a JSON value" };
  const render = (indent) => serialized.replace(/\n/g, `${eol}${indent}`);
  let at = skipJsonWs(content, 0);
  for (let s = 0; s < segments.length; s += 1) {
    const { entries, close } = jsonEntries(content, at);
    if (content[at] === "[") {
      at = entries[Number(segments[s])].valueStart;
      continue;
    }
    const matches = entries.filter((entry) => entry.key === segments[s]);
    if (matches.length > 1) {
      return { ok: false, message: `jsonPath ${segments.slice(0, s + 1).join(".")} names a key that appears ${matches.length} times` };
    }
    if (matches.length === 1) {
      at = matches[0].valueStart;
      continue;
    }
    // Only the leaf can be missing here; add it after the last member.
    const key = JSON.stringify(segments[s]);
    const last = entries[entries.length - 1];
    if (!last) {
      const outer = lineIndentAt(content, at);
      const body = indentUnit
        ? `{${eol}${outer}${indentUnit}${key}: ${render(outer + indentUnit)}${eol}${outer}}`
        : `{${key}:${render("")}}`;
      return { ok: true, content: content.slice(0, at) + body + content.slice(close + 1) };
    }
    const multiLine = content.slice(at, close).includes("\n");
    const indent = multiLine ? lineIndentAt(content, last.start) : "";
    const gap = multiLine ? `${eol}${indent}` : content.slice(at + 1, entries[0].start);
    const member = `,${gap}${key}${content.slice(last.keyEnd, last.valueStart)}${render(indent)}`;
    return { ok: true, content: content.slice(0, last.valueEnd) + member + content.slice(last.valueEnd) };
  }
  return { ok: true, content: content.slice(0, at) + render(lineIndentAt(content, at)) + content.slice(jsonValueEnd(content, at)) };
}

export function detectJsonIndent(content) {
  const lines = String(content || "").split(/\r?\n/);
  for (const line of lines) {
    const match = /^([ \t]+)(?:"|[{[]|[-\dtnf])/.exec(line);
    if (match) return match[1].slice(0, 10);
  }
  return "  ";
}
