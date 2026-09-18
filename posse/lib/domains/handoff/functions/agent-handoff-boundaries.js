import { redactString } from "../../bridge/functions/redaction.js";
import { SECRET_PATTERNS } from "../../../shared/telemetry/functions/logging/secret-patterns.js";
import { AGENT_HANDOFF_BEARER_PROSE_TERMS } from "../../../catalog/handoff.js";

export const AGENT_HANDOFF_COPIED_EVIDENCE_MIN_CHARS = 200;

// redactString intentionally treats any six-character Bearer value as a
// credential because it protects logs and bridge payloads where false
// positives are cheap. Terminal handoff prose has a different tradeoff:
// ordinary security design language such as "Bearer token" must not force a
// model retry. Only complete cataloged terms are eligible: a word boundary
// alone would also accept credential prefixes such as "token-opaque". Keep
// bearer-value punctuation and Unicode word continuations outside the prose
// exception. A single sentence-ending period may precede whitespace, closing
// punctuation or EOF; prefixes of longer credential-shaped values are ineligible.
const BEARER_PLACEHOLDER_RE = new RegExp(
  String.raw`\bBearer\s+(?:${AGENT_HANDOFF_BEARER_PROSE_TERMS
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?:\.(?=$|[\s"'\x60)\]}]))?(?![\p{L}\p{N}\p{M}\p{Pc}\p{Cf}._~+/=-])`,
  "giu",
);

function statelessRegex(pattern) {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
}

export function detectSensitiveAgentHandoffText(value) {
  const text = String(value ?? "");
  for (const { re, label } of SECRET_PATTERNS) {
    if (statelessRegex(re).test(text)) return label;
  }
  const placeholderSafeText = text.replace(BEARER_PLACEHOLDER_RE, "Bearer <placeholder>");
  return redactString(placeholderSafeText) === placeholderSafeText
    ? null
    : "credential or authentication token";
}

export function normalizeAgentHandoffOverlapText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function findCopiedAgentHandoffEvidence(
  narrativeFragments,
  evidenceExcerpts,
  { minChars = AGENT_HANDOFF_COPIED_EVIDENCE_MIN_CHARS } = {},
) {
  const threshold = Number.isInteger(minChars) && minChars > 0
    ? minChars
    : AGENT_HANDOFF_COPIED_EVIDENCE_MIN_CHARS;
  const evidenceWindows = new Set();
  for (const excerpt of evidenceExcerpts || []) {
    const normalized = normalizeAgentHandoffOverlapText(excerpt);
    for (let index = 0; index + threshold <= normalized.length; index += 1) {
      evidenceWindows.add(normalized.slice(index, index + threshold));
    }
  }
  if (evidenceWindows.size === 0) return null;

  for (const fragment of narrativeFragments || []) {
    const normalized = normalizeAgentHandoffOverlapText(fragment?.text);
    for (let index = 0; index + threshold <= normalized.length; index += 1) {
      if (evidenceWindows.has(normalized.slice(index, index + threshold))) {
        return {
          label: String(fragment?.label || "model-authored narrative"),
          overlapChars: threshold,
        };
      }
    }
  }
  return null;
}

export const AGENT_HANDOFF_COPIED_EVIDENCE_MARKER = "[evidence excerpt omitted: cited by selector]";

// Normalize the way normalizeAgentHandoffOverlapText does, but one code point at
// a time so every normalized character keeps the span of original text it came
// from. Stripping needs that map; detection alone never did.
function normalizeWithSourceSpans(value) {
  const source = String(value ?? "");
  let text = "";
  const starts = [];
  const ends = [];
  let index = 0;
  for (const codePoint of source) {
    const start = index;
    index += codePoint.length;
    for (const char of codePoint.normalize("NFKC").toLowerCase()) {
      if (/\s/u.test(char)) {
        if (text.length === 0 || text.endsWith(" ")) continue;
        text += " ";
      } else {
        text += char;
      }
      while (starts.length < text.length) {
        starts.push(start);
        ends.push(index);
      }
    }
  }
  return { source, text, starts, ends };
}

function copiedEvidenceWindows(evidenceExcerpts, threshold) {
  const windows = new Set();
  for (const excerpt of evidenceExcerpts || []) {
    const { text } = normalizeWithSourceSpans(excerpt);
    for (let index = 0; index + threshold <= text.length; index += 1) {
      windows.add(text.slice(index, index + threshold));
    }
  }
  return windows;
}

// Replace each run of narrative text that repeats selected evidence with a
// short marker. The evidence already travels verified through its selector, so
// the copy carries nothing the consumer lacks; rejecting the handoff instead
// costs the producer a whole extra turn to delete it by hand.
export function stripCopiedAgentHandoffEvidence(
  value,
  evidenceExcerpts,
  { minChars = AGENT_HANDOFF_COPIED_EVIDENCE_MIN_CHARS, windows = null } = {},
) {
  const threshold = Number.isInteger(minChars) && minChars > 0
    ? minChars
    : AGENT_HANDOFF_COPIED_EVIDENCE_MIN_CHARS;
  const original = String(value ?? "");
  const evidenceWindows = windows || copiedEvidenceWindows(evidenceExcerpts, threshold);
  if (evidenceWindows.size === 0) return { text: original, removedChars: 0, spans: 0 };
  const { text, starts, ends } = normalizeWithSourceSpans(original);
  const ranges = [];
  let index = 0;
  while (index + threshold <= text.length) {
    if (!evidenceWindows.has(text.slice(index, index + threshold))) {
      index += 1;
      continue;
    }
    let last = index;
    while (last + 1 + threshold <= text.length
      && evidenceWindows.has(text.slice(last + 1, last + 1 + threshold))) {
      last += 1;
    }
    const normalizedEnd = last + threshold;
    ranges.push([starts[index], ends[normalizedEnd - 1]]);
    index = normalizedEnd;
  }
  if (ranges.length === 0) return { text: original, removedChars: 0, spans: 0 };
  let out = "";
  let cursor = 0;
  let removedChars = 0;
  for (const [start, end] of ranges) {
    out += original.slice(cursor, start) + AGENT_HANDOFF_COPIED_EVIDENCE_MARKER;
    removedChars += end - start;
    cursor = end;
  }
  out += original.slice(cursor);
  return { text: out, removedChars, spans: ranges.length };
}

export function copiedAgentHandoffEvidenceWindows(
  evidenceExcerpts,
  minChars = AGENT_HANDOFF_COPIED_EVIDENCE_MIN_CHARS,
) {
  return copiedEvidenceWindows(evidenceExcerpts, minChars);
}
