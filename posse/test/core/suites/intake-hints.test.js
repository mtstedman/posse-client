import {
  it,
  before,
  assert,
  fs,
  path,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  dispatchWorker,
  makeWorker,
  normalizeIntakeHints,
  buildIntakeHintsBlock,
  buildResearchIntakePreload,
  handoff,
} from "../support/core-harness.js";

let db;

suite("Intake hints", () => {
  it("normalizes user-scoped intake hints", () => {
    const hints = normalizeIntakeHints({
      intent_type: "bugfix",
      deliverable_type: "patch",
      output_mode: "repo,artifact",
      suspected_files: "lib\\worker.js, ./lib/handoff.js",
      suspected_dirs: "lib/, ./prompts",
      subtasks: "generate PNG hero, not SVG, split image task",
      constraints: "do not touch db, keep prompts deterministic",
    }, { requestText: "Fix routing around image generation", fallbackMode: "build" });

    assert.equal(hints.intent_type, "bugfix");
    assert.equal(hints.deliverable_type, "patch");
    assert.equal(hints.output_mode, "auto");
    assert.deepEqual(hints.desired_outputs, ["repo", "artifact"]);
    assert.deepEqual(hints.suspected_files, ["lib/worker.js", "lib/handoff.js"]);
    assert.deepEqual(hints.suspected_dirs, ["lib", "prompts"]);
    assert.deepEqual(hints.subtasks, ["generate PNG hero", "not SVG", "split image task"]);
    assert.deepEqual(hints.constraints, ["do not touch db", "keep prompts deterministic"]);
  });

  it("drops out-of-repo intake hint paths before preload", () => {
    const hints = normalizeIntakeHints({
      suspected_files: ["lib/worker.js", "../secrets.txt", "C:/Windows/win.ini"],
      suspected_dirs: ["lib", "../outside", "D:/tmp"],
    }, { requestText: "Investigate repo context", fallbackMode: "build" });

    assert.deepEqual(hints.suspected_files, ["lib/worker.js"]);
    assert.deepEqual(hints.suspected_dirs, ["lib"]);
  });

  it("never preloads hinted files from outside the project root", () => {
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-intake-project-"));
    const outsideDir = fs.mkdtempSync(path.join(__dirname, "tmp-intake-outside-"));
    try {
      fs.mkdirSync(path.join(projectDir, "lib"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "lib", "inside.js"), "export const inside = true;\n", "utf-8");
      fs.writeFileSync(path.join(outsideDir, "secret.txt"), "do not preload\n", "utf-8");

      const preload = buildResearchIntakePreload(projectDir, {
        intent_type: "context",
        deliverable_type: "answer",
        output_mode: "question_only",
        desired_outputs: ["question_only"],
        suspected_files: ["lib/inside.js", path.join(outsideDir, "secret.txt")],
        suspected_dirs: ["lib", outsideDir],
      });

      assert.match(preload, /HINTED FILE PREVIEW: lib\/inside\.js/);
      assert.doesNotMatch(preload, /secret\.txt/);
      assert.doesNotMatch(preload, /do not preload/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("omits generic research preload hints when intake added no material context", () => {
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-intake-project-"));
    try {
      const preload = buildResearchIntakePreload(projectDir, {
        intent_type: "task",
        deliverable_type: "code",
        output_mode: "auto",
        desired_outputs: ["repo"],
      });

      assert.equal(preload, "");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("renders a readable researcher hint block", () => {
    const block = buildIntakeHintsBlock({
      intent_type: "image",
      deliverable_type: "image",
      output_mode: "auto",
      desired_outputs: ["artifact"],
      suspected_files: ["src/ui.js"],
      suspected_dirs: ["assets/images"],
      subtasks: ["generate PNG hero"],
      constraints: ["not SVG"],
    });

    assert.match(block, /intent_type: image/);
    assert.match(block, /desired_outputs: artifact/);
    assert.match(block, /suspected_files/);
    assert.match(block, /generate PNG hero/);
    assert.match(block, /not SVG/);
  });

  it("injects intake hints into the planner prompt", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Image request", "Generate hero art", "normal", {
      metadata: {
        intake_hints: {
          intent_type: "image",
          deliverable_type: "image",
          output_mode: "artifact",
          suspected_files: ["src/ui.js"],
          suspected_dirs: ["assets/images"],
          subtasks: ["generate PNG hero"],
          constraints: ["not SVG"],
        },
      },
      mode: "build",
    });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Image request",
    });

    let plannerPrompt = "";
    const worker = makeWorker(workerMod, {
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    }, async (prompt) => {
      plannerPrompt = prompt;
      return {
        output: '```json\n[{"title":"Generate hero","task_spec":"Generate a PNG hero image","job_type":"artificer","task_mode":"image","files_to_modify":[],"files_to_create":[],"create_roots":[".posse/resources/artifacts/wi-1"],"output_root":".posse/resources/artifacts/wi-1","success_criteria":["done"],"depends_on_index":[]}]\n```',
        stats: {},
      };
    });

    await dispatchWorker(worker, planJob, "standard", null);
    assert.match(plannerPrompt, /INTAKE HINTS/);
    assert.match(plannerPrompt, /deliverable_type: image/);
    assert.match(plannerPrompt, /generate PNG hero/);
    assert.match(plannerPrompt, /not SVG/);
    assert.match(plannerPrompt, /EXPLICIT OUTPUT BINDING/);
    assert.match(plannerPrompt, /treat as a strong planning constraint/);
    // The planner instructions are embedded as a JSON literal (INSTRUCTIONS (literal
    // JSON string)), so the binding's double quotes are JSON-escaped in the final prompt.
    assert.match(plannerPrompt, /output_mode is explicitly bound to \\?"artifact\\?"/);
  });

  it("injects intake hints into the assessor prompt", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Image review", "Review hero art", "normal", {
      metadata: {
        intake_hints: {
          intent_type: "image",
          deliverable_type: "image",
          output_mode: "artifact",
          suspected_files: ["src/ui.js"],
          suspected_dirs: ["assets/images"],
          subtasks: ["generate PNG hero"],
          constraints: ["not SVG"],
        },
      },
    });
    const assessJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "assess",
      title: "Assess: Image review",
      payload_json: JSON.stringify({ task_spec: "Review the generated image output." }),
    });

    let assessPrompt = "";
    const worker = makeWorker(workerMod, {
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    }, async (prompt) => {
      assessPrompt = prompt;
      return { output: '{"verdict":"pass","confidence":"high","reasons":["ok"]}', stats: {} };
    });

    await dispatchWorker(worker, assessJob, "standard", null);
    assert.match(assessPrompt, /INTAKE HINTS/);
    assert.match(assessPrompt, /deliverable_type: image/);
    assert.match(assessPrompt, /generate PNG hero/);
    assert.match(assessPrompt, /not SVG/);
  });
});
