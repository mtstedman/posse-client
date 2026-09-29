// Shaping of a research child's committed report into the compact packet the
// planner receives. Everything here is deterministic and never throws: a
// report that already cost a full child run is trimmed or annotated, never
// discarded (caps are soft; a rejection costs a whole producer turn).

import { parseAgentHandoffEvidenceSelector } from "../../handoff/functions/agent-handoff.js";
import { truncateCompletionProse } from "../../handoff/functions/helpers/shape-normalizer.js";

const CLAIM_PROSE_TRIM_CHARS = 120;
const CLAIM_TEXT_TRIM_CHARS = 500;
// Floors used only when nothing else is left to trim.
const SUMMARY_FLOOR_CHARS = 160;
const LAST_RESORT_TEXT_CHARS = 200;
const PROSE_KEYS = ["prose", "summary"];
const CITED_LANES = ["evidence", "proof", "support"];

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function jsonChars(value) {
  return JSON.stringify(value).length;
}

function claimDetail(claim) {
  if (Array.isArray(claim)) return plainObject(claim[1]) ? claim[1] : null;
  return plainObject(claim) ? claim : null;
}

// A research finding cites evidence in any of the shapes the handoff
// validator accepts: object lanes or a [text, detail] tuple with lanes.
export function researchFindingHasEvidence(claim) {
  const detail = claimDetail(claim);
  if (!detail) return false;
  return CITED_LANES.some((lane) => Array.isArray(detail[lane]) && detail[lane].length > 0);
}

// The evidence metadata the planner needs: the selector and its location.
// Excerpts, hashes, and provenance stay behind the ref.
export function compactResearchEvidenceItem(evidence) {
  if (!plainObject(evidence)) return evidence;
  const { selector, ref, path, lines, source_start_line, source_end_line,
    expanded, expanded_ref, source_ref, expansion_reason } = evidence;
  return {
    ...(selector != null ? { selector } : {}),
    ...(ref != null ? { ref } : {}),
    ...(path != null ? { path } : {}),
    ...(lines != null ? { lines } : {}),
    ...(source_start_line != null ? { source_start_line } : {}),
    ...(source_end_line != null ? { source_end_line } : {}),
    ...(expanded != null ? { expanded } : {}),
    ...(expanded_ref != null ? { expanded_ref } : {}),
    ...(source_ref != null ? { source_ref } : {}),
    ...(expansion_reason != null ? { expansion_reason } : {}),
  };
}

function eachClaim(packet, visit) {
  for (const handoff of packet?.handoffs || []) {
    const claims = handoff?.report?.claims;
    if (!Array.isArray(claims)) continue;
    for (let index = 0; index < claims.length; index++) visit(claims, index, handoff);
  }
}

function claimCount(packet) {
  let count = 0;
  eachClaim(packet, () => { count += 1; });
  return count;
}

/**
 * Accept a report whose findings are not all cited instead of bouncing the
 * child for another full-context turn. Uncited findings reach the planner as
 * prose leads marked `unverified` (no ref is invented for them). Only a report
 * with no cited finding at all (the case the old check rejected) is capped at
 * `partial`; a mostly cited report keeps the child's outcome.
 */
export function markUncitedResearchClaims(packet) {
  let total = 0;
  let uncited = 0;
  eachClaim(packet, (claims, index) => {
    total += 1;
    const claim = claims[index];
    if (researchFindingHasEvidence(claim)) return;
    uncited += 1;
    if (Array.isArray(claim)) {
      claims[index] = [claim[0], { ...(plainObject(claim[1]) ? claim[1] : {}), unverified: true }];
    } else if (plainObject(claim)) {
      claims[index] = { ...claim, unverified: true };
    } else {
      claims[index] = [String(claim ?? ""), { unverified: true }];
    }
  });
  const priorOutcome = packet?.outcome ?? null;
  const outcomeForced = total > 0 && uncited === total && priorOutcome !== "failed" && priorOutcome !== "partial";
  if (outcomeForced) packet.outcome = "partial";
  return { packet, total, uncited, priorOutcome, outcomeForced };
}

function selectorRange(item) {
  if (!plainObject(item) || item.selector == null) return null;
  try {
    return parseAgentHandoffEvidenceSelector(item.selector);
  } catch {
    return null;
  }
}

