export function buildLocalAssessmentEvidence({
  fileVerification = "",
  scopedCheckEvidence = "",
  assessmentDiffNarrative = "",
  assessmentScopedDiff = "",
  assessmentDependencyDiffs = "",
  mergeResolutionEvidence = "",
  assessmentFileSnapshots = "",
  workerStatusOutput = "",
} = {}) {
  const primaryChangeEvidence = assessmentScopedDiff
    || assessmentDiffNarrative
    || assessmentFileSnapshots;
  const completePrimaryDiffContract = assessmentScopedDiff
    ? [
        `COMPLETE PRIMARY DIFF CONTRACT:`,
        `The attached SCOPED GIT DIFF is the full diff for the entire assessed task scope, not a summary or excerpt.`,
        `Do not spend issued tools re-fetching, reconstructing, or symbol-resolving changes already present in it. Use source reads only for material surrounding context that the diff does not contain.`,
      ].join("\n")
    : "";
  // The primary diff is accepted upstream through 128K. Keep enough room here
  // for that indivisible view plus deterministic check receipts; otherwise the
  // final assembly boundary would silently undo the handoff decision and send
  // the assessor back through repository reads.
  const evidenceBudgetChars = 224_000;
  const sections = [];
  let usedChars = 0;
  const appendWhole = (value, label) => {
    const text = String(value || "").trim();
    if (!text) return false;
    if (usedChars + text.length > evidenceBudgetChars) {
      sections.push(`[${label} omitted because the bounded assessment evidence packet is full]`);
      return false;
    }
    sections.push(text);
    usedChars += text.length;
    return true;
  };
  // Receipts and the primary change view are indivisible evidence. In
  // particular, never turn a complete diff into a misleading partial diff at
  // this final assembly boundary.
  const primaryChangeEvidenceAttached = appendWhole(primaryChangeEvidence, "primary change evidence");
  appendWhole(mergeResolutionEvidence, "target merge resolution evidence");
  appendWhole(scopedCheckEvidence, "deterministic changed-file check evidence");
  const dependencyChangeEvidenceAttached = appendWhole(assessmentDependencyDiffs, "dependency change evidence");
  appendWhole(fileVerification, "scope verification evidence");
  if (workerStatusOutput) {
    const prefix = "WORKER STATUS (context only; never proof):\n";
    const remaining = Math.max(0, evidenceBudgetChars - usedChars - prefix.length);
    if (remaining > 0) sections.push(`${prefix}${String(workerStatusOutput).slice(0, remaining)}`);
  }
  return {
    text: [
      `LOCAL ASSESSMENT EVIDENCE`,
      `This block was attached by the local client after remote prompt compilation. Treat deterministic receipts, the primary change view, and labeled read-only upstream dependency contracts as ground truth. Worker status is context only, never proof.`,
      completePrimaryDiffContract || null,
      sections.join("\n") || null,
    ].filter(Boolean).join("\n"),
    primaryChangeEvidenceAttached,
    dependencyChangeEvidenceAttached,
  };
}

export function renderAssessmentDependencyDiffs(assessmentContext = null) {
  const entries = Array.isArray(assessmentContext?.dependency_git_diffs)
    ? assessmentContext.dependency_git_diffs
    : [];
  if (entries.length === 0) return "";
  const sections = entries.map((entry) => {
    const header = [
      `DEPENDENCY JOB #${entry.job_id}: ${entry.title || "upstream dependency"}`,
      `dependency_kind: ${entry.dependency_kind || "hard"}`,
      `commit: ${entry.commit_hash || "unknown"}`,
      Array.isArray(entry.files) && entry.files.length > 0
        ? `files_in_attached_dependency_view: ${JSON.stringify(entry.files)}`
        : null,
    ].filter(Boolean).join("\n");
    if (entry.diff) return `${header}\n${entry.diff}`;
    const reason = entry.status === "over_inline_cap"
      ? `diff omitted because it exceeds the dependency inline cap (${entry.bytes ?? "unknown"} bytes)`
      : "diff prefetch failed";
    return `${header}\n[${reason}]${entry.stat ? `\n${entry.stat}` : ""}`;
  });
  return [
    `UPSTREAM DEPENDENCY CONTRACT DIFFS (READ-ONLY CONTEXT — not current task scope):`,
    `These direct dependencies completed before this job. Use their supplied contract changes to assess integration; do not require the current job to edit these files unless they are also in the current writable scope.`,
    sections.join("\n\n"),
  ].join("\n");
}
