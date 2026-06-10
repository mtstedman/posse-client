import {
  it,
  before,
  beforeEach,
  assert,
  fs,
  os,
  path,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  dispatchWorker,
  makeWorker,
  handoff,
} from "../support/core-harness.js";

let db;

suite("Workflow handoff budgets", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("preserves dev retry constraints during missing-context expansion", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Context expansion", "desc");
    const filePath = path.join(projectDir, "tmp-context-expand.js");
    fs.writeFileSync(filePath, "export const marker = true;\n", "utf-8");
    try {
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Expand missing context",
        planner_complexity_score: 4,
        payload_json: JSON.stringify({
          task_spec: "Use the requested context and then finish the task.",
          task_mode: "image",
          needs_image_generation: true,
          files_to_modify: ["tmp-context-expand.js"],
        }),
      });

      const calls = [];
      const worker = makeWorker(workerMod, { projectDir, silent: true }, async (prompt, opts, meta) => {
        calls.push({ prompt, opts, meta });
        if (calls.length === 1) {
          return { output: "MISSING_CONTEXT: tmp-context-expand.js", stats: {} };
        }
        return {
          output: [
            "--- DEV LOG START ---",
            "status: COMPLETE",
            "summary: done",
            "files_touched: tmp-context-expand.js",
            "criteria_check: ok",
            "--- DEV LOG END ---",
          ].join("\n"),
          stats: {},
        };
      });

      await dispatchWorker(worker, job, "standard", null);

      assert.equal(calls.length, 2);
      assert.equal(calls[0].opts.fallbackReads, calls[1].opts.fallbackReads);
      assert.equal(calls[1].opts.taskMode, "image");
      assert.equal(calls[1].opts.needsImageGeneration, true);
      assert.equal(calls[1].meta.complexity, 4);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it("auto-expands missing context for artificer jobs before provider fallback", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Artificer context expansion", "desc");
    const outputRoot = path.join(projectDir, ".posse", "resources", "artifacts", "wi-artificer-context-expand");
    const filePath = path.join(projectDir, "tmp-artificer-context-expand.js");
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(filePath, "export const presetSeed = true;\n", "utf-8");
    try {
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "artificer",
        title: "Generate preset descriptions",
        provider: "openai",
        planner_complexity_score: 4,
        payload_json: JSON.stringify({
          task_spec: "Generate preset-descriptions.json from tmp-artificer-context-expand.js.",
          task_mode: "content",
          output_root: outputRoot,
          create_roots: [outputRoot],
        }),
      });

      const calls = [];
      const worker = makeWorker(workerMod, { projectDir, silent: true }, async (prompt, opts, meta) => {
        calls.push({ prompt, opts, meta });
        if (calls.length === 1) {
          return { output: "MISSING_CONTEXT:\n- tmp-artificer-context-expand.js", stats: {} };
        }
        return {
          output: [
            "--- ARTIFICER LOG START ---",
            "status: COMPLETE",
            "summary: done",
            "deliverables: preset-descriptions.json",
            "criteria_check: ok",
            "--- ARTIFICER LOG END ---",
          ].join("\n"),
          stats: {},
        };
      });

      const output = await dispatchWorker(worker, job, "standard", null);

      assert.match(output, /ARTIFICER LOG START/);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].meta.jobProvider, "openai");
      assert.match(calls[1].prompt, /ADDITIONAL CONTEXT \(requested by previous attempt\):/);
      assert.match(calls[1].prompt, /tmp-artificer-context-expand\.js/);
      assert.match(calls[1].prompt, /export const presetSeed = true;/);
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
      fs.rmSync(filePath, { force: true });
    }
  });

  it("rejects artificer output roots that escape the project before creating directories", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-artificer-root-"));
    const projectDir = path.join(tempRoot, "project");
    const escapedDir = path.join(tempRoot, "escaped-artifacts");
    fs.mkdirSync(projectDir, { recursive: true });
    try {
      const wi = queueMod.createWorkItem("Escaped artificer root", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "artificer",
        title: "Create escaped artifact",
        payload_json: JSON.stringify({
          task_spec: "Create a markdown artifact.",
          output_root: "../escaped-artifacts",
          create_roots: ["../escaped-artifacts"],
        }),
      });
      let providerCalls = 0;
      const worker = makeWorker(workerMod, { projectDir, silent: true }, async () => {
        providerCalls += 1;
        return { output: "", stats: {} };
      });

      await assert.rejects(
        () => dispatchWorker(worker, job, "standard", null),
        /output_root must not traverse directories/,
      );
      assert.equal(providerCalls, 0);
      assert.equal(fs.existsSync(escapedDir), false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("enforces per-attempt context expansion file budget for dev jobs", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Context expansion budget", "desc");
    const previousSteps = queueMod.getSetting("context_expand_max_steps");
    const previousBudget = queueMod.getSetting("context_expand_file_budget_per_attempt");
    const fileA = path.join(projectDir, "tmp-context-budget-a.js");
    const fileB = path.join(projectDir, "tmp-context-budget-b.js");
    const fileC = path.join(projectDir, "tmp-context-budget-c.js");
    fs.writeFileSync(fileA, "export const a = 1;\n", "utf-8");
    fs.writeFileSync(fileB, "export const b = 2;\n", "utf-8");
    fs.writeFileSync(fileC, "export const c = 3;\n", "utf-8");
    queueMod.setSetting("context_expand_max_steps", "2");
    queueMod.setSetting("context_expand_file_budget_per_attempt", "2");

    try {
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Expand missing context with budget",
        planner_complexity_score: 5,
        payload_json: JSON.stringify({
          task_spec: "Use requested context then finish.",
          files_to_modify: ["tmp-context-budget-a.js"],
        }),
      });

      const calls = [];
      const worker = makeWorker(workerMod, { projectDir, silent: true }, async (prompt, opts, meta) => {
        calls.push({ prompt, opts, meta });
        if (calls.length === 1) {
          return { output: "MISSING_CONTEXT:\n- tmp-context-budget-a.js\n- tmp-context-budget-b.js", stats: {} };
        }
        return { output: "MISSING_CONTEXT:\n- tmp-context-budget-c.js", stats: {} };
      });

      await dispatchWorker(worker, job, "standard", null);

      assert.equal(calls.length, 2, "should stop expanding once file budget is exhausted");
      const logs = queueMod.getArtifacts(job.id, "log").map((artifact) => artifact.content_long || "");
      assert.ok(logs.some((line) => line.includes("context_expand_step:1:")));
      assert.ok(logs.some((line) => line.includes("context_expand_budget_exhausted")));
    } finally {
      queueMod.setSetting("context_expand_max_steps", previousSteps);
      queueMod.setSetting("context_expand_file_budget_per_attempt", previousBudget);
      fs.rmSync(fileA, { force: true });
      fs.rmSync(fileB, { force: true });
      fs.rmSync(fileC, { force: true });
    }
  });

  it("caps assessor parse retries by accumulated assessor input tokens", () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousCap = queueMod.getSetting("assessor_parse_retry_input_tokens_cap");
    try {
      queueMod.setSetting("assessor_parse_retry_input_tokens_cap", "100");
      const wi = queueMod.createWorkItem("Assessor retry cap", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Dev with assessor retries",
      });
      const call = queueMod.createAgentCall({
        work_item_id: wi.id,
        job_id: job.id,
        role: "assessor",
        model_tier: "cheap",
        model_name: "haiku",
        activity: "assessment pass 1",
        prompt_chars: 100,
        reasoning_effort: "low",
        provider: "claude",
      });
      queueMod.completeAgentCall(call.id, {
        input_tokens: 120,
        output_tokens: 12,
        duration_ms: 1,
      });

      const budget = workerMod.__testAssessorParseRetryBudget(job.id);
      assert.equal(budget.exceeded, true);
      assert.equal(budget.cap, 100);
      assert.equal(budget.spent, 120);
    } finally {
      queueMod.setSetting("assessor_parse_retry_input_tokens_cap", previousCap);
    }
  });

  it("enforces assessor fallback-read budget from handoff policy", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const previousFallbackReads = queueMod.getSetting("assessor_fallback_reads");
    const wi = queueMod.createWorkItem("Assess budget", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "assess",
      title: "Assess fallback budget",
      payload_json: JSON.stringify({ task_spec: "Assess the output." }),
    });

    let capturedOpts = null;
    const worker = makeWorker(workerMod, { projectDir, silent: true }, async (_prompt, opts) => {
      capturedOpts = opts;
      return { output: '{"verdict":"pass","confidence":"high","reasons":["ok"]}', stats: {} };
    });
    try {
      queueMod.setSetting("assessor_fallback_reads", "0");

      await dispatchWorker(worker, job, "standard", null);
      assert.equal(capturedOpts.fallbackReads, 0);
    } finally {
      queueMod.setSetting("assessor_fallback_reads", previousFallbackReads);
    }
  });

  it("enforces artificer fallback-read budget from handoff policy", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Artificer budget", "desc");
    const outputRoot = path.join(projectDir, ".posse", "resources", "artifacts", "wi-fallback-budget");
    fs.mkdirSync(outputRoot, { recursive: true });
    try {
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "artificer",
        title: "Artificer fallback budget",
        payload_json: JSON.stringify({
          task_spec: "Create an artifact without extra fallback reads.",
          task_mode: "content",
          output_root: outputRoot,
          create_roots: [outputRoot],
        }),
      });

      let capturedOpts = null;
      const worker = makeWorker(workerMod, { projectDir, silent: true }, async (_prompt, opts) => {
        capturedOpts = opts;
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

      await dispatchWorker(worker, job, "standard", null);
      assert.equal(capturedOpts.fallbackReads, 0);
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("falls back to an alternate artificer provider when artifact output is malformed", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const outputRoot = path.join(projectDir, ".posse", "resources", "artifacts", "wi-artificer-fallback");
    fs.mkdirSync(outputRoot, { recursive: true });
    const originalProviders = queueMod.getSetting("provider_artificer");
    queueMod.setSetting("provider_artificer", "grok,claude");
    try {
      const wi = queueMod.createWorkItem("Artifact fallback", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "artificer",
        title: "Create workshop prompt artifact",
        provider: "grok",
        payload_json: JSON.stringify({
          task_spec: "Create a markdown artifact.",
          task_mode: "content",
          output_root: outputRoot,
          create_roots: [outputRoot],
        }),
      });

      const calls = [];
      const worker = makeWorker(workerMod, { projectDir, silent: true }, async (_prompt, opts, meta) => {
        calls.push({ opts, meta });
        if ((meta?.jobProvider || job.provider) === "grok") {
          return { output: "Here is the artifact content without the required structured log.", stats: {} };
        }
        return {
          output: [
            "--- ARTIFICER LOG START ---",
            "status: COMPLETE",
            "summary: done",
            "deliverables: workshop-system-prompt.md",
            "criteria_check: ok",
            "--- ARTIFICER LOG END ---",
          ].join("\n"),
          stats: {},
        };
      });

      const output = await dispatchWorker(worker, job, "standard", null);
      assert.match(output, /ARTIFICER LOG START/);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].meta.jobProvider, "grok");
      assert.equal(calls[1].meta.jobProvider, "claude");
      assert.equal(job.provider, "claude");
    } finally {
      if (originalProviders == null) queueMod.deleteSetting?.("provider_artificer");
      else queueMod.setSetting("provider_artificer", originalProviders);
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("keeps malformed-output fallback inside the job's frozen artificer provider pool", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const outputRoot = path.join(projectDir, ".posse", "resources", "artifacts", "wi-artificer-frozen-pool");
    fs.mkdirSync(outputRoot, { recursive: true });
    const originalProviders = queueMod.getSetting("provider_artificer");
    queueMod.setSetting("provider_artificer", "claude");
    try {
      const wi = queueMod.createWorkItem("Artifact frozen pool", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "artificer",
        title: "Create report artifact",
        provider: "claude",
        payload_json: JSON.stringify({
          task_spec: "Create a markdown artifact.",
          task_mode: "content",
          output_root: outputRoot,
          create_roots: [outputRoot],
        }),
      });
      job._allowedProviders = ["claude"];
      job._executionProvider = "claude";

      const calls = [];
      const worker = makeWorker(workerMod, { projectDir, silent: true }, async (_prompt, _opts, meta) => {
        calls.push({ provider: meta?.jobProvider || null });
        queueMod.setSetting("provider_artificer", "claude,openai");
        return { output: "Artifact body without required structured log.", stats: {} };
      });

      const output = await dispatchWorker(worker, job, "standard", null);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].provider, "claude");
      assert.doesNotMatch(output, /ARTIFICER LOG START/);
    } finally {
      if (originalProviders == null) queueMod.deleteSetting?.("provider_artificer");
      else queueMod.setSetting("provider_artificer", originalProviders);
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("keeps provider permission and routing strings readable", () => {
    const openaiSource = fs.readFileSync(path.resolve(__dirname, "../lib/domains/providers/functions/openai.js"), "utf-8");
    const grokSource = fs.readFileSync(path.resolve(__dirname, "../lib/domains/providers/functions/grok.js"), "utf-8");
    assert.doesNotMatch(openaiSource, /Ã|€|â€/);
    assert.doesNotMatch(grokSource, /Ã|€|â€/);
  });

  it("materializes a report artifact when the artificer returns report text but no file", () => {
    const { workerMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-report-fallback-"));
    try {
      const outputRoot = path.join(projectDir, "artifacts", "wi-report");
      const target = workerMod.__testMaterializeFallbackArtifactOutput({
        taskMode: "report",
        projectDir,
        payload: {
          output_root: outputRoot,
          files_to_create: [path.join(outputRoot, "streaming-smoketest.md")],
        },
        job: { title: "Run and document streaming route smoketest" },
        output: [
          "Streaming route smoketest completed.",
          "",
          "--- ARTIFICER LOG START ---",
          "status: COMPLETE",
          "summary: documented the route",
          "deliverables: streaming-smoketest.md",
          "criteria_check: ok",
          "--- ARTIFICER LOG END ---",
        ].join("\n"),
      });

      assert.equal(target, path.join(outputRoot, "streaming-smoketest.md"));
      assert.equal(fs.existsSync(target), true);
      const content = fs.readFileSync(target, "utf-8");
      assert.match(content, /# Run and document streaming route smoketest/);
      assert.match(content, /Streaming route smoketest completed\./);
      assert.match(content, /## Completion Log/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("does not let report fallback materialization escape output_root", () => {
    const { workerMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-report-fallback-escape-"));
    try {
      const outputRoot = path.join(projectDir, "artifacts", "wi-report");
      const outputRootForPayload = outputRoot.replace(/\\/g, "/");
      const outsideTarget = path.resolve(outputRoot, "..", "..", "outside.md");
      const target = workerMod.__testMaterializeFallbackArtifactOutput({
        taskMode: "report",
        projectDir,
        payload: {
          output_root: outputRoot,
          files_to_create: [`${outputRootForPayload}/../../outside.md`],
        },
        job: { title: "Unsafe fallback report" },
        output: "Report body that should not escape output_root.",
      });

      assert.equal(target, null);
      assert.equal(fs.existsSync(outsideTarget), false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
