import { createHash } from "node:crypto";
import { ACCEPTANCE_VERSION } from "../../../catalog/acceptance.js";
import { REQUIREMENT_STATES as S } from "../../../catalog/requirements.js";
import { OUTCOME_VERIFIED_COVERAGE } from "../../../catalog/work-item-outcome.js";
import { requirementContracts } from "../../planning/functions/requirement-contract.js";
import { parseJobPayload } from "../../queue/functions/payload.js";

/** Requirement coverage is explicit: a general test pass never proves every outcome. */
export function projectAcceptance({ jobs = [], receipts = [], decisions = [], candidateCommit = null } = {}) {
  const entries = new Map();
  for (const job of jobs) {
    for (const contract of requirementContracts(parseJobPayload(job))) {
      for (const requirement of contract.requirements) {
        const key = `${contract.digest}:${requirement.id}`;
        const row = entries.get(key) || { key, contract_digest: contract.digest, ...requirement, job_ids: [] };
        if (!row.job_ids.includes(job.id)) row.job_ids.push(job.id);
        entries.set(key, row);
      }
    }
  }
  // Do not silently lose an explicit obligation if the plan's contract disappears.
  for (const decision of decisions.filter(d => d.action === "require")) {
    if (!entries.has(decision.key)) entries.set(decision.key, { key: decision.key, id: decision.requirement_id,
      contract_digest: decision.contract_digest, text: decision.requirement_text, state: S.OPEN, job_ids: [], missing_contract: true });
  }
  const requirements = [...entries.values()].map(row => {
    const relevant = decisions.filter(d => d.key === row.key);
    const required = relevant.some(d => d.action === "require");
    const decision = relevant.filter(d => d.action !== "require" && d.commit === candidateCommit).at(-1);
    const evidence = decision?.action === "bind" && !row.missing_contract
      // A content-preserving close-out refresh carries the decision to the new
      // head; its receipt stays at the commit where the check actually ran.
      ? receipts.find(r => r.artifact_id === decision.artifact_id && r.commit_hash === (decision.evidence_commit || candidateCommit)
        && row.job_ids.includes(r.job_id) && r.status === "passed" && OUTCOME_VERIFIED_COVERAGE.includes(r.coverage_status)) : null;
    const waived = decision?.action === "waive" && !!decision.reason;
    return { ...row, required, state: evidence ? S.SATISFIED : waived ? S.WAIVED : row.state,
      evidence: evidence ? { artifact_id: evidence.artifact_id, job_id: evidence.job_id, commit: candidateCommit, reason: decision.reason,
        ...(decision.evidence_commit ? { evidence_commit: decision.evidence_commit } : {}) } : null,
      waiver: waived ? { reason: decision.reason, actor: decision.actor, at: decision.at, commit: candidateCommit } : null };
  });
  const counts = Object.fromEntries(Object.values(S).map(state => [state, requirements.filter(r => r.state === state).length]));
  return { schema_version: ACCEPTANCE_VERSION, candidate_commit: candidateCommit,
    contract_digest: createHash("sha256").update(JSON.stringify([...new Set(requirements.map(r => r.contract_digest))].sort())).digest("hex"),
    state: !requirements.length ? "untracked" : counts[S.OPEN] || counts[S.CONSTRAINED] ? "incomplete" : counts[S.WAIVED] ? "accepted_with_waivers" : "evidence_mapped",
    counts, requirements, unmet_required: requirements.filter(r => r.required && ![S.SATISFIED, S.WAIVED].includes(r.state)).map(r => r.key) };
}
