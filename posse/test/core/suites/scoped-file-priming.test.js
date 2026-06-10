import {
  it,
  beforeEach,
  assert,
  fs,
  path,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  dispatchWorker,
  makeWorker,
} from "../support/core-harness.js";
import { primeCreatableFiles } from "../../../lib/domains/worker/functions/helpers/worktree-lifecycle.js";

let db;

suite("Scoped file priming", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("pre-creates files_to_create and exposes them as editable scope for dev jobs", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const projectDir = path.resolve(__dirname, "..");
    const scratchDir = fs.mkdtempSync(path.join(projectDir, "tmp-scope-"));
    try {
      const wi = queueMod.createWorkItem("Prime create scope", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Create helper module",
        payload_json: JSON.stringify({
          task_spec: "Create a helper module.",
          files_to_modify: [],
          files_to_create: ["src/new-helper.js"],
          create_roots: ["src"],
          success_criteria: ["src/new-helper.js exists"],
        }),
      });
      job._worktreePath = scratchDir;

      let trackedOpts = null;
      const worker = makeWorker(workerMod, { projectDir, silent: true }, async (_prompt, opts) => {
        trackedOpts = opts;
        return {
          output: [
            "--- DEV LOG START ---",
            "status: COMPLETE",
            "files_touched: src/new-helper.js",
            "--- DEV LOG END ---",
          ].join("\n"),
        };
      });

      await dispatchWorker(worker, job, "standard", null);

      const createdPath = path.join(scratchDir, "src", "new-helper.js");
      assert.equal(fs.existsSync(createdPath), true);
      assert.equal(fs.readFileSync(createdPath, "utf-8"), "");
      assert.ok(trackedOpts);
      assert.ok(trackedOpts.scopedFiles.includes("src/new-helper.js"));
      assert.ok(trackedOpts.createFiles.includes("src/new-helper.js"));
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("ignores EEXIST races while priming files_to_create", () => {
    const scratchDir = fs.mkdtempSync(path.join(__dirname, "tmp-prime-race-"));
    const originalWriteFileSync = fs.writeFileSync;
    try {
      fs.writeFileSync = (target, data, opts) => {
        if (opts?.flag === "wx") {
          originalWriteFileSync.call(fs, target, "created by racer", "utf-8");
          const err = new Error("file exists");
          err.code = "EEXIST";
          throw err;
        }
        return originalWriteFileSync.call(fs, target, data, opts);
      };

      const created = primeCreatableFiles(scratchDir, ["src/raced.js"]);

      assert.deepEqual(created, []);
      assert.equal(fs.readFileSync(path.join(scratchDir, "src", "raced.js"), "utf-8"), "created by racer");
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
