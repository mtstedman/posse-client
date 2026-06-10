import {
  it,
  before,
  beforeEach,
  after,
  assert,
  fs,
  path,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  dispatchWorker,
  makeWorker,
  handoff,
  contextDir,
} from "../support/core-harness.js";

let db;

suite("Planner context directories", () => {
  function rmContextPath(targetPath) {
    fs.rmSync(targetPath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }

  function cleanupContextRoot(projectDir = path.resolve(__dirname, "..")) {
    rmContextPath(path.join(projectDir, ".posse", "resources", "context"));
  }

  beforeEach(() => {
    resetRuntimeDb();
    cleanupContextRoot();
  });

  after(() => {
    cleanupContextRoot();
  });

  /** Helper: create a WI with a research artifact that has structured output. */
  function setupResearchedWI(queueMod, { keyFiles = [], relatedFiles = [], plannerFilePriorities = [], brief = "" } = {}) {
    const wi = queueMod.createWorkItem("Context dir test", "desc");
    const researchJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: Context dir test",
    });
    queueMod.updateJobStatus(researchJob.id, "succeeded");

    // Build researcher output with structured JSON appendix
    const structured = {
      key_files: keyFiles,
      planner_file_priorities: plannerFilePriorities,
      related_files: relatedFiles,
      patterns: { routing: "Express router" },
      constraints: ["no TypeScript"],
      questions_for_human: false,
      questions: [],
    };
    const researchOutput = (brief || "# Research Brief\nSome analysis.\n") +
      "\n```json\n" + JSON.stringify(structured, null, 2) + "\n```\n";
    queueMod.storeArtifact({
      work_item_id: wi.id,
      job_id: researchJob.id,
      attempt_id: null,
      artifact_type: "response",
      content_long: researchOutput,
    });

    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Context dir test",
    });
    return { wi, researchJob, planJob };
  }

  it("builds fast/ with brief.md, research.json, and functions.md", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    // Use files that actually exist in the project
    const { wi, planJob } = setupResearchedWI(queueMod, {
      keyFiles: ["lib/domains/artifacts/functions/index.js"],
      brief: "# Research Brief\nThe artifacts module manages directories.\n",
    });

    const worker = makeWorker(workerMod, { projectDir, silent: true }, async () => ({
      output: '```json\n[{"title":"Task","task_spec":"Do it","job_type":"dev","model_tier":"cheap","files_to_modify":["lib/domains/artifacts/functions/index.js"],"success_criteria":["done"],"depends_on_index":[]}]\n```',
      stats: { numTurns: 2 },
    }));

    await dispatchWorker(worker, planJob, "standard", null);

    // Verify fast/ contents
    const ctxDir = contextDir(`wi-${wi.id}`, projectDir);
    const fastDir = path.join(ctxDir, "planner", "fast");
    assert.ok(fs.existsSync(path.join(fastDir, "brief.md")), "brief.md should exist");
    assert.ok(fs.existsSync(path.join(fastDir, "research.json")), "research.json should exist");
    assert.ok(fs.existsSync(path.join(fastDir, "functions.md")), "functions.md should exist");

    // brief.md should contain the researcher's markdown
    const brief = fs.readFileSync(path.join(fastDir, "brief.md"), "utf-8");
    assert.match(brief, /artifacts module manages directories/);

    // research.json should be valid JSON with key_files
    const research = JSON.parse(fs.readFileSync(path.join(fastDir, "research.json"), "utf-8"));
    assert.deepEqual(research.key_files, ["lib/domains/artifacts/functions/index.js"]);
    assert.equal(research.questions_for_human, false);

    // functions.md should have function entries from artifacts.js
    const funcs = fs.readFileSync(path.join(fastDir, "functions.md"), "utf-8");
    assert.match(funcs, /lib\/domains\/artifacts\/functions\/index\.js/);
    assert.match(funcs, /\*\*.*\*\*/); // bold function names

    // Cleanup
    rmContextPath(ctxDir);
  });

  it("pre-stages researcher-ranked planner file priorities", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const { wi, planJob } = setupResearchedWI(queueMod, {
      keyFiles: ["lib/domains/artifacts/functions/index.js"],
      plannerFilePriorities: [
        {
          path: "lib/domains/providers/functions/provider.js",
          rank: 1,
          usefulness: "primary",
          evidence: "chain_read",
          reason: "Provider routing affects the likely edit surface.",
        },
        {
          path: "lib/domains/artifacts/functions/index.js",
          rank: 2,
          usefulness: "supporting",
          evidence: "chain_read",
          reason: "Artifact paths are referenced by the planner.",
        },
      ],
    });

    const worker = makeWorker(workerMod, { projectDir, silent: true }, async () => ({
      output: '```json\n[{"title":"Task","task_spec":"Do it","job_type":"dev","model_tier":"cheap","files_to_modify":["lib/domains/providers/functions/provider.js"],"success_criteria":["done"],"depends_on_index":[]}]\n```',
      stats: { numTurns: 1 },
    }));

    await dispatchWorker(worker, planJob, "standard", null);

    const ctxDir = contextDir(`wi-${wi.id}`, projectDir);
    const fastDir = path.join(ctxDir, "planner", "fast");
    const priorityPath = path.join(fastDir, "file-priorities.md");
    assert.ok(fs.existsSync(priorityPath), "file-priorities.md should exist");

    const priorityText = fs.readFileSync(priorityPath, "utf-8");
    assert.match(priorityText, /1\. lib\/domains\/providers\/functions\/provider\.js/);
    assert.match(priorityText, /evidence=chain_read/);

    const research = JSON.parse(fs.readFileSync(path.join(fastDir, "research.json"), "utf-8"));
    assert.deepEqual(research.key_files, [
      "lib/domains/providers/functions/provider.js",
      "lib/domains/artifacts/functions/index.js",
    ]);
    assert.deepEqual(research.planner_file_priorities.map((entry) => entry.path), [
      "lib/domains/providers/functions/provider.js",
      "lib/domains/artifacts/functions/index.js",
    ]);

    const funcs = fs.readFileSync(path.join(fastDir, "functions.md"), "utf-8");
    assert.ok(
      funcs.indexOf("lib/domains/providers/functions/provider.js") < funcs.indexOf("lib/domains/artifacts/functions/index.js"),
      "functions.md should follow the researcher priority order",
    );

    rmContextPath(ctxDir);
  });

  it("builds full/ with actual source files preserving directory structure", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const { wi, planJob } = setupResearchedWI(queueMod, {
      keyFiles: ["lib/domains/artifacts/functions/index.js"],
      relatedFiles: ["lib/domains/providers/functions/provider.js"],
    });

    const worker = makeWorker(workerMod, { projectDir, silent: true }, async () => ({
      output: '```json\n[{"title":"Task","task_spec":"Do it","job_type":"dev","model_tier":"cheap","files_to_modify":["lib/domains/artifacts/functions/index.js"],"success_criteria":["done"],"depends_on_index":[]}]\n```',
      stats: { numTurns: 1 },
    }));

    await dispatchWorker(worker, planJob, "standard", null);

    const ctxDir = contextDir(`wi-${wi.id}`, projectDir);
    const fullDir = path.join(ctxDir, "planner", "full");
    assert.ok(fs.existsSync(path.join(fullDir, "lib", "domains", "artifacts", "functions", "index.js")), "key_file should be in full/");
    assert.ok(fs.existsSync(path.join(fullDir, "lib", "domains", "providers", "functions", "provider.js")), "related_file should be in full/");

    // fast/ should NOT have source files (only reference files)
    const fastDir = path.join(ctxDir, "planner", "fast");
    assert.ok(!fs.existsSync(path.join(fastDir, "lib", "domains", "artifacts", "functions", "index.js")), "fast/ should not have source files");

    rmContextPath(ctxDir);
  });

  it("drops researcher-provided planner context paths that escape or target private files", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const absoluteInsideProject = path.join(projectDir, "package.json");
    const { wi, planJob } = setupResearchedWI(queueMod, {
      keyFiles: [
        "lib/domains/artifacts/functions/index.js",
        "../package.json",
        ".git/config",
        "lib/.git/config",
        ".env",
        absoluteInsideProject,
      ],
      relatedFiles: [
        { path: "lib/domains/providers/functions/provider.js" },
        { path: "../../outside.txt" },
        ".codex/config.json",
      ],
    });

    const worker = makeWorker(workerMod, { projectDir, silent: true }, async () => ({
      output: '```json\n[{"title":"Task","task_spec":"Do it","job_type":"dev","model_tier":"cheap","files_to_modify":["lib/domains/artifacts/functions/index.js"],"success_criteria":["done"],"depends_on_index":[]}]\n```',
      stats: { numTurns: 1 },
    }));

    await dispatchWorker(worker, planJob, "standard", null);

    const ctxDir = contextDir(`wi-${wi.id}`, projectDir);
    const fullDir = path.join(ctxDir, "planner", "full");
    const research = JSON.parse(fs.readFileSync(path.join(ctxDir, "planner", "fast", "research.json"), "utf-8"));
    assert.deepEqual(research.key_files, ["lib/domains/artifacts/functions/index.js"]);
    assert.deepEqual(research.related_files, ["lib/domains/providers/functions/provider.js"]);
    assert.ok(research.dropped_research_files.some((entry) => entry.path === ".env" && entry.reason === "sensitive_env"));
    assert.ok(research.dropped_research_files.some((entry) => entry.path === ".git/config" && entry.reason === "private_workspace_metadata"));
    assert.ok(research.dropped_research_files.some((entry) => entry.path === absoluteInsideProject && entry.reason === "absolute_path"));
    assert.ok(fs.existsSync(path.join(fullDir, "lib", "domains", "artifacts", "functions", "index.js")));
    assert.ok(fs.existsSync(path.join(fullDir, "lib", "domains", "providers", "functions", "provider.js")));
    assert.equal(fs.existsSync(path.join(fullDir, ".env")), false);
    assert.equal(fs.existsSync(path.join(fullDir, ".git", "config")), false);

    const events = queueMod.getEvents(planJob.id, 20);
    assert.ok(events.some((event) => event.event_type === "planner.research_paths_dropped"));

    rmContextPath(ctxDir);
  });

  it("keeps dropped researcher path metadata scoped to the artifact it came from", async () => {
    const { queueMod, workerMod, dbMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const { wi, planJob } = setupResearchedWI(queueMod, {
      keyFiles: [".env", "lib/domains/artifacts/functions/index.js"],
    });
    const secondResearchJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: clean follow-up",
    });
    queueMod.updateJobStatus(secondResearchJob.id, "succeeded");
    const cleanStructured = {
      key_files: ["lib/domains/providers/functions/provider.js"],
      related_files: [],
      patterns: { routing: "provider routing" },
      constraints: [],
      questions_for_human: false,
      questions: [],
    };
    const cleanArtifact = queueMod.storeArtifact({
      work_item_id: wi.id,
      job_id: secondResearchJob.id,
      attempt_id: null,
      artifact_type: "response",
      content_long: "# Clean Follow-up\nSecond artifact.\n\n```json\n" + JSON.stringify(cleanStructured, null, 2) + "\n```\n",
    });
    dbMod.getDb()
      .prepare("UPDATE artifacts SET created_at = ? WHERE id = ?")
      .run("2999-01-01T00:00:00.000Z", cleanArtifact.id);

    const worker = makeWorker(workerMod, { projectDir, silent: true }, async () => ({
      output: '```json\n[{"title":"Task","task_spec":"Do it","job_type":"dev","model_tier":"cheap","files_to_modify":["lib/domains/providers/functions/provider.js"],"success_criteria":["done"],"depends_on_index":[]}]\n```',
      stats: { numTurns: 1 },
    }));

    await dispatchWorker(worker, planJob, "standard", null);

    const ctxDir = contextDir(`wi-${wi.id}`, projectDir);
    const research = JSON.parse(fs.readFileSync(path.join(ctxDir, "planner", "fast", "research.json"), "utf-8"));
    assert.deepEqual(research.key_files, ["lib/domains/providers/functions/provider.js"]);
    assert.equal(Object.hasOwn(research, "dropped_research_files"), false);

    const events = queueMod.getEvents(planJob.id, 20);
    const droppedEvent = events.find((event) => event.event_type === "planner.research_paths_dropped");
    assert.ok(droppedEvent);
    assert.match(droppedEvent.message, /Dropped 1 researcher-provided/);

    rmContextPath(ctxDir);
  });

  it("handles missing key_files gracefully in functions.md", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const { wi, planJob } = setupResearchedWI(queueMod, {
      keyFiles: ["nonexistent/file.js", "lib/domains/artifacts/functions/index.js"],
    });

    const worker = makeWorker(workerMod, { projectDir, silent: true }, async () => ({
      output: '```json\n[{"title":"T","task_spec":"S","job_type":"dev","model_tier":"cheap","files_to_modify":[],"success_criteria":["ok"],"depends_on_index":[]}]\n```',
      stats: {},
    }));

    await dispatchWorker(worker, planJob, "standard", null);

    const ctxDir = contextDir(`wi-${wi.id}`, projectDir);
    const funcs = fs.readFileSync(path.join(ctxDir, "planner", "fast", "functions.md"), "utf-8");
    assert.match(funcs, /nonexistent\/file\.js/);
    assert.match(funcs, /file not found/);
    assert.match(funcs, /lib\/domains\/artifacts\/functions\/index\.js/);

    rmContextPath(ctxDir);
  });

  it("handles non-JS key_files in functions.md", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const { wi, planJob } = setupResearchedWI(queueMod, {
      keyFiles: ["package.json"],
    });

    const worker = makeWorker(workerMod, { projectDir, silent: true }, async () => ({
      output: '```json\n[{"title":"T","task_spec":"S","job_type":"dev","model_tier":"cheap","files_to_modify":[],"success_criteria":["ok"],"depends_on_index":[]}]\n```',
      stats: {},
    }));

    await dispatchWorker(worker, planJob, "standard", null);

    const ctxDir = contextDir(`wi-${wi.id}`, projectDir);
    const funcs = fs.readFileSync(path.join(ctxDir, "planner", "fast", "functions.md"), "utf-8");
    assert.match(funcs, /package\.json/);
    assert.match(funcs, /non-JS file/);

    rmContextPath(ctxDir);
  });

  it("skips context dir entirely when no research artifacts exist", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("No research", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: No research",
    });

    const worker = makeWorker(workerMod, { projectDir, silent: true }, async () => ({
      output: '```json\n[{"title":"T","task_spec":"S","job_type":"dev","model_tier":"cheap","files_to_modify":[],"success_criteria":["ok"],"depends_on_index":[]}]\n```',
      stats: {},
    }));

    await dispatchWorker(worker, planJob, "standard", null);

    // fast/ should still be created (with empty files), full/ should have nothing
    const ctxDir = contextDir(`wi-${wi.id}`, projectDir);
    const fullDir = path.join(ctxDir, "planner", "full");
    assert.ok(!fs.existsSync(fullDir), "full/ should not exist when no research files");

    // Cleanup if anything was created
    if (fs.existsSync(ctxDir)) rmContextPath(ctxDir);
  });

  it("logs context tier reads from planner tool usage", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const { wi, planJob } = setupResearchedWI(queueMod, {
      keyFiles: ["lib/domains/artifacts/functions/index.js"],
    });

    const ctxDir = contextDir(`wi-${wi.id}`, projectDir);
    const fastDir = path.join(ctxDir, "planner", "fast");
    const fullDir = path.join(ctxDir, "planner", "full");

    const emitted = [];
    const worker = makeWorker(workerMod, { projectDir, silent: true }, async () => ({
      output: '```json\n[{"title":"T","task_spec":"S","job_type":"dev","model_tier":"cheap","files_to_modify":[],"success_criteria":["ok"],"depends_on_index":[]}]\n```',
      stats: {
        numTurns: 4,
        toolUses: [
          { tool: "Read", input: { file_path: path.join(fastDir, "brief.md").replace(/\\/g, "/") } },
          { tool: "Read", input: { file_path: path.join(fastDir, "functions.md").replace(/\\/g, "/") } },
          { tool: "Read", input: { file_path: path.join(fullDir, "lib", "domains", "artifacts", "functions", "index.js").replace(/\\/g, "/") } },
          { tool: "Grep", input: { pattern: "test", path: path.join(projectDir, "lib").replace(/\\/g, "/") } },
        ],
      },
    }));
    worker.emit = (jobId, msg) => { emitted.push(msg); };

    await dispatchWorker(worker, planJob, "standard", null);

    // Check that context read logging was emitted
    const contextLog = emitted.find(m => m.includes("planner reads:"));
    assert.ok(contextLog, "should emit context read log");
    assert.match(contextLog, /fast: 2/);
    assert.match(contextLog, /full: 1/);
    assert.match(contextLog, /project: 1/);

    // Check the artifact was stored
    const logs = queueMod.getArtifacts(planJob.id, "log");
    const contextArtifact = logs.find(a => a.content_long?.startsWith("context_reads:"));
    assert.ok(contextArtifact, "should store context reads artifact");
    assert.match(contextArtifact.content_long, /fast=2 full=1 project=1/);

    if (fs.existsSync(ctxDir)) rmContextPath(ctxDir);
  });

  it("fails deterministically before planner runs when fast/brief.md is unreadable", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const { wi, planJob } = setupResearchedWI(queueMod, {
      brief: "# Research Brief\nRestore the admin page.\n",
    });

    let trackedCallCount = 0;
    const worker = makeWorker(workerMod, { projectDir, silent: true }, async () => {
      trackedCallCount += 1;
      return {
        output: '```json\n[{"title":"T","task_spec":"S","job_type":"dev","model_tier":"cheap","files_to_modify":[],"success_criteria":["ok"],"depends_on_index":[]}]\n```',
        stats: {},
      };
    });

    const ctxDir = contextDir(`wi-${wi.id}`, projectDir);
    const briefPath = path.join(ctxDir, "planner", "fast", "brief.md");
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = function patchedReadFileSync(targetPath, ...args) {
      if (path.resolve(String(targetPath)) === path.resolve(briefPath)) {
        const err = new Error("Access denied");
        err.code = "EACCES";
        throw err;
      }
      return originalReadFileSync.call(this, targetPath, ...args);
    };

    try {
      await assert.rejects(
        dispatchWorker(worker, planJob, "standard", null),
        /Planner handoff preflight failed: unable to read fast\/brief\.md/i,
      );
    } finally {
      fs.readFileSync = originalReadFileSync;
      if (fs.existsSync(ctxDir)) rmContextPath(ctxDir);
    }

    assert.equal(trackedCallCount, 0, "planner provider should not be invoked");
    const summaryArtifacts = queueMod.getArtifacts(planJob.id, "summary");
    assert.ok(
      summaryArtifacts.some((artifact) => /Planner handoff preflight failed: unable to read fast\/brief\.md/i.test(artifact.content_long || "")),
      "should store a planner handoff failure summary",
    );
    const responseArtifacts = queueMod.getArtifacts(planJob.id, "response");
    assert.ok(
      responseArtifacts.some((artifact) => /PLANNER_CONTEXT_ERROR: unable to read fast\/brief\.md/i.test(artifact.content_long || "")),
      "should store a deterministic planner context error artifact",
    );
    const childJobs = queueMod.listJobsByWorkItem(wi.id).filter((candidate) => candidate.parent_job_id === planJob.id);
    assert.equal(childJobs.length, 0, "should not create downstream jobs when planner context preflight fails");
  });

  it("creates per-job scoped context dirs in createJobsFromPlan", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Job context", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Job context",
    });

    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker.createJobsFromPlan(planJob, [
      {
        title: "Edit artifacts module",
        task_spec: "Add a new export.",
        job_type: "dev",
        model_tier: "cheap",
        files_to_modify: ["lib/domains/artifacts/functions/index.js"],
        files_to_create: [],
        success_criteria: ["export exists"],
        depends_on_index: [],
      },
    ]);

    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const devJob = jobs.find(j => j.id !== planJob.id && j.job_type === "dev");
    assert.ok(devJob, "dev job should be created");

    // Check that job context dir was created
    const ctxDir = contextDir(`wi-${wi.id}`, projectDir);
    const jobCtxDir = path.join(ctxDir, `job-${devJob.id}`);
    assert.ok(fs.existsSync(jobCtxDir), "job context dir should exist");
    assert.ok(fs.existsSync(path.join(jobCtxDir, "task.json")), "task.json should exist");

    // task.json should have the task spec and scoped file list
    const taskJson = JSON.parse(fs.readFileSync(path.join(jobCtxDir, "task.json"), "utf-8"));
    assert.equal(taskJson.title, "Edit artifacts module");
    assert.deepEqual(taskJson.files_to_modify, ["lib/domains/artifacts/functions/index.js"]);
    assert.deepEqual(taskJson.success_criteria, ["export exists"]);

    // Scoped source file should be copied
    assert.ok(fs.existsSync(path.join(jobCtxDir, "lib", "domains", "artifacts", "functions", "index.js")), "scoped file should be copied");

    // Payload should have context_dir threaded through
    const freshJob = queueMod.getJob(devJob.id);
    const payload = JSON.parse(freshJob.payload_json);
    assert.ok(payload.context_dir, "payload should have context_dir");
    assert.match(payload.context_dir, new RegExp(`job-${devJob.id}`));

    rmContextPath(ctxDir);
  });

  it("does NOT create per-job context for promote or human_input jobs", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("No job ctx for promote", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: No job ctx",
    });

    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker.createJobsFromPlan(planJob, [
      {
        title: "Ask human",
        job_type: "human_input",
        task_spec: "Approve something.",
        success_criteria: ["approved"],
        depends_on_index: [],
      },
    ]);

    const ctxDir = contextDir(`wi-${wi.id}`, projectDir);
    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const humanJob = jobs.find(j => j.job_type === "human_input" && j.id !== planJob.id);
    assert.ok(humanJob);

    // No job context dir for human_input
    const jobCtxDir = path.join(ctxDir, `job-${humanJob.id}`);
    assert.ok(!fs.existsSync(jobCtxDir), "human_input jobs should not get context dirs");

    if (fs.existsSync(ctxDir)) rmContextPath(ctxDir);
  });

  it("planner makes a single call — no MISSING_CONTEXT loop", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const { planJob } = setupResearchedWI(queueMod, { keyFiles: ["lib/domains/artifacts/functions/index.js"] });

    let callCount = 0;
    const worker = makeWorker(workerMod, { projectDir, silent: true }, async () => {
      callCount++;
      return {
        output: '```json\n[{"title":"T","task_spec":"S","job_type":"dev","model_tier":"cheap","files_to_modify":[],"success_criteria":["ok"],"depends_on_index":[]}]\n```',
        stats: {},
      };
    });

    await dispatchWorker(worker, planJob, "standard", null);

    assert.equal(callCount, 1, "planner should make exactly one call (no MISSING_CONTEXT loop)");

    const ctxDir = contextDir(`wi-${planJob.work_item_id}`, projectDir);
    if (fs.existsSync(ctxDir)) rmContextPath(ctxDir);
  });
});
