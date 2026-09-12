// Diagnostic projection only. It neither ranks nor supplies model-visible files.
export function identifierRoutingShadowDetail({ shadow, rankedFiles = [], error = null }) {
  const available = shadow?.available === true;
  return {
    available,
    ...(available ? {} : { reason: String(error || shadow?.reason || "shadow_result_missing").slice(0, 300) }),
    identifiers: Array.isArray(shadow?.identifiers) ? shadow.identifiers : [],
    identifier_extraction_available: Array.isArray(shadow?.identifiers),
    resolution_directories: shadow?.resolutionDirectories || {},
    resolution_counts_available: shadow?.resolutionDirectories != null,
    evidence_truncated: shadow?.evidenceTruncated === true,
    ranked_files: rankedFiles,
    counterfactual_ranked_files: Array.isArray(shadow?.handoffCandidatePaths)
      ? shadow.handoffCandidatePaths
      : (Array.isArray(shadow?.shadowCandidates) ? shadow.shadowCandidates.map(entry => entry.path) : []),
    baseline_candidate_paths: shadow?.baselineCandidatePaths || [],
    top_changed: shadow?.handoffTopChanged ?? shadow?.topChanged ?? false,
    planner_ms: shadow?.plannerMs ?? null,
    lookup_ms: shadow?.lookupMs ?? null,
    scoring_micros: shadow?.scoringMicros ?? null,
  };
}
