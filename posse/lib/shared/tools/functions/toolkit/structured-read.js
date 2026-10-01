const READ_FILE_MAX_SEARCH_MATCHES = 100;
const READ_FILE_MAX_SEARCH_PATTERN_CHARS = 200;
// A matching line longer than this is reported as snippets around each match
// with its column, not as the whole line (minified JSON is one 9 MB line).
const READ_FILE_LONG_LINE_CHARS = 2000;
const READ_FILE_SNIPPET_RADIUS = 120;
const READ_FILE_CONTEXT_LINE_CHARS = 400;
const READ_FILE_JSON_VALUE_MAX_CHARS = 64 * 1024;
const READ_FILE_JSON_PREVIEW_CHARS = 8 * 1024;

function toPositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toNonNegativeInt(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

export function hasStructuredReadOptions(args = {}) {
  return args.maxBytes != null || args.search != null || args.jsonPath != null;
}

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
export function looksReDosProne(pattern) {
  return /\([^)]*[+*][^)]*\)[+*{]/.test(pattern) || /(\.\*){3,}/.test(pattern) || /\[[^\]]+\][+*]\s*[+*{]/.test(pattern);
}

function compileReadSearchPattern(pattern) {
  const raw = String(pattern || "");
  if (raw.length > READ_FILE_MAX_SEARCH_PATTERN_CHARS) return { ok: false, message: `search pattern exceeds ${READ_FILE_MAX_SEARCH_PATTERN_CHARS} characters` };
  const source = looksReDosProne(raw) ? escapeRegExp(raw) : raw;
  try { return { ok: true, re: new RegExp(source, "i") }; } catch (err) { return { ok: false, message: `Invalid search regex: ${err?.message || String(err)}` }; }
}

function extractJsonPath(root, jsonPath) {
  let cursor = root;
  for (const segment of String(jsonPath || "").split(".").filter(Boolean)) {
    if (cursor == null) return undefined;
    if (Array.isArray(cursor) && /^\d+$/.test(segment)) cursor = cursor[Number(segment)];
    else if (typeof cursor === "object" && Object.prototype.hasOwnProperty.call(cursor, segment)) cursor = cursor[segment];
    else return undefined;
  }
  return cursor;
}

export function splitEditableLines(content) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalEol = content.endsWith("\n");
  const body = hadFinalEol ? content.replace(/\r?\n$/, "") : content;
  return { eol, hadFinalEol, lines: body.length > 0 ? body.split(/\r?\n/) : [] };
}

export function formatNumberedLines(lines, startLine) {
  return lines.map((line, i) => `${String(startLine + i).padStart(6)}\t${line}`).join("\n");
}

function clipLine(text, max = READ_FILE_CONTEXT_LINE_CHARS) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}… [${value.length - max} more chars]` : value;
}

function longLineSnippets(text, re, lineNumber, limit) {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const snippets = [];
  let match;
  while (snippets.length < limit && (match = global.exec(text)) !== null) {
    const start = Math.max(0, match.index - READ_FILE_SNIPPET_RADIUS);
    const end = Math.min(text.length, match.index + match[0].length + READ_FILE_SNIPPET_RADIUS);
    snippets.push({
      line: lineNumber,
      column: match.index + 1,
      snippet: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    });
    if (match[0].length === 0) global.lastIndex += 1;
  }
  return snippets;
}

function summarizeJsonValue(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length <= READ_FILE_JSON_VALUE_MAX_CHARS) return { value, truncated: false };
  if (Array.isArray(value)) {
    const preview = [];
    let chars = 2;
    for (const item of value) {
      const size = (JSON.stringify(item) || "").length + 1;
      if (chars + size > READ_FILE_JSON_PREVIEW_CHARS) break;
      preview.push(item);
      chars += size;
    }
    return { value: { type: "array", length: value.length, preview }, truncated: true };
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    return { value: { type: "object", keyCount: keys.length, keys: keys.slice(0, 200) }, truncated: true };
  }
  return { value: `${serialized.slice(0, READ_FILE_JSON_PREVIEW_CHARS)}…`, truncated: true };
}

export function buildStructuredReadResult({ args, displayPath, content, selectedLines, startLine, totalBytes, totalLines, truncated, defaultMaxBytes = null }) {
  let returnedLines = selectedLines;
  let rawContent = selectedLines.join("\n");
  let clipped = false;
  const maxBytes = toPositiveInt(args.maxBytes, null) ?? toPositiveInt(defaultMaxBytes, null);
  if (maxBytes != null && Buffer.byteLength(rawContent, "utf8") > maxBytes) {
    rawContent = Buffer.from(rawContent, "utf8").subarray(0, maxBytes).toString("utf8");
    returnedLines = rawContent.split("\n");
    clipped = true;
  }
  const data = { ok: true, path: displayPath, totalBytes, totalLines, startLine, returnedLines: returnedLines.length, truncated: Boolean(truncated || clipped), content: rawContent, numberedContent: formatNumberedLines(returnedLines, startLine) };
  if (args.search != null) {
    const compiled = compileReadSearchPattern(args.search);
    if (!compiled.ok) return `Error: ${compiled.message}`;
    const ctxLines = toNonNegativeInt(args.searchContext, 2);
    const matches = [];
    for (let li = 0; li < selectedLines.length; li += 1) {
      compiled.re.lastIndex = 0;
      if (!compiled.re.test(selectedLines[li])) continue;
      if (selectedLines[li].length > READ_FILE_LONG_LINE_CHARS) {
        const snippets = longLineSnippets(selectedLines[li], compiled.re, startLine + li, READ_FILE_MAX_SEARCH_MATCHES - matches.length);
        matches.push(...snippets);
        data.longLineSnippets = true;
        if (matches.length >= READ_FILE_MAX_SEARCH_MATCHES) { data.truncated = true; break; }
        continue;
      }
      matches.push({ line: startLine + li, text: selectedLines[li], context: { before: selectedLines.slice(Math.max(0, li - ctxLines), li).map((line) => clipLine(line)), after: selectedLines.slice(li + 1, Math.min(selectedLines.length, li + 1 + ctxLines)).map((line) => clipLine(line)) } });
      if (matches.length >= READ_FILE_MAX_SEARCH_MATCHES) { data.truncated = true; break; }
    }
    data.matches = matches;
  }
  if (args.jsonPath != null) {
    try {
      const value = extractJsonPath(JSON.parse(content), args.jsonPath);
      const summary = summarizeJsonValue(value);
      data.jsonPathValue = summary.value;
      data.jsonPathMatched = value !== undefined;
      if (summary.truncated) {
        data.jsonPathValueTruncated = true;
        data.jsonPathHint = "The value is too large to return whole; request a deeper jsonPath (for example an array index such as items.0, or one object key).";
      }
    }
    catch (err) { data.jsonPathMatched = false; data.jsonPathError = `Invalid JSON: ${err?.message || String(err)}`; }
  }
  return JSON.stringify(data, null, 2);
}
