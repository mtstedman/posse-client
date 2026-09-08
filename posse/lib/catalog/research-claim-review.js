import { AGENT_CALL_CHILD_KINDS } from "./agent-call.js";
// Product policy: bounded, observational review; never edits a terminal report.
export const RESEARCH_CLAIM_REVIEW = Object.freeze({
  setting: "research_claim_review",
  modes: Object.freeze(["off", "shadow"]),
  promptProfile: "research_claim_review",
  artifactType: "report",
  artifactKind: "research_claim_review",
  childKind: AGENT_CALL_CHILD_KINDS.RESEARCH_CLAIM_REVIEW,
  verdicts: Object.freeze(["supported", "contradicted", "insufficient_context"]),
  maxClaims: 16,
  maxInputChars: 48000,
  maxExcerptChars: 6000,
  maxOutputTokens: 2400,
  timeoutMs: 60000,
});
