import crypto from "node:crypto";
import assert from "node:assert/strict";
import { RESEARCH_CLAIM_REVIEW as POLICY } from "../../../catalog/research-claim-review.js";

export const claimReviewDigest = value => crypto.createHash("sha256").update(value).digest("hex");

// Deliberately accepts only a committed packet. No job payload, success criteria,
// prior assessor feedback, filesystem lookup, or benchmark metadata is read here.
export function buildClaimReviewInput(packet) {
  const report = packet?.handoffs?.[0]?.report;
  assert(report && Array.isArray(report.claims), "Missing committed research claims");
  const input = { claims: [], evidence: [], unreviewed_claim_ids: report.claims.map((_, i) => i + 1) };
  const evidenceKeys = new Map();
  for (let index = 0; index < report.claims.length; index++) {
    const claimId = index + 1;
    if (index >= POLICY.maxClaims) continue;
    const [claim, detail] = report.claims[index];
    const candidate = structuredClone(input);
    candidate.unreviewed_claim_ids = candidate.unreviewed_claim_ids.filter(id => id !== claimId);
    const keys = new Map(evidenceKeys);
    const ids = [];
    for (const source of ["evidence", "proof", "support"].flatMap(lane => detail?.[lane] || [])) {
      if (typeof source.excerpt !== "string" || !source.excerpt) continue;
      const digest = claimReviewDigest(source.excerpt);
      assert(!source.excerpt_sha256 || source.excerpt_sha256 === digest, "Committed excerpt digest mismatch");
      const key = JSON.stringify([source.selector, source.source_content_sha256, digest]);
      let id = keys.get(key);
      if (!id) {
        id = `S${candidate.evidence.length + 1}`;
        keys.set(key, id);
        candidate.evidence.push({
          evidence_id: id,
          selector: source.selector,
          path: source.path ?? source.provenance?.path,
          lines: source.lines,
          source_windows: source.provenance?.source_windows?.map(window => ({
            path: window.path, source_start_line: window.source_start_line,
            source_end_line: window.source_end_line, materialized_start_line: window.materialized_start_line,
            materialized_end_line: window.materialized_end_line, source_version: window.source_version,
          })),
          line_semantics: source.line_semantics ?? source.provenance?.line_semantics,
          source_content_sha256: source.source_content_sha256,
          excerpt_sha256: digest,
          excerpt: source.excerpt.slice(0, POLICY.maxExcerptChars),
          truncated: source.excerpt.length > POLICY.maxExcerptChars,
        });
      }
      if (!ids.includes(id)) ids.push(id);
    }
    candidate.claims.push({ claim_id: claimId, claim, evidence_ids: ids });
    if (JSON.stringify(candidate).length > POLICY.maxInputChars) {
      continue;
    }
    input.claims = candidate.claims;
    input.evidence = candidate.evidence;
    input.unreviewed_claim_ids = candidate.unreviewed_claim_ids;
    for (const [key, id] of keys) evidenceKeys.set(key, id);
  }
  return input;
}

export function parseClaimReview(output, input) {
  const parsed = JSON.parse(String(output).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  assert.deepEqual(Object.keys(parsed), ["claims"], "Unexpected review fields");
  assert(Array.isArray(parsed.claims) && parsed.claims.length === input.claims.length, "Incomplete review");
  const evidenceIds = new Set(input.evidence.map(item => item.evidence_id));
  parsed.claims.forEach((entry, index) => {
    assert.deepEqual(Object.keys(entry).sort(), ["claim_id", "evidence_ids", "reason", "verdict"]);
    assert.equal(entry.claim_id, input.claims[index].claim_id, "Claim order or identity drift");
    assert(POLICY.verdicts.includes(entry.verdict), "Invalid review verdict");
    assert(typeof entry.reason === "string" && entry.reason.trim() && entry.reason.length <= 2000, "Invalid review reason");
    assert(Array.isArray(entry.evidence_ids) && entry.evidence_ids.every(id => evidenceIds.has(id)), "Invented evidence identity");
    if (entry.verdict !== "insufficient_context") assert(entry.evidence_ids.length > 0, "Factual judgment requires evidence");
  });
  return parsed;
}
