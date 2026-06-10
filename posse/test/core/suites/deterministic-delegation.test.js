import {
  it,
  before,
  assert,
  path,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  withEnv,
  stubWorkerRole,
  getResolvedImageProtocol,
} from "../support/core-harness.js";

let db;

suite("Deterministic delegation", () => {
  it("maps artificer jobs to the artificer provider role", () => {
    const { workerMod } = runtimeModules;
    assert.equal(workerMod.__testDelegationRoleForJobType("artificer"), "artificer");
    assert.equal(workerMod.__testDelegationRoleForJobType("dev"), "dev");
  });

  it("preserves a pinned artificer chat provider for image tasks", () => {
    const { workerMod } = runtimeModules;
    const assignments = workerMod.__testBuildDeterministicDelegations([{
      job_id: 22,
      model_tier: "cheap",
      reasoning_effort: "low",
      priority: "normal",
    }], {
      providerMap: {
        artificer: ["claude", "openai"],
      },
      getJobById: () => ({
        id: 22,
        job_type: "artificer",
        provider: "openai",
        model_tier: "cheap",
        reasoning_effort: "low",
        priority: "normal",
        payload_json: JSON.stringify({ task_mode: "image", needs_image_generation: true }),
      }),
    });

    assert.equal(assignments.length, 1);
    assert.equal(assignments[0].provider, "openai");
    assert.match(assignments[0].reason, /planner-pinned provider preserved/i);
  });

  it("round-robins multi-provider dev routing deterministically", () => {
    const { workerMod } = runtimeModules;
    const assignments = workerMod.__testBuildDeterministicDelegations([{
      job_id: 11,
      model_tier: "standard",
      reasoning_effort: "low",
      priority: "normal",
    }, {
      job_id: 12,
      model_tier: "standard",
      reasoning_effort: "low",
      priority: "normal",
    }, {
      job_id: 13,
      model_tier: "standard",
      reasoning_effort: "low",
      priority: "normal",
    }], {
      providerMap: {
        dev: ["claude", "openai"],
      },
      getProviderCapacity: () => ({
        blocked: false,
        reason: "",
        source: "available",
        retryInSec: 0,
      }),
      getJobById: (id) => ({
        id,
        job_type: "dev",
        model_tier: "standard",
        reasoning_effort: "low",
        priority: "normal",
        payload_json: JSON.stringify({ task_mode: "code" }),
      }),
    });

    assert.equal(assignments.length, 3);
    assert.deepEqual(assignments.map((entry) => entry.provider), ["claude", "openai", "claude"]);
    assert.match(assignments[0].reason, /round-robin selected claude/i);
    assert.match(assignments[1].reason, /round-robin selected openai/i);
  });

  it("skips usage-capped providers during deterministic routing", () => {
    const { workerMod } = runtimeModules;
    const assignments = workerMod.__testBuildDeterministicDelegations([{
      job_id: 11,
      model_tier: "standard",
      reasoning_effort: "low",
      priority: "normal",
    }, {
      job_id: 12,
      model_tier: "standard",
      reasoning_effort: "low",
      priority: "normal",
    }], {
      providerMap: {
        dev: ["claude", "openai"],
      },
      getProviderCapacity: (providerName) => ({
        blocked: providerName === "openai",
        reason: providerName === "openai" ? "Week (7d) token cap exhausted" : "",
        source: providerName === "openai" ? "usage_limit" : "available",
        retryInSec: providerName === "openai" ? 3600 : 0,
      }),
      getJobById: (id) => ({
        id,
        job_type: "dev",
        model_tier: "standard",
        reasoning_effort: "low",
        priority: "normal",
        payload_json: JSON.stringify({ task_mode: "code" }),
      }),
    });

    assert.equal(assignments.length, 2);
    assert.deepEqual(assignments.map((entry) => entry.provider), ["claude", "claude"]);
    assert.match(assignments[0].reason, /single available dev provider/i);
  });

  it("routes image artificer chat through the artificer provider pool", () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");
    try {
      queueMod.setSetting("artifact_image_provider", "openai");
      const assignments = workerMod.__testBuildDeterministicDelegations([{
        job_id: 22,
        model_tier: "cheap",
        reasoning_effort: "low",
        priority: "normal",
      }], {
        providerMap: {
          artificer: ["claude", "openai"],
        },
        getProviderCapacity: () => ({
          blocked: false,
          reason: "",
          source: "available",
          retryInSec: 0,
        }),
        getJobById: () => ({
          id: 22,
          job_type: "artificer",
          model_tier: "cheap",
          reasoning_effort: "low",
          priority: "normal",
          payload_json: JSON.stringify({ task_mode: "image", needs_image_generation: true }),
        }),
      });

      assert.equal(assignments.length, 1);
      assert.equal(assignments[0].provider, "claude");
      // model is null by design: job.model_name holds the chat model, not the
      // image-generation model. The image model is resolved by the generate_image
      // tool from settings at call time (and lives at getResolvedImageProtocol().model).
      assert.equal(assignments[0].model, null);
    } finally {
      queueMod.setSetting("artifact_image_provider", previousImageProvider);
    }
  });

  it("keeps routed image providers out of persisted chat provider without polluting model_name", async () => withEnv({ XAI_API_KEY: "test-key" }, async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const previousProvider = queueMod.getSetting("provider_artificer");
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");
    const previousGrokImageModel = queueMod.getSetting("grok_image_model");
    try {
      queueMod.setSetting("provider_artificer", "claude");
      queueMod.setSetting("artifact_image_provider", "grok");
      queueMod.setSetting("grok_image_model", "grok-imagine-image-pro");

      const wi = queueMod.createWorkItem("Image route persistence", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "artificer",
        title: "Generate routed image",
        model_tier: "strong",
        payload_json: JSON.stringify({
          task_mode: "image",
          needs_image_generation: true,
          output_root: ".posse/resources/artifacts/wi-route-persist",
          create_roots: [".posse/resources/artifacts/wi-route-persist"],
        }),
      });

      const lease = queueMod.acquireLease(job.id, "test-worker", 900);
      const leasedJob = queueMod.getJob(job.id);
      leasedJob._leaseToken = lease.leaseToken;

      const worker = new workerMod.Worker({ projectDir, silent: true });
      stubWorkerRole(worker, "artificer", async () => [
        "--- ARTIFICER LOG START ---",
        "status: COMPLETE",
        "summary: done",
        "deliverables: neon.png",
        "criteria_check: ok",
        "--- ARTIFICER LOG END ---",
      ].join("\n"));

      await worker.execute(leasedJob);

      const refreshed = queueMod.getJob(job.id);
      assert.equal(getResolvedImageProtocol().provider, "grok");
      assert.equal(refreshed.provider, null);
      // model_name must NOT be the image-only model — that string is for the
      // generate_image tool only and crashes chat calls (assessor/fix/summary).
      assert.notEqual(refreshed.model_name, "grok-imagine-image-pro");
    } finally {
      if (previousProvider == null) queueMod.deleteSetting?.("provider_artificer");
      else queueMod.setSetting("provider_artificer", previousProvider);
      if (previousImageProvider == null) queueMod.deleteSetting?.("artifact_image_provider");
      else queueMod.setSetting("artifact_image_provider", previousImageProvider);
      if (previousGrokImageModel == null) queueMod.deleteSetting?.("grok_image_model");
      else queueMod.setSetting("grok_image_model", previousGrokImageModel);
    }
  }));

  it("clears a stale image-only model_name from a prior run when re-routing", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const previousProvider = queueMod.getSetting("provider_artificer");
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");
    const previousGrokImageModel = queueMod.getSetting("grok_image_model");
    try {
      queueMod.setSetting("provider_artificer", "grok");
      queueMod.setSetting("artifact_image_provider", "grok");
      queueMod.setSetting("grok_image_model", "grok-imagine-image-pro");

      const wi = queueMod.createWorkItem("Image route stale clear", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "artificer",
        title: "Generate routed image",
        model_tier: "strong",
        payload_json: JSON.stringify({
          task_mode: "image",
          needs_image_generation: true,
          output_root: ".posse/resources/artifacts/wi-route-stale",
          create_roots: [".posse/resources/artifacts/wi-route-stale"],
        }),
      });
      // Simulate legacy data: a prior run wrote the image-only model into the
      // chat-model column. Routing must scrub it before any chat call fires.
      queueMod.updateJobProvider(job.id, "grok", "grok-imagine-image-pro");

      const lease = queueMod.acquireLease(job.id, "test-worker", 900);
      const leasedJob = queueMod.getJob(job.id);
      leasedJob._leaseToken = lease.leaseToken;

      const worker = new workerMod.Worker({ projectDir, silent: true });
      stubWorkerRole(worker, "artificer", async () => [
        "--- ARTIFICER LOG START ---",
        "status: COMPLETE",
        "summary: done",
        "deliverables: neon.png",
        "criteria_check: ok",
        "--- ARTIFICER LOG END ---",
      ].join("\n"));

      await worker.execute(leasedJob);

      const refreshed = queueMod.getJob(job.id);
      assert.equal(refreshed.provider, "grok");
      assert.equal(refreshed.model_name, null);
    } finally {
      if (previousProvider == null) queueMod.deleteSetting?.("provider_artificer");
      else queueMod.setSetting("provider_artificer", previousProvider);
      if (previousImageProvider == null) queueMod.deleteSetting?.("artifact_image_provider");
      else queueMod.setSetting("artifact_image_provider", previousImageProvider);
      if (previousGrokImageModel == null) queueMod.deleteSetting?.("grok_image_model");
      else queueMod.setSetting("grok_image_model", previousGrokImageModel);
    }
  });

  it("uses the tier text model for chat when job.model_name is image-only (every role)", () => {
    // Defense-in-depth: even if an image-only model leaks into job.model_name
    // (legacy data, delegator hallucination, stale row), no chat call should
    // ever ship that model string. Previously the guard was role-gated to
    // artificer/dev, which let the assessor crash with claude exit 1 on
    // "grok-imagine-image".
    const { workerMod } = runtimeModules;
    for (const role of ["artificer", "dev", "assessor", "fix", "researcher", "planner", "delegate"]) {
      const resolved = workerMod.__testResolvePrimaryExecutionModelName(
        "grok-imagine-image-pro",
        { role, needsImageGeneration: role === "artificer" || role === "dev" },
        { model: "grok-code-fast-1" },
      );
      assert.equal(resolved, "grok-code-fast-1", `role=${role} should fall back to tier text model`);
    }

    const nonImage = workerMod.__testResolvePrimaryExecutionModelName(
      "grok-code-fast-1",
      { role: "artificer", needsImageGeneration: true },
      { model: "grok-4" },
    );
    assert.equal(nonImage, "grok-code-fast-1");
  });

  it("ignores pinned providers that are no longer enabled for the role", () => {
    const { workerMod } = runtimeModules;
    const resolved = workerMod.__testResolveExecutionProviderFromSettings("grok", ["codex"], "dev");
    assert.equal(resolved.provider, "codex");
    assert.equal(resolved.ignoredPinnedProvider, true);
    assert.equal(resolved.honoredPinnedProvider, false);

    const honored = workerMod.__testResolveExecutionProviderFromSettings("codex", ["codex"], "dev");
    assert.equal(honored.provider, "codex");
    assert.equal(honored.honoredPinnedProvider, true);
    assert.equal(honored.ignoredPinnedProvider, false);
  });

  it("does not preserve stale pinned providers during deterministic delegation", () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Pinned provider drift", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Fix route",
      provider: "grok",
      model_name: "grok-code-fast-1",
      model_tier: "cheap",
    });

    const assignments = workerMod.__testBuildDeterministicDelegations(
      [{ job_id: job.id, title: "Fix route", job_type: "dev", model_tier: "cheap" }],
      {
        providerMap: { dev: ["codex"], assessor: ["claude"], artificer: ["claude"] },
        getJobById: (id) => queueMod.getJob(id),
      },
    );

    assert.ok(Array.isArray(assignments));
    assert.equal(assignments[0].provider, "codex");
    assert.equal(assignments[0].model ?? null, null);
  });
});
