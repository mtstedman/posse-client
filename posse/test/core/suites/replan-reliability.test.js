import {
  it,
  before,
  beforeEach,
  after,
  assert,
  path,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  sanitizeHumanQuestions,
  isRepoFileAccessQuestion,
  stripDisplayAnsi,
} from "../support/core-harness.js";

let db;

suite("Replan reliability", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("counts actual replan cycles instead of canceled sibling events", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Replan counter", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Current job",
      payload_json: JSON.stringify({ task_spec: "do work" }),
    });

    queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research (replan): Replan counter",
    });

    for (let i = 0; i < 4; i++) {
      queueMod.logEvent({
        work_item_id: wi.id,
        job_id: current.id,
        event_type: "job.canceled_by_replan",
        actor_type: "system",
        message: `noise ${i}`,
      });
    }

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "needs_replan",
      confidence: "high",
      reasons: ["planner should try again"],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {} });

    assert.ok(spawnedJobs.some(j => j.job_type === "research" && /^Research \(replan\):/.test(j.title)));
    assert.equal(spawnedJobs.some(j => j.job_type === "plan" && /^Replan:/.test(j.title)), false);
    assert.equal(spawnedJobs.some(j => j.job_type === "human_input"), false);
  });

  it("counts loopback replan research by payload flag even when titles change", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Replan payload counter", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Current job",
      payload_json: JSON.stringify({ task_spec: "do work" }),
    });

    for (let i = 0; i < 3; i++) {
      queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: `Investigate alternative plan ${i + 1}`,
        payload_json: JSON.stringify({ _is_loopback: true }),
      });
    }

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "needs_replan",
      confidence: "high",
      reasons: ["planner should try again"],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {} });

    assert.ok(spawnedJobs.some(j => j.job_type === "human_input"));
    assert.equal(spawnedJobs.some(j => j.job_type === "research" && /^Research \(replan\):/.test(j.title)), false);
  });

  it("cancels stale review-gated branches during replan", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Stale review cleanup", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Current job",
      payload_json: JSON.stringify({ task_spec: "do work" }),
    });
    const stale = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "fix",
      title: "Old fix branch",
    });
    queueMod.updateJobStatus(stale.id, "waiting_on_review");
    const staleReview = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Review needed: Old fix branch",
      parent_job_id: stale.id,
      payload_json: JSON.stringify({ original_job_id: stale.id, questions: ["pass or fail?"] }),
    });
    queueMod.updateJobStatus(staleReview.id, "waiting_on_human");

    assessorMod.processVerdict(current, {
      verdict: "needs_replan",
      confidence: "high",
      reasons: ["branch is stale"],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {} });

    assert.equal(queueMod.getJob(stale.id).status, "canceled");
    assert.equal(queueMod.getJob(staleReview.id).status, "canceled");
  });

  it("cancels queued artifact and promote jobs from stale plans during replan", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Stale artifact cleanup", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Current job",
      payload_json: JSON.stringify({ task_spec: "do work" }),
    });
    const staleArtifact = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "artificer",
      title: "Old artifact branch",
      payload_json: JSON.stringify({ task_mode: "image" }),
    });
    const stalePromote = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "promote",
      title: "Old promote branch",
      payload_json: JSON.stringify({ mappings: [] }),
    });
    const staleSummary = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "summarize",
      title: "Old summary branch",
    });
    const completedArtifact = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "artificer",
      title: "Completed artifact branch",
    });
    queueMod.updateJobStatus(completedArtifact.id, "succeeded");

    assessorMod.processVerdict(current, {
      verdict: "needs_replan",
      confidence: "high",
      reasons: ["old artifact branch is stale"],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {} });

    assert.equal(queueMod.getJob(staleArtifact.id).status, "canceled");
    assert.equal(queueMod.getJob(stalePromote.id).status, "canceled");
    assert.equal(queueMod.getJob(staleSummary.id).status, "canceled");
    assert.equal(queueMod.getJob(completedArtifact.id).status, "succeeded");
  });

  it("rolls back stale cancellations when replan spawn fails", async () => {
    const { queueMod } = runtimeModules;
    const { handle } = await import("../../../lib/domains/worker/functions/helpers/verdicts/needs_replan.js");
    const wi = queueMod.createWorkItem("Transactional replan", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Current job",
      payload_json: JSON.stringify({ task_spec: "do work" }),
    });
    const stale = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "fix",
      title: "Old fix branch",
    });

    assert.throws(() => handle(current, {
      verdict: "needs_replan",
      confidence: "high",
      reasons: ["force spawn failure"],
    }, {
      emitLog: () => {},
      reasonBrief: "",
      spawnedJobs: [],
      updateJobStatus: (status) => queueMod.updateJobStatus(current.id, status),
      spawnFromAssessor: () => {
        throw new Error("spawn failed");
      },
    }), /spawn failed/);

    assert.equal(queueMod.getJob(current.id).status, "queued");
    assert.equal(queueMod.getJob(stale.id).status, "queued");
    assert.equal(queueMod.listJobsByWorkItem(wi.id).filter((job) => job.job_type === "research").length, 0);
  });

  it("cancels queued children from older plan waves when a newer plan compiles", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Supersede old plan wave", "desc");
    const oldPlan = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Replan: Supersede old plan wave",
    });
    queueMod.updateJobStatus(oldPlan.id, "succeeded");
    const staleDev = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Old queued dev",
      parent_job_id: oldPlan.id,
      payload_json: JSON.stringify({ task_spec: "old", files_to_modify: ["old.php"] }),
    });
    const stalePromote = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "promote",
      title: "Old queued promote",
      parent_job_id: oldPlan.id,
      payload_json: JSON.stringify({ mappings: [] }),
    });
    const alreadyDone = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Old succeeded dev",
      parent_job_id: oldPlan.id,
      payload_json: JSON.stringify({ task_spec: "done", files_to_modify: ["done.php"] }),
    });
    queueMod.updateJobStatus(alreadyDone.id, "succeeded");
    const activeOld = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Old leased dev",
      parent_job_id: oldPlan.id,
      payload_json: JSON.stringify({ task_spec: "active", files_to_modify: ["active.php"] }),
    });
    queueMod.updateJobStatus(activeOld.id, "leased");

    const newPlan = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Supersede old plan wave",
    });
    const emitted = [];
    const worker = new workerMod.Worker({ projectDir: path.resolve(__dirname, ".."), silent: true });
    worker.emit = (_jobId, message) => {
      emitted.push(stripDisplayAnsi(message));
    };
    worker.createJobsFromPlan(newPlan, [{
      title: "New implementation",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Implement the current plan.",
      files_to_modify: ["new.php"],
      success_criteria: ["new.php updated"],
    }]);

    assert.equal(queueMod.getJob(staleDev.id).status, "canceled");
    assert.equal(queueMod.getJob(stalePromote.id).status, "canceled");
    assert.equal(queueMod.getJob(alreadyDone.id).status, "succeeded");
    assert.equal(queueMod.getJob(activeOld.id).status, "leased");
    assert.ok(emitted.some((line) =>
      line.includes("canceled 2 queued job(s) from older plan wave(s); 1 active older-plan job(s) already running")
    ));
    assert.ok(queueMod.listJobsByWorkItem(wi.id).some((job) => job.parent_job_id === newPlan.id && job.title === "New implementation"));
  });

  it("keeps deterministic promote job creation out of the visible event log", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Quiet promote jobs", "desc");
    const promote = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "promote",
      title: "Promote generated assets",
      payload_json: JSON.stringify({ mappings: [] }),
    });

    const event = queueMod.getEvents(promote.id, 5).find((row) => row.event_type === "job.created");
    assert.ok(event);
    assert.equal(JSON.parse(event.event_json).visible, false);
  });

  it("replans after a successful intermediate report when repo output is still required", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Repo output contract", "desc", "normal", {
      metadata: {
        intake_hints: {
          output_mode: "auto",
          desired_outputs: ["repo"],
          deliverable_type: "code",
        },
      },
    });
    const reportJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "artificer",
      title: "Report: Smoke test admin page",
      payload_json: JSON.stringify({
        task_spec: "Write intermediate smoke test evidence.",
        task_mode: "report",
        output_root: ".posse/resources/artifacts/wi-1/task-01-report",
        files_to_modify: [],
        files_to_create: [".posse/resources/artifacts/wi-1/task-01-report/report.md"],
        create_roots: [".posse/resources/artifacts/wi-1/task-01-report"],
      }),
    });

    const { spawnedJobs } = assessorMod.processVerdict(reportJob, {
      verdict: "pass",
      confidence: "high",
      reasons: ["Captured intermediate smoke test evidence."],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {} });

    assert.ok(spawnedJobs.some(j => j.job_type === "research" && /^Research \(replan\):/.test(j.title)));
    assert.equal(spawnedJobs.some(j => j.job_type === "plan" && /^Replan:/.test(j.title)), false);
  });

  it("does not replan answered question-mode research for question_only output", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Answer a question", "desc", "normal", {
      metadata: {
        mode: "question",
        intake_hints: {
          output_mode: "auto",
          desired_outputs: ["question_only"],
          deliverable_type: "answer",
        },
      },
    });
    const researchJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: Answer a question",
      payload_json: JSON.stringify({
        task_spec: "Research and answer the user's question.",
      }),
    });

    const { spawnedJobs } = assessorMod.processVerdict(researchJob, {
      verdict: "pass",
      confidence: "high",
      reasons: ["Answered the question."],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {} });

    assert.equal(spawnedJobs.some((job) => job.job_type === "research" && /^Research \(replan\):/.test(job.title)), false);
    assert.equal(spawnedJobs.some((job) => job.job_type === "plan" && /^Replan:/.test(job.title)), false);
    assert.equal(queueMod.getJob(researchJob.id).status, "succeeded");
  });

  it("reroutes failed zero-scope repo-bound code jobs to an intermediate report instead of a fix", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Zero-scope recovery", "desc", "normal", {
      metadata: {
        intake_hints: {
          output_mode: "auto",
          desired_outputs: ["repo"],
          deliverable_type: "code",
        },
      },
    });
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Smoke test admin page after JSX fix",
      payload_json: JSON.stringify({
        task_spec: "Run the admin smoke test.",
        task_mode: "code",
        files_to_modify: [],
        files_to_create: [],
        files_to_delete: [],
        create_roots: [],
      }),
    });

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "fail",
      confidence: "high",
      reasons: ["The smoke test did not produce terminal repo output."],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {} });

    const reportJob = spawnedJobs.find((job) => job.job_type === "artificer");
    assert.ok(reportJob, "expected a report job to be spawned");
    assert.equal(spawnedJobs.some((job) => job.job_type === "fix"), false);
    const payload = JSON.parse(queueMod.getJob(reportJob.id).payload_json);
    assert.equal(payload.task_mode, "report");
    assert.match(payload.files_to_create[0], /report\.md$/);
  });

  it("filters assessor repo-file questions before spawning human review", () => {
    const question = "Please provide the contents of `src/prompts/music.js` (or the diff) so I can verify the edits around lines ~199-201 and ~282-291.";
    const context = "Need a human ruling on whether the output is acceptable.";
    assert.equal(isRepoFileAccessQuestion(question, { context }), true);
    assert.deepEqual(sanitizeHumanQuestions([question], { context }), []);
  });

  it("filters assessor repo-file questions that mention blocked file reads and line ranges", () => {
    const question = "I attempted to read the repository file `src/prompts/music.js` but file-read operations are blocked. Please provide the contents of `src/prompts/music.js` (or the diff) so I can verify the edits around lines ~199-201 and ~282-291.";
    const context = "Need a human ruling on whether the output is acceptable.";
    assert.equal(isRepoFileAccessQuestion(question, { context }), true);
    assert.deepEqual(sanitizeHumanQuestions([question], { context }), []);
  });

  it("filters assessor questions that ask for diffs around code identifiers without repeating the file path", () => {
    const question = "If you prefer not to paste the whole file, can you confirm the exact line numbers or show the diffs around `loadWorkshopStyleSources`, the combobox initialization code, and the `onSelect` handlers so I can verify they meet the task spec?";
    const context = "Need a human ruling on whether the output is acceptable.\nThe repo file is `htdocs/js/workshop-style.js`.";
    assert.equal(isRepoFileAccessQuestion(question, { context }), true);
    assert.deepEqual(sanitizeHumanQuestions([question], { context }), []);
  });

  it("filters assessor questions that ask to confirm whether a repo file contains specific code", () => {
    const question = "If you prefer a targeted check instead of the full file, can you confirm whether `htdocs/js/workshop.js` contains (a) a `Promise.all([fetch('/api/presets'), fetch('/api/styles')])` or equivalent and (b) two calls to the shared combobox initializer with `onSelect` handlers?";
    const context = "Need a human ruling on whether the output is acceptable.";
    assert.equal(isRepoFileAccessQuestion(question, { context }), true);
    assert.deepEqual(sanitizeHumanQuestions([question], { context }), []);
  });

  it("filters assessor questions that ask for CSS rules from a repo file or confirmation they were added", () => {
    const question = "Please provide the combobox-related CSS rules from `htdocs/css/main.css` (the section that defines `.combobox`, `.combobox__dropdown`, `.combobox__item`, `.is-open`, `.is-focused`, and focus outline styles), or confirm that these selectors and accessible focus outline rules were added to `htdocs/css/main.css`.";
    const context = "Need a human ruling on whether the styling meets the task requirements.";
    assert.equal(isRepoFileAccessQuestion(question, { context }), true);
    assert.deepEqual(sanitizeHumanQuestions([question], { context }), []);
  });

  it("does not classify ordinary run-the-flow questions as repo file access just because context mentions paths", async () => {
    const classifier = await import("../../../lib/domains/worker/functions/helpers/human-question-classifier.js");
    const result = classifier.classifyHumanQuestion(
      "Please run through the signup flow and tell me whether it still 404s.",
      { context: "Relevant files: `htdocs/signup.html`, `htdocs/api/index.php`." }
    );

    assert.equal(result.category, "other");
    assert.equal(result.allowHuman, true);
  });

  it("keeps fix delete scope pinned to the original job", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Fix delete validation", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Delete legacy auth files",
      payload_json: JSON.stringify({
        files_to_modify: ["htdocs/app.js"],
        files_to_delete: ["htdocs/old-auth.js"],
      }),
    });

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "fail",
      confidence: "high",
      reasons: ["Delete the legacy auth files."],
      spawn_jobs: [{
        job_type: "fix",
        title: "Delete leftover auth files",
        payload: {
          instructions: "Delete the old auth files.",
          files_to_delete: ["../outside.js", "htdocs/legacy-auth.js"],
        },
      }],
      human_questions: [],
    }, { emit: () => {} });

    const fixJob = spawnedJobs.find((job) => job.job_type === "fix");
    assert.ok(fixJob);
    const payload = JSON.parse(fixJob.payload_json || "{}");
    assert.deepEqual(payload.files_to_delete, ["htdocs/old-auth.js"]);
  });

  it("does not let assessor prose expand fix modify or delete scope", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Fix scope escalation", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Refit admin palette surfaces",
      payload_json: JSON.stringify({
        files_to_modify: ["www/livevane.com/htdocs/admin/index.html"],
        files_to_delete: [],
      }),
    });

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "fail",
      confidence: "high",
      reasons: [
        "www/livevane.com/htdocs/admin/index.html was deleted and must be restored before the palette updates can be verified.",
      ],
      spawn_jobs: [{
        job_type: "fix",
        title: "Restore admin index and refit palette surfaces",
        payload: {
          instructions: "Recreate www/livevane.com/htdocs/admin/index.html from the previous version, then update the solid panel styling in that file.",
          files_to_modify: ["www/livevane.com/htdocs/flows/index.html"],
          files_to_delete: ["www/livevane.com/htdocs/admin/index.html"],
        },
      }],
      human_questions: [],
    }, { emit: () => {} });

    const fixJob = spawnedJobs.find((job) => job.job_type === "fix");
    assert.ok(fixJob);
    const payload = JSON.parse(fixJob.payload_json || "{}");
    assert.deepEqual(payload.files_to_modify, ["www/livevane.com/htdocs/admin/index.html"]);
    assert.deepEqual(payload.files_to_delete, []);
  });
});
