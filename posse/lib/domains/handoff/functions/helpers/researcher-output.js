// lib/domains/handoff/functions/helpers/researcher-output.js
//
// Researcher structured output parsing helpers.

import { extractJsonResult } from "../../../../shared/format/functions/json.js";
import { sanitizeAtlasSymbolIdList } from "../../../atlas/functions/v2/symbol-id.js";
import { normalizeResearchSymbolSeeds } from "./research-symbols.js";
import {
  formatHashRefSelector,
  HASH_REF_LANES,
  isHashRefAlias,
  normalizeHashRefAlias,
  parseHashRefSelector,
} from "../../../../catalog/hash-store.js";

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
    Array.isArray(parsed.memories) ||
    typeof parsed.synthesis === "string" ||
    HASH_REF_LANES.some((lane) => Array.isArray(parsed[lane])) ||
    Array.isArray(parsed.planner_file_priorities) ||
    Array.isArray(parsed.ranked_files) ||
    Array.isArray(parsed.constraints) ||
    (parsed.patterns && typeof parsed.patterns === "object") ||
    (parsed.scope_estimate && typeof parsed.scope_estimate === "object" && !Array.isArray(parsed.scope_estimate)) ||
    Array.isArray(parsed.absence_checks) ||
    typeof parsed.questions_for_human === "boolean" ||
    Array.isArray(parsed.questions);
  if (hasRecognizedFields) return parsed;
  return null;
}

function researcherEvidenceRefs(report = {}) {
  const lanes = { proof: [], support: [], decoy: [] };
  const selector = (item = {}) => ({
    ref: item.ref,
    ...(item.lines && item.selector !== item.ref ? {
      lines: {
        start: item.lines.start,
        count: item.lines.end - item.lines.start + 1,
      },
    } : {}),
  });
  for (const claim of Array.isArray(report.claims) ? report.claims : []) {
    const detail = claim?.[1] || {};
    for (const item of ["evidence", "proof", "support"].flatMap((lane) => (
      Array.isArray(detail[lane]) ? detail[lane] : []
    ))) {
      const grounded = ["Tool Result", "Full Tool Call"].includes(item?.provenance?.kind);
      const lane = item?.selector_kind === "path" || item?.path || !grounded
        ? "support"
        : "proof";
      lanes[lane].push(selector(item));
    }
    for (const entry of Array.isArray(detail.decoy) ? detail.decoy : []) {
      const [item, reason] = Array.isArray(entry) ? entry : [];
      if (!item) continue;
      lanes.decoy.push({ ...selector(item), why: reason });
    }
  }
  return lanes;
}

/**
 * Project a validated, materialized researcher terminal packet into the
 * structured appendix vocabulary consumed by planning. This intentionally
 * accepts both terminal researcher profiles: report packets are historical
 * compatibility input for build workflows whose remote selected the wrong
 * terminal profile.
 */
export function researcherPacketToStructuredOutput(packet) {
  if (!packet || !["researcher.pipeline.v1", "researcher.report.v1"].includes(packet.profile)) {
    const error = new Error("Expected a validated researcher terminal packet");
    error.code = "RESEARCHER_PACKET_INVALID";
    throw error;
  }
  const first = Array.isArray(packet.handoffs) ? packet.handoffs[0] : null;
  const report = first?.report;
  if (!report || typeof report !== "object") {
    const error = new Error("Researcher terminal packet is missing its report");
    error.code = "RESEARCHER_PACKET_INVALID";
    throw error;
  }

  const refs = researcherEvidenceRefs(report);
  const research = report.research && typeof report.research === "object"
    ? report.research
    : {};
  const files = [...new Set([
    ...(Array.isArray(report.scope?.key_files) ? report.scope.key_files : []),
    ...(Array.isArray(report.scope?.files_to_modify) ? report.scope.files_to_modify : []),
    ...(Array.isArray(report.scope?.files_to_create) ? report.scope.files_to_create : []),
  ])];
  const relatedFiles = [...new Set(
    Array.isArray(report.scope?.related_files) ? report.scope.related_files : [],
  )];
  const plannerFilePriorities = Array.isArray(research.planner_file_priorities)
    ? research.planner_file_priorities
    : files.map((filePath, index) => ({
        path: filePath,
        rank: index + 1,
        reason: "agent_handoff evidence",
      }));
  const patterns = Object.fromEntries(
    (Array.isArray(research.patterns) ? research.patterns : [])
      .filter((entry) => entry?.name)
      .map((entry) => [entry.name, entry.description]),
  );
  const questions = Array.isArray(research.question_details) && research.question_details.length > 0
    ? research.question_details
    : (Array.isArray(report.questions) ? report.questions : []);

  return {
    synthesis: report.summary || "",
    claims: (Array.isArray(report.claims) ? report.claims : [])
      .map((claim) => claim?.[0])
      .filter(Boolean),
    key_files: files,
    related_files: relatedFiles,
    key_symbols: Array.isArray(research.key_symbols) ? research.key_symbols : [],
    memories: Array.isArray(research.memories) ? research.memories : [],
    planner_file_priorities: plannerFilePriorities,
    proof: refs.proof,
    support: refs.support,
    decoy: refs.decoy,
    patterns,
    constraints: Array.isArray(report.constraints) ? report.constraints : [],
    ...(research.scope_estimate ? { scope_estimate: research.scope_estimate } : {}),
    ...(Array.isArray(research.absence_checks) ? { absence_checks: research.absence_checks } : {}),
    ...(Array.isArray(research.verification_targets) ? {
      verification_targets: research.verification_targets,
    } : {}),
    questions_for_human: packet.outcome === "input_required",
    questions,
  };
}

