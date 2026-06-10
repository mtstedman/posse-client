import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { finalAssessmentFor } from "../lib/domains/cli/functions/review-report.js";

describe("review final assessment", () => {
  it("passes recovered failed jobs with succeeded descendants", () => {
    const assessment = finalAssessmentFor({
      wi: { id: 109, status: "failed" },
      jobs: [
        { id: 638, job_type: "dev", status: "failed" },
        { id: 666, parent_job_id: 638, job_type: "fix", status: "succeeded" },
      ],
    });

    assert.equal(assessment.status, "PASS");
  });

  it("still fails unrecovered review-visible job failures", () => {
    const assessment = finalAssessmentFor({
      wi: { id: 110, status: "failed" },
      jobs: [
        { id: 700, job_type: "dev", status: "failed" },
      ],
    });

    assert.equal(assessment.status, "FAIL");
    assert.match(assessment.reason, /1 review-visible job\(s\) failed/);
  });
});
