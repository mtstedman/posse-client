import {
  it,
  before,
  beforeEach,
  after,
  assert,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
} from "../support/core-harness.js";

let db;

suite("Fix scope inheritance", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("treats previously created files as editable scope for spawned fix jobs", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Resize logo", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Fix logo image aspect ratio",
      payload_json: JSON.stringify({
        task_spec: "Resize htdocs/images/logo.png to better fit the header.",
        files_to_modify: [],
        files_to_create: ["htdocs/images/logo.png"],
        create_roots: ["htdocs/images"],
        task_mode: "code",
      }),
    });

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "fail",
      confidence: "high",
      reasons: ["The logo aspect ratio is wrong; resize the existing PNG instead of leaving it distorted."],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {} });

    const fixJob = spawnedJobs.find((job) => job.job_type === "fix");
    assert.ok(fixJob, "expected a fix job to be spawned");
    const payload = JSON.parse(queueMod.getJob(fixJob.id).payload_json);
    assert.deepEqual(payload.files_to_modify, ["htdocs/images/logo.png"]);
    assert.deepEqual(payload.files_to_create, ["htdocs/images/logo.png"]);
    assert.deepEqual(payload.create_roots, ["htdocs/images"]);
  });

  it("seeds a fix replacement when assessor spawn specs contain only unsupported job types", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Repair downstream chain", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Update API handler",
      payload_json: JSON.stringify({
        task_spec: "Update the API handler.",
        files_to_modify: ["src/api.js"],
        files_to_create: [],
        create_roots: [],
        task_mode: "code",
      }),
    });
    const downstream = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "summarize",
      title: "Summarize API handler update",
    });
    queueMod.addDependency(downstream.id, current.id, "hard");

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "fail",
      confidence: "high",
      reasons: ["The handler still returns stale data."],
      spawn_jobs: [{ job_type: "human_input", title: "Ask for clarification", payload: {} }],
      human_questions: [],
    }, { emit: () => {} });

    const fixJob = spawnedJobs.find((job) => job.job_type === "fix");
    assert.ok(fixJob, "expected a default fix job to be spawned");
    const deps = queueMod.getDependencies(downstream.id);
    assert.equal(deps.some((dep) => dep.depends_on_job_id === current.id), false);
    assert.equal(deps.some((dep) => dep.depends_on_job_id === fixJob.id), true);
  });

  it("preserves artifact output_root as writable scope for spawned image artifact repair jobs", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Repair generated logo", "desc", "normal", { mode: "image" });
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "artificer",
      title: "Generate tightly-cropped neon logo for header",
      payload_json: JSON.stringify({
        task_spec: "Generate a cropped neon header logo.",
        files_to_modify: [],
        files_to_create: [],
        create_roots: [],
        task_mode: "image",
        output_root: ".posse/resources/artifacts/wi-1/task-01-logo",
        needs_image_generation: true,
      }),
    });

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "fail",
      confidence: "medium",
      reasons: ["Image dimensions deviate significantly from specification."],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {} });

    const imageJob = spawnedJobs.find((job) => job.job_type === "artificer");
    assert.ok(imageJob, "expected an image artifact repair job to be spawned");
    assert.equal(spawnedJobs.some((job) => job.job_type === "fix"), false);
    const payload = JSON.parse(queueMod.getJob(imageJob.id).payload_json);
    assert.equal(payload.task_mode, "image");
    assert.equal(payload.output_root, ".posse/resources/artifacts/wi-1/task-01-logo");
    assert.ok(payload.create_roots.includes(".posse/resources/artifacts/wi-1/task-01-logo"));
    assert.equal(payload.needs_image_generation, true);
    assert.equal(payload._image_artifact_recovery, true);
    assert.match(payload.task_spec, /generate_image/);
    assert.equal(imageJob.provider, null);
  });

  it("routes image artifact protocol config failures to a code fix instead of image repair", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Repair image protocol", "desc", "normal", { mode: "image" });
    const outputRoot = ".posse/resources/artifacts/wi-1/task-01-hero";
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "artificer",
      title: "Generate Tulum hero image",
      payload_json: JSON.stringify({
        task_spec: "Generate hero-bg.jpg for the wedding frontend.",
        files_to_modify: [],
        files_to_create: [`${outputRoot}/hero-bg.jpg`],
        create_roots: [outputRoot],
        task_mode: "image",
        output_root: outputRoot,
        needs_image_generation: true,
      }),
    });

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "fail",
      confidence: "high",
      reasons: [
        "No artifact protocol configured for task_mode \"image\".",
      ],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {} });

    assert.equal(spawnedJobs.some((job) => job.job_type === "artificer"), false);
    const fixJob = spawnedJobs.find((job) => job.job_type === "fix");
    assert.ok(fixJob, "expected a code fix job to be spawned");
    const payload = JSON.parse(queueMod.getJob(fixJob.id).payload_json);
    assert.equal(payload.task_mode, "code");
    assert.equal(payload.output_root, null);
    assert.equal(payload.needs_image_generation, false);
    assert.deepEqual(payload.files_to_modify, ["config/artifact-protocols.json"]);
    assert.deepEqual(payload.files_to_create, ["config/artifact-protocols.json"]);
    assert.deepEqual(payload.create_roots, ["config"]);
    assert.equal(payload._artifact_protocol_config_recovery, true);
  });

  it("reroutes failed report artifact repairs to artifact scope only", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Technicals report", "desc", "normal", { mode: "report" });
    const outputRoot = ".posse/resources/artifacts/wi-65/task-01-write-technicals-scoring-redesign-report";
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "artificer",
      title: "Write Technicals Scoring Redesign Report with Implementation Plan",
      payload_json: JSON.stringify({
        task_spec: "Produce a single Markdown document at `{output_root}/technicals-scoring-redesign.md`.",
        files_to_modify: [],
        files_to_create: [],
        create_roots: [outputRoot],
        task_mode: "report",
        output_root: outputRoot,
        success_criteria: [
          "File `{output_root}/technicals-scoring-redesign.md` exists and is valid Markdown",
        ],
      }),
    });

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "fail",
      confidence: "high",
      reasons: [
        "Required file `technicals-scoring-redesign.md` does not exist in output_root.",
        "File references must match migrations/0035_pick_classification.sql, results.php, brief.php, and helpers.php.",
      ],
      spawn_jobs: [{
        job_type: "fix",
        title: "Write technicals-scoring-redesign.md report with all required sections",
        payload: {
          instructions: "Write output_root/technicals-scoring-redesign.md and include references to migrations/0035_pick_classification.sql, results.php, brief.php, and helpers.php.",
        },
      }],
      human_questions: [],
    }, { emit: () => {} });

    assert.equal(spawnedJobs.some((job) => job.job_type === "fix"), false);
    const artifactJob = spawnedJobs.find((job) => job.job_type === "artificer");
    assert.ok(artifactJob, "expected an artificer artifact repair job");
    const payload = JSON.parse(queueMod.getJob(artifactJob.id).payload_json);
    assert.equal(payload.task_mode, "report");
    assert.equal(payload.output_root, outputRoot);
    assert.deepEqual(payload.files_to_modify, []);
    assert.deepEqual(payload.files_to_create, []);
    assert.deepEqual(payload.create_roots, [outputRoot]);
    assert.equal(payload._artifact_recovery, true);
    assert.match(payload.task_spec, /do not create a nested output_root directory/i);
    assert.equal(payload.create_roots.some((root) => /(^|\/)(migrations|output_root)$/.test(root)), false);
  });

  it("routes obvious image-mode/frontend mismatches to human review instead of spawning a fix", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const previousRetryLimit = queueMod.getSetting("assessor_internal_retry_limit");
    const wi = queueMod.createWorkItem("Gov frontend", "desc", "normal", {
      metadata: {
        intake_hints: {
          intent_type: "task",
          deliverable_type: "code",
          output_mode: "repo",
        },
      },
    });
    queueMod.setSetting("assessor_internal_retry_limit", "0");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "artificer",
      title: "HTML frontend - core pages, CSS, and API client",
      payload_json: JSON.stringify({
        task_spec: "Build the core frontend pages, shared CSS, and JavaScript API client module.",
        files_to_modify: [],
        files_to_create: [
          "public/css/style.css",
          "public/js/app.js",
          "public/index.html",
        ],
        create_roots: ["public/css", "public/js", "public"],
        task_mode: "image",
        output_root: ".posse/resources/artifacts/wi-2",
        needs_image_generation: true,
      }),
    });
    queueMod.logEvent({
      work_item_id: wi.id,
      job_id: current.id,
      event_type: "job.assessment_internal_retry",
      actor_type: "assessor",
      message: "retry 1",
    });
    queueMod.logEvent({
      work_item_id: wi.id,
      job_id: current.id,
      event_type: "job.assessment_internal_retry",
      actor_type: "assessor",
      message: "retry 2",
    });

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "fail",
      confidence: "high",
      reasons: [
        "The task was an ARTIFACT task in image mode but the output manifest contains only .css, .html, and .js files, which are disallowed formats according to the artifact contract.",
        "No files with allowed formats [.png, .jpg, .jpeg, .webp] — found: [.css, .html, .js].",
      ],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {} });

    const refreshed = queueMod.getJob(current.id);
    assert.equal(refreshed.status, "waiting_on_review");
    assert.equal(spawnedJobs.some((job) => job.job_type === "fix"), false);
    const reviewJob = spawnedJobs.find((job) => job.job_type === "human_input");
    assert.ok(reviewJob, "expected a human review job to be spawned");
    const payload = JSON.parse(queueMod.getJob(reviewJob.id).payload_json);
    assert.equal(payload.review_type, "needs_review");
    assert.match(payload.questions[0], /re-routed and replanned|pass \/ fail \/ replan \/ retry/i);
    queueMod.setSetting("assessor_internal_retry_limit", previousRetryLimit);
  });

  it("reads assessor internal retry limit from settings", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const previousRetryLimit = queueMod.getSetting("assessor_internal_retry_limit");
    queueMod.setSetting("assessor_internal_retry_limit", "7");
    assert.equal(assessorMod.__testGetAssessmentInternalRetryLimit(), 7);
    queueMod.setSetting("assessor_internal_retry_limit", previousRetryLimit);
  });

  it("retries parse_error assessments internally before escalating to human review", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const previousRetryLimit = queueMod.getSetting("assessor_internal_retry_limit");
    queueMod.setSetting("assessor_internal_retry_limit", "1");

    const wi = queueMod.createWorkItem("Parse retry", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Assess me",
      payload_json: JSON.stringify({ _assess_only: 0 }),
    });

    const first = assessorMod.processVerdict(current, {
      verdict: "parse_error",
      confidence: "none",
      reasons: ["bad json"],
      spawn_jobs: [],
      human_questions: [],
      raw: "oops",
    }, { emit: () => {} });

    const refreshed = queueMod.getJob(current.id);
    const payload = JSON.parse(refreshed.payload_json || "{}");
    assert.equal(refreshed.status, "queued");
    assert.equal(payload._assess_only, 1);
    assert.equal(first.spawnedJobs.length, 0);

    queueMod.setSetting("assessor_internal_retry_limit", previousRetryLimit);
  });

  it("escalates parse_error assessments to human review after internal retries are exhausted", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const previousRetryLimit = queueMod.getSetting("assessor_internal_retry_limit");
    queueMod.setSetting("assessor_internal_retry_limit", "1");

    const wi = queueMod.createWorkItem("Parse review", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Assess me again",
      payload_json: JSON.stringify({ _assess_only: 1 }),
    });
    queueMod.logEvent({
      work_item_id: wi.id,
      job_id: current.id,
      event_type: "job.assessment_internal_retry",
      actor_type: "assessor",
      message: "retry 1",
    });

    const second = assessorMod.processVerdict(current, {
      verdict: "parse_error",
      confidence: "none",
      reasons: ["still bad json"],
      spawn_jobs: [],
      human_questions: [],
      raw: "still oops",
    }, { emit: () => {} });

    const refreshed = queueMod.getJob(current.id);
    assert.equal(refreshed.status, "waiting_on_review");
    const reviewJob = second.spawnedJobs.find((job) => job.job_type === "human_input");
    assert.ok(reviewJob);
    const payload = JSON.parse(queueMod.getJob(reviewJob.id).payload_json || "{}");
    assert.equal(payload.review_type, "assessment_parse_error");

    queueMod.setSetting("assessor_internal_retry_limit", previousRetryLimit);
  });

  it("does not internally requeue parse_error verdicts when retry is explicitly disabled", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const previousRetryLimit = queueMod.getSetting("assessor_internal_retry_limit");
    queueMod.setSetting("assessor_internal_retry_limit", "5");

    const wi = queueMod.createWorkItem("Parse no-retry", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Assess without internal retry",
      payload_json: JSON.stringify({ _assess_only: 1 }),
    });

    const result = assessorMod.processVerdict(current, {
      verdict: "parse_error",
      confidence: "none",
      reasons: ["budget exhausted"],
      spawn_jobs: [],
      human_questions: [],
      raw: "still oops",
      _disable_internal_retry: true,
    }, { emit: () => {} });

    const refreshed = queueMod.getJob(current.id);
    assert.equal(refreshed.status, "waiting_on_review");
    const events = queueMod.getEvents(current.id, 20);
    assert.equal(events.some((evt) => evt.event_type === "job.assessment_internal_retry"), false);
    const reviewJob = result.spawnedJobs.find((job) => job.job_type === "human_input");
    assert.ok(reviewJob);
    const payload = JSON.parse(queueMod.getJob(reviewJob.id).payload_json || "{}");
    assert.equal(payload.review_type, "assessment_parse_error");

    queueMod.setSetting("assessor_internal_retry_limit", previousRetryLimit);
  });

  it("grants spawned fix jobs permission to create a missing test file named in instructions", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Add route tests", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Add tests for GET /api/songs/:id route",
      payload_json: JSON.stringify({
        task_spec: "Add tests for GET /api/songs/:id route.",
        files_to_modify: ["src/services/db.js", "api/songs.js"],
        files_to_create: [],
        create_roots: [],
        task_mode: "code",
      }),
    });

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "fail",
      confidence: "high",
      reasons: ["The route changes are present, but tests are still missing."],
      spawn_jobs: [{
        job_type: "fix",
        title: "Add tests for GET /api/songs/:id route",
        payload: {
          instructions: "Create a new file `api/songs.test.js` covering GET /api/songs/:id and keep the existing route logic intact.",
        },
      }],
      human_questions: [],
    }, { emit: () => {} });

    const fixJob = spawnedJobs.find((job) => job.job_type === "fix");
    assert.ok(fixJob, "expected a fix job to be spawned");
    const payload = JSON.parse(queueMod.getJob(fixJob.id).payload_json);
    assert.deepEqual(payload.files_to_create, ["api/songs.test.js"]);
    assert.deepEqual(payload.create_roots, ["api"]);
    assert.deepEqual(
      payload.files_to_modify.sort(),
      ["api/songs.js", "api/songs.test.js", "src/services/db.js"].sort(),
    );
  });

  it("adds existing files named by fix instructions to spawned fix write scope", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Repair payload validation", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Add payload failure-path coverage",
      payload_json: JSON.stringify({
        task_spec: "Add regression tests for worker payload failures.",
        files_to_modify: ["tests/test_workers_payloads.py"],
        files_to_create: [],
        create_roots: [],
        task_mode: "code",
      }),
    });

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "fail",
      confidence: "high",
      reasons: ["The test fails because dataframe_from_payload still accepts string data."],
      spawn_jobs: [{
        job_type: "fix",
        title: "Reject invalid payload data",
        payload: {
          instructions: "Update `src/workers/payloads.py` in `dataframe_from_payload` so string `data` logs WARNING and returns None. Re-run `python -m pytest tests/test_workers_payloads.py -q`.",
        },
      }],
      human_questions: [],
    }, { emit: () => {} });

    const fixJob = spawnedJobs.find((job) => job.job_type === "fix");
    assert.ok(fixJob, "expected a fix job to be spawned");
    const payload = JSON.parse(queueMod.getJob(fixJob.id).payload_json);
    assert.deepEqual(
      payload.files_to_modify.sort(),
      ["src/workers/payloads.py", "tests/test_workers_payloads.py"].sort(),
    );
    assert.equal(payload.declared_output_contract, false);
    assert.equal(payload.files_to_modify.includes("python"), false);
  });

  it("keeps spawned fix jobs pinned to the original modify scope when package.json is mentioned in assessor feedback", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Clean up package scope", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Remove out-of-scope package.json modification",
      payload_json: JSON.stringify({
        task_spec: "Remove the unintended package.json change.",
        files_to_modify: ["src/services/db.js", "api/songs.js"],
        files_to_create: [],
        create_roots: [],
        task_mode: "code",
      }),
    });

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "fail",
      confidence: "high",
      reasons: ["package.json was modified out of scope and must be restored."],
      spawn_jobs: [{
        job_type: "fix",
        title: "Remove out-of-scope package.json modification",
        payload: {
          instructions: "Rollback any changes made to `package.json` and keep the route implementation files as they are.",
        },
      }],
      human_questions: [],
    }, { emit: () => {} });

    const fixJob = spawnedJobs.find((job) => job.job_type === "fix");
    assert.ok(fixJob, "expected a fix job to be spawned");
    const payload = JSON.parse(queueMod.getJob(fixJob.id).payload_json);
    assert.deepEqual(
      payload.files_to_modify.sort(),
      ["api/songs.js", "src/services/db.js"].sort(),
    );
    assert.deepEqual(payload.files_to_create, []);
    assert.deepEqual(payload.create_roots, []);
  });

  it("keeps spawned fix jobs pinned to the original modify scope when deletion targets are only mentioned in prose", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Retire lyrics page", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Retire standalone lyrics builder page and backend",
      payload_json: JSON.stringify({
        task_spec: [
          "Files to DELETE:",
          "- `htdocs/lyrics.html`",
          "- `htdocs/js/lyrics.js`",
          "- `api/lyrics.php`",
        ].join("\n"),
        files_to_modify: ["app.js", "api/index.php"],
        files_to_create: [],
        create_roots: [],
        success_criteria: [
          "htdocs/lyrics.html is deleted",
          "htdocs/js/lyrics.js is deleted",
          "api/lyrics.php is deleted",
        ],
        task_mode: "code",
      }),
    });

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "fail",
      confidence: "high",
      reasons: ["Files that were required to be deleted still exist."],
      spawn_jobs: [{
        job_type: "fix",
        title: "Remove required lyrics files",
        payload: {
          instructions: "The files `htdocs/lyrics.html`, `htdocs/js/lyrics.js`, and `api/lyrics.php` must be fully deleted from the repo.",
        },
      }],
      human_questions: [],
    }, { emit: () => {} });

    const fixJob = spawnedJobs.find((job) => job.job_type === "fix");
    assert.ok(fixJob, "expected a fix job to be spawned");
    const payload = JSON.parse(queueMod.getJob(fixJob.id).payload_json);
    assert.deepEqual(
      payload.files_to_modify.sort(),
      ["app.js", "api/index.php"].sort(),
    );
    assert.deepEqual(payload.files_to_delete, []);
  });

  it("routes structured-data fix loops into artificer plus promote recovery", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Unified contacts", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "fix",
      title: "Fix: Regenerate unified state contact dataset",
      payload_json: JSON.stringify({
        task_spec: "Regenerate and normalize the unified state contact dataset from artifact sources into the final JSON. The remote PHP generator exists, but local PHP is unavailable.",
        files_to_modify: ["data/state_office_contacts.json"],
        files_to_create: [],
        create_roots: [],
        success_criteria: ["Unified state contact dataset is refreshed"],
        task_mode: "code",
      }),
    });
    const downstream = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "summarize",
      title: "Summarize unified contacts refresh",
    });
    queueMod.addDependency(downstream.id, current.id, "hard");

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "fail",
      confidence: "high",
      reasons: ["Local PHP is unavailable, so recover this as a structured dataset artifact and then promote the final JSON into the repo."],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {} });

    assert.equal(spawnedJobs.some((job) => job.job_type === "fix"), false);
    const artificerJob = spawnedJobs.find((job) => job.job_type === "artificer");
    const promoteJob = spawnedJobs.find((job) => job.job_type === "promote");
    assert.ok(artificerJob, "expected an artificer recovery job");
    assert.ok(promoteJob, "expected a promote follow-up");
    assert.equal(artificerJob.title, "Fix: Regenerate unified state contact dataset");

    const artificerPayload = JSON.parse(queueMod.getJob(artificerJob.id).payload_json);
    assert.equal(artificerPayload.task_mode, "content");
    assert.deepEqual(artificerPayload.files_to_modify, []);
    assert.ok(artificerPayload.files_to_create.some((file) => file.endsWith("/state_office_contacts.json")));

    const promotePayload = JSON.parse(queueMod.getJob(promoteJob.id).payload_json);
    assert.ok(promotePayload.mappings.some((mapping) => mapping.pattern === "state_office_contacts.json" && mapping.dest === "data/state_office_contacts.json"));

    const promoteDeps = queueMod.getDependencies(promoteJob.id);
    assert.ok(promoteDeps.some((dep) => dep.depends_on_job_id === artificerJob.id));

    const downstreamDeps = queueMod.getDependencies(downstream.id);
    assert.ok(downstreamDeps.some((dep) => dep.depends_on_job_id === promoteJob.id));
    assert.equal(downstreamDeps.some((dep) => dep.depends_on_job_id === current.id), false);
  });

  it("does not infer existing edit targets as files_to_create for add-tests instructions", () => {
    const { queueMod, assessorMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Style tests", "desc");
    const current = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Add tests for saved styles filtering UI",
      payload_json: JSON.stringify({
        task_spec: "Update the saved styles filtering UI.",
        files_to_modify: ["htdocs/style.html", "htdocs/js/style.js", "htdocs/css/style-page.css"],
        files_to_create: [],
        create_roots: [],
        task_mode: "code",
      }),
    });

    const { spawnedJobs } = assessorMod.processVerdict(current, {
      verdict: "fail",
      confidence: "high",
      reasons: ["Saved styles filtering tests are missing."],
      spawn_jobs: [{
        job_type: "fix",
        title: "Add tests for saved styles filtering UI",
        payload: {
          instructions: "Add comprehensive unit or integration tests in htdocs/js/style.js for the saved styles filtering UI functionality.",
        },
      }],
      human_questions: [],
    }, { emit: () => {} });

    const fixJob = spawnedJobs.find((job) => job.job_type === "fix");
    assert.ok(fixJob, "expected a fix job to be spawned");
    const payload = JSON.parse(queueMod.getJob(fixJob.id).payload_json);
    assert.deepEqual(payload.files_to_create, []);
    assert.ok(payload.files_to_modify.includes("htdocs/js/style.js"));
  });
});
