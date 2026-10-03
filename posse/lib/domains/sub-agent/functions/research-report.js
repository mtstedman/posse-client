// Shaping of a research child's committed report into the compact packet the
// planner receives. Everything here is deterministic and never throws: a
// report that already cost a full child run is trimmed or annotated, never
// discarded (caps are soft; a rejection costs a whole producer turn).

import { parseAgentHandoffEvidenceSelector } from "../../handoff/functions/agent-handoff.js";
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

/**
 * Apply lossless selector de-duplication and measure the report against the
 * planner's target. The target is accounting guidance, not a content cap: an
 * over-target report is returned in full.
 *
 * @param {Record<string, any>} compact
 * @param {{ maxChars: number, evidenceAllowance?: number }} options
 */
export function fitResearchReport(compact, {
  maxChars,
  evidenceAllowance = 0,
} = /** @type {any} */ ({})) {
  const cap = Math.max(0, Number(maxChars) || 0);
  const allowance = Math.max(0, Number(evidenceAllowance) || 0);
  const charsBefore = jsonChars(compact);
  const packet = structuredClone(compact);
  applyLossless(packet);
  const charsAfter = jsonChars(packet);
  const measuredChars = charsAfter + (allowance * evidenceOccurrences(packet));
  const fits = measuredChars <= cap;
  return {
    packet,
    overTarget: fits ? null : {
      chars_before: charsBefore,
      chars_after: charsAfter,
      measured_chars: measuredChars,
      target_chars: cap,
    },
    steps: charsAfter < charsBefore ? ["lossless_selectors"] : [],
    fits,
  };
}
