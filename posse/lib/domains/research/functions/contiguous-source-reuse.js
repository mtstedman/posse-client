// Combine already-validated, current-attempt source receipts only when they
// cover one continuous interval. Never bridge an unseen gap or an old session.
export function contiguousSourceReuse(admissions) {
  if (admissions.length < 2 || admissions.some((entry) => (
    !entry?.covered || entry.reason !== "exact_selector" || entry.coverageScope !== "current_attempt"
  ))) return null;
  const ordered = [...admissions].sort((a, b) => a.result.startLine - b.result.startLine);
  const first = ordered[0];
  const startLine = first.result.startLine;
  let endLine = first.result.endLine;
  const refs = new Map();
  for (const entry of ordered) {
    const result = entry.result;
    if (result.repo_rel_path !== first.result.repo_rel_path
      || entry.coverageOrigin.job_id !== first.coverageOrigin.job_id
      || entry.coverageOrigin.attempt_id !== first.coverageOrigin.attempt_id
      || result.startLine > endLine + 1 || !result.evidence_ref?.ref) return null;
    endLine = Math.max(endLine, result.endLine);
    refs.set(result.evidence_ref.ref, result.evidence_ref);
  }
  return {
    covered: true,
    reason: "exact_selector",
    coverageScope: first.coverageScope,
    coverageOrigin: first.coverageOrigin,
    result: {
      status: "covered",
      executed: false,
      coverage_scope: first.coverageScope,
      coverage_origin: first.coverageOrigin,
      repo_rel_path: first.result.repo_rel_path,
      startLine,
      endLine,
      coverage_ranges: [{ startLine, endLine, evidence_refs: [...refs.values()] }],
    },
  };
}
