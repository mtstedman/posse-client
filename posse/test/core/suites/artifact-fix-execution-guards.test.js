import {
  it,
  assert,
  fs,
  os,
  path,
  suite,
  runtimeModules,
} from "../support/core-harness.js";

let db;

suite("Artifact fix execution guards", () => {
  it("skips the git no-op guard for artifact-mode fix jobs", () => {
    const { workerMod } = runtimeModules;
    assert.equal(
      workerMod.__testRequiresGitNoopCheck(
        { job_type: "fix" },
        { task_mode: "image", output_root: ".posse/resources/artifacts/wi-1/task-01-logo" },
      ),
      false,
    );
    assert.equal(
      workerMod.__testRequiresGitNoopCheck(
        { job_type: "fix" },
        { task_mode: "code", files_to_modify: ["src/app.js"] },
      ),
      true,
    );
  });

  it("validates declared code outputs against committed files and the worktree", async () => {
    const { workerMod } = runtimeModules;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-output-contract-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "app.js"), "app\n", "utf-8");
      fs.writeFileSync(path.join(dir, "src", "new.js"), "new\n", "utf-8");

      const failed = await workerMod.__testValidateDeclaredOutputContract({
        job: { job_type: "dev" },
        payload: {
          files_to_create: ["src/new.js"],
          files_to_modify: ["src/app.js", "src/missing.js"],
        },
        filesCommitted: ["src/app.js"],
        cwd: dir,
      });
      assert.equal(failed.ok, false);
      assert.deepEqual(failed.missingModifies, ["src/missing.js"]);
      assert.deepEqual(failed.untouchedCreates, ["src/new.js"]);
      assert.deepEqual(failed.untouchedModifies, ["src/missing.js"]);

      const passed = await workerMod.__testValidateDeclaredOutputContract({
        job: { job_type: "fix" },
        payload: {
          files_to_create: ["src/new.js"],
          files_to_modify: ["src/app.js"],
        },
        filesCommitted: ["src/app.js", "src/new.js"],
        cwd: dir,
      });
      assert.equal(passed.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recognizes worktree lock timeout errors for penalty-free retry", () => {
    const { workerMod } = runtimeModules;
    const info = workerMod.__testWorktreeLockTimeoutInfo(
      new Error("Timed out waiting for worktree lock: /tmp/project/.posse/worktree-locks/abc.lock"),
    );
    assert.equal(info.timeout, true);
    assert.match(info.lockPath, /abc\.lock/);
  });
});
