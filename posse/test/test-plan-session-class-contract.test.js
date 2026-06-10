import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PlanSession } from "../lib/domains/planning/classes/PlanSession.js";

describe("plan session class contract", () => {
  it("validates and classifies planned tasks", () => {
    const session = new PlanSession({
      rawTasks: [
        { title: "Build API route", job_type: "dev", task_mode: "code" },
        { title: "Generate screenshot", job_type: "artificer", task_mode: "image", needs_image_generation: true },
      ],
    });
    const validation = session.validate();
    const classified = session.classifyTasks();
    const split = session.splitImageTasks();

    assert.equal(validation.valid, true);
    assert.deepEqual(classified.map((entry) => entry.classification), ["code", "image"]);
    assert.equal(split.image.length, 1);
    assert.equal(split.nonImage.length, 1);
    assert.equal(session.hasArtificer(), true);
    assert.equal(session.taskCount(), 2);
  });

  it("throws if emit is called without a worker", () => {
    const session = new PlanSession({
      rawTasks: [{ title: "Task", job_type: "dev" }],
    });
    assert.throws(() => session.emit(), /requires a worker/);
  });
});
