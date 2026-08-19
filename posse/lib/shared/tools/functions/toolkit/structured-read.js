const READ_FILE_MAX_SEARCH_MATCHES = 100;
const READ_FILE_MAX_SEARCH_PATTERN_CHARS = 200;

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

export function buildStructuredReadResult({ args, displayPath, content, selectedLines, startLine, totalBytes, totalLines, truncated }) {
  let returnedLines = selectedLines;
  let rawContent = selectedLines.join("\n");
  let clipped = false;
  const maxBytes = toPositiveInt(args.maxBytes, null);
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
      matches.push({ line: startLine + li, text: selectedLines[li], context: { before: selectedLines.slice(Math.max(0, li - ctxLines), li), after: selectedLines.slice(li + 1, Math.min(selectedLines.length, li + 1 + ctxLines)) } });
      if (matches.length >= READ_FILE_MAX_SEARCH_MATCHES) { data.truncated = true; break; }
    }
    data.matches = matches;
  }
  if (args.jsonPath != null) {
    try { const value = extractJsonPath(JSON.parse(content), args.jsonPath); data.jsonPathValue = value; data.jsonPathMatched = value !== undefined; }
    catch (err) { data.jsonPathMatched = false; data.jsonPathError = `Invalid JSON: ${err?.message || String(err)}`; }
  }
  return JSON.stringify(data, null, 2);
}