function linesEqual(lines, start, end) {
  if (!plainObject(lines) || start == null) return false;
  const lineEnd = lines.end ?? (Number.isInteger(lines.count) ? lines.start + lines.count - 1 : null);
  return lines.start === start && lineEnd === end;
}

// Drop metadata the selector already carries: its ref and its line range.
function losslessEvidenceItem(item) {
  const compact = compactResearchEvidenceItem(item);
  const parsed = selectorRange(compact);
  if (!parsed) return compact;
  const out = { ...compact };
  if (out.ref != null && parsed.ref != null && out.ref === parsed.ref) delete out.ref;
  if (parsed.start != null) {
    if (linesEqual(out.lines, parsed.start, parsed.end)) delete out.lines;
    if (out.source_start_line === parsed.start) delete out.source_start_line;
    if (out.source_end_line === parsed.end) delete out.source_end_line;
  }
  return out;
}

function compactDecoyEntry(entry) {
  if (Array.isArray(entry)) return [losslessEvidenceItem(entry[0]), ...entry.slice(1)];
  return losslessEvidenceItem(entry);
}

function applyLossless(packet) {
  eachClaim(packet, (claims, index) => {
    const detail = claimDetail(claims[index]);
    if (!detail) return;
    for (const lane of CITED_LANES) {
      if (Array.isArray(detail[lane])) detail[lane] = detail[lane].map(losslessEvidenceItem);
    }
    if (Array.isArray(detail.decoy)) detail.decoy = detail.decoy.map(compactDecoyEntry);
  });
}

function evidenceOccurrences(packet) {
  let count = 0;
  eachClaim(packet, (claims, index) => {
    const detail = claimDetail(claims[index]);
    if (Array.isArray(detail?.evidence)) count += detail.evidence.length;
  });
  return count;
}

function claimText(claim) {
  if (Array.isArray(claim)) return claim[0];
  return plainObject(claim) ? claim.claim : null;
}

function setClaimText(claims, index, text) {
  const claim = claims[index];
  if (Array.isArray(claim)) claim[0] = text;
  else if (plainObject(claim)) claim.claim = text;
}

