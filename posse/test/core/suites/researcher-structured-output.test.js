import {
  it,
  before,
  assert,
  path,
  __dirname,
  suite,
  runtimeModules,
  now,
  createJob,
  resetRuntimeDb,
  dispatchWorker,
  makeWorker,
  parseResearcherStructuredOutput,
  extractResearcherFiles,
  normalizeResearcherFilePriorities,
  researcherOutputNeedsHuman,
} from "../support/core-harness.js";

let db;

suite("Researcher Structured Output", () => {
  it("parses the canonical structured appendix", () => {
    const output = [
      "# Research Brief",
      "",
      "```json",
      JSON.stringify({
        key_files: ["src/app.js"],
        patterns: { routing: "Express router per module" },
        constraints: ["tests use Vitest"],
        questions_for_human: true,
        questions: [
          {
            id: "Q1",
            category: "convention",
            question: "Should admin routes live under /admin or /internal/admin?",
            context: "Both patterns appear in the repo.",
            impact: "Planner cannot route the new endpoint confidently."
          }
        ]
      }, null, 2),
      "```",
    ].join("\n");

    const parsed = parseResearcherStructuredOutput(output);
    assert.ok(parsed);
    assert.equal(parsed.questions_for_human, true);
    assert.equal(parsed.questions[0].id, "Q1");
    assert.equal(parsed.key_files[0], "src/app.js");
  });

  it("recognizes scope-only researcher estimates", () => {
    const output = [
      "# Research Brief",
      "",
      "```json",
      JSON.stringify({
        scope_estimate: {
          confidence: "medium",
          likely_touch_count: 6,
          unknowns: ["callers not fully traced"],
          scope_reasons: ["multiple related files"],
        },
      }, null, 2),
      "```",
    ].join("\n");

    const parsed = parseResearcherStructuredOutput(output);
    assert.ok(parsed);
    assert.equal(parsed.scope_estimate.confidence, "medium");
    assert.equal(parsed.scope_estimate.likely_touch_count, 6);
  });

  it("extracts key files from the structured appendix", () => {
    const artifacts = [
      {
        content_long: [
          "# Research Brief",
          "",
          "```json",
          JSON.stringify({
            key_files: ["src/app.js", { path: "src/model.js", reason: "data shape" }],
            related_files: ["src/routes.js", { path: "src/db.js" }],
            patterns: {},
            constraints: [],
            questions_for_human: false,
            questions: []
          }, null, 2),
          "```",
        ].join("\n")
      }
    ];

    const files = extractResearcherFiles(artifacts);
    assert.deepEqual(files, ["src/app.js", "src/model.js", "src/routes.js", "src/db.js"]);
  });

  it("ignores malformed related file entries without aborting extraction", () => {
    const artifacts = [
      {
        content_long: [
          "```json",
          JSON.stringify({
            key_files: ["src/app.js"],
            related_files: [null, 123, { path: "src/db.js" }],
            questions_for_human: false,
            questions: [],
          }),
          "```",
        ].join("\n"),
      },
    ];

    assert.deepEqual(extractResearcherFiles(artifacts), ["src/app.js", "src/db.js"]);
  });

  it("normalizes researcher-ranked planner file priorities", () => {
    const parsed = {
      planner_file_priorities: [
        {
          path: "src/routes.js",
          rank: 2,
          usefulness: "supporting",
          evidence: "chain_read",
          reason: "Shows route registration.",
        },
        {
          path: "src/app.js",
          rank: 1,
          usefulness: "primary",
          evidence: "chain_read",
          reason: "Likely edit target.",
        },
      ],
    };

    const priorities = normalizeResearcherFilePriorities(parsed);
    assert.deepEqual(priorities.map((entry) => entry.path), ["src/app.js", "src/routes.js"]);
    assert.deepEqual(priorities.map((entry) => entry.rank), [1, 2]);
    assert.equal(priorities[0].evidence, "chain_read");
  });

  it("extracts researcher files with planner priorities first", () => {
    const artifacts = [
      {
        content_long: [
          "# Research Brief",
          "",
          "```json",
          JSON.stringify({
            key_files: ["src/app.js"],
            planner_file_priorities: [
              { path: "src/routes.js", rank: 1, usefulness: "primary", evidence: "chain_read", reason: "Route entrypoint." },
              { path: "src/db.js", rank: 2, usefulness: "supporting", evidence: "chain_read", reason: "Data helper." },
            ],
            related_files: ["src/lib.js"],
            patterns: {},
            constraints: [],
            questions_for_human: false,
            questions: []
          }, null, 2),
          "```",
        ].join("\n")
      }
    ];

    const files = extractResearcherFiles(artifacts);
    assert.deepEqual(files, ["src/routes.js", "src/db.js", "src/app.js", "src/lib.js"]);
  });

  it("accumulates files across multiple researcher artifacts instead of overwriting", () => {
    const mkArtifact = (keyFile, relatedFile) => ({
      content_long: [
        "# Research Brief",
        "",
        "```json",
        JSON.stringify({
          key_files: [keyFile],
          related_files: [relatedFile],
          patterns: {},
          constraints: [],
          questions_for_human: false,
          questions: [],
        }, null, 2),
        "```",
      ].join("\n"),
    });

    // Two qualifying artifacts (e.g. an earlier summary + the final output).
    // Files from the earlier artifact must survive, not be dropped by the last.
    const files = extractResearcherFiles([
      mkArtifact("src/a.js", "src/b.js"),
      mkArtifact("src/c.js", "src/d.js"),
    ]);
    assert.deepEqual(files, ["src/a.js", "src/b.js", "src/c.js", "src/d.js"]);
  });

  it("detects human-question gating from the canonical JSON appendix", () => {
    const output = [
      "# Research Brief",
      "",
      "```json",
      JSON.stringify({
        key_files: ["src/app.js"],
        patterns: {},
        constraints: [],
        questions_for_human: true,
        questions: [
          {
            id: "Q1",
            category: "config",
            question: "Which environment should this target?",
            context: "No deployment target found in the repo.",
            impact: "Planner cannot set the correct config path."
          }
        ]
      }, null, 2),
      "```",
    ].join("\n");

    assert.equal(researcherOutputNeedsHuman(output), true);
  });

  it("respects a canonical appendix that says no human questions are needed", () => {
    const output = [
      "# Research Brief",
      "",
      "```json",
      JSON.stringify({
        key_files: ["src/app.js"],
        patterns: {},
        constraints: [],
        questions_for_human: false,
        questions: []
      }, null, 2),
      "```",
    ].join("\n");

    assert.equal(researcherOutputNeedsHuman(output), false);
  });

  it("parses malformed fenced researcher JSON with comments and trailing commas", () => {
    const output = [
      "# Research Brief",
      "",
      "```json",
      "{",
      '  "key_files": ["src/app.js",],',
      '  "related_files": ["src/lib.js"],',
      '  "questions_for_human": true,',
      '  // keep this question',
      '  "questions": ["Should we migrate now?"]',
      "}",
      "```",
    ].join("\n");

    const parsed = parseResearcherStructuredOutput(output);
    assert.ok(parsed);
    assert.deepEqual(parsed.key_files, ["src/app.js"]);
    assert.equal(parsed.questions_for_human, true);
    assert.equal(researcherOutputNeedsHuman(output), true);
  });

  it("parses unfenced structured researcher JSON embedded in prose", () => {
    const output = [
      "# Research Brief",
      "Summary first.",
      '{"key_files":["src/index.js"],"related_files":["src/util.js"],"questions_for_human":false,"questions":[]}',
    ].join("\n\n");

    const parsed = parseResearcherStructuredOutput(output);
    assert.ok(parsed);
    assert.deepEqual(parsed.related_files, ["src/util.js"]);
  });

  it("ignores explicit JSON null researcher appendices", () => {
    assert.equal(parseResearcherStructuredOutput("```json\nnull\n```"), null);
    assert.equal(researcherOutputNeedsHuman("```json\nnull\n```"), false);
  });

  it("tries researcher self-resolution before initial human escalation", () => {
    resetRuntimeDb();
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Choose admin route", "desc");
    const researchJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: Choose admin route",
      reasoning_effort: "medium",
      payload_json: JSON.stringify({ planning_mode: "dual_redteam", deepthink_budget: "xhigh" }),
    });
    const worker = new workerMod.Worker({ projectDir: path.resolve(__dirname, ".."), silent: true });
    const output = [
      "# Research Brief",
      "",
      "```json",
      JSON.stringify({
        key_files: ["src/app.js"],
        questions_for_human: true,
        questions: ["Should admin routes live under /admin or /internal/admin?"],
      }),
      "```",
    ].join("\n");

    worker._spawnPlanAfterResearch(researchJob, output);

    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const selfResolve = jobs.find((job) => job.job_type === "research" && job.title.includes("self-resolve"));
    assert.ok(selfResolve);
    assert.equal(jobs.some((job) => job.job_type === "human_input"), false);
    const payload = JSON.parse(selfResolve.payload_json);
    assert.equal(payload._self_resolve, true);
    assert.equal(payload.planning_mode, "dual_redteam");
    assert.equal(payload.deepthink_budget, "xhigh");
    assert.match(payload.instructions, /Before escalating to the human/);
  });

  it("carries replan metadata through research-owned plan creation", () => {
    resetRuntimeDb();
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Fix stale UI plan", "desc");
    const researchJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research (replan): Fix stale UI plan",
      payload_json: JSON.stringify({
        _is_loopback: true,
        replan_reason: "Previous plan targeted missing markup.",
        original_job_id: 42,
        original_title: "Convert stale tables",
        deepthink_budget: "high",
      }),
    });
    const worker = new workerMod.Worker({ projectDir: path.resolve(__dirname, ".."), silent: true });
    const output = [
      "# Research Brief",
      "",
      "```json",
      JSON.stringify({
        key_files: ["htdocs/index.php"],
        questions_for_human: false,
        questions: [],
      }),
      "```",
    ].join("\n");

    worker._spawnPlanAfterResearch(researchJob, output);

    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const plans = jobs.filter((job) => job.job_type === "plan");
    assert.equal(plans.length, 1);
    assert.match(plans[0].title, /^Replan:/);
    const payload = JSON.parse(plans[0].payload_json);
    assert.equal(payload.replan_reason, "Previous plan targeted missing markup.");
    assert.equal(payload.original_job_id, 42);
    assert.equal(payload.original_title, "Convert stale tables");
    assert.equal(payload.deepthink_budget, "high");
  });

  it("spawns primary red-team and synthesis planners when research payload is explicitly flagged", () => {
    resetRuntimeDb();
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Refine dashboard UX", "desc");
    const researchJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: Refine dashboard UX",
      payload_json: JSON.stringify({
        planning_mode: "dual_redteam",
        deepthink_budget: "high",
      }),
    });
    const worker = new workerMod.Worker({ projectDir: path.resolve(__dirname, ".."), silent: true });

    worker._spawnPlanAfterResearch(researchJob, "# Research Brief\nNo human questions.\n");

    const plans = queueMod.listJobsByWorkItem(wi.id)
      .filter((job) => job.job_type === "plan")
      .sort((a, b) => a.id - b.id);
    assert.equal(plans.length, 3);
    assert.match(plans[0].title, /^Plan \(primary\):/);
    assert.match(plans[1].title, /^Plan red-team:/);
    assert.match(plans[2].title, /^Plan synthesis:/);

    const payloads = plans.map((job) => JSON.parse(job.payload_json));
    assert.deepEqual(payloads.map((payload) => payload.planner_role_mode), ["primary", "redteam", "synth"]);
    assert.equal(payloads[0].planning_mode, "dual_redteam");
    assert.equal(payloads[1].primary_plan_job_id, plans[0].id);
    assert.equal(payloads[2].primary_plan_job_id, plans[0].id);
    assert.equal(payloads[2].red_team_plan_job_id, plans[1].id);

    const redDeps = queueMod.getDependencies(plans[1].id).map((dep) => dep.depends_on_job_id);
    const synthDeps = queueMod.getDependencies(plans[2].id).map((dep) => dep.depends_on_job_id);
    assert.deepEqual(redDeps, [plans[0].id]);
    assert.deepEqual(synthDeps.sort((a, b) => a - b), [plans[0].id, plans[1].id]);
  });

  it("stores red-team planning artifacts and compiles only the synthesis planner output", async () => {
    resetRuntimeDb();
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Refine dashboard UX", "desc");
    const primary = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan (primary): Refine dashboard UX",
      payload_json: JSON.stringify({
        planning_mode: "dual_redteam",
        planner_role_mode: "primary",
        deepthink_budget: "normal",
      }),
    });
    const redteam = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan red-team: Refine dashboard UX",
      payload_json: JSON.stringify({
        planning_mode: "dual_redteam",
        planner_role_mode: "redteam",
        primary_plan_job_id: primary.id,
        deepthink_budget: "normal",
      }),
    });
    const synth = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan synthesis: Refine dashboard UX",
      payload_json: JSON.stringify({
        planning_mode: "dual_redteam",
        planner_role_mode: "synth",
        primary_plan_job_id: primary.id,
        red_team_plan_job_id: redteam.id,
        deepthink_budget: "normal",
      }),
    });

    const primaryOutput = JSON.stringify([
      {
        title: "Primary task",
        task_spec: "Initial candidate plan",
        job_type: "human_input",
        model_tier: "cheap",
        success_criteria: ["candidate captured"],
        depends_on_index: [],
      },
    ]);
    const synthOutput = JSON.stringify([
      {
        title: "Synthesized task",
        task_spec: "Final synthesized write-layer plan",
        job_type: "human_input",
        model_tier: "cheap",
        success_criteria: ["synthesis captured"],
        depends_on_index: [],
      },
    ]);
    const compiled = [];
    const worker = makeWorker(workerMod, {
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    }, async (prompt) => {
      if (prompt.includes("SYNTHESIS PLANNER")) {
        return { output: synthOutput, stats: {} };
      }
      if (prompt.includes("RED-TEAM PLANNER")) {
        return { output: "## Critical Risks\nThe primary plan misses empty and error states.", stats: {} };
      }
      return { output: primaryOutput, stats: {} };
    });
    worker.createJobsFromPlan = (planJob, tasks) => {
      compiled.push({ planJob, tasks });
    };

    await dispatchWorker(worker, primary, "standard", null);
    await dispatchWorker(worker, redteam, "standard", null);
    assert.equal(compiled.length, 0);

    await dispatchWorker(worker, synth, "standard", null);
    assert.equal(compiled.length, 1);
    assert.equal(compiled[0].planJob.id, synth.id);
    assert.equal(compiled[0].tasks[0].title, "Synthesized task");

    const primaryArtifacts = queueMod.getArtifactsByWorkItem(wi.id, "plan_primary");
    const redteamArtifacts = queueMod.getArtifactsByWorkItem(wi.id, "plan_redteam");
    const synthArtifacts = queueMod.getArtifactsByWorkItem(wi.id, "plan_synthesis");
    assert.equal(primaryArtifacts.length, 1);
    assert.equal(redteamArtifacts.length, 1);
    assert.equal(synthArtifacts.length, 1);
    assert.match(synthArtifacts[0].content_long, /Primary Planner Output/);
    assert.match(synthArtifacts[0].content_long, /The primary plan misses empty and error states/);
    assert.match(synthArtifacts[0].content_long, /Synthesized task/);
  });

  it("stores an information_request insight when self-resolution still needs a human", () => {
    resetRuntimeDb();
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Choose admin route", "desc");
    const researchJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research (self-resolve): Choose admin route",
      payload_json: JSON.stringify({
        planning_mode: "dual_redteam",
        _is_loopback: true,
        _self_resolve: true,
        _clarification_round: 0,
      }),
    });
    const worker = new workerMod.Worker({ projectDir: path.resolve(__dirname, ".."), silent: true });
    const output = [
      "# Research Brief",
      "",
      "```json",
      JSON.stringify({
        key_files: ["src/app.js"],
        questions_for_human: true,
        questions: ["Should admin routes live under /admin or /internal/admin?"],
      }),
      "```",
    ].join("\n");

    worker._spawnPlanAfterResearch(researchJob, output);

    const jobs = queueMod.listJobsByWorkItem(wi.id);
    assert.ok(jobs.some((job) => job.job_type === "human_input"));
    const followUp = jobs.find((job) => job.job_type === "research" && job.title.includes("follow-up"));
    assert.ok(followUp);
    assert.equal(JSON.parse(followUp.payload_json).planning_mode, "dual_redteam");
    const insights = queueMod.getInsights({ insight_type: "information_request", limit: 5 });
    assert.equal(insights.length, 1);
    assert.match(insights[0].detail, /Should admin routes live/);
  });
});
