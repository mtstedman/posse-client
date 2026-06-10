import {
  it,
  assert,
  fs,
  os,
  path,
  execFileSync,
  suite,
  ensureProjectMap,
  ensureProjectMapRebuildHook,
  generateProjectMap,
  getCachedProjectMap,
} from "../support/core-harness.js";

let db;

suite("Project map", () => {
  function commitAll(repoDir, message) {
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: ["ignore", "ignore", "pipe"] });
    execFileSync("git", [
      "-c", "user.name=Posse Test",
      "-c", "user.email=posse-test@example.com",
      "commit",
      "-m", message,
    ], { cwd: repoDir, stdio: ["ignore", "ignore", "pipe"] });
  }

  it("generates, caches, and invalidates a project map by HEAD", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-project-map-"));
    try {
      fs.mkdirSync(path.join(repoDir, "lib", "queue"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, "lib", "worker", "roles"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, "test"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, "prompts"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, "lib", "queue.js"), "export const queue = true;\n", "utf8");
      fs.writeFileSync(path.join(repoDir, "lib", "queue", "locks.js"), "export const locks = true;\n", "utf8");
      fs.writeFileSync(path.join(repoDir, "lib", "worker", "roles", "researcher.js"), "export const role = 'researcher';\n", "utf8");
      fs.writeFileSync(path.join(repoDir, "test", "core.test.js"), "export const test = true;\n", "utf8");
      fs.writeFileSync(path.join(repoDir, "prompts", "researcher.md"), "Research.\n", "utf8");
      execFileSync("git", ["init"], { cwd: repoDir, stdio: ["ignore", "ignore", "pipe"] });
      commitAll(repoDir, "initial");

      const generated = generateProjectMap(repoDir);
      assert.ok(generated.head_sha);
      assert.deepEqual(generated.modules.queue, ["lib/queue.js", "lib/queue/", "lib/queue/locks.js"]);
      assert.ok(generated.modules.worker.includes("lib/worker/"));
      assert.ok(generated.module_aliases.queue.includes("lib/queue"));
      assert.ok(generated.module_aliases.queue.includes("lib/queue/locks.js"));

      const first = ensureProjectMap(repoDir);
      assert.equal(fs.existsSync(path.join(repoDir, ".posse", "project-map.json")), true);
      assert.equal(getCachedProjectMap(repoDir).head_sha, first.head_sha);
      const warm = ensureProjectMap(repoDir);
      assert.equal(warm.generated_at, first.generated_at);

      fs.writeFileSync(path.join(repoDir, "lib", "worker", "queue-runner.js"), "export const runner = true;\n", "utf8");
      commitAll(repoDir, "worker update");
      const updated = ensureProjectMap(repoDir);
      assert.notEqual(updated.head_sha, first.head_sha);
      assert.ok(updated.modules.worker.includes("lib/worker/queue-runner.js"));
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("installs a managed post-commit rebuild hook without removing existing hook content", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-project-map-hook-"));
    try {
      execFileSync("git", ["init"], { cwd: repoDir, stdio: ["ignore", "ignore", "pipe"] });
      const hooksDir = path.join(repoDir, ".git", "hooks");
      const hookPath = path.join(hooksDir, "post-commit");
      fs.writeFileSync(hookPath, "#!/bin/sh\necho user-hook\n", "utf8");

      const report = ensureProjectMapRebuildHook({ cwd: repoDir });

      assert.equal(report.attempted, true);
      assert.equal(report.ok, true);
      const hook = fs.readFileSync(hookPath, "utf8");
      assert.match(hook, /echo user-hook/);
      assert.match(hook, /POSSE PROJECT MAP/);
      assert.match(hook, /project-map\.js/);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
