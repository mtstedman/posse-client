// Operator consent covers only the failed checks on the reviewed candidate.
// A new tree, target, or failing check requires a fresh decision.
export function mergeTestWaiverCovers(waiver, candidate) {
  if (!waiver?.gate_job_id || !candidate?.candidate_tree || !candidate?.target_head) return false;
  if (waiver.candidate_tree !== candidate.candidate_tree || waiver.target_head !== candidate.target_head) return false;
  const allowed = new Set((waiver.failed_checks || []).map(String));
  const failed = (candidate.results || []).filter((result) => result.ok !== true);
  return failed.length > 0 && failed.every((result) => allowed.has(String(result.test?.id || result.test?.name || "")));
}

export function mergeTestWaiverFromGate(job, payload, feedback) {
  const evidence = payload?.merge_failure_recovery?.integration_gate;
  if (!evidence?.candidate_tree || !evidence?.target_head) return null;
  const failed = (evidence.results || []).filter((result) => result.ok !== true);
  if (!failed.length || failed.some((result) => !result.test?.id && !result.test?.name)) return null;
  return {
    gate_job_id: job.id,
    candidate_tree: evidence.candidate_tree,
    target_head: evidence.target_head,
    failed_checks: failed.map((result) => String(result.test?.id || result.test?.name)),
    feedback: feedback || null,
  };
}
