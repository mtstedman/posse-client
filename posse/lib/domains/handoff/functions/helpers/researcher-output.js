// lib/handoff/helpers/researcher-output.js
//
// Researcher structured output parsing helpers.

import { extractJsonResult } from "../../../../shared/format/functions/json.js";
import { sanitizeAtlasSymbolIdList } from "../../../atlas/functions/v2/symbol-id.js";

/**
 * Extract the structured researcher appendix from output text.
 * Accepts either the current JSON appendix schema or older variants.
 */
export function parseResearcherStructuredOutput(output) {
  if (!output || typeof output !== "string") return null;
  const result = extractJsonResult(output);
  if (!result.found) return null;
  if (result.repaired) return null;
  const parsed = result.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const hasRecognizedFields =
    Array.isArray(parsed.key_files) ||
    Array.isArray(parsed.related_files) ||
    Array.isArray(parsed.key_symbols) ||
    Array.isArray(parsed.planner_file_priorities) ||
    Array.isArray(parsed.ranked_files) ||
    Array.isArray(parsed.constraints) ||
    (parsed.patterns && typeof parsed.patterns === "object") ||
    (parsed.scope_estimate && typeof parsed.scope_estimate === "object" && !Array.isArray(parsed.scope_estimate)) ||
    typeof parsed.questions_for_human === "boolean" ||
    Array.isArray(parsed.questions);
  if (hasRecognizedFields) return parsed;
  return null;
}

/**
 * Normalize researcher-provided key_symbols (opaque ATLAS symbol IDs) for
 * downstream seeding. Symbols that fail the ATLAS id shape are dropped —
 * the brief's symbol list is a seed contract, not free text. Entries may be
 * bare id strings or { symbolId, name?, why? } objects.
 *
 * @param {any} parsed
 * @param {number} [maxItems]
 * @returns {string[]}
 */
export function normalizeResearcherKeySymbols(parsed, maxItems = 24) {
  const source = Array.isArray(parsed?.key_symbols) ? parsed.key_symbols : [];
  const rawIds = source
    .map((entry) => (typeof entry === "string" ? entry : entry?.symbolId || entry?.symbol_id || ""))
    .filter(Boolean);
  try {
    return sanitizeAtlasSymbolIdList(rawIds, maxItems, "researcher key_symbols");
  } catch {
    // A malformed entry must not discard the whole list — re-validate one by one.
    const out = [];
    for (const id of rawIds) {
      try {
        const [valid] = sanitizeAtlasSymbolIdList([id], 1, "researcher key_symbols");
        if (valid && !out.includes(valid)) out.push(valid);
      } catch { /* drop the malformed id */ }
      if (out.length >= maxItems) break;
    }
    return out;
  }
}

function filePathFromResearcherValue(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.path === "string") return value.path;
  return "";
}

function normalizePriorityString(value, fallback = "unspecified") {
  const text = String(value || "").trim();
  return text ? text.slice(0, 80) : fallback;
}

/**
 * Normalize researcher-provided planner file priority objects without applying
 * repo path safety. Callers that touch disk must still sanitize paths.
 */
export function normalizeResearcherFilePriorities(parsed) {
  const source = Array.isArray(parsed?.planner_file_priorities)
    ? parsed.planner_file_priorities
    : Array.isArray(parsed?.ranked_files)
      ? parsed.ranked_files
      : [];
  const seen = new Set();
  const priorities = [];

  source.forEach((entry, index) => {
    const path = filePathFromResearcherValue(entry).trim();
    if (!path || seen.has(path)) return;
    seen.add(path);
    const rawRank = entry && typeof entry === "object" ? Number(entry.rank) : NaN;
    priorities.push({
      path,
      rank: Number.isFinite(rawRank) && rawRank > 0 ? rawRank : priorities.length + 1,
      usefulness: normalizePriorityString(entry?.usefulness, "unspecified"),
      evidence: normalizePriorityString(entry?.evidence, "unspecified"),
      reason: String(entry?.reason || "").trim().slice(0, 240),
    });
  });

  return priorities
    .sort((a, b) => a.rank - b.rank)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/**
 * Determine whether researcher output explicitly requests human clarification.
 * Prefers the canonical structured appendix, with legacy text markers as fallback.
 */
export function researcherOutputNeedsHuman(output) {
  const structured = parseResearcherStructuredOutput(output);
  if (structured && typeof structured.questions_for_human === "boolean") {
    return structured.questions_for_human;
  }
  if (!output || typeof output !== "string") return false;
  return /questions_for_human["']?\s*:\s*true/i.test(output)
    || /QUESTIONS_FOR_HUMAN:\s*true/i.test(output)
    || /Questions for Human/i.test(output);
}

/**
 * Extract key_files / related_files from researcher output artifacts.
 */
export function extractResearcherFiles(artifacts) {
  let keyFiles = [];
  for (const a of artifacts || []) {
    const parsed = parseResearcherStructuredOutput(a.content_long || "");
    if (!parsed) continue;
    let artifactFiles = [];
    const priorityFiles = normalizeResearcherFilePriorities(parsed).map((entry) => entry.path);
    if (priorityFiles.length > 0) artifactFiles = [...artifactFiles, ...priorityFiles];
    if (Array.isArray(parsed.key_files)) {
      const paths = parsed.key_files.map((f) => typeof f === "string" ? f : f?.path).filter(Boolean);
      artifactFiles = [...artifactFiles, ...paths];
    }
    if (Array.isArray(parsed.related_files)) {
      const paths = parsed.related_files.map((f) => typeof f === "string" ? f : f?.path).filter(Boolean);
      artifactFiles = [...artifactFiles, ...paths];
    }
    if (priorityFiles.length > 0 || Array.isArray(parsed.key_files) || Array.isArray(parsed.related_files)) {
      keyFiles = [...new Set([...keyFiles, ...artifactFiles])];
    }
  }
  return keyFiles;
}
