// Shared ANSI-aware terminal string helpers.

export const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
export const ANSI_PATTERN_AT_START = /^\x1b\[[0-?]*[ -/]*[@-~]/;

export function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "");
}

function isCombiningCodePoint(cp) {
  return (cp >= 0x0300 && cp <= 0x036F)
    || (cp >= 0x1AB0 && cp <= 0x1AFF)
    || (cp >= 0x1DC0 && cp <= 0x1DFF)
    || (cp >= 0x20D0 && cp <= 0x20FF)
    || (cp >= 0xFE00 && cp <= 0xFE0F)
    || (cp >= 0xFE20 && cp <= 0xFE2F);
}

function isWideCodePoint(cp) {
  return (cp >= 0x1100 && cp <= 0x115F)
    || cp === 0x2329
    || cp === 0x232A
    || (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F)
    || (cp >= 0xAC00 && cp <= 0xD7A3)
    || (cp >= 0xF900 && cp <= 0xFAFF)
    || (cp >= 0xFE10 && cp <= 0xFE19)
    || (cp >= 0xFE30 && cp <= 0xFE6F)
    || (cp >= 0xFF00 && cp <= 0xFF60)
    || (cp >= 0xFFE0 && cp <= 0xFFE6)
    || (cp >= 0x1F000 && cp <= 0x1FAFF)
    || (cp >= 0x2600 && cp <= 0x27BF);
}

const NARROW_SYMBOL_CODEPOINTS = new Set([
  0x2713, // check mark
  0x2717, // ballot x
]);

function codePointColumnWidth(cp) {
  if (cp == null) return 0;
  if (cp === 0 || cp < 32 || (cp >= 0x7F && cp < 0xA0) || isCombiningCodePoint(cp)) return 0;
  if (NARROW_SYMBOL_CODEPOINTS.has(cp)) return 1;
  return isWideCodePoint(cp) ? 2 : 1;
}

export function displayColumnWidth(value) {
  let width = 0;
  for (const ch of stripAnsi(value)) {
    width += codePointColumnWidth(ch.codePointAt(0));
  }
  return width;
}

function sliceAnsiByColumns(value, maxColumns) {
  let columns = 0;
  let i = 0;
  let out = "";
  const source = String(value ?? "");
  while (i < source.length && columns < maxColumns) {
    if (source[i] === "\x1b") {
      const match = ANSI_PATTERN_AT_START.exec(source.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    const cp = source.codePointAt(i);
    if (cp == null) break;
    const ch = String.fromCodePoint(cp);
    const charWidth = codePointColumnWidth(cp);
    if (charWidth > 0 && columns + charWidth > maxColumns) break;
    out += ch;
    columns += charWidth;
    i += ch.length;
  }
  return { text: out, columns };
}

export function fit(value, width, { reset = "\x1b[0m" } = {}) {
  if (width <= 0) return "";
  const columns = displayColumnWidth(value);
  if (columns > width) {
    const slice = sliceAnsiByColumns(value, Math.max(0, width - 1));
    const used = slice.columns + 1;
    return slice.text + "\u2026" + reset + " ".repeat(Math.max(0, width - used));
  }
  const text = String(value ?? "");
  const hasAnsi = /\x1b\[[0-?]*[ -/]*[@-~]/.test(text);
  const resetSuffix = hasAnsi && reset && !text.endsWith(reset) ? reset : "";
  return text + resetSuffix + " ".repeat(width - columns);
}
