export function syncAssessorWorkerDisplay(display, job, {
  shortJobTitle,
  tier = "cheap",
  effort = "medium",
  attempt = 1,
} = {}) {
  if (!display || !job?.id) return;
  display.setWorker(job.id, {
    role: "assessor",
    activity: `assessing: ${shortJobTitle(job).slice(0, 40)}`,
    tier,
    effort,
    attempt,
    workItemId: job.work_item_id,
    provider: null,
    modelName: null,
  });
}
