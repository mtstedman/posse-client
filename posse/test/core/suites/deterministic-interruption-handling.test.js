import {
  it,
  before,
  beforeEach,
  after,
  assert,
  fs,
  path,
  execFileSync,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  artifactsDir,
  wiScopeId,
} from "../support/core-harness.js";

let db;

suite("Deterministic interruption handling", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("does not unblock original jobs after a human_input lease-expiry interruption", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Human interruption", "desc");
    const original = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Needs review",
    });
    queueMod.updateJobStatus(original.id, "waiting_on_review");

    const humanJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Review gate",
      parent_job_id: original.id,
      payload_json: JSON.stringify({
        original_job_id: original.id,
        review_type: "assessment_transport_error",
        questions: ["Retry?"],
      }),
    });

    const lease = queueMod.acquireLease(humanJob.id, "test-worker", 900);
    const leasedJob = queueMod.getJob(humanJob.id);
    leasedJob._leaseToken = lease.leaseToken;

    let resolveDisplay;
    const display = {
      askQuestions: () => new Promise((resolve) => { resolveDisplay = resolve; }),
      workerLine: () => {},
    };

    const worker = new workerMod.Worker({ projectDir: path.resolve(__dirname, ".."), silent: true, display });
    const execution = worker.execute(leasedJob);
    await new Promise((resolve) => setTimeout(resolve, 10));
    worker.killJob(humanJob.id, "lease_expired");
    await execution;

    assert.equal(queueMod.getJob(original.id).status, "waiting_on_review");
    assert.equal(queueMod.getJob(humanJob.id).status, "queued");
    resolveDisplay?.([]);
  });

  it("requeues promote jobs killed by lease expiry before committing", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-promote-interrupt-"));
    const originalCopyFileSync = fs.copyFileSync;
    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "README.md"), "base\n", "utf-8");
      execFileSync("git", ["add", "README.md"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wi = queueMod.createWorkItem("Promote interruption", "desc");
      const sourceDir = path.join(artifactsDir(wiScopeId(wi.id), projectDir), "task-01-promote-interruption");
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(path.join(sourceDir, "hero.png"), "png-data", "utf-8");

      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "promote",
        title: "Promote image",
        payload_json: JSON.stringify({
          task_mode: "report",
          source_dir: sourceDir,
          mappings: [{ pattern: "hero.png", dest: "public/images" }],
        }),
      });

      const lease = queueMod.acquireLease(job.id, "test-worker", 900);
      const leasedJob = queueMod.getJob(job.id);
      leasedJob._leaseToken = lease.leaseToken;

      const worker = new workerMod.Worker({ projectDir, silent: true });
      let killIssued = false;
      fs.copyFileSync = (...args) => {
        originalCopyFileSync(...args);
        if (!killIssued) {
          killIssued = true;
          worker.killJob(job.id, "lease_expired");
        }
      };

      await worker.execute(leasedJob);

      assert.equal(queueMod.getJob(job.id).status, "queued");
      const headMessage = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: projectDir, encoding: "utf-8" }).trim();
      assert.equal(headMessage, "init");
    } finally {
      fs.copyFileSync = originalCopyFileSync;
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
