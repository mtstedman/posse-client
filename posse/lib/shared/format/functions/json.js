// lib/format/json.js
//
// Provider-agnostic JSON extraction helpers for LLM output.

const MAX_FENCED_JSON_CANDIDATES = 5;

// Sanitize common LLM JSON quirks that JSON.parse rejects:
// - trailing commas: [1, 2,] or {"a": 1,}
// - single-line comments: // ...
// - block comments: /* ... */
function sanitizeJson(raw) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (esc) { esc = false; out += ch; continue; }
    if (ch === "\\" && inStr) { esc = true; out += ch; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (!inStr) {
      if (ch === "/" && raw[i + 1] === "/") {
        while (i < raw.length && raw[i] !== "\n") i++;
        out += "\n";
        continue;
      }
      if (ch === "/" && raw[i + 1] === "*") {
        i += 2;
        while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out.replace(/,\s*([\]}])/g, "$1");
}

function repairTruncated(raw) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (stack.length === 0) return null;

  let trimmed = raw;
  if (inStr) trimmed += '"';
  const lastGood = trimmed.search(/,\s*("[^"]*":\s*)?[^,\[\]{}"]*$/);
  if (lastGood !== -1) trimmed = trimmed.slice(0, lastGood);
  let suffix = "";
  while (stack.length) suffix += stack.pop();
  return trimmed + suffix;
}

export function extractJsonResult(text) {
  if (!text || typeof text !== "string") return { found: false, value: null };
  const foundResult = (value, repaired = false) => (
    repaired ? { found: true, value, repaired: true } : { found: true, value }
  );

  const tryParse = (s) => {
    try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false, value: null }; }
  };

  const tryCandidate = (raw) => {
    let result = tryParse(raw);
    if (result.ok) return { ...result, repaired: false };
    const sanitized = sanitizeJson(raw);
    result = tryParse(sanitized);
    if (result.ok) return { ...result, repaired: false };
    const repaired = repairTruncated(sanitized);
    if (repaired) {
      result = tryParse(repaired);
      if (result.ok) return { ...result, repaired: true };
    }
    return { ok: false, value: null };
  };

  const fencedGreedy = text.match(/```json\s*([\s\S]*)```/);
  if (fencedGreedy) {
    const result = tryCandidate(fencedGreedy[1].trim());
    if (result.ok) return foundResult(result.value, result.repaired);
  }

  const allFenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (allFenced.length > 0) {
    const sorted = [...allFenced].sort((a, b) => b[1].length - a[1].length).slice(0, MAX_FENCED_JSON_CANDIDATES);
    for (const m of sorted) {
      const result = tryCandidate(m[1].trim());
      if (result.ok) return foundResult(result.value, result.repaired);
    }
  }

  const full = tryCandidate(text.trim());
  if (full.ok) return foundResult(full.value, full.repaired);

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const sub = text.slice(searchFrom);
    const offset = sub.search(/[\[{]/);
    if (offset === -1) break;
    const startIdx = searchFrom + offset;

    const opener = text[startIdx];
    const closer = opener === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;
    let endIdx = -1;

    for (let i = startIdx; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === opener) depth++;
      else if (ch === closer) depth--;
      if (depth === 0) { endIdx = i; break; }
    }

    if (endIdx !== -1) {
      const result = tryCandidate(text.slice(startIdx, endIdx + 1));
      if (result.ok) return foundResult(result.value, result.repaired);
    }

    searchFrom = startIdx + 1;
  }

  const firstBracket = text.search(/[\[{]/);
  if (firstBracket !== -1) {
    const result = tryCandidate(text.slice(firstBracket));
    if (result.ok) return foundResult(result.value, result.repaired);
  }

  return { found: false, value: null };
}

export function extractJson(text) {
  const result = extractJsonResult(text);
  return result.found ? result.value : null;
}
