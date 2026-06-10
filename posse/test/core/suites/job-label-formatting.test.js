import {
  it,
  assert,
  suite,
  jobLabel,
  jobReportStatus,
  workItemDisplayStatus,
} from "../support/core-harness.js";

let db;

suite("Job Label Formatting", () => {
  it("strips redundant research prefix", () => {
    assert.equal(jobLabel("research", "Research: Add JWT auth"), "Add JWT auth");
    assert.equal(jobLabel("research", "Investigate codebase"), "codebase");
  });

  it("strips redundant dev prefix", () => {
    assert.equal(jobLabel("dev", "Implement user preferences"), "user preferences");
    assert.equal(jobLabel("dev", "Create new API endpoint"), "new API endpoint");
  });

  it("strips redundant fix prefix", () => {
    assert.equal(jobLabel("fix", "Fix broken login flow"), "broken login flow");
  });

  it("shortens improvement follow-up labels", () => {
    assert.equal(jobLabel("dev", "Improvement: Consider adding metadata"), "[I] Consider adding metadata");
  });

  it("leaves non-redundant titles unchanged", () => {
    assert.equal(jobLabel("dev", "User preferences CRUD"), "User preferences CRUD");
    assert.equal(jobLabel("research", "JWT auth patterns"), "JWT auth patterns");
  });

  it("classifies failed jobs with succeeded fix descendants as recovered for reports", () => {
    const jobs = [
      { id: 1, job_type: "dev", status: "failed", title: "Original task" },
      { id: 2, parent_job_id: 1, job_type: "fix", status: "failed", title: "First fix" },
      { id: 3, parent_job_id: 2, job_type: "fix", status: "succeeded", title: "Second fix" },
    ];

    assert.equal(jobReportStatus(jobs[0], jobs), "recovered");
    assert.equal(jobReportStatus(jobs[1], jobs), "recovered");
    assert.equal(jobReportStatus(jobs[2], jobs), "succeeded");
  });

  it("keeps unresolved leaf failures failed in report summaries", () => {
    const jobs = [
      { id: 1, job_type: "dev", status: "failed", title: "Original task" },
      { id: 2, parent_job_id: 1, job_type: "fix", status: "failed", title: "Broken fix" },
    ];

    assert.equal(jobReportStatus(jobs[0], jobs), "failed");
    assert.equal(jobReportStatus(jobs[1], jobs), "failed");
  });

  it("does not treat human escalation alone as recovered work", () => {
    const jobs = [
      { id: 1, job_type: "dev", status: "failed", title: "Original task" },
      { id: 2, parent_job_id: 1, job_type: "human_input", status: "succeeded", title: "Human answered" },
    ];

    assert.equal(jobReportStatus(jobs[0], jobs), "failed");
    assert.equal(jobReportStatus(jobs[1], jobs), "succeeded");
  });

  it("shows work items as complete when failed attempts were recovered", () => {
    const jobs = [
      { id: 1, job_type: "dev", status: "failed", title: "Original task" },
      { id: 2, parent_job_id: 1, job_type: "fix", status: "succeeded", title: "Escalated fix" },
    ];

    assert.equal(workItemDisplayStatus({ status: "failed" }, jobs), "complete");
  });
});
