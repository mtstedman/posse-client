import {
  it,
  beforeEach,
  after,
  assert,
  fs,
  os,
  path,
  __dirname,
  suite,
  runtimeModules,
  now,
  createJob,
  resetRuntimeDb,
  withEnv,
  dispatchWorker,
  makeWorker,
  withAccountSettingsPath,
  withArtifactProtocols,
  inferPromoteTask,
  normalizePromoteMappings,
  artifactsDir,
  workItemArtifactRoot,
} from "../support/core-harness.js";

let db;

suite("Plan to pipeline job creation", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("validates planner-selected skills and persists surviving ids on dev jobs", () => {
    const { queueMod, workerMod, dbMod } = runtimeModules;
    queueMod.setSetting("skills_enabled", "true");
    queueMod.setSetting("skills_disabled_ids", "");
    const wi = queueMod.createWorkItem("Plan skills", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Skills",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Polish UI module",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Improve the scoped UI behavior.",
      files_to_modify: ["lib/domains/artifacts/functions/index.js"],
      success_criteria: ["Scoped file updated"],
      depends_on_index: [],
      skills: ["frontend-design", "missing-skill"],
    }]);

    const created = dbMod.getDb().prepare(`SELECT * FROM jobs WHERE parent_job_id = ? AND job_type = 'dev'`).get(planJob.id);
    assert.equal(created.skills, JSON.stringify(["frontend-design"]));
    const payload = JSON.parse(created.payload_json);
    assert.deepEqual(payload.skills, ["frontend-design"]);
    const skipped = queueMod.getEvents(null, 100).find((event) => event.event_type === "skill_skipped_unknown");
    assert.ok(skipped);
  });

  it("infers frontend-design skill for frontend dev work when planner omits skills", () => {
    const { queueMod, workerMod, dbMod } = runtimeModules;
    queueMod.setSetting("skills_enabled", "true");
    queueMod.setSetting("skills_disabled_ids", "");
    const wi = queueMod.createWorkItem("Frontend skill fallback", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Frontend fallback",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Create shared learn CSS",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Create a shared stylesheet for responsive learn page layout and typography.",
      files_to_create: ["htdocs/learn/learn.css"],
      success_criteria: ["Stylesheet exists"],
      depends_on_index: [],
    }]);

    const created = dbMod.getDb().prepare(`SELECT * FROM jobs WHERE parent_job_id = ? AND job_type = 'dev'`).get(planJob.id);
    assert.equal(created.skills, JSON.stringify(["frontend-design"]));
    const payload = JSON.parse(created.payload_json);
    assert.deepEqual(payload.skills, ["frontend-design"]);
    const inferred = queueMod.getEvents(null, 100).find((event) => event.event_type === "skill_inferred");
    assert.match(inferred?.message || "", /frontend-design/);
  });

  it("does not infer frontend-design for a narrow browser-script bug fix without design intent", () => {
    const { queueMod, workerMod, dbMod } = runtimeModules;
    queueMod.setSetting("skills_enabled", "true");
    queueMod.setSetting("skills_disabled_ids", "");
    const wi = queueMod.createWorkItem("No frontend fallback", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: No frontend fallback",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Fix glossary label",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Add the missing Vedic key to a category label map in the glossary script.",
      files_to_modify: ["htdocs/assets/js/spirit-glossary.js"],
      success_criteria: ["The label map includes vedic: 'Vedic'"],
      depends_on_index: [],
    }]);

    const created = dbMod.getDb().prepare(`SELECT * FROM jobs WHERE parent_job_id = ? AND job_type = 'dev'`).get(planJob.id);
    assert.equal(created.skills, null);
  });

  it("drops planner-selected skills from artificer jobs", () => {
    const { queueMod, workerMod, dbMod } = runtimeModules;
    queueMod.setSetting("skills_enabled", "true");
    queueMod.setSetting("skills_disabled_ids", "");
    const wi = queueMod.createWorkItem("Artificer skill drop", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Artificer skill drop",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Generate UI mockups",
      job_type: "artificer",
      task_mode: "image",
      needs_image_generation: true,
      task_spec: "Generate UI mockup images.",
      output_root: ".posse/resources/artifacts/wi-1",
      create_roots: [".posse/resources/artifacts/wi-1"],
      success_criteria: ["Mockups exist"],
      depends_on_index: [],
      skills: ["frontend-design"],
    }]);

    const created = dbMod.getDb().prepare(`SELECT * FROM jobs WHERE parent_job_id = ? AND job_type = 'artificer'`).get(planJob.id);
    assert.ok(created);
    assert.equal(created.skills, null);
    const payload = JSON.parse(created.payload_json);
    assert.equal(Object.hasOwn(payload, "skills"), false);
    const skipped = queueMod.getEvents(null, 100).find((event) => event.event_type === "skill_skipped_disabled");
    assert.match(skipped?.message || "", /non-dev task/);
  });

  it("skips duplicate planned dev tasks and maps dependencies to the first job", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Duplicate planned task", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Duplicate planned task",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });
    const duplicateTask = {
      title: "Fix weak view_as validation",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Make view_as validation reject weak or malformed values.",
      files_to_modify: ["src/view-as.php"],
      success_criteria: ["Invalid view_as values are rejected"],
      depends_on_index: [],
    };

    worker.createJobsFromPlan(planJob, [
      duplicateTask,
      { ...duplicateTask },
      {
        title: "Verify view_as validation",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Add a focused validation test for view_as.",
        files_to_modify: ["tests/view-as.test.php"],
        success_criteria: ["Validation test covers malformed values"],
        depends_on_index: [1],
      },
    ]);

    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const fixJobs = jobs.filter((job) => job.job_type === "dev" && job.title === duplicateTask.title);
    assert.equal(fixJobs.length, 1);

    const verifyJob = jobs.find((job) => job.title === "Verify view_as validation");
    assert.ok(verifyJob);
    const deps = queueMod.getDependencies(verifyJob.id);
    assert.ok(deps.some((dep) => dep.depends_on_job_id === fixJobs[0].id));

    const skipped = queueMod.getEventsByWorkItem(wi.id, 100)
      .find((event) => event.event_type === "plan.task_invalid");
    assert.equal(JSON.parse(skipped.event_json).reason, "duplicate_planned_task");
  });

  it("keeps same-title planned dev tasks when the task specs differ", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Similar planned tasks", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Similar planned tasks",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [
      {
        title: "Fix validation",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Fix the request validator.",
        files_to_modify: ["src/request.php"],
        success_criteria: ["Request validator passes"],
        depends_on_index: [],
      },
      {
        title: "Fix validation",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Fix the response validator.",
        files_to_modify: ["src/response.php"],
        success_criteria: ["Response validator passes"],
        depends_on_index: [],
      },
    ]);

    const devJobs = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.job_type === "dev");
    assert.equal(devJobs.length, 2);
  });

  it("creates deterministic promote jobs with expected payload and dependencies", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Promote artifacts", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Promote artifacts",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [
      {
        title: "Generate product images",
        job_type: "artificer",
        task_mode: "image",
        needs_image_generation: true,
        task_spec: "Generate PNG product images",
        success_criteria: ["Images exist"],
        depends_on_index: [],
      },
      {
        title: "Install generated images",
        job_type: "promote",
        mappings: [{ pattern: "*.png", dest: "public/images" }],
        depends_on_index: [0],
      },
      {
        title: "Wire promoted images into the UI",
        job_type: "dev",
        task_spec: "Reference promoted assets from the UI",
        files_to_modify: ["src/app.js"],
        files_to_create: [],
        success_criteria: ["UI references promoted images"],
        depends_on_index: [1],
      },
    ]);

    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const created = jobs.filter(j => j.id !== planJob.id && j.job_type !== "delegate");
    const artificerJob = created.find(j => j.job_type === "artificer");
    const promoteJob = created.find(j => j.job_type === "promote");
    const devJob = created.find(j => j.job_type === "dev");

    assert.ok(artificerJob);
    assert.ok(promoteJob);
    assert.ok(devJob);
    assert.equal(promoteJob.model_tier, "cheap");
    assert.equal(promoteJob.reasoning_effort, "low");
    assert.equal(promoteJob.max_attempts, 2);

    const artificerPayload = JSON.parse(artificerJob.payload_json);
    const promotePayload = JSON.parse(promoteJob.payload_json);
    const artifactRoot = workItemArtifactRoot(wi.id, worker.projectDir).replace(/\\/g, "/");
    const sourceDir = String(promotePayload.source_dir || "").replace(/\\/g, "/");
    const outputRoot = String(artificerPayload.output_root || "").replace(/\\/g, "/");
    assert.deepEqual(promotePayload.mappings, [{ pattern: "*.png", dest: "public/images", destination_type: "directory" }]);
    assert.deepEqual(promotePayload.create_roots, ["public/images"]);
    assert.equal(sourceDir, outputRoot);
    assert.equal(sourceDir, `${artifactRoot}/task-01-generate-product-images`);

    const promoteDeps = queueMod.getDependencies(promoteJob.id);
    assert.ok(promoteDeps.some(dep => dep.depends_on_job_id === artificerJob.id));

    const devDeps = queueMod.getDependencies(devJob.id);
    assert.ok(devDeps.some(dep => dep.depends_on_job_id === promoteJob.id));
  });

  it("splits promote tasks by upstream artifact output directory", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Promote split image outputs", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Promote split image outputs",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [
      {
        title: "Generate jungle-nightlife hero background image",
        job_type: "artificer",
        task_mode: "image",
        needs_image_generation: true,
        task_spec: "Generate the hero background. Save output as: `hero-bg.jpg` in the artifact directory.",
        success_criteria: ["File hero-bg.jpg exists in the artifact output directory"],
        depends_on_index: [],
      },
      {
        title: "Generate jungle-nightlife couple / scene photo",
        job_type: "artificer",
        task_mode: "image",
        needs_image_generation: true,
        task_spec: "Generate the couple scene photo. Save output as: `couple-photo.jpg` in the artifact directory.",
        success_criteria: ["File couple-photo.jpg exists in the artifact output directory"],
        depends_on_index: [],
      },
      {
        title: "Promote generated jungle images into htdocs/assets/images/",
        job_type: "promote",
        mappings: [
          { pattern: "hero-bg.jpg", dest: "htdocs/assets/images" },
          { pattern: "couple-photo.jpg", dest: "htdocs/assets/images" },
        ],
        depends_on_index: [0, 1],
      },
      {
        title: "Wire promoted images",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Reference promoted images from CSS and HTML.",
        files_to_modify: ["htdocs/assets/css/style.css", "htdocs/index.php"],
        files_to_create: [],
        success_criteria: ["Promoted images are referenced"],
        depends_on_index: [2],
      },
    ]);

    const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id && job.job_type !== "delegate");
    const artificerJobs = created.filter((job) => job.job_type === "artificer");
    const promoteJobs = created.filter((job) => job.job_type === "promote");
    const devJob = created.find((job) => job.job_type === "dev");
    assert.equal(artificerJobs.length, 2);
    assert.equal(promoteJobs.length, 2);
    assert.ok(devJob);

    const heroArtifact = artificerJobs.find((job) => /hero background/.test(job.title));
    const coupleArtifact = artificerJobs.find((job) => /couple/.test(job.title));
    assert.ok(heroArtifact);
    assert.ok(coupleArtifact);
    const heroOutputRoot = JSON.parse(heroArtifact.payload_json).output_root;
    const coupleOutputRoot = JSON.parse(coupleArtifact.payload_json).output_root;

    const payloads = promoteJobs.map((job) => ({ job, payload: JSON.parse(job.payload_json) }));
    const heroPromote = payloads.find(({ payload }) => payload.mappings.some((mapping) => mapping.pattern === "hero-bg.jpg"));
    const couplePromote = payloads.find(({ payload }) => payload.mappings.some((mapping) => mapping.pattern === "couple-photo.jpg"));
    assert.ok(heroPromote);
    assert.ok(couplePromote);
    assert.equal(heroPromote.payload.source_dir, heroOutputRoot);
    assert.equal(couplePromote.payload.source_dir, coupleOutputRoot);
    assert.deepEqual(heroPromote.payload.mappings, [
      { pattern: "hero-bg.jpg", dest: "htdocs/assets/images", destination_type: "directory" },
    ]);
    assert.deepEqual(couplePromote.payload.mappings, [
      { pattern: "couple-photo.jpg", dest: "htdocs/assets/images", destination_type: "directory" },
    ]);

    const heroPromoteDeps = queueMod.getDependencies(heroPromote.job.id).map((dep) => dep.depends_on_job_id);
    const couplePromoteDeps = queueMod.getDependencies(couplePromote.job.id).map((dep) => dep.depends_on_job_id);
    const devDeps = queueMod.getDependencies(devJob.id).map((dep) => dep.depends_on_job_id);
    assert.deepEqual(heroPromoteDeps, [heroArtifact.id]);
    assert.ok(couplePromoteDeps.includes(coupleArtifact.id));
    assert.ok(couplePromoteDeps.includes(heroPromote.job.id));
    assert.deepEqual(devDeps, [couplePromote.job.id]);
  });

  it("routes ambiguous promote mappings to the earliest upstream artifact output directory", async () => {
    const { routePromoteTaskByOutputDir } = await import("../../../lib/domains/worker/functions/planning/task-splitting.js");
    const artifactDirAbs = "C:/repo/.posse/resources/artifacts/wi-1";
    const tasks = [
      {
        title: "Generate first hero image",
        output_root: `${artifactDirAbs}/task-01-first-hero`,
        task_spec: "Save output as: `hero-bg.jpg`.",
        success_criteria: ["hero-bg.jpg exists"],
      },
      {
        title: "Generate backup hero image",
        output_root: `${artifactDirAbs}/task-02-backup-hero`,
        task_spec: "Save output as: `hero-bg.jpg`.",
        success_criteria: ["hero-bg.jpg exists"],
      },
      {
        title: "Promote generated hero image",
        job_type: "promote",
        mappings: [{ pattern: "hero-bg.jpg", dest: "htdocs/assets/images" }],
        depends_on_index: [0, 1],
      },
    ];

    const routed = routePromoteTaskByOutputDir(tasks[2], 2, tasks, artifactDirAbs);
    assert.ok(routed);
    assert.equal(routed.normalizedTask.source_dir, `${artifactDirAbs}/task-01-first-hero`);
    assert.deepEqual(routed.normalizedTask.mappings, tasks[2].mappings);

    const wildcard = routePromoteTaskByOutputDir({
      ...tasks[2],
      mappings: [{ pattern: "*.jpg", dest: "htdocs/assets/images" }],
    }, 2, tasks, artifactDirAbs);
    assert.ok(wildcard);
    assert.equal(wildcard.normalizedTask.source_dir, `${artifactDirAbs}/task-01-first-hero`);
  });

  it("does not force parent deepthink_budget onto planned jobs", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Budgeted plan", "desc", "normal", {
      metadata: { deepthink_budget: "xhigh" },
    });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Budgeted plan",
      payload_json: JSON.stringify({ deepthink_budget: "xhigh" }),
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Do normal thing",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Implement the scoped change.",
      reasoning_effort: "medium",
      files_to_modify: ["src/app.js"],
      files_to_create: [],
      success_criteria: ["done"],
      depends_on_index: [],
    }, {
      title: "Do explicitly low thing",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Implement the low-budget scoped change.",
      reasoning_effort: "medium",
      deepthink_budget: "low",
      files_to_modify: ["src/low.js"],
      files_to_create: [],
      success_criteria: ["done"],
      depends_on_index: [],
    }, {
      title: "Do explicitly normal thing",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Implement the normal-budget scoped change.",
      reasoning_effort: "medium",
      deepthink_budget: "normal",
      files_to_modify: ["src/normal.js"],
      files_to_create: [],
      success_criteria: ["done"],
      depends_on_index: [],
    }]);

    const devJobs = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.job_type === "dev");
    assert.equal(devJobs.length, 3);

    const normalJob = devJobs.find((job) => job.title === "Do normal thing");
    assert.ok(normalJob);
    assert.equal(normalJob.reasoning_effort, "medium");
    const normalPayload = JSON.parse(normalJob.payload_json);
    assert.equal(normalPayload.deepthink_budget, "normal");
    assert.equal(normalPayload.deepthink, false);

    const lowJob = devJobs.find((job) => job.title === "Do explicitly low thing");
    assert.ok(lowJob);
    assert.equal(lowJob.reasoning_effort, "low");
    const lowPayload = JSON.parse(lowJob.payload_json);
    assert.equal(lowPayload.deepthink_budget, "low");
    assert.equal(lowPayload.deepthink, false);

    const explicitNormalJob = devJobs.find((job) => job.title === "Do explicitly normal thing");
    assert.ok(explicitNormalJob);
    assert.equal(explicitNormalJob.reasoning_effort, "medium");
    const explicitNormalPayload = JSON.parse(explicitNormalJob.payload_json);
    assert.equal(explicitNormalPayload.deepthink_budget, "normal");
    assert.equal(explicitNormalPayload.deepthink, false);
  });

  it("honors explicit task deepthink_budget for planned jobs", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Task budgeted plan", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Task budgeted plan",
      payload_json: JSON.stringify({ deepthink_budget: "normal" }),
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Do hard thing",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Implement the risky change.",
      deepthink_budget: "xhigh",
      files_to_modify: ["src/app.js"],
      files_to_create: [],
      success_criteria: ["done"],
      depends_on_index: [],
    }]);

    const devJob = queueMod.listJobsByWorkItem(wi.id).find((job) => job.job_type === "dev");
    assert.ok(devJob);
    assert.equal(devJob.reasoning_effort, "high");
    const payload = JSON.parse(devJob.payload_json);
    assert.equal(payload.deepthink_budget, "xhigh");
    assert.equal(payload.deepthink, true);
  });

  it("normalizes artifact-copy dev tasks into promote jobs", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Normalize promote copy task", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Normalize promote copy task",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [
      {
        title: "Generate product images",
        job_type: "artificer",
        task_mode: "image",
        needs_image_generation: true,
        task_spec: "Generate PNG product images",
        success_criteria: ["Images exist"],
        depends_on_index: [],
      },
      {
        title: "Promote generated images to public/images",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Copy all generated image files from the artifact directory into public/images.",
        files_to_modify: [],
        files_to_create: ["public/images/hero.png", "public/images/card.png"],
        create_roots: ["public/images"],
        success_criteria: ["Images copied into public/images"],
        depends_on_index: [0],
      },
    ]);

    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const artificerJob = jobs.find(j => j.job_type === "artificer");
    const promoteJob = jobs.find(j => j.job_type === "promote");
    assert.ok(artificerJob, "expected artifact generation job");
    assert.ok(promoteJob, "expected artifact copy task to normalize into a promote job");

    const artificerPayload = JSON.parse(artificerJob.payload_json);
    const promotePayload = JSON.parse(promoteJob.payload_json);
    assert.equal(promotePayload.source_dir, artificerPayload.output_root);
    assert.match(promotePayload.source_dir, /resources\/artifacts\/wi-\d+\/task-01-generate-product-images$/);
    assert.deepEqual(promotePayload.mappings, [
      { pattern: "hero.png", dest: "public/images", destination_type: "directory" },
      { pattern: "card.png", dest: "public/images", destination_type: "directory" },
    ]);
  });

  it("plan approval gate includes promote jobs created during artifact routing", () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousApproval = queueMod.getSetting("plan_approval_mode");
    queueMod.setSetting("plan_approval_mode", "true");
    try {
      const wi = queueMod.createWorkItem("Approve generated assets", "desc", "normal", { mode: "build" });
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: Approve generated assets",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [
        {
          title: "Generate product images",
          job_type: "artificer",
          task_mode: "image",
          needs_image_generation: true,
          task_spec: "Generate PNG product images",
          success_criteria: ["Images exist"],
          depends_on_index: [],
        },
        {
          title: "Promote generated images to public/images",
          job_type: "dev",
          task_mode: "code",
          task_spec: "Copy all generated image files from the artifact directory into public/images.",
          files_to_modify: [],
          files_to_create: ["public/images/hero.png"],
          create_roots: ["public/images"],
          success_criteria: ["Images copied into public/images"],
          depends_on_index: [0],
        },
      ]);

      const jobs = queueMod.listJobsByWorkItem(wi.id);
      const artificerJob = jobs.find((job) => job.job_type === "artificer");
      const promoteJob = jobs.find((job) => job.job_type === "promote");
      const gate = jobs.find((job) => job.job_type === "human_input");
      assert.ok(artificerJob);
      assert.ok(promoteJob);
      assert.ok(gate);
      const gatePayload = JSON.parse(gate.payload_json || "{}");
      assert.ok(gatePayload.gated_job_ids.includes(artificerJob.id));
      assert.ok(gatePayload.gated_job_ids.includes(promoteJob.id));
    } finally {
      queueMod.setSetting("plan_approval_mode", previousApproval || "");
    }
  });

  it("keeps PHP source-file creation as dev/code despite artifact-looking planner fields", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("PHP API", "desc", "normal", { mode: "build" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: PHP API",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Create PHP API deliverables",
      job_type: "artificer",
      task_mode: "report",
      task_spec: "Create the PHP API files as the implementation deliverable.",
      output_root: ".posse/resources/artifacts/wi-1",
      create_roots: [".posse/resources/artifacts/wi-1"],
      files_to_modify: [],
      files_to_create: ["api/index.php", "includes/Router.php"],
      success_criteria: ["PHP API files exist"],
      depends_on_index: [],
    }]);

    const created = queueMod.listJobsByWorkItem(wi.id).filter(j => j.id !== planJob.id && j.job_type !== "delegate");
    assert.equal(created.length, 1);
    assert.equal(created[0].job_type, "dev");

    const payload = JSON.parse(created[0].payload_json);
    assert.equal(payload.task_mode, "code");
    assert.equal(payload.needs_image_generation, false);
    assert.equal(payload.output_root, null);
    assert.deepEqual(payload.files_to_create, ["api/index.php", "includes/Router.php"]);
    assert.deepEqual(payload.create_roots, ["api", "includes"]);
  });

  it("splits repo image create outputs into artificer plus promote jobs", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Logo asset", "desc", "normal", { mode: "build" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Logo asset",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Create repo logo image",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Generate a logo image for the application.",
      files_to_modify: [],
      files_to_create: ["public/images/logo.png"],
      success_criteria: ["Logo image exists in public/images"],
      depends_on_index: [],
    }]);

    const created = queueMod.listJobsByWorkItem(wi.id).filter(j => j.id !== planJob.id && j.job_type !== "delegate");
    const artificerJob = created.find(j => j.job_type === "artificer");
    const promoteJob = created.find(j => j.job_type === "promote");
    assert.ok(artificerJob);
    assert.ok(promoteJob);
    assert.equal(created.some(j => j.job_type === "dev"), false);

    const artificerPayload = JSON.parse(artificerJob.payload_json);
    assert.equal(artificerPayload.task_mode, "image");
    assert.equal(artificerPayload.needs_image_generation, true);
    assert.ok(artificerPayload.files_to_create.some(file => file.endsWith("/logo.png")));

    const promotePayload = JSON.parse(promoteJob.payload_json);
    assert.deepEqual(promotePayload.mappings, [
      { pattern: "logo.png", dest: "public/images/logo.png", destination_type: "file" },
    ]);
    assert.deepEqual(promotePayload.files_to_create, ["public/images/logo.png"]);

    const promoteDeps = queueMod.getDependencies(promoteJob.id);
    assert.ok(promoteDeps.some(dep => dep.depends_on_job_id === artificerJob.id));
  });

  it("drops file-kind split groups atomically when they would cross planner_max_tasks", () => {
    const { queueMod, workerMod } = runtimeModules;
    const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-planner-cap-settings-"));
    try {
      withAccountSettingsPath(path.join(settingsDir, "account.db"), () => {
        queueMod.setSetting("planner_max_tasks", "2");
        const wi = queueMod.createWorkItem("Capped mixed output", "desc", "normal", { mode: "build" });
        const planJob = queueMod.createJob({
          work_item_id: wi.id,
          job_type: "plan",
          title: "Plan: capped mixed output",
        });
        const worker = new workerMod.Worker({
          projectDir: path.resolve(__dirname, ".."),
          silent: true,
        });

        worker.createJobsFromPlan(planJob, [
          {
            title: "Create normal helper",
            job_type: "dev",
            task_mode: "code",
            task_spec: "Create a normal helper file.",
            files_to_modify: [],
            files_to_create: ["src/normal-helper.js"],
            success_criteria: ["Normal helper exists"],
            depends_on_index: [],
          },
          {
            title: "Create repo logo image and helper",
            job_type: "dev",
            task_mode: "code",
            task_spec: "Generate a logo image and create helper code for the application.",
            files_to_modify: [],
            files_to_create: ["public/images/logo.png", "src/logo-helper.js"],
            success_criteria: ["Logo and helper exist"],
            depends_on_index: [],
          },
        ]);

        const created = queueMod.listJobsByWorkItem(wi.id).filter(j => j.id !== planJob.id && j.job_type !== "delegate");
        assert.equal(created.length, 1);
        assert.equal(created[0].job_type, "dev");
        assert.equal(JSON.parse(created[0].payload_json).files_to_create[0], "src/normal-helper.js");
        assert.equal(created.some(j => j.job_type === "artificer"), false);
        assert.equal(created.some(j => j.job_type === "promote"), false);
        const capEvent = queueMod.getEvents(null, 100).find((event) => event.event_type === "plan.task_capped");
        assert.ok(capEvent);
        assert.match(capEvent.message, /dropping the whole split group/);
        const eventJson = JSON.parse(capEvent.event_json);
        assert.equal(eventJson.reason, "file_kind_split");
        assert.equal(eventJson.split_task_count, 3);
      });
    } finally {
      fs.rmSync(settingsDir, { recursive: true, force: true });
    }
  });

  it("revalidates file-kind normalized tasks before creating jobs", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Invalid normalized create", "desc", "normal", { mode: "build" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: invalid normalized create",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    assert.throws(
      () => worker.createJobsFromPlan(planJob, [{
        title: "Create escaped source file",
        job_type: "artificer",
        task_mode: "image",
        task_spec: "Create a source file outside the repo.",
        files_to_create: ["../escape.js"],
        success_criteria: ["No escaped file is created"],
        depends_on_index: [],
      }]),
      /Planner plan contained no valid tasks after schema validation/,
    );

    const created = queueMod.listJobsByWorkItem(wi.id).filter(j => j.id !== planJob.id && j.job_type !== "delegate");
    assert.equal(created.length, 0);
    const invalidEvent = queueMod.getEvents(null, 100).find((event) => event.event_type === "plan.task_invalid");
    assert.ok(invalidEvent);
    assert.match(invalidEvent.message, /invalid rewritten planned task/i);
  });

  it("splits mixed PHP and image create scopes while preserving downstream dependencies", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Mixed API and logo", "desc", "normal", { mode: "build" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Mixed API and logo",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [
      {
        title: "Create PHP API and logo",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Create the PHP API and generate a logo image.",
        files_to_modify: [],
        files_to_create: ["api/index.php", "includes/Router.php", "public/images/logo.png"],
        success_criteria: ["API and logo exist"],
        depends_on_index: [],
      },
      {
        title: "Add API smoke test",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Add a smoke test after the API files exist.",
        files_to_modify: [],
        files_to_create: ["api/api.test.js"],
        success_criteria: ["Smoke test exists"],
        depends_on_index: [0],
      },
    ]);

    const created = queueMod.listJobsByWorkItem(wi.id).filter(j => j.id !== planJob.id && j.job_type !== "delegate");
    const artificerJob = created.find(j => j.job_type === "artificer");
    const promoteJob = created.find(j => j.job_type === "promote");
    const codeJob = created.find(j => j.title === "Code changes for: Create PHP API and logo");
    const downstreamJob = created.find(j => j.title === "Add API smoke test");
    assert.ok(artificerJob);
    assert.ok(promoteJob);
    assert.ok(codeJob);
    assert.ok(downstreamJob);

    const codePayload = JSON.parse(codeJob.payload_json);
    assert.deepEqual(codePayload.files_to_create, ["api/index.php", "includes/Router.php"]);
    assert.equal(codePayload.needs_image_generation, false);
    assert.equal(codePayload.output_root, null);

    const codeDeps = queueMod.getDependencies(codeJob.id);
    assert.ok(codeDeps.some(dep => dep.depends_on_job_id === promoteJob.id));

    const downstreamDeps = queueMod.getDependencies(downstreamJob.id);
    assert.ok(downstreamDeps.some(dep => dep.depends_on_job_id === codeJob.id));
    assert.ok(!downstreamDeps.some(dep => dep.depends_on_job_id === promoteJob.id));
    assert.ok(!downstreamDeps.some(dep => dep.depends_on_job_id === artificerJob.id));
  });

  it("wires planner dependencies that reference later tasks", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Forward dependency", "desc", "normal", { mode: "build" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Forward dependency",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [
      {
        title: "Use generated module",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Use the module after it exists.",
        files_to_modify: ["htdocs/learn/index.html"],
        success_criteria: ["Module is used"],
        depends_on_index: [1],
      },
      {
        title: "Create generated module",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Create the module first.",
        files_to_create: ["htdocs/learn/generated-module.js"],
        success_criteria: ["Module exists"],
        depends_on_index: [],
      },
    ]);

    const created = queueMod.listJobsByWorkItem(wi.id).filter(j => j.id !== planJob.id && j.job_type !== "delegate");
    const dependentJob = created.find(j => j.title === "Use generated module");
    const prerequisiteJob = created.find(j => j.title === "Create generated module");
    assert.ok(dependentJob);
    assert.ok(prerequisiteJob);

    const deps = queueMod.getDependencies(dependentJob.id);
    assert.ok(deps.some(dep => dep.depends_on_job_id === prerequisiteJob.id));
    const missingEvents = queueMod.getEvents(dependentJob.id, 100)
      .filter((event) => event.event_type === "plan.dependency_missing");
    assert.equal(missingEvents.length, 0);
  });

  it("rewrites pending forward dependencies when the target task splits", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Forward dependency split", "desc", "normal", { mode: "build" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Forward dependency split",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [
      {
        title: "Use generated API",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Wire the generated API after code and image assets are ready.",
        files_to_modify: ["htdocs/learn/index.html"],
        success_criteria: ["Generated API is wired"],
        depends_on_index: [1],
      },
      {
        title: "Create API and logo",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Create the API file and generate a logo image.",
        files_to_create: ["api/forward.php", "public/images/forward-logo.png"],
        success_criteria: ["API and logo exist"],
        depends_on_index: [],
      },
    ]);

    const created = queueMod.listJobsByWorkItem(wi.id).filter(j => j.id !== planJob.id && j.job_type !== "delegate");
    const dependentJob = created.find(j => j.title === "Use generated API");
    const codeJob = created.find(j => j.title === "Code changes for: Create API and logo");
    const promoteJob = created.find(j => j.job_type === "promote");
    const imageJob = created.find(j => j.job_type === "artificer");
    assert.ok(dependentJob);
    assert.ok(codeJob);
    assert.ok(promoteJob);
    assert.ok(imageJob);

    const dependentDeps = queueMod.getDependencies(dependentJob.id);
    assert.ok(dependentDeps.some(dep => dep.depends_on_job_id === codeJob.id));
    assert.ok(!dependentDeps.some(dep => dep.depends_on_job_id === promoteJob.id));
    assert.ok(!dependentDeps.some(dep => dep.depends_on_job_id === imageJob.id));
  });

  it("keeps mixed-task image generation from waiting on original repo-edit dependencies", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Parallel image branch", "desc", "normal", { mode: "build" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Parallel image branch",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [
      {
        title: "Prepare page structure",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Update the page shell first.",
        files_to_modify: ["htdocs/learn/index.html"],
        success_criteria: ["Page shell updated"],
        depends_on_index: [],
      },
      {
        title: "Wire page image",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Generate a hero image and wire it into the page.",
        files_to_modify: ["htdocs/learn/index.html"],
        files_to_create: ["htdocs/learn/img/hero.png"],
        success_criteria: ["Image generated and page references it"],
        depends_on_index: [0],
      },
    ]);

    const created = queueMod.listJobsByWorkItem(wi.id).filter(j => j.id !== planJob.id && j.job_type !== "delegate");
    const setupJob = created.find(j => j.title === "Prepare page structure");
    const imageJob = created.find(j => j.job_type === "artificer");
    const promoteJob = created.find(j => j.job_type === "promote");
    const codeJob = created.find(j => j.title === "Code changes for: Wire page image");
    assert.ok(setupJob);
    assert.ok(imageJob);
    assert.ok(promoteJob);
    assert.ok(codeJob);

    const imageDeps = queueMod.getDependencies(imageJob.id);
    assert.ok(!imageDeps.some(dep => dep.depends_on_job_id === setupJob.id), "image generation should not wait on unrelated repo-edit setup");

    const promoteDeps = queueMod.getDependencies(promoteJob.id);
    assert.ok(promoteDeps.some(dep => dep.depends_on_job_id === imageJob.id));

    const codeDeps = queueMod.getDependencies(codeJob.id);
    assert.ok(codeDeps.some(dep => dep.depends_on_job_id === setupJob.id));
    assert.ok(codeDeps.some(dep => dep.depends_on_job_id === promoteJob.id));
  });

  it("prevents duplicate promote jobs for the same destination files", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Duplicate promote guard", "desc", "normal", { mode: "build" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Duplicate promote guard",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [
      {
        title: "Generate admin console header banner image",
        job_type: "artificer",
        task_mode: "image",
        needs_image_generation: true,
        task_spec: "Generate admin-header-banner.png.",
        files_to_create: ["admin-header-banner.png"],
        success_criteria: ["banner exists"],
        depends_on_index: [],
      },
      {
        title: "Promote generated admin images into repo",
        job_type: "promote",
        mappings: [
          { pattern: "admin-header-banner.png", dest: "htdocs/assets/img/" },
          { pattern: "admin-empty-state.png", dest: "htdocs/assets/img/" },
        ],
        depends_on_index: [0],
      },
      {
        title: "Elevate admin header with banner image and fix back-link layout",
        job_type: "dev",
        task_mode: "image",
        needs_image_generation: true,
        task_spec: "Generate both admin images and wire them into the admin header.",
        files_to_modify: ["htdocs/admin.php"],
        files_to_create: [
          "htdocs/assets/img/admin-header-banner.png",
          "htdocs/assets/img/admin-empty-state.png",
        ],
        success_criteria: ["admin header uses promoted images"],
        depends_on_index: [1],
      },
    ]);

    const created = queueMod.listJobsByWorkItem(wi.id).filter(j => j.id !== planJob.id && j.job_type !== "delegate");
    const explicitPromote = created.find(j => j.title === "Promote generated admin images into repo");
    const splitPromote = created.find(j => j.title === "Promote images for: Elevate admin header with banner image and fix back-link layout");
    const splitImage = created.find(j => j.title === "Generate images for: Elevate admin header with banner image and fix back-link layout");
    const codeJob = created.find(j => j.title === "Code changes for: Elevate admin header with banner image and fix back-link layout");

    assert.ok(explicitPromote);
    assert.ok(splitPromote);
    assert.ok(splitImage);
    assert.ok(codeJob);
    assert.equal(explicitPromote.status, "canceled");
    assert.equal(splitPromote.status, "queued");

    const promoteDeps = queueMod.getDependencies(splitPromote.id);
    assert.deepEqual(promoteDeps.map(dep => dep.depends_on_job_id), [splitImage.id]);

    const codeDeps = queueMod.getDependencies(codeJob.id);
    assert.ok(codeDeps.some(dep => dep.depends_on_job_id === splitPromote.id));
    assert.ok(!codeDeps.some(dep => dep.depends_on_job_id === explicitPromote.id));

    const event = queueMod.getEvents(explicitPromote.id, 100)
      .find((row) => row.event_type === "job.dropped_duplicate_promote");
    assert.ok(event);
  });

  it("normalizes markdown artifact copy tasks into promote jobs", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Promote markdown report", "desc", "normal", { mode: "report" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Promote markdown report",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [
      {
        title: "Draft release notes",
        job_type: "artificer",
        task_mode: "report",
        task_spec: "Write release notes markdown.",
        success_criteria: ["notes exist"],
        depends_on_index: [],
      },
      {
        title: "Promote generated markdown notes to docs/releases",
        job_type: "dev",
        task_mode: "report",
        task_spec: "Copy the generated markdown deliverable from the artifact directory into docs/releases.",
        files_to_modify: [],
        files_to_create: ["docs/releases/release-notes.md"],
        create_roots: ["docs/releases"],
        success_criteria: ["Markdown report is copied into docs/releases"],
        depends_on_index: [0],
      },
    ]);

    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const promoteJob = jobs.find(j => j.job_type === "promote");
    assert.ok(promoteJob, "expected markdown artifact copy task to normalize into a promote job");

    const promotePayload = JSON.parse(promoteJob.payload_json);
    assert.deepEqual(promotePayload.mappings, [
      { pattern: "release-notes.md", dest: "docs/releases", destination_type: "directory" },
    ]);
  });

  it("ignores promote source_dir values that escape the artifact directory", () => {
    const projectDir = path.resolve(__dirname, "..");
    const artifactDirAbs = path.resolve(projectDir, ".posse/resources/artifacts/wi-test-promote");
    const promoted = inferPromoteTask({
      title: "Promote generated report",
      job_type: "dev",
      task_mode: "report",
      task_spec: "Copy the generated report from the artifact directory into docs/reports.",
      files_to_modify: [],
      files_to_create: ["docs/reports/status.md"],
      source_dir: "../../Windows/System32",
    }, artifactDirAbs);

    assert.ok(promoted);
    assert.equal(promoted.source_dir, artifactDirAbs);
  });

  it("normalizes root-relative promote destinations to the proved or active repo web root", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-promote-webroot-"));
    try {
      fs.mkdirSync(path.join(projectDir, "images"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "assets/img"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "htdocs/legacy/img"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "htdocs/legacy/img/sidereal-time.webp"), "existing", "utf-8");
      const artifactDirAbs = path.join(projectDir, ".posse/resources/artifacts/wi-test-promote");

      const promoted = normalizePromoteMappings({
        source_dir: artifactDirAbs,
        mappings: [
          { pattern: "music-banner-1.png", dest: "/images/music-banner-1.png" },
          { pattern: "root-structure.webp", dest: "/assets/img/root-structure.webp" },
          { pattern: "sidereal-time.webp", dest: "/legacy/img/sidereal-time.webp" },
          { pattern: "legacy-new.webp", dest: "/legacy/img/legacy-new.webp" },
        ],
      }, artifactDirAbs, { projectDir });

      assert.deepEqual(promoted.mappings, [
        { pattern: "music-banner-1.png", dest: "images/music-banner-1.png", destination_type: "file" },
        { pattern: "root-structure.webp", dest: "assets/img/root-structure.webp", destination_type: "file" },
        { pattern: "sidereal-time.webp", dest: "htdocs/legacy/img/sidereal-time.webp", destination_type: "file" },
        { pattern: "legacy-new.webp", dest: "htdocs/legacy/img/legacy-new.webp", destination_type: "file" },
      ]);
      assert.deepEqual(promoted.files_to_create, [
        "images/music-banner-1.png",
        "assets/img/root-structure.webp",
        "htdocs/legacy/img/legacy-new.webp",
      ]);
      assert.deepEqual(promoted.files_to_modify, ["htdocs/legacy/img/sidereal-time.webp"]);
      assert.deepEqual(promoted.create_roots, ["images", "assets/img", "htdocs/legacy/img"]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("drops ambiguous root-relative promote destinations but keeps new root-webroot directories", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-promote-no-guess-"));
    try {
      fs.mkdirSync(path.join(projectDir, "htdocs/assets/img"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "public/assets/img"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "public/assets/img/already.webp"), "public", "utf-8");
      const artifactDirAbs = path.join(projectDir, ".posse/resources/artifacts/wi-test-promote");

      const promoted = normalizePromoteMappings({
        source_dir: artifactDirAbs,
        mappings: [
          { pattern: "already.webp", dest: "public/assets/img/already.webp" },
          { pattern: "missing.webp", dest: "/assets/img/missing.webp" },
          { pattern: "ambiguous.webp", dest: "/assets/img/ambiguous.webp" },
          { pattern: "music-banner-N.png", dest: "/images/music-banner-N.png" },
          { pattern: "music-banner-1.png", dest: "/images/music-banner-1.png" },
        ],
      }, artifactDirAbs, { projectDir });

      assert.deepEqual(promoted.mappings, [
        { pattern: "already.webp", dest: "public/assets/img/already.webp", destination_type: "file" },
        { pattern: "music-banner-1.png", dest: "images/music-banner-1.png", destination_type: "file" },
      ]);
      assert.deepEqual(promoted.files_to_create, ["images/music-banner-1.png"]);
      assert.deepEqual(promoted.files_to_modify, ["public/assets/img/already.webp"]);
      assert.deepEqual(promoted.create_roots, ["images"]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("keeps root-relative promote jobs as repo-root creates in greenfield web-root mode", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-promote-root-webroot-"));
    try {
      const wi = queueMod.createWorkItem("Music banner", "desc", "normal", { mode: "build" });
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: Music banner",
      });
      const worker = new workerMod.Worker({
        projectDir,
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [{
        title: "Promote music banner images",
        job_type: "promote",
        source_dir: path.join(projectDir, ".posse/resources/artifacts/wi-5"),
        mappings: [
          { pattern: "music-banner-N.png", dest: "/images/music-banner-N.png" },
          { pattern: "music-banner-1.png", dest: "/images/music-banner-1.png" },
        ],
        depends_on_index: [],
      }]);

      const created = queueMod.listJobsByWorkItem(wi.id).filter(j => j.id !== planJob.id && j.job_type !== "delegate");
      assert.equal(created.length, 1);
      assert.equal(created[0].job_type, "promote");
      const payload = JSON.parse(created[0].payload_json);
      assert.deepEqual(payload.mappings, [
        { pattern: "music-banner-1.png", dest: "images/music-banner-1.png", destination_type: "file" },
      ]);
      assert.deepEqual(payload.files_to_create, ["images/music-banner-1.png"]);
      assert.deepEqual(payload.create_roots, ["images"]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("does not infer repo-authored markdown docs as promote tasks from incidental move language", () => {
    const projectDir = path.resolve(__dirname, "..");
    const artifactDirAbs = path.resolve(projectDir, ".posse/resources/artifacts/wi-test-style-plan");
    const promoted = inferPromoteTask({
      title: "Author Fiscal Wizard style plan (design system contract)",
      job_type: "dev",
      task_mode: "code",
      task_spec: [
        "Create docs/STYLE.md as the design contract that the rest of the visual overhaul implements.",
        "Document which existing classes move to which radius tier.",
        "The document must be specific enough that implementation tasks can read it once and execute deterministically.",
      ].join("\n"),
      files_to_modify: [],
      files_to_create: ["docs/STYLE.md"],
      success_criteria: ["docs/STYLE.md exists"],
      depends_on_index: [],
    }, artifactDirAbs);

    assert.equal(promoted, null);
  });

  it("keeps repo-bound markdown design contracts as dev jobs", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Fiscal Wizard style pass", "Create a repo-facing style plan.", "normal", {
      mode: "build",
      metadata: {
        intake_hints: {
          output_mode: "repo",
          desired_outputs: ["repo"],
          deliverable_type: "code",
        },
      },
    });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Fiscal Wizard style pass",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Author Fiscal Wizard style plan (design system contract)",
      job_type: "dev",
      task_mode: "code",
      task_spec: [
        "Create docs/STYLE.md as the design contract that the rest of the visual overhaul implements.",
        "Document which existing classes move to which radius tier.",
        "The document must define wizard tokens, table rules, image roles, and motion rules.",
      ].join("\n"),
      files_to_modify: [],
      files_to_create: ["docs/STYLE.md"],
      success_criteria: ["docs/STYLE.md exists"],
      depends_on_index: [],
    }]);

    const created = queueMod.listJobsByWorkItem(wi.id).filter(j => j.id !== planJob.id && j.job_type !== "delegate");
    assert.equal(created.length, 1);
    assert.equal(created[0].job_type, "dev");

    const payload = JSON.parse(created[0].payload_json);
    assert.equal(payload.task_mode, "code");
    assert.deepEqual(payload.files_to_create, ["docs/STYLE.md"]);
    assert.equal(payload.output_root, null);
  });

  it("normalizes json and csv artifact copy tasks into promote jobs", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Promote data artifacts", "desc", "normal", { mode: "report" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Promote data artifacts",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [
      {
        title: "Generate exports",
        job_type: "artificer",
        task_mode: "report",
        task_spec: "Write data exports.",
        success_criteria: ["exports exist"],
        depends_on_index: [],
      },
      {
        title: "Copy exports into data snapshots",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Copy the generated files into data/snapshots.",
        files_to_modify: [],
        files_to_create: ["data/snapshots/report.json", "data/snapshots/report.csv"],
        create_roots: ["data/snapshots"],
        success_criteria: ["Exports are copied into data/snapshots"],
        depends_on_index: [0],
      },
    ]);

    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const promoteJob = jobs.find(j => j.job_type === "promote");
    assert.ok(promoteJob, "expected json/csv artifact copy task to normalize into a promote job");

    const promotePayload = JSON.parse(promoteJob.payload_json);
    assert.deepEqual(promotePayload.mappings, [
      { pattern: "report.json", dest: "data/snapshots", destination_type: "directory" },
      { pattern: "report.csv", dest: "data/snapshots", destination_type: "directory" },
    ]);
  });

  it("rebases artifact files_to_create into the scoped output_root", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Scoped report artifact paths", "desc", "normal", { mode: "report" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Scoped report artifact paths",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [
      {
        title: "Bug report",
        job_type: "artificer",
        task_mode: "report",
        task_spec: "Write bug-report.md",
        files_to_modify: [],
        files_to_create: [".posse/resources/artifacts/wi-999/bug-report.md"],
        create_roots: [],
        success_criteria: ["bug-report.md exists"],
        depends_on_index: [],
      },
    ]);

    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const reportJob = jobs.find(j => j.job_type === "artificer");
    assert.ok(reportJob);

    const payload = JSON.parse(reportJob.payload_json);
    assert.ok(payload.output_root.includes(`/wi-${wi.id}/task-01-bug-report`));
    assert.deepEqual(payload.files_to_create, [`${payload.output_root}/bug-report.md`]);
    assert.deepEqual(payload.create_roots, [payload.output_root]);
  });

  it("normalizes promote file destinations into exact create files plus parent roots", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Promote exact files", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Promote exact files",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [
      {
        title: "Promote hero image",
        job_type: "promote",
        mappings: [{ pattern: "hero-bg.png", dest: "htdocs/images/hero-bg.png" }],
        depends_on_index: [],
      },
    ]);

    const promoteJob = queueMod.listJobsByWorkItem(wi.id).find(j => j.job_type === "promote");
    assert.ok(promoteJob);
    const promotePayload = JSON.parse(promoteJob.payload_json);
    assert.deepEqual(promotePayload.files_to_create, ["htdocs/images/hero-bg.png"]);
    assert.deepEqual(promotePayload.create_roots, ["htdocs/images"]);
    assert.deepEqual(promotePayload.mappings, [
      { pattern: "hero-bg.png", dest: "htdocs/images/hero-bg.png", destination_type: "file" },
    ]);
  });

  it("stores planner prompt and response artifacts even when planning output is unparsable", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Planner artifact capture", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Planner artifact capture",
    });
    const worker = makeWorker(workerMod, {
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    }, async () => ({ output: "this is not json" }));
    worker.repairJson = async () => null;

    await assert.rejects(
      dispatchWorker(worker, planJob, "standard", null),
      /Planner output could not be parsed as a JSON task array/
    );

    // Single call (planner has tools now — no strict retry loop)
    const prompts = queueMod.getArtifacts(planJob.id, "prompt");
    const responses = queueMod.getArtifacts(planJob.id, "response");
    assert.equal(prompts.length, 1);
    assert.equal(responses.length, 1);
    assert.match(responses[0].content_long, /this is not json/);
  });

  it("falls through to repair when planner output is not JSON", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Planner repair fallback", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Planner repair fallback",
    });
    const worker = makeWorker(workerMod, {
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    }, async () => ({ output: "Here is the plan in prose, not JSON." }));

    // repairJson salvages the output into a valid task array
    let repairCalled = false;
    worker.repairJson = async () => {
      repairCalled = true;
      return [
        {
          title: "Touch config",
          task_spec: "Update config/app.json with the requested setting.",
          job_type: "dev",
          model_tier: "cheap",
          files_to_modify: ["config/app.json"],
          success_criteria: ["config/app.json includes the requested setting"],
          depends_on_index: [],
        },
      ];
    };

    await dispatchWorker(worker, planJob, "standard", null);

    assert.ok(repairCalled, "repair should be called when planner output is not JSON");
    const jobs = queueMod.listJobsByWorkItem(wi.id);
    assert.ok(jobs.some(j => j.id !== planJob.id && j.job_type === "dev"));
  });

  it("includes planner output classification when strict retry and repair both fail", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Planner failure class", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Planner failure class",
    });
    const worker = makeWorker(workerMod, {
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    }, async () => ({ output: "Still prose, still not JSON." }));
    worker.repairJson = async () => null;

    await assert.rejects(
      dispatchWorker(worker, planJob, "standard", null),
      /class=prose_or_no_json/
    );
  });

  it("drops invalid planned tasks instead of creating malformed jobs", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Task validation", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Task validation",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [
      {
        title: "Broken promote",
        job_type: "promote",
        depends_on_index: [],
      },
      {
        title: "Protected promote destination",
        job_type: "promote",
        mappings: [{ pattern: "hero.png", dest: ".git/hooks/hero.png" }],
        depends_on_index: [],
      },
      {
        title: "Broken HTML filename",
        job_type: "dev",
        task_spec: "Create the nav auth placeholder file.",
        files_to_modify: [],
        files_to_create: ["auth\"></div>"],
        success_criteria: ["The placeholder exists"],
        depends_on_index: [],
      },
      {
        title: "Valid dev task",
        job_type: "dev",
        task_spec: "Update src/app.js.",
        files_to_modify: ["src/app.js"],
        files_to_create: [],
        success_criteria: ["src/app.js is updated"],
        depends_on_index: [],
      },
    ]);

    const jobs = queueMod.listJobsByWorkItem(wi.id);
    const created = jobs.filter(j => j.id !== planJob.id && j.job_type !== "delegate");
    assert.equal(created.length, 1);
    assert.equal(created[0].title, "Valid dev task");
    assert.equal(created.some(j => j.title === "Broken HTML filename"), false);
    assert.equal(created.some(j => j.title === "Protected promote destination"), false);
  });

  it("fails planning when every task is rejected by schema validation", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("All invalid tasks", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: All invalid tasks",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    assert.throws(
      () => worker.createJobsFromPlan(planJob, [{ title: "Broken promote", job_type: "promote" }]),
      /no valid tasks after schema validation/
    );
  });

  it("scopes sibling artifact tasks to distinct per-task output roots", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Scoped image outputs", "desc", "normal", { mode: "image" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Scoped image outputs",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [
      {
        title: "Splash hero cyberpunk",
        job_type: "artificer",
        task_mode: "image",
        task_spec: "Generate hero image",
        output_root: ".posse/resources/artifacts/wi-1",
        create_roots: [".posse/resources/artifacts/wi-1"],
        files_to_modify: [],
        files_to_create: [],
        success_criteria: ["done"],
        depends_on_index: [],
      },
      {
        title: "Dashboard card icons",
        job_type: "artificer",
        task_mode: "image",
        task_spec: "Generate icon set",
        output_root: ".posse/resources/artifacts/wi-1",
        create_roots: [".posse/resources/artifacts/wi-1"],
        files_to_modify: [],
        files_to_create: [],
        success_criteria: ["done"],
        depends_on_index: [],
      },
    ]);

    const created = queueMod.listJobsByWorkItem(wi.id).filter(j => j.id !== planJob.id && j.job_type !== "delegate");
    assert.equal(created.length, 2);

    const payloads = created.map((job) => JSON.parse(job.payload_json));
    assert.notEqual(payloads[0].output_root, payloads[1].output_root);
    assert.notDeepEqual(payloads[0].create_roots, payloads[1].create_roots);
    assert.match(payloads[0].output_root, /task-01-splash-hero-cyberpunk$/);
    assert.match(payloads[1].output_root, /task-02-dashboard-card-icons$/);
  });

  it("keeps repo integration code tasks as dev jobs inside image-mode work items", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Logo integration", "desc", "normal", { mode: "image" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Logo integration",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Integrate logo into HTML, JS, and CSS",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Wire the promoted logo into the site header and navbar styles.",
      files_to_modify: ["htdocs/index.html", "htdocs/css/main.css"],
      success_criteria: ["Site header uses the promoted logo"],
      depends_on_index: [],
    }]);

    const created = queueMod.listJobsByWorkItem(wi.id).find((job) => job.id !== planJob.id && job.job_type !== "delegate");
    assert.ok(created);
    assert.equal(created.job_type, "dev");
    const payload = JSON.parse(created.payload_json);
    assert.equal(payload.task_mode, "code");
    assert.deepEqual(payload.files_to_modify, ["htdocs/index.html", "htdocs/css/main.css"]);
    assert.equal(payload.output_root, null);
  });

  it("reroutes artifact-like data collection tasks to artificer/report in build work items", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Officials data research", "desc", "normal", { mode: "build" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Officials data research",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Elected officials data - Vermont",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Research Vermont elected officials and write a JSON dataset artifact.",
      files_to_modify: [],
      output_root: ".posse/resources/artifacts/wi-1",
      create_roots: [".posse/resources/artifacts/wi-1"],
      files_to_create: [".posse/resources/artifacts/wi-1/vermont.json"],
      success_criteria: ["A JSON dataset artifact exists for Vermont officials"],
      depends_on_index: [],
    }]);

    const created = queueMod.listJobsByWorkItem(wi.id).find((job) => job.id !== planJob.id && job.job_type !== "delegate");
    assert.ok(created);
    assert.equal(created.job_type, "artificer");
    const payload = JSON.parse(created.payload_json);
      assert.equal(payload.task_mode, "report");
      assert.ok(payload.output_root.includes(`/wi-${wi.id}/task-01-elected-officials-data-vermont`));
      assert.deepEqual(payload.files_to_modify, []);
    });

  it("reroutes dev image-generation tasks to artificer/image", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Image route guard", "Ensure image tasks do not run in dev.", "normal", { mode: "build" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Image route guard",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Generate logo variants",
      job_type: "dev",
      task_mode: "code",
      needs_image_generation: true,
      task_spec: "Generate 3 logo image variants for brand exploration.",
      files_to_modify: [],
      files_to_create: [],
      success_criteria: ["Logo variants exist as artifacts"],
      depends_on_index: [],
    }]);

    const created = queueMod.listJobsByWorkItem(wi.id).find((job) => job.id !== planJob.id && job.job_type !== "delegate");
    assert.ok(created);
    assert.equal(created.job_type, "artificer");
    const payload = JSON.parse(created.payload_json);
    assert.equal(payload.task_mode, "image");
    assert.equal(payload.needs_image_generation, true);
  });

  it("reroutes structured data repo transforms to artificer with a promote follow-up", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Unified state dataset", "desc", "normal", { mode: "build" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Unified state dataset",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Regenerate unified state contact dataset",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Regenerate and normalize the unified state contact dataset from artifact sources into the final JSON.",
      files_to_modify: ["data/state_office_contacts.json"],
      files_to_create: [],
      success_criteria: ["Unified state contact dataset is refreshed"],
      depends_on_index: [],
    }, {
      title: "Publish dataset summary",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Update the summary after the dataset refresh completes.",
      files_to_modify: ["docs/dataset-summary.md"],
      files_to_create: [],
      success_criteria: ["Summary reflects the new dataset"],
      depends_on_index: [0],
    }]);

    const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id && job.job_type !== "delegate");
    const artificerJob = created.find((job) => job.job_type === "artificer");
    const promoteJob = created.find((job) => job.job_type === "promote");
    const downstreamJob = created.find((job) => job.title === "Publish dataset summary");
    assert.ok(artificerJob);
    assert.ok(promoteJob);
    assert.ok(downstreamJob);

    const artificerPayload = JSON.parse(artificerJob.payload_json);
    assert.equal(artificerPayload.task_mode, "content");
    assert.deepEqual(artificerPayload.files_to_modify, []);
    assert.ok(artificerPayload.files_to_create.some((file) => file.endsWith("/state_office_contacts.json")));

    const promotePayload = JSON.parse(promoteJob.payload_json);
    assert.ok(Array.isArray(promotePayload.mappings));
    assert.ok(promotePayload.mappings.some((mapping) => mapping.pattern === "state_office_contacts.json" && mapping.dest === "data/state_office_contacts.json"));
    assert.equal(promotePayload.source_dir, artificerPayload.output_root);
    assert.deepEqual(promotePayload.files_to_modify, ["data/state_office_contacts.json"]);

    const deps = queueMod.getDependencies(promoteJob.id);
    assert.ok(deps.some((dep) => dep.depends_on_job_id === artificerJob.id));

    const downstreamDeps = queueMod.getDependencies(downstreamJob.id);
    assert.ok(downstreamDeps.some((dep) => dep.depends_on_job_id === promoteJob.id));
    assert.ok(!downstreamDeps.some((dep) => dep.depends_on_job_id === artificerJob.id));
  });

  it("keeps planner image tasks in artificer/image even with repo design hints", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Viewer design refinement", "Clarify the boundaries between the panels and the background in the viewer.", "normal", {
      mode: "build",
      metadata: {
        intake_hints: {
          intent_type: "task",
          deliverable_type: "code",
          output_mode: "repo",
          suspected_dirs: ["www/livevane.com/htdocs", "www/livevane.com/htdocs/css"],
          subtasks: ["design polish in repo"],
        },
      },
    });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Viewer design refinement",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    withEnv({ OPENAI_API_KEY: "test-key" }, () => {
      worker.createJobsFromPlan(planJob, [{
        title: "Clarify cyberpunk viewer boundaries",
        job_type: "artificer",
        task_mode: "image",
        task_spec: "Clarify the boundaries between the panels and the background. Match the main page background in the viewer and admin surfaces rather than generating a new mockup.",
        files_to_modify: [],
        files_to_create: [],
        success_criteria: ["Viewer background and panels feel clearly separated in the repo UI"],
        depends_on_index: [],
      }]);
    });

    const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id && job.job_type !== "delegate");
    assert.equal(created.length, 1);
    const routed = created[0];
    assert.equal(routed.job_type, "artificer");
    const payload = JSON.parse(routed.payload_json);
    assert.equal(payload.task_mode, "image");
    assert.equal(payload.needs_image_generation, true);
    assert.ok(payload.output_root);
    assert.deepEqual(payload.create_roots, [payload.output_root]);
  });

  it("does not let explicit output_mode=repo downgrade planner image tasks", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Repo-bound visual polish", "Adjust the hero treatment in the real site.", "normal", {
      mode: "build",
      metadata: {
        intake_hints: {
          output_mode: "repo",
          deliverable_type: "code",
        },
      },
    });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Repo-bound visual polish",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    withEnv({ OPENAI_API_KEY: "test-key" }, () => {
      worker.createJobsFromPlan(planJob, [{
        title: "Create hero image treatment in the real site",
        job_type: "artificer",
        task_mode: "image",
        task_spec: "Create a stronger hero image treatment by refining the real viewer and admin surfaces in the repo. Do not make a separate mockup artifact.",
        files_to_modify: [],
        files_to_create: [],
        success_criteria: ["The real repo UI is refined without generating a separate artifact deliverable"],
        depends_on_index: [],
      }]);
    });

    const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id && job.job_type !== "delegate");
    assert.equal(created.length, 1);
    const routed = created[0];
    assert.equal(routed.job_type, "artificer");
    const payload = JSON.parse(routed.payload_json);
    assert.equal(payload.task_mode, "image");
    assert.equal(payload.needs_image_generation, true);
    assert.ok(payload.output_root);
    assert.deepEqual(payload.create_roots, [payload.output_root]);
  });

  it("preserves artificer/report when WI binds output_mode=artifact even if the spec looks like a 'repo design' task", () => {
    // Regression for the 2026-04-23 spirit run: the planner correctly emitted
    // {job_type: artificer, task_mode: report} for a plan-artifact task whose
    // spec mentions "admin" repeatedly. The hinted-repo-design heuristic
    // matches the word "admin" in both designIntent and repoSurface regexes
    // and downgraded the task to dev/code, nulling output_root. The explicit
    // intake binding (output_mode=artifact) must win over that heuristic.
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem(
      "Make an implementation plan to upgrade the admin area",
      "Plan work across the admin area — produce a single master plan document.",
      "normal",
      {
        mode: "build",
        metadata: {
          intake_hints: {
            intent_type: "report",
            deliverable_type: "code",  // the offending contradictory tag from the real run
            output_mode: "artifact",
            desired_outputs: ["artifact"],
          },
        },
      },
    );
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: admin tools implementation plan",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Generate admin-tools implementation plan artifact",
      job_type: "artificer",
      task_mode: "report",
      output_root: "/tmp/posse-test-artifacts/wi-1",
      create_roots: ["/tmp/posse-test-artifacts/wi-1"],
      files_to_modify: [],
      files_to_create: ["/tmp/posse-test-artifacts/wi-1/admin-tools-implementation-plan.md"],
      task_spec: "Produce the master implementation plan for admin tools as a markdown artifact. Cover admin middleware, admin audit log, admin UI, admin endpoints, and PR sequence.",
      success_criteria: ["admin-tools-implementation-plan.md exists and is non-empty"],
      depends_on_index: [],
    }]);

    const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id && job.job_type !== "delegate");
    assert.equal(created.length, 1);
    const routed = created[0];
    assert.equal(routed.job_type, "artificer", "explicit output_mode=artifact must preserve artificer");
    const payload = JSON.parse(routed.payload_json);
    assert.equal(payload.task_mode, "report", "task_mode must remain 'report' for an artifact deliverable");
    assert.ok(payload.output_root, "output_root must survive (pointed at the artifact dir)");
  });

  it("preserves explicit image-generation artificer tasks even with output_mode=repo", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Repo output with generated hero", "Generate assets and wire them in.", "normal", {
      mode: "build",
      metadata: {
        intake_hints: {
          output_mode: "repo",
          deliverable_type: "code",
        },
      },
    });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Repo output with generated hero",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Generate branded hero artwork",
      job_type: "artificer",
      task_mode: "image",
      needs_image_generation: true,
      task_spec: "Generate a branded hero image artifact for the landing page.",
      files_to_modify: [],
      files_to_create: [],
      success_criteria: ["Hero artwork exists as an artifact output"],
      depends_on_index: [],
    }]);

    const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id && job.job_type !== "delegate");
    assert.equal(created.length, 1);
    const routed = created[0];
    assert.equal(routed.job_type, "artificer");
    const payload = JSON.parse(routed.payload_json);
    assert.equal(payload.task_mode, "image");
    assert.equal(payload.needs_image_generation, true);
  });

  it("reroutes zero-scope repo-bound code tasks to artificer/report for intermediate evidence", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Repo-bound smoke test", "Verify the fix and then finish the repo work.", "normal", {
      mode: "build",
      metadata: {
        intake_hints: {
          output_mode: "auto",
          desired_outputs: ["repo"],
          deliverable_type: "code",
        },
      },
    });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Repo-bound smoke test",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Smoke test admin page after JSX fix",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Run the admin smoke test and capture observations.",
      files_to_modify: [],
      files_to_create: [],
      files_to_delete: [],
      create_roots: [],
      success_criteria: ["The smoke test evidence is captured"],
      depends_on_index: [],
    }]);

    const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id && job.job_type !== "delegate");
    assert.equal(created.length, 1);
    assert.equal(created[0].job_type, "artificer");
    const payload = JSON.parse(created[0].payload_json);
    assert.equal(payload.task_mode, "report");
    assert.equal(payload.files_to_modify.length, 0);
    assert.equal(payload.files_to_create.length, 1);
    assert.match(payload.files_to_create[0], /report\.md$/);
  });

  it("drops under-scoped code tasks when research identifies many candidate files", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Sweep site pages", "Update all pages for event details", "normal", { mode: "build" });
    const researchJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: Sweep site pages",
    });
    queueMod.updateJobStatus(researchJob.id, "succeeded");
    queueMod.storeArtifact({
      work_item_id: wi.id,
      job_id: researchJob.id,
      attempt_id: null,
      artifact_type: "response",
      content_long: `\`\`\`json\n${JSON.stringify({
        key_files: [
          "index.html",
          "pages/events/a.html",
          "pages/events/b.html",
          "pages/events/c.html",
          "pages/events/d.html",
        ],
        related_files: [],
        patterns: {},
        constraints: [],
        questions_for_human: false,
        questions: [],
      }, null, 2)}\n\`\`\``,
    });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Sweep site pages",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    assert.throws(() => worker.createJobsFromPlan(planJob, [{
      title: "Apply event updates across pages",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Update all site pages with the new event details.",
      files_to_modify: [],
      files_to_create: [],
      files_to_delete: [],
      create_roots: ["."],
      success_criteria: ["All pages updated"],
      depends_on_index: [],
    }]), /no valid tasks after schema validation/i);

    const updatedPlanJob = queueMod.getJob(planJob.id);
    const planPayload = JSON.parse(updatedPlanJob.payload_json || "{}");
    assert.equal(planPayload.deepthink, true);
    assert.equal(planPayload._planner_scope_recovery_reason, "under_scoped_code_tasks");
    const wiEvents = queueMod.getEventsByWorkItem(wi.id);
    assert.ok(wiEvents.some((evt) => evt.event_type === "plan.recovery_escalated"));
  });

  it("warns but keeps broad narrow-scope code tasks when planner_under_scoped_broad_gate=warn", () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousGateMode = queueMod.getSetting("planner_under_scoped_broad_gate");
    queueMod.setSetting("planner_under_scoped_broad_gate", "warn");
    try {
      const wi = queueMod.createWorkItem("UI cleanup", "Polish overall UI flow and form behavior across pages", "normal", { mode: "build" });
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: UI cleanup",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [{
        title: "Sitewide UI polish sweep",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Audit and polish overall page flow and form UX.",
        files_to_modify: ["htdocs/workshop.html"],
        files_to_create: [],
        files_to_delete: [],
        create_roots: [],
        success_criteria: ["UI updates complete"],
        depends_on_index: [],
      }]);

      const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.parent_job_id === planJob.id && job.job_type === "dev");
      assert.equal(created.length, 1);
      const wiEvents = queueMod.getEventsByWorkItem(wi.id);
      assert.ok(wiEvents.some((evt) => evt.event_type === "plan.task_scope_warning"));
    } finally {
      queueMod.setSetting("planner_under_scoped_broad_gate", previousGateMode);
    }
  });

  it("drops broad narrow-scope code tasks when planner_under_scoped_broad_gate=enforce", () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousGateMode = queueMod.getSetting("planner_under_scoped_broad_gate");
    queueMod.setSetting("planner_under_scoped_broad_gate", "enforce");
    try {
      const wi = queueMod.createWorkItem("Cross-page polish", "Overall polish across pages", "normal", { mode: "build" });
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: Cross-page polish",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      assert.throws(() => worker.createJobsFromPlan(planJob, [{
        title: "Overall sitewide polish",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Review all pages and polish UX flows end-to-end.",
        files_to_modify: [],
        files_to_create: [],
        files_to_delete: [],
        create_roots: ["htdocs"],
        success_criteria: ["Polish complete"],
        depends_on_index: [],
      }]), /no valid tasks after schema validation/i);

      const updatedPlanJob = queueMod.getJob(planJob.id);
      const planPayload = JSON.parse(updatedPlanJob.payload_json || "{}");
      assert.equal(planPayload.deepthink, true);
      assert.equal(planPayload._planner_scope_recovery_reason, "under_scoped_code_tasks");
      const wiEvents = queueMod.getEventsByWorkItem(wi.id);
      assert.ok(wiEvents.some((evt) => evt.event_type === "plan.task_invalid" && /broad task with narrow writable scope/i.test(evt.message || "")));
      assert.ok(wiEvents.some((evt) => evt.event_type === "plan.recovery_escalated"));
    } finally {
      queueMod.setSetting("planner_under_scoped_broad_gate", previousGateMode);
    }
  });

  it("aggregates scope/context hygiene signals from existing event names", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Metrics WI", "desc", "normal", { mode: "build" });
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Metrics WI",
    });
    queueMod.logEvent({
      work_item_id: wi.id,
      job_id: job.id,
      event_type: "plan.task_invalid",
      actor_type: "system",
      message: "Dropped under-scoped code task \"x\": research identified 6 candidate files but files_to_modify/files_to_create are both empty",
      event_json: JSON.stringify({ reason: "research_candidates_missing_scope", research_candidate_count: 6 }),
    });
    queueMod.logEvent({
      work_item_id: wi.id,
      job_id: job.id,
      event_type: "plan.recovery_escalated",
      actor_type: "system",
      message: "Escalated planner retry after under-scoped task drop(s)",
    });
    queueMod.logEvent({
      work_item_id: wi.id,
      job_id: job.id,
      event_type: "job.scope_cleaned_noop",
      actor_type: "worker",
      message: "scope cleaned to noop",
    });
    queueMod.logEvent({
      work_item_id: wi.id,
      job_id: job.id,
      event_type: "scheduler.scope_would_have_conflicted",
      actor_type: "scheduler",
      message: "Relaxed root overlap allowed; strict mode would block",
    });

    queueMod.flushEventsNow?.();
    const metrics = queueMod.getScopeContextHealthMetrics({ trailingDays: 30 });
    assert.equal(metrics.all_time.under_scoped_drops, 1);
    assert.equal(metrics.all_time.recovery_escalations, 1);
    assert.equal(metrics.all_time.scope_cleaned_noops, 1);
    assert.equal(metrics.all_time.strict_shadow_conflicts, 1);
    assert.equal(metrics.trailing.under_scoped_drops, 1);
    assert.equal(metrics.trailing.recovery_escalations, 1);
    assert.equal(metrics.trailing.scope_cleaned_noops, 1);
    assert.equal(metrics.trailing.strict_shadow_conflicts, 1);
  });

  it("drops dependents when a prerequisite task is dropped", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Dropped dependency", "Do dependent work", "normal", { mode: "build" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Dropped dependency",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    assert.throws(() => worker.createJobsFromPlan(planJob, [
      {
        title: "Unsafe broad setup",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Prepare files broadly.",
        files_to_modify: [],
        files_to_create: [],
        files_to_delete: [],
        create_roots: ["."],
        success_criteria: ["setup complete"],
        depends_on_index: [],
      },
      {
        title: "Use setup result",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Use the setup result.",
        files_to_modify: ["src/uses-setup.js"],
        files_to_create: [],
        files_to_delete: [],
        create_roots: [],
        success_criteria: ["uses setup"],
        depends_on_index: [0],
      },
    ]), /no valid tasks after schema validation/i);

    const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.parent_job_id === planJob.id);
    assert.equal(created.length, 0);
    const events = queueMod.getEventsByWorkItem(wi.id, 20);
    assert.ok(events.some((event) => event.event_type === "plan.task_invalid" && /Dropped dependent planned task/.test(event.message || "")));
  });

  it("rejects artificer tasks that target the repo root as an output scope", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Unsafe artifact root", "Generate broad artifacts", "normal", { mode: "report" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Unsafe artifact root",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    assert.throws(() => worker.createJobsFromPlan(planJob, [{
      title: "Write broad report",
      job_type: "artificer",
      task_mode: "report",
      task_spec: "Write report outputs.",
      output_root: ".",
      create_roots: ["."],
      files_to_create: ["report.md"],
      success_criteria: ["report written"],
      depends_on_index: [],
    }]), /no valid tasks after schema validation/i);

    const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.parent_job_id === planJob.id);
    assert.equal(created.length, 0);
    const events = queueMod.getEventsByWorkItem(wi.id, 20);
    assert.ok(events.some((event) => event.event_type === "plan.scope_rejected" && /broad create\/output root/i.test(event.message || "")));
  });

  it("keeps code tasks with files_to_create when research identifies many candidate files", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Create missing page", "Add a new event page", "normal", { mode: "build" });
    const researchJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: Create missing page",
    });
    queueMod.updateJobStatus(researchJob.id, "succeeded");
    queueMod.storeArtifact({
      work_item_id: wi.id,
      job_id: researchJob.id,
      attempt_id: null,
      artifact_type: "response",
      content_long: `\`\`\`json\n${JSON.stringify({
        key_files: [
          "index.html",
          "pages/events/a.html",
          "pages/events/b.html",
          "pages/events/c.html",
          "pages/events/d.html",
        ],
        related_files: [],
        patterns: {},
        constraints: [],
        questions_for_human: false,
        questions: [],
      }, null, 2)}\n\`\`\``,
    });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Create missing page",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Create new event page",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Create pages/events/new.html and wire it into navigation.",
      files_to_modify: [],
      files_to_create: ["pages/events/new.html"],
      files_to_delete: [],
      create_roots: ["pages/events"],
      success_criteria: ["New page exists and is linked"],
      depends_on_index: [],
    }]);

    const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.parent_job_id === planJob.id && job.job_type === "dev");
    assert.equal(created.length, 1);
    const payload = JSON.parse(created[0].payload_json);
    assert.deepEqual(payload.files_to_create, ["pages/events/new.html"]);
  });

  it("forwards planner complexity and risk scores from plan tasks into dev jobs", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Propagate planner scores", "Ensure complexity and risk are forwarded");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Propagate planner scores",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Implement scoring propagation",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Touch one file.",
      files_to_modify: ["lib/domains/worker/classes/Worker.js"],
      files_to_create: [],
      files_to_delete: [],
      create_roots: [],
      complexity: "5",
      risk: 4,
      success_criteria: ["done"],
      depends_on_index: [],
    }]);

    const created = queueMod.listJobsByWorkItem(wi.id).find((job) => job.parent_job_id === planJob.id && job.job_type === "dev");
    assert.ok(created);
    assert.equal(created.planner_complexity_score, 5);
    assert.equal(created.planner_risk_score, 4);
    const payload = JSON.parse(created.payload_json || "{}");
    assert.equal(payload.planner_complexity_score, 5);
    assert.equal(payload.planner_risk_score, 4);
  });

  it("uses declared scope breadth to raise dev turn budget without forcing strong model", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Scope budget", "Touch many files with low risk");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Scope budget",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Mechanical copy update",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Apply a mechanical label update across scoped files.",
      files_to_modify: Array.from({ length: 10 }, (_, index) => `lib/scope/file-${index}.js`),
      files_to_create: [],
      files_to_delete: [],
      create_roots: [],
      risk: 1,
      scope_confidence: "high",
      test_command: "npm run test:quick",
      success_criteria: ["labels updated"],
      depends_on_index: [],
    }]);

    const created = queueMod.listJobsByWorkItem(wi.id).find((job) => job.parent_job_id === planJob.id && job.job_type === "dev");
    assert.ok(created);
    assert.equal(created.model_tier, "standard");
    const payload = JSON.parse(created.payload_json || "{}");
    assert.equal(payload._max_turns_override, 36);
    assert.equal(payload._execution_policy.structural_facts.scope_file_count, 10);
  });

  it("uses planner risk to raise assessor policy for one-file tasks", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Risk policy", "Change auth behavior");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Risk policy",
    });
    const worker = new workerMod.Worker({
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    });

    worker.createJobsFromPlan(planJob, [{
      title: "Adjust auth check",
      job_type: "dev",
      task_mode: "code",
      task_spec: "Update auth permission handling in one file.",
      files_to_modify: ["lib/domains/auth/functions/policy.js"],
      files_to_create: [],
      files_to_delete: [],
      create_roots: [],
      risk: 5,
      risk_tags: ["auth"],
      scope_confidence: "high",
      verification_difficulty: 3,
      test_command: "npm run test:auth:fast",
      success_criteria: ["auth tests pass"],
      depends_on_index: [],
    }]);

    const created = queueMod.listJobsByWorkItem(wi.id).find((job) => job.parent_job_id === planJob.id && job.job_type === "dev");
    assert.ok(created);
    assert.equal(created.planner_risk_score, 5);
    assert.equal(created.planner_failure_cost_score, 3);
    const payload = JSON.parse(created.payload_json || "{}");
    assert.equal(payload._assess_model_tier, "strong");
    assert.equal(payload._assess_reasoning_effort, "high");
    assert.equal(payload._assess_pass_confidence_floor, "high");
    assert.equal(payload.risk_tags.includes("auth"), true);
  });

    it("keeps repo HTML creation as a dev/code task even if planner emits artifact fields", () => {
      const { queueMod, workerMod } = runtimeModules;
      const wi = queueMod.createWorkItem("Create homepage", "Create an index.html homepage", "normal", { mode: "build" });
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: Create homepage",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [{
        title: "Create index.html homepage",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Create an index.html file for the homepage of this site.",
        files_to_modify: [],
        output_root: ".posse/resources/artifacts/wi-1",
        create_roots: [],
        files_to_create: ["index.html"],
        success_criteria: ["index.html exists in the repo root"],
        depends_on_index: [],
      }]);

      const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id && job.job_type !== "delegate");

      assert.equal(created.length, 1);
      assert.equal(created[0].job_type, "dev");
      const payload = JSON.parse(created[0].payload_json);
      assert.equal(payload.task_mode, "code");
      assert.equal(payload.output_root, null);
      assert.deepEqual(payload.files_to_create, ["index.html"]);
    });

    it("keeps repo HTML page creation on dev even when planner mislabels it as content", () => {
      const { queueMod, workerMod } = runtimeModules;
      const wi = queueMod.createWorkItem("Create login page", "Create a login.html page", "normal", { mode: "build" });
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: Create login page",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [{
        title: "Create login.html",
        job_type: "dev",
        task_mode: "content",
        task_spec: "Create login.html for the site login page.",
        files_to_modify: [],
        output_root: ".posse/resources/artifacts/wi-1",
        create_roots: [".posse/resources/artifacts/wi-1"],
        files_to_create: ["login.html"],
        success_criteria: ["login.html exists in the repo root"],
        depends_on_index: [],
      }]);

      const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id && job.job_type !== "delegate");
      assert.equal(created.length, 1);
      assert.equal(created[0].job_type, "dev");
      const payload = JSON.parse(created[0].payload_json);
      assert.equal(payload.task_mode, "code");
      assert.equal(payload.output_root, null);
      assert.deepEqual(payload.files_to_create, ["login.html"]);
    });

    it("narrows artifact generation to only missing files when outputs already exist", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Reuse partial artifacts", "desc", "normal", { mode: "image" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Reuse partial artifacts",
    });
    const worker = new workerMod.Worker({ projectDir, silent: true });
    const outputRoot = path.join(artifactsDir(`wi-${wi.id}`, projectDir), "task-01-reuse-partial");
    try {
      fs.mkdirSync(outputRoot, { recursive: true });
      fs.writeFileSync(path.join(outputRoot, "hero-bg.png"), Buffer.alloc(4096, 1));

      worker.createJobsFromPlan(planJob, [{
        title: "Generate image set",
        job_type: "artificer",
        task_mode: "image",
        needs_image_generation: true,
        task_spec: "Generate both required images",
        output_root: outputRoot.replace(/\\/g, "/"),
        create_roots: [outputRoot.replace(/\\/g, "/")],
        files_to_create: [
          path.join(outputRoot, "hero-bg.png").replace(/\\/g, "/"),
          path.join(outputRoot, "card-style.png").replace(/\\/g, "/"),
        ],
        success_criteria: ["Both images exist"],
        depends_on_index: [],
      }]);

      const created = queueMod.listJobsByWorkItem(wi.id).find((job) => job.id !== planJob.id && job.job_type === "artificer");
      assert.ok(created);
      const payload = JSON.parse(created.payload_json);
      assert.deepEqual(payload.files_to_create, [path.join(outputRoot, "card-style.png").replace(/\\/g, "/")]);
      assert.match(payload.task_spec, /already exist in output_root/i);
      assert.equal(created.status, "queued");
    } finally {
      fs.rmSync(path.join(artifactsDir(`wi-${wi.id}`, projectDir)), { recursive: true, force: true });
    }
  });

  it("marks artifact jobs succeeded during planning when all expected outputs already exist", () => withEnv({
    OPENAI_API_KEY: "test-key",
  }, () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Reuse complete artifacts", "desc", "normal", { mode: "image" });
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Reuse complete artifacts",
    });
    const worker = new workerMod.Worker({ projectDir, silent: true });
    const outputRoot = path.join(artifactsDir(`wi-${wi.id}`, projectDir), "task-01-reuse-complete");
    try {
      fs.mkdirSync(outputRoot, { recursive: true });
      fs.writeFileSync(path.join(outputRoot, "hero-bg.png"), Buffer.alloc(4096, 1));
      fs.writeFileSync(path.join(outputRoot, "card-style.png"), Buffer.alloc(4096, 2));

      worker.createJobsFromPlan(planJob, [{
        title: "Generate image set",
        job_type: "artificer",
        task_mode: "image",
        needs_image_generation: true,
        task_spec: "Generate both required images",
        output_root: outputRoot.replace(/\\/g, "/"),
        create_roots: [outputRoot.replace(/\\/g, "/")],
        files_to_create: [
          path.join(outputRoot, "hero-bg.png").replace(/\\/g, "/"),
          path.join(outputRoot, "card-style.png").replace(/\\/g, "/"),
        ],
        success_criteria: ["Both images exist"],
        depends_on_index: [],
      }]);

      const created = queueMod.listJobsByWorkItem(wi.id).find((job) => job.id !== planJob.id && job.job_type === "artificer");
      assert.ok(created);
      assert.equal(created.status, "succeeded");
      assert.match(created.result_json || "", /Planner reused 2 existing artifact output/);
    } finally {
      fs.rmSync(path.join(artifactsDir(`wi-${wi.id}`, projectDir)), { recursive: true, force: true });
    }
  }));

  it("narrows inferred Grok image-generation tasks to missing outputs during planner preflight", () => withArtifactProtocols((config) => {
    config.image.provider = "grok";
    config.image.model = "grok-imagine-image";
  }, () => withEnv({
    XAI_API_KEY: "test-key",
  }, () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Reuse inferred grok image", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Reuse inferred grok image",
    });
    const worker = new workerMod.Worker({ projectDir, silent: true });
    const outputRoot = path.join(artifactsDir(`wi-${wi.id}`, projectDir), "task-01-reuse-grok-logo");
    try {
      fs.mkdirSync(outputRoot, { recursive: true });
      fs.writeFileSync(path.join(outputRoot, "logo.png"), Buffer.alloc(4096, 7));
      const outputRootRel = path.relative(projectDir, outputRoot).replace(/\\/g, "/");
      const logoPathRel = path.join(outputRootRel, "logo.png").replace(/\\/g, "/");

      worker.createJobsFromPlan(planJob, [{
        title: "Generate banner logo",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Generate neon cyberpunk header images logo.png and wordmark.png for the app header.",
        output_root: outputRootRel,
        create_roots: [outputRootRel],
        files_to_create: [
          logoPathRel,
          path.join(outputRootRel, "wordmark.png").replace(/\\/g, "/"),
        ],
        success_criteria: ["The header images exist"],
        depends_on_index: [],
      }]);

      const created = queueMod.listJobsByWorkItem(wi.id).find((job) => job.id !== planJob.id && job.job_type !== "delegate");
      assert.ok(created);
      assert.equal(created.status, "queued");
      const payload = JSON.parse(created.payload_json);
      assert.equal(created.provider, "claude");
      assert.equal(payload.image_provider, "grok");
      assert.equal(payload.image_model, "grok-imagine-image");
      assert.deepEqual(payload.files_to_create, [path.join(outputRootRel, "wordmark.png").replace(/\\/g, "/")]);
      assert.match(payload.task_spec, /already exist in output_root/i);
    } finally {
      fs.rmSync(path.join(artifactsDir(`wi-${wi.id}`, projectDir)), { recursive: true, force: true });
    }
  })));

  it("runs image preflight even when Codex is configured on the role", () => withArtifactProtocols((config) => {
    config.image.provider = "openai";
    config.image.model = "gpt-image-1.5";
  }, () => withEnv({
    OPENAI_API_KEY: "test-key",
    CODEX_API_KEY: "codex-test",
  }, () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const previousProviderDev = queueMod.getSetting("provider_dev");
    const previousProviderArtificer = queueMod.getSetting("provider_artificer");
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");
    const previousOpenAiSessionLimit = queueMod.getSetting("openai_limit_tokens_session");
    const previousOpenAiWeekLimit = queueMod.getSetting("openai_limit_tokens_week");
    const db = runtimeModules.dbMod.getDb();
    queueMod.setSetting("provider_dev", "codex,openai");
    queueMod.setSetting("provider_artificer", "codex,openai");
    queueMod.setSetting("artifact_image_provider", "openai");
    queueMod.setSetting("openai_limit_tokens_session", null);

    queueMod.setSetting("openai_limit_tokens_week", null);
    const wi = queueMod.createWorkItem("Reuse with codex configured", "desc");
    const planJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan: Reuse with codex configured",
    });
    const worker = new workerMod.Worker({ projectDir, silent: true });
    const outputRoot = path.join(artifactsDir(`wi-${wi.id}`, projectDir), "task-01-reuse-codex-config");
    try {
      fs.mkdirSync(outputRoot, { recursive: true });
      fs.writeFileSync(path.join(outputRoot, "hero-bg.png"), Buffer.alloc(4096, 5));
      const outputRootRel = path.relative(projectDir, outputRoot).replace(/\\/g, "/");

      worker.createJobsFromPlan(planJob, [{
        title: "Generate hero and card images",
        job_type: "dev",
        task_mode: "code",
        task_spec: "Generate hero-bg.png and card-style.png as cyberpunk UI images.",
        output_root: outputRootRel,
        create_roots: [outputRootRel],
        files_to_create: [
          path.join(outputRootRel, "hero-bg.png").replace(/\\/g, "/"),
          path.join(outputRootRel, "card-style.png").replace(/\\/g, "/"),
        ],
        success_criteria: ["Both images exist"],
        depends_on_index: [],
      }]);

      const created = queueMod.listJobsByWorkItem(wi.id).find((job) => job.id !== planJob.id && job.job_type !== "delegate");
      assert.ok(created);
      assert.equal(created.provider, "openai");
      const payload = JSON.parse(created.payload_json);
      assert.equal(payload.image_provider, "openai");
      assert.equal(payload.image_model, "gpt-image-1.5");
      assert.deepEqual(payload.files_to_create, [path.join(outputRootRel, "card-style.png").replace(/\\/g, "/")]);
      assert.match(payload.task_spec, /already exist in output_root/i);
    } finally {
      queueMod.setSetting("provider_dev", previousProviderDev ?? "claude");
      queueMod.setSetting("provider_artificer", previousProviderArtificer ?? "claude");
      queueMod.setSetting("artifact_image_provider", previousImageProvider);
      if (previousOpenAiSessionLimit == null) {
        queueMod.setSetting("openai_limit_tokens_session", null);
      } else {
        queueMod.setSetting("openai_limit_tokens_session", previousOpenAiSessionLimit);
      }
      if (previousOpenAiWeekLimit == null) {
        queueMod.setSetting("openai_limit_tokens_week", null);
      } else {
        queueMod.setSetting("openai_limit_tokens_week", previousOpenAiWeekLimit);
      }
      fs.rmSync(path.join(artifactsDir(`wi-${wi.id}`, projectDir)), { recursive: true, force: true });
    }
  })));

  it("uses JS delegation mode to assign providers without spawning a delegate job", () => withEnv({
    OPENAI_API_KEY: "test-key",
  }, () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousMode = queueMod.getSetting("delegation_mode");
    const previousProviderDev = queueMod.getSetting("provider_dev");
    const previousOpenAiSessionLimit = queueMod.getSetting("openai_limit_tokens_session");
    const previousOpenAiWeekLimit = queueMod.getSetting("openai_limit_tokens_week");
    const previousOpenAiObservedSession = queueMod.getSetting("openai_observed_pct_session");
    const previousOpenAiObservedWeek = queueMod.getSetting("openai_observed_pct_week");
    const db = runtimeModules.dbMod.getDb();
    queueMod.setSetting("delegation_mode", "js");
    queueMod.setSetting("provider_dev", "claude,openai");
    queueMod.setSetting("openai_limit_tokens_session", null);
    queueMod.setSetting("openai_limit_tokens_week", null);
    queueMod.setSetting("openai_observed_pct_session", null);
    queueMod.setSetting("openai_observed_pct_week", null);
    try {
      const wi = queueMod.createWorkItem("JS delegate mode", "desc");
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: JS delegate mode",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [
        {
          title: "Implement first feature",
          job_type: "dev",
          task_spec: "Edit one file",
          files_to_modify: ["lib/domains/artifacts/functions/index.js"],
          success_criteria: ["done"],
          depends_on_index: [],
        },
        {
          title: "Implement second feature",
          job_type: "dev",
          task_spec: "Edit another file",
          files_to_modify: ["lib/worker.js"],
          success_criteria: ["done"],
          depends_on_index: [],
        },
      ]);

      const jobs = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id);
      assert.equal(jobs.some((job) => job.job_type === "delegate"), false);
      const devProviders = jobs.filter((job) => job.job_type === "dev").map((job) => job.provider);
      assert.equal(devProviders.length, 2);
      assert.equal(devProviders.every((provider) => ["claude", "openai"].includes(provider)), true);
      assert.equal(devProviders.every((provider) => typeof provider === "string" && provider.length > 0), true);
    } finally {
      queueMod.setSetting("delegation_mode", previousMode ?? "js");
      queueMod.setSetting("provider_dev", previousProviderDev ?? "claude");
      if (previousOpenAiSessionLimit == null) {
        queueMod.setSetting("openai_limit_tokens_session", null);
      } else {
        queueMod.setSetting("openai_limit_tokens_session", previousOpenAiSessionLimit);
      }
      if (previousOpenAiWeekLimit == null) {
        queueMod.setSetting("openai_limit_tokens_week", null);
      } else {
        queueMod.setSetting("openai_limit_tokens_week", previousOpenAiWeekLimit);
      }
      queueMod.setSetting("openai_observed_pct_session", previousOpenAiObservedSession);
      queueMod.setSetting("openai_observed_pct_week", previousOpenAiObservedWeek);
    }
  }));

  it("uses ML delegation mode to spawn a delegate job for unresolved multi-provider roles", () => withEnv({
    OPENAI_API_KEY: "test-key",
  }, () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousMode = queueMod.getSetting("delegation_mode");
    const previousProviderDev = queueMod.getSetting("provider_dev");
    const previousOpenAiSessionLimit = queueMod.getSetting("openai_limit_tokens_session");
    const previousOpenAiWeekLimit = queueMod.getSetting("openai_limit_tokens_week");
    const db = runtimeModules.dbMod.getDb();
    queueMod.setSetting("delegation_mode", "ml");
    queueMod.setSetting("provider_dev", "claude,openai");
    queueMod.setSetting("openai_limit_tokens_session", null);

    queueMod.setSetting("openai_limit_tokens_week", null);
    try {
      const wi = queueMod.createWorkItem("ML delegate mode", "desc");
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: ML delegate mode",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [{
        title: "Implement feature",
        job_type: "dev",
        task_spec: "Edit one file",
        files_to_modify: ["lib/domains/artifacts/functions/index.js"],
        success_criteria: ["done"],
        depends_on_index: [],
      }]);

      const jobs = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id);
      assert.equal(jobs.some((job) => job.job_type === "delegate"), true);
    } finally {
      queueMod.setSetting("delegation_mode", previousMode ?? "js");
      queueMod.setSetting("provider_dev", previousProviderDev ?? "claude");
      if (previousOpenAiSessionLimit == null) {
        queueMod.setSetting("openai_limit_tokens_session", null);
      } else {
        queueMod.setSetting("openai_limit_tokens_session", previousOpenAiSessionLimit);
      }
      if (previousOpenAiWeekLimit == null) {
        queueMod.setSetting("openai_limit_tokens_week", null);
      } else {
        queueMod.setSetting("openai_limit_tokens_week", previousOpenAiWeekLimit);
      }
    }
  }));

});

// ═════════════════════════════════════════════════════════════════════════════
// Planner context directory system
// ═════════════════════════════════════════════════════════════════════════════
