// @ts-check



/**
 * @param {string} text
 * @param {number} maxBytes
 */
export function truncateUtf8String(text, maxBytes) {
  let used = 0;
  let out = "";
  for (const char of String(text || "")) {
    const next = Buffer.byteLength(char, "utf8");
    if (used + next > maxBytes) break;
    out += char;
    used += next;
  }
  return out;
}
