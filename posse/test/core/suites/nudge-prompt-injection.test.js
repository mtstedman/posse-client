import {
  it,
  beforeEach,
  assert,
  path,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  dispatchWorker,
  makeWorker,
} from "../support/core-harness.js";

let db;

suite("Nudge prompt injection", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("injects human correction into planner, assessor, and artificer prompts", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Nudge prompt coverage", "desc");

    const plannerJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Nudge prompt coverage",
    });
    queueMod.storeArtifact({
      work_item_id: wi.id,
      job_id: plannerJob.id,
      artifact_type: "nudge",
      content_long: "Favor the incremental rollout path.",
    });

    let plannerPrompt = "";
    const plannerWorker = makeWorker(workerMod, { projectDir, silent: true }, async (prompt) => {
      plannerPrompt = prompt;
      return {
        output: '```json\n[{"title":"T","task_spec":"S","job_type":"dev","model_tier":"cheap","files_to_modify":[],"success_criteria":["ok"],"depends_on_index":[]}]\n```',
        stats: {},
      };
    });
    await dispatchWorker(plannerWorker, plannerJob, "standard", null);
    assert.match(plannerPrompt, /HUMAN CORRECTION/);
    assert.match(plannerPrompt, /incremental rollout path/);

    const assessJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "assess",
      title: "Assess: Nudge prompt coverage",
      payload_json: JSON.stringify({ task_spec: "Check the revised output." }),
    });
    queueMod.storeArtifact({
      work_item_id: wi.id,
      job_id: assessJob.id,
      artifact_type: "nudge",
      content_long: "Pay extra attention to migration safety.",
    });

    let assessPrompt = "";
    const assessWorker = makeWorker(workerMod, { projectDir, silent: true }, async (prompt) => {
      assessPrompt = prompt;
      return { output: '{"verdict":"pass","confidence":"high","reasons":["ok"]}', stats: {} };
    });
    await dispatchWorker(assessWorker, assessJob, "standard", null);
    assert.match(assessPrompt, /HUMAN CORRECTION/);
    assert.match(assessPrompt, /migration safety/);

    const outputRoot = path.join(projectDir, ".posse", "resources", "artifacts", "wi-test-nudge", "deliverable");
    const artificerJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "artificer",
      title: "Artificer: Nudge prompt coverage",
      payload_json: JSON.stringify({
        task_spec: "Create the deliverable.",
        task_mode: "content",
        output_root: outputRoot,
        create_roots: [outputRoot],
      }),
    });
    queueMod.storeArtifact({
      work_item_id: wi.id,
      job_id: artificerJob.id,
      artifact_type: "nudge",
      content_long: "Keep the tone crisp and operator-friendly.",
    });

    let artificerPrompt = "";
    const artificerWorker = makeWorker(workerMod, { projectDir, silent: true }, async (prompt) => {
      artificerPrompt = prompt;
      return {
        output: [
          "--- ARTIFICER LOG START ---",
          "status: COMPLETE",
          "summary: done",
          "deliverables: note.md",
          "criteria_check: ok",
          "--- ARTIFICER LOG END ---",
        ].join("\n"),
        stats: {},
      };
    });
    await dispatchWorker(artificerWorker, artificerJob, "standard", null);
    assert.match(artificerPrompt, /HUMAN CORRECTION/);
    assert.match(artificerPrompt, /operator-friendly/);
  });
});
