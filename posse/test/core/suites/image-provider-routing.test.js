import {
  it,
  before,
  beforeEach,
  after,
  assert,
  fs,
  os,
  path,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  withEnv,
  withArtifactProtocols,
  getArtifactProtocol,
  getResolvedImageProtocol,
} from "../support/core-harness.js";

let db;

suite("Image provider routing", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("resolves image execution to the routed provider even if a stale job says claude", () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");
    try {
      queueMod.setSetting("artifact_image_provider", "openai");
      const route = workerMod.resolveImageExecutionProvider({
        task_mode: "image",
        needs_image_generation: true,
      });

      assert.equal(route.provider, "openai");
      assert.equal(route.provider, getResolvedImageProtocol().provider);
    } finally {
      queueMod.setSetting("artifact_image_provider", previousImageProvider);
    }
  });

  it("keeps image round-robin cursor out of function-local mutable state", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const { providerRegistry } = await import("../../../lib/domains/providers/functions/provider.js");
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");
    try {
      providerRegistry.resetSelectionCursor();
      queueMod.setSetting("artifact_image_provider", "openai");
      const route = workerMod.resolveImageExecutionProvider({
        task_mode: "image",
        needs_image_generation: true,
      });

      assert.equal(route.provider, "openai");
    } finally {
      queueMod.setSetting("artifact_image_provider", previousImageProvider);
      providerRegistry.resetSelectionCursor();
    }
  });

  it("keeps the image provider out of image-generation job chat assignment", () => {
    withArtifactProtocols((config) => {
      config.image.provider = "grok";
      config.image.model = "grok-imagine-image";
    }, () => withEnv({ XAI_API_KEY: "test-key" }, () => {
      const { queueMod, workerMod } = runtimeModules;
      const wi = queueMod.createWorkItem("Grok images", "desc");
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: Grok images",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [{
        title: "Generate hero image",
        job_type: "artificer",
        task_mode: "image",
        needs_image_generation: true,
        task_spec: "Generate a PNG hero image",
        success_criteria: ["Image exists"],
      }]);

      const created = queueMod.listJobsByWorkItem(wi.id).find((job) => job.id !== planJob.id);
      assert.ok(created);
      assert.equal(getArtifactProtocol("image").provider, "grok");
      assert.equal(created.provider, "claude");
      assert.notEqual(created.provider, getArtifactProtocol("image").provider);
    }));
  });

  it("keeps repo-edit image-adjacent tasks in dev instead of artificer", () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");
    try {
      queueMod.setSetting("artifact_image_provider", "openai");
      const wi = queueMod.createWorkItem("Image integration is repo work", "desc");
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: image integration",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [
        {
          title: "Remove the hexagram from the header brand link",
          job_type: "artificer",
          task_mode: "image",
          needs_image_generation: true,
          task_spec: "Remove the logo-like image mark from the existing header brand link. Do not generate assets.",
          files_to_modify: ["htdocs/_partials/header.php"],
          files_to_create: [],
          success_criteria: ["Header brand link no longer renders the mark"],
        },
        {
          title: "Rewire page imagery and CSS to the STYLE.md image-slot contract",
          job_type: "artificer",
          task_mode: "image",
          needs_image_generation: true,
          task_spec: "Integrate existing generated images into PHP pages and CSS image slots.",
          files_to_modify: ["htdocs/assets/css/app.css", "htdocs/index.php"],
          files_to_create: [],
          success_criteria: ["Pages use the image-slot contract"],
        },
        {
          title: "Generate the five missing technical category icons",
          job_type: "artificer",
          task_mode: "image",
          needs_image_generation: true,
          task_spec: "Generate PNG icon assets for the technical categories.",
          files_to_modify: [],
          files_to_create: [],
          success_criteria: ["Icon assets exist"],
        },
      ]);

      const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id);
      const byTitle = Object.fromEntries(created.map((job) => [job.title, job]));
      const header = byTitle["Remove the hexagram from the header brand link"];
      const rewire = byTitle["Rewire page imagery and CSS to the STYLE.md image-slot contract"];
      const generate = byTitle["Generate the five missing technical category icons"];

      assert.equal(header.job_type, "dev");
      assert.equal(rewire.job_type, "dev");
      assert.equal(JSON.parse(header.payload_json).task_mode, "code");
      assert.equal(JSON.parse(header.payload_json).needs_image_generation, false);
      assert.equal(JSON.parse(rewire.payload_json).task_mode, "code");
      assert.equal(JSON.parse(rewire.payload_json).needs_image_generation, false);
      assert.equal(generate.job_type, "artificer");
      assert.equal(JSON.parse(generate.payload_json).task_mode, "image");
      assert.equal(JSON.parse(generate.payload_json).needs_image_generation, true);
    } finally {
      queueMod.setSetting("artifact_image_provider", previousImageProvider);
    }
  });

  it("splits blended generated-image and repo-edit tasks by requested output", () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");
    try {
      queueMod.setSetting("artifact_image_provider", "openai");
      const wi = queueMod.createWorkItem("Blended image and artifact routing", "desc");
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: blended output",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [
        {
          title: "Generate decor brief and wire CSS",
          job_type: "artificer",
          task_mode: "image",
          needs_image_generation: true,
          task_spec: "Generate decor-brief.png as a low-opacity background figure, then wire it into CSS.",
          files_to_modify: ["htdocs/assets/css/app.css"],
          files_to_create: [],
          success_criteria: ["decor-brief.png exists and CSS references it"],
        },
      ]);

      const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id);
      const imageJob = created.find((job) => job.title === "Generate images for: Generate decor brief and wire CSS");
      const devJob = created.find((job) => job.title === "Code changes for: Generate decor brief and wire CSS");

      assert.equal(created.length, 2);
      assert.ok(imageJob);
      assert.ok(devJob);
      assert.equal(imageJob.job_type, "artificer");
      assert.equal(devJob.job_type, "dev");
      assert.deepEqual(JSON.parse(imageJob.payload_json).files_to_create.map((file) => path.basename(file)), ["decor-brief.png"]);
      assert.equal(JSON.parse(imageJob.payload_json).needs_image_generation, true);
      assert.equal(JSON.parse(devJob.payload_json).task_mode, "code");
      assert.equal(JSON.parse(devJob.payload_json).needs_image_generation, false);
      assert.deepEqual(JSON.parse(devJob.payload_json).files_to_modify, ["htdocs/assets/css/app.css"]);
      assert.deepEqual(queueMod.getDependencies(devJob.id).map((dep) => dep.depends_on_job_id), [imageJob.id]);
    } finally {
      queueMod.setSetting("artifact_image_provider", previousImageProvider);
    }
  });

  it("adds a promote hop when blended image output targets the repo", () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");
    try {
      queueMod.setSetting("artifact_image_provider", "openai");
      const wi = queueMod.createWorkItem("Blended repo image promotion", "desc");
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: repo image output",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [
        {
          title: "Generate and install hero art",
          job_type: "dev",
          task_mode: "image",
          needs_image_generation: true,
          task_spec: "Generate the hero image and update the homepage to use it.",
          files_to_modify: ["htdocs/index.php"],
          files_to_create: ["htdocs/assets/img/hero.png"],
          success_criteria: ["Homepage references htdocs/assets/img/hero.png"],
        },
      ]);

      const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id);
      const imageJob = created.find((job) => job.title === "Generate images for: Generate and install hero art");
      const promoteJob = created.find((job) => job.title === "Promote images for: Generate and install hero art");
      const devJob = created.find((job) => job.title === "Code changes for: Generate and install hero art");

      assert.equal(created.length, 3);
      assert.equal(imageJob.job_type, "artificer");
      assert.equal(promoteJob.job_type, "promote");
      assert.equal(devJob.job_type, "dev");
      assert.deepEqual(JSON.parse(imageJob.payload_json).files_to_create.map((file) => path.basename(file)), ["hero.png"]);
      assert.deepEqual(
        JSON.parse(promoteJob.payload_json).mappings.map(({ pattern, dest }) => ({ pattern, dest })),
        [{ pattern: "hero.png", dest: "htdocs/assets/img/hero.png" }],
      );
      assert.deepEqual(queueMod.getDependencies(promoteJob.id).map((dep) => dep.depends_on_job_id), [imageJob.id]);
      assert.deepEqual(queueMod.getDependencies(devJob.id).map((dep) => dep.depends_on_job_id), [promoteJob.id]);
      assert.equal(JSON.parse(devJob.payload_json).needs_image_generation, false);
    } finally {
      queueMod.setSetting("artifact_image_provider", previousImageProvider);
    }
  });

  it("deduplicates split image outputs and scopes promote to the upstream artifact task", () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");
    try {
      queueMod.setSetting("artifact_image_provider", "openai");
      const wi = queueMod.createWorkItem("Composite image promotion", "desc");
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: composite image promotion",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [
        {
          title: "Integrate hero and category imagery intentionally on portal, brief, and metrics pages",
          job_type: "dev",
          task_mode: "image",
          needs_image_generation: true,
          task_spec: [
            "Update portal, brief, and metrics pages and generate htdocs/assets/img/cat-composite.png.",
            "Use cat-composite.png intentionally in a composite-summary slot.",
          ].join("\n"),
          files_to_modify: ["htdocs/portal.php", "htdocs/brief.php", "htdocs/metrics.php"],
          files_to_create: ["htdocs/assets/img/cat-composite.png", "cat-composite.png"],
          success_criteria: ["cat-composite.png is rendered intentionally"],
        },
      ]);

      const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id);
      const imageJob = created.find((job) => job.title === "Generate images for: Integrate hero and category imagery intentionally on portal, brief, and metrics pages");
      const promoteJob = created.find((job) => job.title === "Promote images for: Integrate hero and category imagery intentionally on portal, brief, and metrics pages");
      const devJob = created.find((job) => job.title === "Code changes for: Integrate hero and category imagery intentionally on portal, brief, and metrics pages");
      const imagePayload = JSON.parse(imageJob.payload_json);
      const promotePayload = JSON.parse(promoteJob.payload_json);

      assert.equal(created.length, 3);
      assert.deepEqual(imagePayload.files_to_create.map((file) => path.basename(file)), ["cat-composite.png"]);
      assert.equal(imagePayload.success_criteria[0], "Generated image artifact file(s): cat-composite.png");
      assert.equal(promotePayload.source_dir, imagePayload.output_root);
      assert.match(promotePayload.source_dir, /task-01-generate-images-for-integrate-hero-and-c/);
      assert.deepEqual(
        promotePayload.mappings.map(({ pattern, dest }) => ({ pattern, dest })),
        [{ pattern: "cat-composite.png", dest: "htdocs/assets/img/cat-composite.png" }],
      );
      assert.deepEqual(queueMod.getDependencies(promoteJob.id).map((dep) => dep.depends_on_job_id), [imageJob.id]);
      assert.deepEqual(queueMod.getDependencies(devJob.id).map((dep) => dep.depends_on_job_id), [promoteJob.id]);
    } finally {
      queueMod.setSetting("artifact_image_provider", previousImageProvider);
    }
  });

  it("resolves CSS-relative image split promote paths against the edited stylesheet", () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");
    try {
      queueMod.setSetting("artifact_image_provider", "openai");
      const wi = queueMod.createWorkItem("CSS-relative image promotion", "desc");
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: CSS-relative image promotion",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [
        {
          title: "Generate CSS hero image and wire stylesheet",
          job_type: "dev",
          task_mode: "image",
          needs_image_generation: true,
          task_spec: "Generate hero-index.png and update app.css to use url('../img/hero-index.png').",
          files_to_modify: ["htdocs/assets/css/app.css"],
          files_to_create: [],
          success_criteria: ["app.css references ../img/hero-index.png"],
        },
      ]);

      const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id);
      const imageJob = created.find((job) => job.title === "Generate images for: Generate CSS hero image and wire stylesheet");
      const promoteJob = created.find((job) => job.title === "Promote images for: Generate CSS hero image and wire stylesheet");
      const devJob = created.find((job) => job.title === "Code changes for: Generate CSS hero image and wire stylesheet");
      const imagePayload = JSON.parse(imageJob.payload_json);
      const promotePayload = JSON.parse(promoteJob.payload_json);

      assert.equal(created.length, 3);
      assert.equal(promotePayload.source_dir, imagePayload.output_root);
      assert.match(promotePayload.source_dir, /task-01-generate-images-for-generate-css-hero/);
      assert.deepEqual(
        promotePayload.mappings.map(({ pattern, dest }) => ({ pattern, dest })),
        [{ pattern: "hero-index.png", dest: "htdocs/assets/img/hero-index.png" }],
      );
      assert.deepEqual(promotePayload.files_to_create, ["htdocs/assets/img/hero-index.png"]);
      assert.deepEqual(promotePayload.create_roots, ["htdocs/assets/img"]);
      assert.deepEqual(queueMod.getDependencies(promoteJob.id).map((dep) => dep.depends_on_job_id), [imageJob.id]);
      assert.deepEqual(queueMod.getDependencies(devJob.id).map((dep) => dep.depends_on_job_id), [promoteJob.id]);
    } finally {
      queueMod.setSetting("artifact_image_provider", previousImageProvider);
    }
  });

  it("keeps web-root asset paths out of the stylesheet directory during image promotion", () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");
    try {
      queueMod.setSetting("artifact_image_provider", "openai");
      const wi = queueMod.createWorkItem("CSS web-root image promotion", "desc");
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: CSS web-root image promotion",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [
        {
          title: "Generate CSS hero asset and wire stylesheet",
          job_type: "dev",
          task_mode: "image",
          needs_image_generation: true,
          task_spec: "Generate assets/img/hero.png and update app.css to reference it.",
          files_to_modify: ["htdocs/assets/css/app.css"],
          files_to_create: [],
          success_criteria: ["app.css references assets/img/hero.png"],
        },
      ]);

      const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id);
      const promoteJob = created.find((job) => job.title === "Promote images for: Generate CSS hero asset and wire stylesheet");
      const promotePayload = JSON.parse(promoteJob.payload_json);

      assert.deepEqual(
        promotePayload.mappings.map(({ pattern, dest }) => ({ pattern, dest })),
        [{ pattern: "hero.png", dest: "htdocs/assets/img/hero.png" }],
      );
      assert.deepEqual(promotePayload.files_to_create, ["htdocs/assets/img/hero.png"]);
      assert.deepEqual(promotePayload.create_roots, ["htdocs/assets/img"]);
    } finally {
      queueMod.setSetting("artifact_image_provider", previousImageProvider);
    }
  });

  it("does not split greenfield code tasks that only reference existing image assets", () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");
    try {
      queueMod.setSetting("artifact_image_provider", "openai");
      const wi = queueMod.createWorkItem("Wedding frontend", "desc");
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: wedding frontend",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [
        {
          title: "Generate Tulum images",
          job_type: "artificer",
          task_mode: "image",
          needs_image_generation: true,
          task_spec: "Generate hero-bg.jpg and botanical-left.png.",
          files_to_create: ["hero-bg.jpg", "botanical-left.png"],
          success_criteria: ["Images exist"],
          depends_on_index: [],
        },
        {
          title: "Promote Tulum images into repo",
          job_type: "promote",
          mappings: [
            { pattern: "hero-bg.jpg", dest: "assets/images/hero-bg.jpg" },
            { pattern: "botanical-left.png", dest: "assets/images/botanical-left.png" },
          ],
          depends_on_index: [0],
        },
        {
          title: "Create wedding frontend: index.php, assets/css/style.css, assets/js/main.js",
          job_type: "dev",
          task_mode: "code",
          task_spec: [
            "Create the frontend files. Images will already be at assets/images/.",
            "index.php references assets/images/botanical-left.png.",
            "assets/css/style.css uses background: url('../assets/images/hero-bg.jpg') center/cover no-repeat.",
          ].join("\n"),
          files_to_create: ["index.php", "assets/css/style.css", "assets/js/main.js"],
          success_criteria: [
            "index.php references assets/images/botanical-left.png",
            "style.css references ../assets/images/hero-bg.jpg",
          ],
          depends_on_index: [1],
        },
      ]);

      const created = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.id !== planJob.id);
      const frontendJob = created.find((job) => job.title === "Create wedding frontend: index.php, assets/css/style.css, assets/js/main.js");
      const syntheticImageJob = created.find((job) => job.title.startsWith("Generate images for: Create wedding frontend"));
      const syntheticCodeJob = created.find((job) => job.title.startsWith("Code changes for: Create wedding frontend"));
      const promoteJob = created.find((job) => job.title === "Promote Tulum images into repo");

      assert.equal(created.length, 3);
      assert.ok(frontendJob);
      assert.equal(frontendJob.job_type, "dev");
      assert.equal(JSON.parse(frontendJob.payload_json).task_mode, "code");
      assert.equal(syntheticImageJob, undefined);
      assert.equal(syntheticCodeJob, undefined);
      assert.deepEqual(queueMod.getDependencies(frontendJob.id).map((dep) => dep.depends_on_job_id), [promoteJob.id]);

      const invalidEvents = queueMod.getEvents(null, 100)
        .filter((event) => event.event_type === "plan.task_invalid");
      assert.deepEqual(invalidEvents, []);
    } finally {
      queueMod.setSetting("artifact_image_provider", previousImageProvider);
    }
  });

  it("fails image-generation jobs early when the routed provider is unavailable", () => {
    withArtifactProtocols((config) => {
      config.image.provider = "grok";
      config.image.model = "grok-imagine-image";
    }, () => withEnv({ XAI_API_KEY: null }, () => {
      const { queueMod, workerMod } = runtimeModules;
      const wi = queueMod.createWorkItem("Missing grok creds", "desc");
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: Missing grok creds",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      worker.createJobsFromPlan(planJob, [{
        title: "Generate hero image",
        job_type: "artificer",
        task_mode: "image",
        needs_image_generation: true,
        task_spec: "Generate a PNG hero image",
        success_criteria: ["Image exists"],
      }]);

      const created = queueMod.listJobsByWorkItem(wi.id).find((job) => job.id !== planJob.id);
      const refreshed = created ? queueMod.getJob(created.id) : null;
      assert.ok(refreshed);
      assert.equal(refreshed.status, "failed");
      assert.match(refreshed.last_error || "", /Image generation requires an available image provider \(grok\)/);
    }));
  });

  it("fails legacy non-code mutating jobs early when their image route is unavailable", async () => {
    await withArtifactProtocols((config) => {
      config.image.provider = "grok";
      config.image.model = "grok-imagine-image";
    }, () => withEnv({ XAI_API_KEY: null }, async () => {
      const { queueMod, workerMod } = runtimeModules;
      const wi = queueMod.createWorkItem("Legacy dev image route", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Legacy dev image job",
        max_attempts: 1,
        payload_json: JSON.stringify({
          task_mode: "image",
          needs_image_generation: true,
          task_spec: "Generate a PNG hero image",
          success_criteria: ["Image exists"],
        }),
      });
      const lease = queueMod.acquireLease(job.id, "test-worker", 900);
      const leasedJob = queueMod.getJob(job.id);
      leasedJob._leaseToken = lease.leaseToken;
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      await worker.execute(leasedJob);

      const refreshed = queueMod.getJob(job.id);
      assert.equal(refreshed.status, "dead_letter");
      assert.match(refreshed.last_error || "", /Image generation requires an available image provider \(grok\)/);
    }));
  });

  it("normalizes Grok image routes back to the current default image model when config drifts to a code model", () => {
    withArtifactProtocols((config) => {
      config.image.provider = "grok";
      config.image.model = "grok-3-mini";
    }, () => {
      const { queueMod } = runtimeModules;
      const previousImageProvider = queueMod.getSetting("artifact_image_provider");
      try {
        queueMod.setSetting("artifact_image_provider", "grok");
        const resolved = getResolvedImageProtocol();
        const route = runtimeModules.workerMod.resolveImageExecutionProvider({ needs_image_generation: true });
        assert.equal(resolved.provider, "grok");
        assert.equal(resolved.model, "grok-imagine-image-quality");
        assert.equal(route.provider, "grok");
        assert.equal(route.model, resolved.model);
      } finally {
        queueMod.setSetting("artifact_image_provider", previousImageProvider);
      }
    });
  });

  it("keeps grok-imagine-image-quality as a valid routed Grok image model", () => {
    withArtifactProtocols((config) => {
      config.image.provider = "grok";
      config.image.model = "grok-imagine-image-quality";
    }, () => {
      const { queueMod } = runtimeModules;
      const previousImageProvider = queueMod.getSetting("artifact_image_provider");
      const previousGrokImageModel = queueMod.getSetting("grok_image_model");
      try {
        queueMod.setSetting("artifact_image_provider", "grok");
        queueMod.setSetting("grok_image_model", "grok-imagine-image-quality");
        const resolved = getResolvedImageProtocol();
        assert.equal(resolved.provider, "grok");
        assert.equal(resolved.model, "grok-imagine-image-quality");
      } finally {
        queueMod.setSetting("artifact_image_provider", previousImageProvider);
        queueMod.setSetting("grok_image_model", previousGrokImageModel);
      }
    });
  });

  it("keeps grok-imagine-image as a valid routed Grok image model", () => {
    withArtifactProtocols((config) => {
      config.image.provider = "grok";
      config.image.model = "grok-imagine-image";
    }, () => {
      const { queueMod } = runtimeModules;
      const previousImageProvider = queueMod.getSetting("artifact_image_provider");
      const previousGrokImageModel = queueMod.getSetting("grok_image_model");
      try {
        queueMod.setSetting("artifact_image_provider", "grok");
        queueMod.setSetting("grok_image_model", "grok-imagine-image");
        const resolved = getResolvedImageProtocol();
        assert.equal(resolved.provider, "grok");
        assert.equal(resolved.model, "grok-imagine-image");
      } finally {
        queueMod.setSetting("artifact_image_provider", previousImageProvider);
        queueMod.setSetting("grok_image_model", previousGrokImageModel);
      }
    });
  });

  it("normalizes duplicated Grok image suffixes from settings before routing", () => {
    withArtifactProtocols((config) => {
      config.image.provider = "grok";
      config.image.model = "grok-imagine-image-image";
    }, () => {
      const { queueMod } = runtimeModules;
      const previousImageProvider = queueMod.getSetting("artifact_image_provider");
      const previousGrokImageModel = queueMod.getSetting("grok_image_model");
      try {
        queueMod.setSetting("artifact_image_provider", "grok");
        queueMod.setSetting("grok_image_model", "grok-imagine-image-image");
        const resolved = getResolvedImageProtocol();
        assert.equal(resolved.provider, "grok");
        assert.equal(resolved.model, "grok-imagine-image");
      } finally {
        queueMod.setSetting("artifact_image_provider", previousImageProvider);
        queueMod.setSetting("grok_image_model", previousGrokImageModel);
      }
    });
  });

  it("keeps image route overrides out of image-generation job chat assignment", () => {
    withArtifactProtocols((config) => {
      config.image.provider = "claude";
      config.image.model = "sonnet";
    }, () => {
      const { queueMod, workerMod } = runtimeModules;
      const previousImageProvider = queueMod.getSetting("artifact_image_provider");
      const wi = queueMod.createWorkItem("Bad image provider", "desc");
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: Bad image provider",
      });
      const worker = new workerMod.Worker({
        projectDir: path.resolve(__dirname, ".."),
        silent: true,
      });

      try {
        queueMod.setSetting("artifact_image_provider", "openai");
        worker.createJobsFromPlan(planJob, [{
          title: "Generate hero image",
          job_type: "artificer",
          task_mode: "image",
          needs_image_generation: true,
          task_spec: "Generate a PNG hero image",
          success_criteria: ["Image exists"],
        }]);

        const created = queueMod.listJobsByWorkItem(wi.id).find((job) => job.id !== planJob.id);
        const refreshed = created ? queueMod.getJob(created.id) : null;
        assert.ok(refreshed);
        assert.equal(refreshed.status, "queued");
        assert.equal(getResolvedImageProtocol().provider, "openai");
        assert.equal(refreshed.provider, "claude");
        assert.notEqual(refreshed.provider, getResolvedImageProtocol().provider);
      } finally {
        queueMod.setSetting("artifact_image_provider", previousImageProvider);
      }
    });
  });

  it("strips image-generation execution hints from dev-role calls", () => {
    const { workerMod } = runtimeModules;
    const sanitized = workerMod.__testSanitizeExecutionHintsForRole("dev", {
      needsImageGeneration: true,
      taskMode: "code",
      allowWrite: true,
    });
    const untouched = workerMod.__testSanitizeExecutionHintsForRole("artificer", {
      needsImageGeneration: true,
      taskMode: "image",
      allowWrite: true,
    });

    assert.equal(sanitized.needsImageGeneration, false);
    assert.equal(untouched.needsImageGeneration, true);
  });

  it("treats negated approval phrases as rejected", () => {
    const { workerMod } = runtimeModules;
    assert.equal(workerMod.__testClassifyApprovalAnswer("No, I do not approve"), "rejected");
    assert.equal(workerMod.__testClassifyApprovalAnswer("Do not allow this"), "rejected");
  });

  it("times out hung image generation requests and aborts the client call", async () => {
    const { execGenerateImageInternal } = await import("../../../lib/domains/providers/functions/helpers/image-generate-internal.js");
    const { buildScopePredicates, safePath } = await import("../../../lib/functions/toolkit/index.js");
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-image-timeout-"));
    let sawAbort = false;

    try {
      const result = await execGenerateImageInternal({
        prompt: "A small test image",
        path: "out.png",
      }, {
        cwd: scratchDir,
        scopePredicates: buildScopePredicates(scratchDir, { createFiles: ["out.png"] }),
        safePathImpl: safePath,
        imageTimeoutMs: 10,
        buildImageClient: () => ({
          images: {
            generate: (_params, options = {}) => new Promise((_, reject) => {
              options.signal?.addEventListener("abort", () => {
                sawAbort = true;
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              }, { once: true });
            }),
          },
        }),
      });

      assert.match(result, /timed out after 1s/i);
      assert.equal(sawAbort, true);
      assert.equal(fs.existsSync(path.join(scratchDir, "out.png")), false);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
