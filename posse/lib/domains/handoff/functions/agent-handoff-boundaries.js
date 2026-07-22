import { redactString } from "../../bridge/functions/redaction.js";
import { SECRET_PATTERNS } from "../../../shared/telemetry/functions/logging/secret-patterns.js";

export const AGENT_HANDOFF_COPIED_EVIDENCE_MIN_CHARS = 200;

function statelessRegex(pattern) {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
}

export function detectSensitiveAgentHandoffText(value) {
  const text = String(value ?? "");
  for (const { re, label } of SECRET_PATTERNS) {
    if (statelessRegex(re).test(text)) return label;
  }
  return redactString(text) === text ? null : "credential or authentication token";
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
