// Keep prompt selection and pipeline completion on the same workflow facts.
// Request wording and inferred deliverable type do not determine whether a
// researcher has a downstream planner.
export function researchReturnsFinalReport(workItem, payload = {}) {
  let metadata = {};
  try { metadata = JSON.parse(workItem?.metadata_json || "{}"); } catch { /* legacy metadata */ }
  const intakeOutputMode = String(metadata?.intake_hints?.output_mode || "").trim().toLowerCase();
  return metadata?.mode === "question"
    || workItem?.mode === "report"
    || payload?.task_mode === "report"
    || intakeOutputMode === "question_only";
}