const RESEARCHER_MEMORY_TITLE_MAX = 120;
const RESEARCHER_MEMORY_CONTENT_MAX = 1200;
const RESEARCHER_CITATION_WHY_MAX = 180;
const RESEARCHER_CITATION_REFS_PER_LANE_MAX = 24;

function safeRelMemoryPath(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
  const segments = raw.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function resilientSymbolIdList(values, maxItems, fieldName) {
  const rawIds = (Array.isArray(values) ? values : []).map((v) => String(v || "").trim()).filter(Boolean);
  const out = [];
  for (const id of rawIds) {
    try {
      const [valid] = sanitizeAtlasSymbolIdList([id], 1, fieldName);
      if (valid && !out.includes(valid)) out.push(valid);
    } catch { /* drop the malformed id */ }
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeCitationWhy(value, maxChars = RESEARCHER_CITATION_WHY_MAX) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxChars) : "";
}

function citationEntryParts(entry) {
  if (typeof entry === "string") {
    const selector = parseHashRefSelector(entry);
    return {
      rawRef: selector?.ref || entry,
      lines: selector?.lines || null,
      why: "",
    };
  }
  if (Array.isArray(entry)) {
    const selector = typeof entry[0] === "string"
      ? parseHashRefSelector(entry[0])
      : null;
    return {
      rawRef: selector?.ref || entry[0]?.ref || entry[0]?.hash || entry[0],
      lines: selector?.lines || entry[0]?.lines || null,
      why: normalizeCitationWhy(entry[1]),
    };
  }
  if (entry && typeof entry === "object") {
    const selector = parseHashRefSelector(entry.selector ?? entry.hash ?? entry.ref ?? entry.ref_hash);
    return {
      rawRef: selector?.ref || entry.hash || entry.ref || entry.ref_hash,
      lines: selector?.lines || entry.lines || null,
      why: normalizeCitationWhy(entry.why ?? entry.note ?? entry.reason),
    };
  }
  return { rawRef: "", why: "" };
}

function normalizeCitationLines(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const start = Number(value.start);
  const count = value.count == null ? null : Number(value.count);
  const end = count == null ? Number(value.end) : start + count - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  return { start, end };
}

/**
 * Normalize researcher hash-ref citation triage into the closed lane contract
 * from the hash-store catalog. Entries may be "#hash", ["#hash", "why"], or
 * object-shaped { hash/ref/ref_hash, why/note/reason }. Decoy refs without a
 * why are dropped because the exclusion judgment is not recoverable from the
 * artifact payload alone.
 *
 * @param {any} parsed
 * @param {{ maxRefsPerLane?: number, maxWhyChars?: number }} [opts]
 * @returns {{ synthesis: string, proof: Array<{ hash: string, why?: string }>, support: Array<{ hash: string, why?: string }>, decoy: Array<{ hash: string, why: string }>, dropped: Array<{ lane: string, ref: string, reason: string }> }}
 */
export function normalizeResearcherCitationTriage(parsed, opts = {}) {
  const maxRefsPerLane = Math.max(
    1,
    Number.parseInt(String(opts.maxRefsPerLane || RESEARCHER_CITATION_REFS_PER_LANE_MAX), 10) ||
      RESEARCHER_CITATION_REFS_PER_LANE_MAX,
  );
  const maxWhyChars = Math.max(
    1,
    Number.parseInt(String(opts.maxWhyChars || RESEARCHER_CITATION_WHY_MAX), 10) ||
      RESEARCHER_CITATION_WHY_MAX,
  );
  const out = {
    synthesis: String(parsed?.synthesis || "").trim(),
    dropped: [],
  };
  for (const lane of HASH_REF_LANES) out[lane] = [];

  const seen = new Set();
  for (const lane of HASH_REF_LANES) {
    const entries = Array.isArray(parsed?.[lane]) ? parsed[lane] : [];
    for (const entry of entries) {
      if (out[lane].length >= maxRefsPerLane) break;
      const parts = citationEntryParts(entry);
      const hash = normalizeHashRefAlias(parts.rawRef);
      const lines = normalizeCitationLines(parts.lines);
      const selector = formatHashRefSelector(hash, lines);
      const why = normalizeCitationWhy(parts.why, maxWhyChars);
      if (!isHashRefAlias(hash)) {
        out.dropped.push({ lane, ref: String(parts.rawRef || "").trim(), reason: "invalid_ref" });
        continue;
      }
      if (seen.has(selector)) {
        out.dropped.push({ lane, ref: selector, reason: "duplicate_ref" });
        continue;
      }
      if (lane === "decoy" && !why) {
        out.dropped.push({ lane, ref: hash, reason: "missing_decoy_why" });
        continue;
      }
      seen.add(selector);
      const normalized = { hash };
      if (lines) normalized.lines = lines;
      if (why) normalized.why = why;
      out[lane].push(normalized);
    }
  }

  return out;
}

/**
 * Rewrite the final structured appendix so every material ref is delivered in
 * one lane only. Models occasionally repeat a ref in proof/support/decoy even
 * though downstream normalization is first-lane-wins; sanitizing before the
 * response artifact is stored keeps the durable handoff canonical too.
 *
 * @param {string} output
 * @returns {string}
 */
export function sanitizeResearcherStructuredOutput(output) {
  if (!output || typeof output !== "string") return output;
  const blocks = [...output.matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    const extracted = extractJsonResult(block[1]);
    if (!extracted.found || extracted.repaired) continue;
    const parsed = extracted.value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    if (!HASH_REF_LANES.some((lane) => Array.isArray(parsed[lane]))) continue;

    const triage = normalizeResearcherCitationTriage(parsed);
    const normalized = { ...parsed };
    for (const lane of HASH_REF_LANES) {
      normalized[lane] = triage[lane].map(({ hash, lines, why }) => (
        why ? [formatHashRefSelector(hash, lines), why] : [formatHashRefSelector(hash, lines)]
      ));
    }
    const replacement = `\`\`\`json\n${JSON.stringify(normalized, null, 2)}\n\`\`\``;
    return output.slice(0, block.index) + replacement + output.slice(block.index + block[0].length);
  }
  return output;
}

/**
 * Normalize the researcher's `memories` appendix field: durable findings the
 * pipeline persists deterministically (no agent tool calls). Hard-capped per
 * round, length-bounded, deduped by title — the appendix is
 * a seed contract, not free text.
 *
 * @param {any} parsed
 * @param {number} [maxItems]
 * @returns {Array<{ title: string, content: string, symbolIds: string[], fileRelPaths: string[] }>}
 */
export function normalizeResearcherMemories(parsed, maxItems = 5) {
  const source = Array.isArray(parsed?.memories) ? parsed.memories : [];
  const out = [];
  const seenTitles = new Set();
  for (const entry of source) {
    if (!entry || typeof entry !== "object") continue;
    const title = String(entry.title || "").trim().slice(0, RESEARCHER_MEMORY_TITLE_MAX);
    const content = String(entry.content || "").trim().slice(0, RESEARCHER_MEMORY_CONTENT_MAX);
    if (!title || !content) continue;
    const titleKey = title.toLowerCase();
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);
    const fileRelPaths = [];
    for (const value of Array.isArray(entry.key_files) ? entry.key_files : (Array.isArray(entry.files) ? entry.files : [])) {
      const path = safeRelMemoryPath(value);
      if (path && !fileRelPaths.includes(path)) fileRelPaths.push(path);
      if (fileRelPaths.length >= 12) break;
    }
    out.push({
      title,
      content,
      symbolIds: resilientSymbolIdList(entry.key_symbols ?? entry.symbolIds, 12, "researcher memory symbolIds"),
      fileRelPaths,
    });
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Normalize researcher-provided key_symbols for downstream seeding. Opaque
 * ATLAS ids and language-level qualified names are retained; malformed
 * optional entries are dropped instead of invalidating the research brief.
 *
 * @param {any} parsed
 * @param {number} [maxItems]
 * @returns {string[]}
 */
export function normalizeResearcherKeySymbols(parsed, maxItems = 24) {
  const source = Array.isArray(parsed?.key_symbols) ? parsed.key_symbols : [];
  const rawSeeds = source
    .map((entry) => (typeof entry === "string" ? entry : entry?.symbolId || entry?.symbol_id || ""))
    .filter(Boolean);
  return normalizeResearchSymbolSeeds(rawSeeds, maxItems);
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
