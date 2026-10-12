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

export function joinEditableLines(lines, eol, hadFinalEol) {
  return lines.join(eol) + (hadFinalEol ? eol : "");
}

export function detectJsonIndent(content) {
  const lines = String(content || "").split(/\r?\n/);
  for (const line of lines) {
    const match = /^([ \t]+)(?:"|[{[]|[-\dtnf])/.exec(line);
    if (match) return match[1].slice(0, 10);
  }
  return "  ";
}
