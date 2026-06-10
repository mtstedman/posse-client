import {
  it,
  before,
  beforeEach,
  assert,
  suite,
  runtimeModules,
  resetRuntimeDb,
  handoff,
} from "../support/core-harness.js";

let db;

suite("Kaizen insight reuse", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("keeps insight queries scoped to the current project DB", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Scoped project", "desc");
    queueMod.storeInsight({
      work_item_id: wi.id,
      insight_type: "human_override",
      summary: "Use PNG artifacts before promote",
      detail: "Project-specific preference",
      file_paths: ["public/images/hero.png"],
    });

    const insights = queueMod.getInsights({ limit: 10 });
    assert.equal(insights.length, 1);
    assert.equal(insights[0].summary, "Use PNG artifacts before promote");
  });

  it("stores file-linked actionable insights separately from raw failure notes", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Actionable memory", "desc");
    queueMod.storeInsight({
      work_item_id: wi.id,
      insight_type: "failure",
      summary: "Raw failure should stay out of prompts",
      detail: "Attempt failed once.",
      file_paths: ["lib/handoff.js"],
    });
    queueMod.storeInsight({
      work_item_id: wi.id,
      insight_type: "pattern",
      summary: "Prompt assembly changes need aggregate test updates",
      insight_kind: "test_coupling",
      action: "Update aggregate test copies when changing handoff prompt assembly.",
      confidence: "high",
      source: "kaizen",
      evidence: ["test/core.test.js missed the same assertion"],
      file_paths: ["lib/handoff.js"],
    });

    const actionable = queueMod.getInsights({
      file_paths: ["lib/handoff.js"],
      only_actionable: true,
      limit: 10,
    });
    assert.equal(actionable.length, 1);
    assert.equal(actionable[0].insight_kind, "test_coupling");
    assert.match(actionable[0].action, /aggregate test copies/);
  });

  it("loads file-scoped and project-level insights into future planner/dev handoffs", async () => {
    const { queueMod, handoffMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Forward learning", "desc");

    queueMod.storeInsight({
      work_item_id: wi.id,
      insight_type: "human_override",
      summary: "This project prefers staged artifact output before repo promotion",
      detail: "Keep generated assets under .posse until promote",
      file_paths: null,
    });
    queueMod.storeInsight({
      work_item_id: wi.id,
      insight_type: "scope_issue",
      summary: "Do not write image outputs into repo root",
      detail: "Artifacts belong under the scoped output root.",
      insight_kind: "risk",
      action: "Keep image artifacts under the scoped output root instead of writing into repo root.",
      confidence: "high",
      file_paths: ["public/images/hero.png"],
    });

    const devPacket = await handoffMod.handoff(handoffMod.buildRoutingPacket(
      { id: 1, title: "Update hero image", job_type: "dev", work_item_id: wi.id },
      {
        role: "dev",
        workItem: { id: wi.id, title: "Forward learning" },
        payload: {
          task_spec: "Refresh the hero image safely",
          files_to_modify: ["public/images/hero.png"],
        },
        cwd: process.cwd(),
      }
    ));

    assert.ok(devPacket.run_insights.some(i => /repo root/i.test(i.summary)));
    assert.ok(devPacket.run_insights.some(i => /staged artifact output/i.test(i.summary)));

    const plannerPacket = await handoffMod.handoff(handoffMod.buildRoutingPacket(
      { id: 2, title: "Plan image workflow", job_type: "research", work_item_id: wi.id },
      {
        role: "planner",
        workItem: { id: wi.id, title: "Forward learning" },
        payload: {
          task_spec: "Plan the next image pipeline change",
        },
        cwd: process.cwd(),
      }
    ));

    assert.ok(plannerPacket.run_insights.some(i => /staged artifact output/i.test(i.summary)));
  });
});