function headTail(text, max) {
  if (typeof text !== "string" || text.length <= max) return text;
  const marker = ` … [trimmed from ${text.length} chars] … `;
  const keep = Math.max(0, max - marker.length);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${text.slice(0, head).trimEnd()}${marker}${tail > 0 ? text.slice(text.length - tail).trimStart() : ""}`;
}

/**
 * Fit a sanitized research report to the planner's result cap without losing
 * the child's run. `evidenceAllowance` reserves room, per cited evidence
 * occurrence, for the annotations expansion adds after the fit. Trim order:
 * lossless selector de-duplication, per-claim prose, claim text, trailing
 * claims (at least one stays, with all its evidence), the report summary (head
 * and tail kept), and last the remaining claim's evidence list. A kept claim's
 * selectors are never altered.
 *
 * @param {Record<string, any>} compact
 * @param {{ maxChars: number, evidenceAllowance?: number, resolveFullReportRef?: () => string | null }} options
 */
export function fitResearchReport(compact, {
  maxChars,
  evidenceAllowance = 0,
  resolveFullReportRef = () => null,
} = /** @type {any} */ ({})) {
  const cap = Math.max(0, Number(maxChars) || 0);
  const allowance = Math.max(0, Number(evidenceAllowance) || 0);
  const charsBefore = jsonChars(compact);
  const reserve = (packet) => allowance * evidenceOccurrences(packet);
  if (charsBefore + reserve(compact) <= cap) {
    return { packet: compact, trimmed: null, steps: [], fits: true };
  }

  const packet = structuredClone(compact);
  const claimsBefore = claimCount(packet);
  const fullReportRef = (() => {
    try {
      return resolveFullReportRef() || null;
    } catch {
      return null;
    }
  })();
  // Measure with the annotation in place; its numbers never gain digits.
  const placeholder = {
    claims_dropped: claimsBefore,
    chars_before: charsBefore,
    chars_after: charsBefore,
    full_report_ref: fullReportRef,
  };
  const size = () => jsonChars({ ...packet, trimmed: placeholder }) + reserve(packet);
  const fits = () => size() <= cap;
  const steps = [];
  const step = (name, apply) => {
    if (fits()) return true;
    if (apply() !== false) steps.push(name);
    return fits();
  };
  const claimSlots = () => {
    const slots = [];
    eachClaim(packet, (claims, index) => slots.push({ claims, index }));
    return slots.reverse();
  };

  step("lossless_selectors", () => applyLossless(packet));

  for (const [name, transform] of [
    ["claim_prose_truncated", (text) => truncateCompletionProse(text, CLAIM_PROSE_TRIM_CHARS)],
    ["claim_prose_dropped", () => null],
  ]) {
    let changed = false;
    for (const { claims, index } of claimSlots()) {
      if (fits()) break;
      const detail = claimDetail(claims[index]);
      for (const key of PROSE_KEYS) {
        if (typeof detail?.[key] !== "string") continue;
        const next = transform(detail[key]);
        if (next === undefined) continue;
        if (next === null) delete detail[key];
        else detail[key] = next;
        changed = true;
      }
    }
    if (changed) steps.push(name);
  }

  let textChanged = false;
  for (const { claims, index } of claimSlots()) {
    if (fits()) break;
    const next = truncateCompletionProse(claimText(claims[index]), CLAIM_TEXT_TRIM_CHARS);
    if (next === undefined) continue;
    setClaimText(claims, index, next);
    textChanged = true;
  }
  if (textChanged) steps.push("claim_text_truncated");

  let dropped = 0;
  while (!fits() && claimCount(packet) > 1) {
    const [last] = claimSlots();
    last.claims.splice(last.index, 1);
    dropped += 1;
  }
  if (dropped > 0) steps.push("trailing_claims_dropped");

  // Gaps and limitations close a summary, so both ends are kept; every cut
  // is taken from the original text so markers never nest.
  const summaries = () => (packet.handoffs || [])
    .filter((handoff) => typeof handoff?.report?.summary === "string")
    .reverse();
  const originalSummaries = new Map(summaries().map((handoff) => [handoff, handoff.report.summary]));
  let summaryChanged = false;
  for (const handoff of summaries()) {
    const original = originalSummaries.get(handoff);
    for (let guard = 0; guard < 4 && !fits(); guard++) {
      const current = handoff.report.summary.length;
      const target = Math.max(SUMMARY_FLOOR_CHARS, current - (size() - cap));
      if (target >= current) break;
      handoff.report.summary = headTail(original, target);
      summaryChanged = true;
    }
  }
  if (summaryChanged) steps.push("summary_trimmed");

  let evidenceCut = false;
  if (!fits() && claimCount(packet) === 1) {
    const [only] = claimSlots();
    const detail = claimDetail(only.claims[only.index]);
    while (!fits() && Array.isArray(detail?.decoy) && detail.decoy.length > 0) {
      detail.decoy.pop();
      if (detail.decoy.length === 0) delete detail.decoy;
      evidenceCut = true;
    }
    for (const lane of [...CITED_LANES].reverse()) {
      while (!fits() && Array.isArray(detail?.[lane]) && detail[lane].length > 1) {
        detail[lane].pop();
        evidenceCut = true;
      }
    }
  }
  if (evidenceCut) steps.push("evidence_list_cut");

  // Nothing else is optional: floor the remaining prose so delivery still
  // happens; `fits` records whether the cap was reached.
  if (!fits()) {
    for (const handoff of summaries()) {
      handoff.report.summary = headTail(originalSummaries.get(handoff) ?? handoff.report.summary, SUMMARY_FLOOR_CHARS);
    }
    for (const { claims, index } of claimSlots()) {
      const next = truncateCompletionProse(claimText(claims[index]), LAST_RESORT_TEXT_CHARS);
      if (next !== undefined) setClaimText(claims, index, next);
    }
    for (const handoff of packet.handoffs || []) {
      const next = truncateCompletionProse(handoff?.intent, LAST_RESORT_TEXT_CHARS);
      if (next !== undefined) handoff.intent = next;
    }
    steps.push("floor");
  }

  const trimmed = {
    claims_dropped: claimsBefore - claimCount(packet),
    chars_before: charsBefore,
    chars_after: 0,
    full_report_ref: fullReportRef,
  };
  packet.trimmed = trimmed;
  for (let guard = 0; guard < 3; guard++) {
    const measured = jsonChars(packet);
    if (trimmed.chars_after === measured) break;
    trimmed.chars_after = measured;
  }
  return {
    packet,
    trimmed,
    steps,
    fits: trimmed.chars_after + reserve(packet) <= cap,
  };
}
