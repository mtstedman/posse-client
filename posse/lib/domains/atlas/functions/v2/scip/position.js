// @ts-check
//
// SCIP occurrence range → JS string offsets. SCIP ranges are
// `repeated int32` in one of two shapes:
//
//   [start_line, start_char, end_char]                 (same line)
//   [start_line, start_char, end_line, end_char]       (multi-line)
//
// `start_line` is 0-based; `start_char`/`end_char` are interpreted according
// to Document.position_encoding:
//   1 = UTF-8 bytes, 2 = UTF-16 code units, 3 = UTF-32 code points.
// ATLAS stores JS string offsets, so UTF-8/UTF-32 positions are converted.

/**
 * Build a `lineStarts[]` array where `lineStarts[i]` is the JS-string char
 * offset at which line `i` (0-based) starts. The 0-th entry is always 0.
 *
 * @param {string} source
 * @returns {number[]}
 */
export function buildLineStarts(source) {
  /** @type {number[]} */
  const out = [0];
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    if (ch === 10) {
      // \n — single-character newline. Don't try to be clever about \r\n;
      // CRLF still ends at \n so the next line starts at i+1.
      out.push(i + 1);
    }
  }
  return out;
}

/**
 * Convert a SCIP occurrence range to a JS-string range. Falls back
 * conservatively if the line/column overshoot the source string — clamps
 * to `source.length` so we never throw mid-ingest for a slightly stale
 * `.scip` file. The caller can still filter on the returned indices.
 *
 * @param {number[]} range
 * @param {string} source
 * @param {number[]} lineStarts
 * @param {number} [positionEncoding]
 * @returns {{ start: number, end: number, range_start_line: number, range_end_line: number, clamped: boolean }}
 */
export function scipRangeToJs(range, source, lineStarts, positionEncoding = 2) {
  if (!Array.isArray(range) || range.length < 3) {
    return { start: 0, end: 0, range_start_line: 1, range_end_line: 1, clamped: true };
  }
  const startLine = range[0] | 0;
  const startChar = range[1] | 0;
  let endLine;
  let endChar;
  if (range.length === 3) {
    endLine = startLine;
    endChar = range[2] | 0;
  } else {
    endLine = range[2] | 0;
    endChar = range[3] | 0;
  }

  const sourceLen = source.length;
  const startOffset = clampOffset(lineStarts, source, sourceLen, startLine, startChar, positionEncoding);
  const endOffset = clampOffset(lineStarts, source, sourceLen, endLine, endChar, positionEncoding);
  const start = startOffset.offset;
  const end = endOffset.offset;
  const orderedEnd = Math.min(Math.max(end, start), sourceLen);
  return {
    start: Math.min(start, sourceLen),
    end: orderedEnd,
    // ATLAS row line anchors are 1-based; SCIP lines are 0-based.
    range_start_line: startLine + 1,
    range_end_line: endLine + 1,
    clamped: startOffset.clamped || endOffset.clamped || end < start,
  };
}

/**
 * @param {number[]} lineStarts
 * @param {string} source
 * @param {number} sourceLen
 * @param {number} line
 * @param {number} char
 * @param {number} positionEncoding
 * @returns {{ offset: number, clamped: boolean }}
 */
function clampOffset(lineStarts, source, sourceLen, line, char, positionEncoding) {
  if (line < 0) return { offset: 0, clamped: true };
  if (line >= lineStarts.length) return { offset: sourceLen, clamped: true };
  const lineStart = lineStarts[line];
  const lineEnd = line + 1 < lineStarts.length
    ? Math.max(lineStart, lineStarts[line + 1] - 1)
    : sourceLen;
  const lineText = source.slice(lineStart, lineEnd);
  const charLimit = encodedLineLength(lineText, positionEncoding);
  const normalizedChar = Math.max(0, char);
  const offset = Math.min(lineStart + charOffsetToJs(lineText, normalizedChar, positionEncoding), sourceLen);
  return {
    offset,
    clamped: char < 0 || normalizedChar > charLimit,
  };
}

/**
 * @param {string} lineText
 * @param {number} char
 * @param {number} positionEncoding
 * @returns {number}
 */
function charOffsetToJs(lineText, char, positionEncoding) {
  if (positionEncoding === 1) return utf8ByteOffsetToJs(lineText, char);
  if (positionEncoding === 3) return utf32CodePointOffsetToJs(lineText, char);
  return Math.min(char, lineText.length);
}

/**
 * @param {string} lineText
 * @param {number} positionEncoding
 * @returns {number}
 */
function encodedLineLength(lineText, positionEncoding) {
  if (positionEncoding === 1) return Buffer.byteLength(lineText, "utf8");
  if (positionEncoding === 3) return Array.from(lineText).length;
  return lineText.length;
}

/**
 * @param {string} text
 * @param {number} byteOffset
 * @returns {number}
 */
function utf8ByteOffsetToJs(text, byteOffset) {
  let bytes = 0;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp ?? 0);
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > byteOffset) return i;
    bytes += n;
    i += ch.length;
  }
  return text.length;
}

/**
 * @param {string} text
 * @param {number} codePointOffset
 * @returns {number}
 */
function utf32CodePointOffsetToJs(text, codePointOffset) {
  let points = 0;
  for (let i = 0; i < text.length;) {
    if (points >= codePointOffset) return i;
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp ?? 0);
    points++;
    i += ch.length;
  }
  return text.length;
}
