import {
  it,
  beforeEach,
  assert,
  fs,
  path,
  execFileSync,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  makeWorker,
} from "../support/core-harness.js";

let db;

function removeScratchDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  } catch {}
}

suite("Delete no-op handling", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("treats cleanup tasks as satisfied when scoped files are already absent", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const scratchDir = fs.mkdtempSync(path.join(__dirname, "tmp-delete-noop-"));
    try {
      execFileSync("git", ["init"], { cwd: scratchDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: scratchDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: scratchDir, stdio: "ignore" });
      fs.writeFileSync(path.join(scratchDir, "README.md"), "test\n", "utf-8");
      execFileSync("git", ["add", "README.md"], { cwd: scratchDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: scratchDir, stdio: "ignore" });

      const wi = queueMod.createWorkItem("Cleanup leftover files", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "fix",
        title: "Remove leftover Node.js files as specified",
        payload_json: JSON.stringify({
          task_spec: "Delete the leftover Node.js files.",
          files_to_modify: ["old-node-script.js", "package-lock.json"],
          files_to_create: [],
          create_roots: [],
          success_criteria: ["old-node-script.js is removed", "package-lock.json is removed"],
        }),
      });
      job._worktreePath = scratchDir;

      const worker = makeWorker(workerMod, { projectDir, silent: true }, async () => ({
        output: [
          "--- DEV LOG START ---",
          "status: COMPLETE",
          "summary: Removed leftover Node.js files",
          "--- DEV LOG END ---",
        ].join("\n"),
      }));

      const lease = queueMod.acquireLease(job.id, "test-worker", 900);
      const leasedJob = queueMod.getJob(job.id);
      leasedJob._leaseToken = lease.leaseToken;
      leasedJob._worktreePath = scratchDir;

      await worker.execute(leasedJob);

      assert.equal(queueMod.getJob(job.id).status, "succeeded");
    } finally {
      removeScratchDir(scratchDir);
    }
  });

  it("infers delete targets from cleanup instructions when planner scope omitted them", async () => {
    const { workerMod } = runtimeModules;
    const payload = {
      task_spec: [
        "Remove all Node.js backend files and update project configuration for PHP.",
        "- `server.js`",
        "- `package.json`",
        "- `api/auth.js`",
        "- `src/services/db.js`",
        "Also remove package-lock.json if present.",
      ].join("\n"),
      files_to_modify: [".gitignore", ".env.example"],
      files_to_create: [],
      success_criteria: ["server.js is deleted", "package.json is deleted"],
    };
    const targets = workerMod.__testInferDeletionTargets({
      title: "Cleanup — remove Node.js files",
    }, payload);

    assert.ok(targets.includes("server.js"));
    assert.ok(targets.includes("package.json"));
    assert.ok(targets.includes("api/auth.js"));
    assert.ok(targets.includes("src/services/db.js"));
    assert.ok(targets.includes("package-lock.json"));
    assert.equal(targets.includes("Node.js"), false);
  });

  it("treats file placement tasks as satisfied when destination files already exist", () => {
    const { workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const scratchDir = fs.mkdtempSync(path.join(__dirname, "tmp-placement-noop-"));
    try {
      fs.mkdirSync(path.join(scratchDir, "htdocs", "images"), { recursive: true });
      fs.writeFileSync(path.join(scratchDir, "htdocs", "images", "hero.png"), "png-data", "utf-8");

      const satisfied = workerMod.__testFilePlacementNoopSatisfied({
        title: "Move hero image into htdocs/images",
      }, {
        task_spec: "Move the hero image into htdocs/images.",
        files_to_modify: [],
        files_to_create: ["htdocs/images/hero.png"],
        success_criteria: ["htdocs/images/hero.png exists"],
      }, scratchDir, [
        "--- DEV LOG START ---",
        "status: COMPLETE",
        "summary: htdocs/images/hero.png already exists, no changes needed",
        "--- DEV LOG END ---",
      ].join("\n"));

      assert.equal(satisfied, true);
    } finally {
      removeScratchDir(scratchDir);
    }
  });
});
