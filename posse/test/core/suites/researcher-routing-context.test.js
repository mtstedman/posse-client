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
  getProviderName,
} from "../support/core-harness.js";

let db;

suite("Researcher routing context", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("injects artifact protocol and admin-backed provider routing into the research prompt", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Generate a hero image", "Create a homepage hero visual.");
    const researchJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: Generate a hero image",
      provider: "codex",
    });

    let capturedPrompt = "";
    const worker = makeWorker(workerMod, {
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    }, async (prompt) => {
      capturedPrompt = prompt;
      return {
        output: "# Research Brief\nImage routing noted.\n\n```json\n{\"key_files\":[],\"related_files\":[],\"questions_for_human\":false,\"questions\":[]}\n```",
        stats: { numTurns: 1 },
      };
    });

    const previousArtificer = queueMod.getSetting("provider_artificer");
    try {
      queueMod.setSetting("provider_artificer", "openai");

      await dispatchWorker(worker, researchJob, "standard", null);

      assert.match(capturedPrompt, /PIPELINE ROUTING CONTEXT/);
      assert.match(capturedPrompt, /config\/artifact-protocols\.json/);
      assert.match(capturedPrompt, /Image deliverables belong to the ARTIFICER role/i);
      const expectedResearcher = researchJob.provider || getProviderName("researcher");
      assert.match(
        capturedPrompt,
        new RegExp(`Admin-backed provider selections: researcher=${expectedResearcher}, planner=${getProviderName("planner")}, artificer=${getProviderName("artificer")}`),
      );
      assert.match(capturedPrompt, /Do not claim the project has no image generation path/i);
    } finally {
      queueMod.setSetting("provider_artificer", previousArtificer);
    }
  });
});
