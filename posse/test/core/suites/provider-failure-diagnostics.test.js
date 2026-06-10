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
  runtimeAccountSettingsPath,
  createJob,
  resetRuntimeDb,
  writeAccountSettingsDb,
  stubWorkerRole,
  stripDisplayAnsi,
} from "../support/core-harness.js";

let db;

suite("Provider failure diagnostics", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("does not dead-letter distinct provider failures that share a generic exit line", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Retry distinct provider failures", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan with provider failures",
    });

    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const attempt1 = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "planner");
    queueMod.completeAttempt(attempt1.attempt.id, {
      status: "failed",
      error_text: "claude exited 1\nstderr: first root cause",
    });
    const attempt2 = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "planner");
    queueMod.completeAttempt(attempt2.attempt.id, {
      status: "failed",
      error_text: "claude exited 1\nstderr: second root cause",
    });

    const emitted = [];
    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker.emit = (_jobId, msg) => { emitted.push(msg); };

    const err = new Error("claude exited 1\nstderr: third root cause");
    err.stderr = "stderr: third root cause";
    worker._retryOrFail(queueMod.getJob(job.id), lease.leaseToken, err);

    const refreshed = queueMod.getJob(job.id);
    assert.equal(refreshed.status, "queued");
    assert.ok(emitted.some(msg => msg.includes("retrying in")), "expected a retry instead of dead-letter");
    assert.ok(!emitted.some(msg => msg.includes("same error on consecutive attempts")), "distinct stderr should not be treated as the same repeated error");
  });

  it("describes turn-budget retries as requeues instead of failed jobs", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Turn budget wording", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Retry after turn budget",
      max_attempts: 3,
    });

    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const attempt = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "dev");
    queueMod.completeAttempt(attempt.attempt.id, {
      status: "failed",
      error_text: "claude exhausted turn budget (23/22)",
    });

    const emitted = [];
    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker.emit = (_jobId, msg) => { emitted.push(stripDisplayAnsi(msg)); };
    worker._retryOrFail(queueMod.getJob(job.id), lease.leaseToken, "claude exhausted turn budget (23/22)");

    assert.equal(queueMod.getJob(job.id).status, "queued");
    assert.ok(emitted.some(msg => msg.includes("hit turn budget") && msg.includes("requeuing in")));
    assert.equal(emitted.some(msg => msg.includes("failed (attempt")), false);
    const retryEvent = queueMod.getEvents(job.id, 10).find((event) => event.event_type === "job.attempt_failed");
    assert.ok(retryEvent.message.includes("hit turn budget"));
    assert.equal(retryEvent.message.includes("failed"), false);
  });

  it("describes tool-use retries as requeues instead of failed jobs", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Tool-use wording", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Retry after tool use",
      max_attempts: 3,
    });

    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const attempt = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "planner");
    queueMod.completeAttempt(attempt.attempt.id, {
      status: "failed",
      error_text: "claude exited 1\nTool calls (1): Read: lib/worker.js",
    });

    const err = new Error("claude exited 1");
    err.toolUses = [{ tool: "Read", input: { file_path: "lib/worker.js" } }];
    const emitted = [];
    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker.emit = (_jobId, msg) => { emitted.push(stripDisplayAnsi(msg)); };
    worker._retryOrFail(queueMod.getJob(job.id), lease.leaseToken, err);

    assert.equal(queueMod.getJob(job.id).status, "queued");
    assert.ok(emitted.some(msg => msg.includes("stopped during tool use") && msg.includes("requeuing in")));
    assert.equal(emitted.some(msg => msg.includes("failed (attempt")), false);
  });

  it("classifies provider auth and model config errors as permanent", async () => {
    const { isPermanentProviderConfigError } = await import("../../../lib/domains/worker/functions/helpers/diagnostics.js");

    assert.equal(isPermanentProviderConfigError("OpenAI error: 401 Incorrect API key provided"), true);
    assert.equal(isPermanentProviderConfigError("Codex error: model gpt-5.5 is not supported when using Codex"), true);
    assert.equal(isPermanentProviderConfigError("Anthropic overloaded_error: service temporarily overloaded"), false);
    assert.equal(isPermanentProviderConfigError("429 rate limit exceeded; retry later"), false);
    assert.equal(isPermanentProviderConfigError("503: model gateway temporarily unavailable\nhost not found upstream"), false);
    assert.equal(isPermanentProviderConfigError("model overloaded (529)\ncurrently unknown to the load balancer; retry shortly"), false);
    assert.equal(isPermanentProviderConfigError("deployment endpoint did not respond\nresource not found (504)"), false);
    assert.equal(isPermanentProviderConfigError("api key manager reachable\nresource not found upstream"), false);
  });

  it("dead-letters permanent provider config errors without retrying", () => {
    const { queueMod, workerMod, observationsMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Permanent provider config", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Provider config should not retry",
      max_attempts: 3,
      provider: "openai",
      model_tier: "strong",
    });

    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const attempt = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "dev");
    queueMod.completeAttempt(attempt.attempt.id, {
      status: "failed",
      error_text: "OpenAI error: 401 Incorrect API key provided",
    });

    const emitted = [];
    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker.emit = (_jobId, msg) => { emitted.push(stripDisplayAnsi(msg)); };
    worker._retryOrFail(queueMod.getJob(job.id), lease.leaseToken, "OpenAI error: 401 Incorrect API key provided");

    assert.equal(queueMod.getJob(job.id).status, "dead_letter");
    assert.ok(emitted.some((msg) => msg.includes("permanent provider configuration/model error")));
    assert.equal(emitted.some((msg) => msg.includes("retrying in")), false);
    const observations = observationsMod.getObservationsByJob(job.id, 10);
    assert.ok(observations.some((row) => row.summary.includes("permanent provider configuration/model error")));
  });

  it("tags max-attempt dead letters caused by repeated errors", () => {
    const { queueMod, workerMod, observationsMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Repeated max-attempt failure", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Repeat until max",
      max_attempts: 3,
    });

    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    for (let i = 0; i < 3; i++) {
      const attempt = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "dev");
      queueMod.completeAttempt(attempt.attempt.id, {
        status: "failed",
        error_text: "fatal: missing generated dependency",
      });
    }

    const emitted = [];
    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker.emit = (_jobId, msg) => { emitted.push(msg); };
    worker._retryOrFail(queueMod.getJob(job.id), lease.leaseToken, new Error("fatal: missing generated dependency"));

    assert.equal(queueMod.getJob(job.id).status, "dead_letter");
    assert.ok(emitted.some(msg => msg.includes("same error repeated")), "expected same-error reason in worker output");
    const observations = observationsMod.getObservationsByJob(job.id, 10);
    assert.ok(observations.some(row => row.summary.includes("same error repeated")), "expected same-error reason in observations");
  });

  it("requeues a same-error dead-letter when next attempt swaps to a different model", () => {
    // Mirrors the codex setup where cheap and standard tiers map to the same
    // model, so a name-based tier escalation produces no real model change.
    // After two same-error attempts the original dead-letter guard would fire,
    // but attempt 3 would still escalate to a *different* model (strong tier)
    // and deserves another shot.
    const { queueMod, workerMod } = runtimeModules;
    writeAccountSettingsDb(runtimeAccountSettingsPath, {
      codex_model_cheap: "gpt-5.3-codex",
      codex_model_standard: "gpt-5.3-codex",
      codex_model_strong: "gpt-5.5",
      provider_dev: "codex",
    });
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Codex same-error escalation", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Create a file codex keeps not creating",
      max_attempts: 3,
      provider: "codex",
      model_tier: "cheap",
    });
    queueMod.updateJobProvider(job.id, "codex");

    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    // Both prior attempts ran on gpt-5.3-codex (cheap and standard collapse to
    // the same model under these settings) and produced the same failure.
    for (let i = 0; i < 2; i++) {
      const attempt = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "dev", "gpt-5.3-codex");
      queueMod.completeAttempt(attempt.attempt.id, {
        status: "failed",
        error_text: "Git commit failed: Failed to stage createFiles path 'Foo.php'",
      });
    }

    const emitted = [];
    const worker = new workerMod.Worker({ projectDir, silent: true });
    worker.emit = (_jobId, msg) => { emitted.push(stripDisplayAnsi(msg)); };
    worker._retryOrFail(
      queueMod.getJob(job.id),
      lease.leaseToken,
      new Error("Git commit failed: Failed to stage createFiles path 'Foo.php'"),
    );

    assert.equal(queueMod.getJob(job.id).status, "queued", "should requeue when next attempt swaps model");
    assert.ok(
      emitted.some((msg) => msg.includes("next attempt swaps model") && msg.includes("gpt-5.5")),
      "expected model-swap escalation note in worker output",
    );
  });

  it("opens a provider circuit on consecutive fast failures and reroutes retries", () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Circuit breaker reroute", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Reroute after fast failures",
      max_attempts: 5,
      provider: "codex",
    });
    queueMod.updateJobProvider(job.id, "codex");

    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const attempt1 = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "dev");
    queueMod.completeAttempt(attempt1.attempt.id, {
      status: "failed",
      duration_ms: 90,
      error_text: "spawn ENOENT on codex",
    });
    const attempt2 = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "dev");
    queueMod.completeAttempt(attempt2.attempt.id, {
      status: "failed",
      duration_ms: 140,
      error_text: "process exited before startup",
    });
    const attempt3 = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "dev");
    queueMod.completeAttempt(attempt3.attempt.id, {
      status: "failed",
      duration_ms: 220,
      error_text: "tool bootstrap failed instantly",
    });

    const worker = new workerMod.Worker({ projectDir, silent: true });
    const jobForRetry = queueMod.getJob(job.id);
    jobForRetry._allowedProviders = ["codex", "claude"];
    jobForRetry._executionProvider = "codex";

    worker._retryOrFail(jobForRetry, lease.leaseToken, "tool bootstrap failed instantly");

    const refreshed = queueMod.getJob(job.id);
    assert.equal(refreshed.status, "queued");
    assert.equal(refreshed.provider, "claude");
  });

  it("stores provider failure diagnostics with stderr and partial output", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Planner diagnostics", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Planner should leave diagnostics",
    });

    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const leasedJob = queueMod.getJob(job.id);
    leasedJob._leaseToken = lease.leaseToken;

    const worker = new workerMod.Worker({ projectDir, silent: true });
    stubWorkerRole(worker, "plan", async () => {
      const err = new Error("claude exited 1\nfatal: request rejected");
      err.stderr = "fatal: request rejected";
      err.partialOutput = '{"tasks": [';
      err.toolUses = [{ tool: "Read", input: { file_path: "lib/worker.js" } }];
      throw err;
    });

    await worker.execute(leasedJob);

    assert.equal(queueMod.getJob(job.id).status, "queued");
    const artifacts = queueMod.getArtifacts(job.id, "log");
    const diagnostics = artifacts.find(a => a.content_long.includes("## Provider Failure Diagnostics"));
    assert.ok(diagnostics, "expected a diagnostics log artifact");
    assert.match(diagnostics.content_long, /fatal: request rejected/);
    assert.match(diagnostics.content_long, /Partial Output/);
    assert.match(diagnostics.content_long, /Read: lib\/worker\.js/);
    const responses = queueMod.getArtifacts(job.id, "response");
    assert.ok(responses.some(a => a.content_long === '{"tasks": ['), "expected partial output to be recoverable as a response artifact");
    const retryEvents = queueMod.getEvents(job.id, 20).filter((event) => event.event_type === "job.attempt_failed");
    assert.ok(retryEvents.some((event) => event.message.includes("stopped during tool use")));
    assert.equal(retryEvents.some((event) => /Attempt \d+ failed/.test(event.message)), false);
  });

  it("surfaces Claude invalid_client init failures in provider diagnostics and dead-letters without retry", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Planner invalid client diagnostics", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Planner should classify invalid client",
    });

    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const leasedJob = queueMod.getJob(job.id);
    leasedJob._leaseToken = lease.leaseToken;

    const worker = new workerMod.Worker({ projectDir, silent: true });
    stubWorkerRole(worker, "plan", async () => {
      const err = new Error("claude exited 1\nFailed to initialize Claude agent");
      err.stderr = "Failed to initialize Claude agent\nOAuth error: invalid_client";
      throw err;
    });

    await worker.execute(leasedJob);

    assert.equal(queueMod.getJob(job.id).status, "dead_letter");
    const artifacts = queueMod.getArtifacts(job.id, "log");
    const diagnostics = artifacts.find(a => a.content_long.includes("## Provider Failure Diagnostics"));
    assert.ok(diagnostics, "expected a diagnostics log artifact");
    assert.match(diagnostics.content_long, /Summary: claude exited 1 - invalid_client: OAuth error: invalid_client/);
    assert.match(diagnostics.content_long, /Repeat key: invalid_client \| OAuth error: invalid_client/);
  });

  it("stores provider failure diagnostics when only call stats survive", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const wi = queueMod.createWorkItem("Planner diagnostics with no text", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Planner should leave stats-only diagnostics",
    });

    const lease = queueMod.acquireLease(job.id, "test-worker", 900);
    const leasedJob = queueMod.getJob(job.id);
    leasedJob._leaseToken = lease.leaseToken;

    const worker = new workerMod.Worker({ projectDir, silent: true });
    stubWorkerRole(worker, "plan", async () => {
      const err = new Error("claude exited 1");
      err.stats = {
        exitCode: 1,
        durationMs: 147000,
        inputTokens: 12,
        outputTokens: 6974,
        outputChars: 0,
        modelName: "opus",
        maxTurns: 10,
        numTurns: 10,
      };
      throw err;
    });

    await worker.execute(leasedJob);

    assert.equal(queueMod.getJob(job.id).status, "queued");
    const artifacts = queueMod.getArtifacts(job.id, "log");
    const diagnostics = artifacts.find(a => a.content_long.includes("## Provider Failure Diagnostics"));
    assert.ok(diagnostics, "expected stats-only provider failure to leave diagnostics");
    assert.match(diagnostics.content_long, /Call Stats/);
    assert.match(diagnostics.content_long, /"output_tokens": 6974/);
    assert.match(diagnostics.content_long, /"output_chars": 0/);
  });
});
