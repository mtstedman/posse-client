import {
  it,
  before,
  assert,
  fs,
  path,
  __dirname,
  ARTIFACT_PROTOCOLS_PATH,
  suite,
  runtimeModules,
  now,
  reloadArtifactProtocols,
  getArtifactProtocol,
  validateManifestAgainstContract,
  injectArtifactScope,
  normalizeArtifactCreateFiles,
  buildManifest,
  cleanupArtifactDirs,
  pruneEmptyArtifactDirs,
  artifactsDir,
  inputsDir,
  workspaceDir,
  wiScopeId,
  workItemArtifactRoot,
  artifactTaskOutputRoot,
} from "../support/core-harness.js";

let db;

suite("Artifact protocol routes", () => {
  it("reloads artifact protocol config when the JSON file changes", () => {
    const original = fs.readFileSync(ARTIFACT_PROTOCOLS_PATH, "utf-8");
    try {
      reloadArtifactProtocols();
      const config = JSON.parse(original);
      const originalMax = Number(config.image.max_outputs || 0);
      config.image.max_outputs = originalMax + 37;
      fs.writeFileSync(ARTIFACT_PROTOCOLS_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
      const future = new Date(Date.now() + 2000);
      fs.utimesSync(ARTIFACT_PROTOCOLS_PATH, future, future);

      const updated = getArtifactProtocol("image");
      assert.equal(updated.max_outputs, originalMax + 37);
    } finally {
      fs.writeFileSync(ARTIFACT_PROTOCOLS_PATH, original, "utf-8");
      reloadArtifactProtocols();
    }
  });

  it("uses cached artifact protocols when the config file mtime is unchanged", () => {
    const originalReadFileSync = fs.readFileSync;
    try {
      reloadArtifactProtocols();
      const initial = getArtifactProtocol("image");
      assert.ok(initial);

      let protocolReads = 0;
      fs.readFileSync = (...args) => {
        if (path.resolve(String(args[0])) === path.resolve(ARTIFACT_PROTOCOLS_PATH)) {
          protocolReads += 1;
          throw new Error("artifact protocol config should be served from cache");
        }
        return originalReadFileSync(...args);
      };

      const cached = getArtifactProtocol("image");
      assert.equal(cached, initial);
      assert.equal(protocolReads, 0);
    } finally {
      fs.readFileSync = originalReadFileSync;
      reloadArtifactProtocols();
    }
  });

  it("logs protocol load failures again after an explicit reload", () => {
    const original = fs.readFileSync(ARTIFACT_PROTOCOLS_PATH, "utf-8");
    const originalError = console.error;
    const messages = [];
    try {
      console.error = (...args) => { messages.push(args.map(String).join(" ")); };
      reloadArtifactProtocols();
      fs.writeFileSync(ARTIFACT_PROTOCOLS_PATH, "{ broken json\n", "utf-8");

      getArtifactProtocol("image");
      reloadArtifactProtocols();
      getArtifactProtocol("image");

      const warnings = messages.filter((message) => message.includes("config/artifact-protocols.json not loaded"));
      assert.equal(warnings.length, 2);
    } finally {
      console.error = originalError;
      fs.writeFileSync(ARTIFACT_PROTOCOLS_PATH, original, "utf-8");
      reloadArtifactProtocols();
    }
  });

  it("bounds manifest traversal by depth and file count", () => {
    const root = fs.mkdtempSync(path.join(__dirname, "tmp-artifact-manifest-bounds-"));
    try {
      const deep = path.join(root, "a", "b", "c");
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, "deep.txt"), "deep\n", "utf-8");
      const depthLimited = buildManifest(root, root, { maxDepth: 1 });
      assert.equal(depthLimited.count, 0);
      assert.equal(depthLimited.truncated, false);
      assert.ok(depthLimited.errors.some((message) => message.includes("max_depth")));

      fs.writeFileSync(path.join(root, "one.txt"), "1\n", "utf-8");
      fs.writeFileSync(path.join(root, "two.txt"), "2\n", "utf-8");
      fs.writeFileSync(path.join(root, "three.txt"), "3\n", "utf-8");
      const fileLimited = buildManifest(root, root, { maxDepth: 4, maxFiles: 2 });
      assert.equal(fileLimited.count, 2);
      assert.equal(fileLimited.truncated, true);
      assert.ok(fileLimited.errors.some((message) => message.includes("max_files 2 reached")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips symlinks while building artifact manifests", () => {
    const root = fs.mkdtempSync(path.join(__dirname, "tmp-artifact-manifest-symlink-"));
    try {
      const target = path.join(root, "target");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "hidden.txt"), "hidden\n", "utf-8");
      fs.writeFileSync(path.join(root, "visible.txt"), "visible\n", "utf-8");
      const link = path.join(root, "linked-target");
      try {
        fs.symlinkSync(target, link, "junction");
        fs.symlinkSync(target, path.join(root, "linked-target-2"), "junction");
      } catch {
        return;
      }

      const manifest = buildManifest(root, root);
      const paths = manifest.files.map((file) => file.path);
      assert.ok(paths.includes("visible.txt"));
      assert.ok(paths.includes("target/hidden.txt"));
      assert.ok(!paths.includes("linked-target/hidden.txt"));
      assert.ok(manifest.errors.some((message) => message.includes("symlink")));

      const capped = buildManifest(root, root, { maxErrors: 1 });
      assert.equal(capped.errors.length, 2);
      assert.ok(capped.errors[0].includes("symlink"));
      assert.match(capped.errors[1], /manifest scan errors suppressed/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates image manifests against the configured contract", () => {
    const result = validateManifestAgainstContract({
      count: 2,
      files: [
        { path: "thumb.txt", size: 50, ext: ".txt" },
        { path: "icon.png", size: 512, ext: ".png" },
      ],
    }, "image");

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((msg) => /below minimum size/i.test(msg)));
    assert.ok(result.violations.some((msg) => /disallowed formats/i.test(msg)));
  });

  it("exempts manifest files from the image format check when real deliverables exist", () => {
    const result = validateManifestAgainstContract({
      count: 4,
      files: [
        { path: "rave-hero.png", size: 250000, ext: ".png" },
        { path: "rave-dj.png", size: 180000, ext: ".png" },
        { path: "rave-community.png", size: 150000, ext: ".png" },
        { path: "manifest.json", size: 1200, ext: ".json" },
      ],
    }, "image");

    assert.equal(result.valid, true);
    assert.deepEqual(result.violations, []);
  });

  it("accepts job-linked manifest filenames (manifest-<id>.json) alongside image deliverables", () => {
    const result = validateManifestAgainstContract({
      count: 2,
      files: [
        { path: "rave-hero.png", size: 250000, ext: ".png" },
        { path: "manifest-78.json", size: 1200, ext: ".json" },
      ],
    }, "image");

    assert.equal(result.valid, true);
    assert.deepEqual(result.violations, []);
  });

  it("still fails image outputs that contain only a manifest file", () => {
    const result = validateManifestAgainstContract({
      count: 1,
      files: [
        { path: "manifest.json", size: 1200, ext: ".json" },
      ],
    }, "image");

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((msg) => /No files with allowed formats/.test(msg)));
  });

  it("treats excess image outputs as warnings instead of hard failures", () => {
    const result = validateManifestAgainstContract({
      count: 6,
      files: [
        { path: "hero-bg.png", size: 250000, ext: ".png" },
        { path: "dashboard-banner.png", size: 180000, ext: ".png" },
        { path: "card-style.png", size: 90000, ext: ".png" },
        { path: "card-lyrics.png", size: 92000, ext: ".png" },
        { path: "card-songs.png", size: 91000, ext: ".png" },
        { path: "login-bg.png", size: 170000, ext: ".png" },
      ],
    }, "image");

    assert.equal(result.valid, true);
    assert.deepEqual(result.violations, []);
    assert.ok(result.warnings.some((msg) => /exceeds max_outputs/i.test(msg)));
  });

  it("warns on executable-looking content artifacts without rejecting content mode", () => {
    const result = validateManifestAgainstContract({
      count: 1,
      files: [
        { path: "bundle.exe", size: 4096, ext: ".exe" },
      ],
    }, "content");

    assert.equal(result.valid, true);
    assert.deepEqual(result.violations, []);
    assert.ok(result.warnings.some((msg) => /high-risk extensions/i.test(msg)));
  });

  it("validates intake-processing manifests through a configured protocol", () => {
    assert.ok(getArtifactProtocol("intake_processing"));
    const result = validateManifestAgainstContract({
      count: 1,
      files: [
        { path: "normalized-upload.json", size: 128, ext: ".json" },
      ],
    }, "intake_processing");

    assert.equal(result.valid, true);
    assert.deepEqual(result.violations, []);
  });

  it("injects artifact roots for intake-processing jobs", () => {
    const projectDir = path.resolve(__dirname, "..");
    const payload = {
      task_mode: "intake_processing",
      files_to_modify: [],
      files_to_create: [],
      create_roots: ["custom/output"],
      input_roots: ["seed/input"],
    };

    const scoped = injectArtifactScope(payload, "wi-test-intake", projectDir);

    assert.deepEqual(scoped.files_to_modify, []);
    assert.deepEqual(scoped.files_to_create, []);
    assert.ok(scoped.create_roots.includes(artifactsDir("wi-test-intake", projectDir).replace(/\\/g, "/")));
    assert.ok(scoped.create_roots.includes(workspaceDir("wi-test-intake", projectDir).replace(/\\/g, "/")));
    assert.ok(scoped.input_roots.includes(inputsDir("wi-test-intake", projectDir).replace(/\\/g, "/")));
    assert.equal(scoped.output_root, artifactsDir("wi-test-intake", projectDir).replace(/\\/g, "/"));
  });

  it("preserves artifact file scope even when the planner marker is absent", () => {
    const projectDir = path.resolve(__dirname, "..");
    const scoped = injectArtifactScope({
      task_mode: "report",
      output_root: ".posse/resources/artifacts/wi-test-report/task-02-hybrid",
      create_roots: [".posse/resources/artifacts/wi-test-report/task-02-hybrid"],
      files_to_modify: ["docs/index.md"],
      files_to_create: ["reports/summary.md"],
      files_to_delete: ["docs/old-report.md"],
    }, "wi-test-report", projectDir);
    const expectedRoot = path.resolve(projectDir, ".posse/resources/artifacts/wi-test-report/task-02-hybrid").replace(/\\/g, "/");

    assert.deepEqual(scoped.files_to_modify, ["docs/index.md"]);
    assert.deepEqual(scoped.files_to_create, [`${expectedRoot}/reports/summary.md`]);
    assert.deepEqual(scoped.files_to_delete, ["docs/old-report.md"]);
  });

  it("derives job artifact roots from the work-item artifact namespace", () => {
    const projectDir = path.resolve(__dirname, "..");
    const wiRoot = workItemArtifactRoot(42, projectDir).replace(/\\/g, "/");
    const taskRoot = artifactTaskOutputRoot(42, "task-007-render-hero", projectDir).replace(/\\/g, "/");

    assert.equal(wiRoot, artifactsDir(wiScopeId(42), projectDir).replace(/\\/g, "/"));
    assert.equal(taskRoot, `${wiRoot}/task-007-render-hero`);
  });

  it("preserves explicit artifact subdirectories instead of widening back to the WI root", () => {
    const projectDir = path.resolve(__dirname, "..");
    const scoped = injectArtifactScope({
      task_mode: "image",
      output_root: ".posse/resources/artifacts/wi-test-image/task-01-hero",
      create_roots: [".posse/resources/artifacts/wi-test-image/task-01-hero"],
      input_roots: [],
    }, "wi-test-image", projectDir);

    const expectedRoot = path.resolve(projectDir, ".posse/resources/artifacts/wi-test-image/task-01-hero").replace(/\\/g, "/");
    assert.equal(scoped.output_root, expectedRoot);
    assert.deepEqual(scoped.create_roots, [expectedRoot]);
  });

  it("rejects explicit artifact output roots outside the project", () => {
    const projectDir = path.resolve(__dirname, "..");
    assert.throws(() => injectArtifactScope({
      task_mode: "image",
      output_root: "../../outside-project",
      create_roots: [],
      input_roots: [],
    }, "wi-test-image", projectDir), /escapes project scope/);
  });

  it("validates explicit artifact output roots before creating scope dirs", () => {
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-artifact-invalid-root-"));
    const scopeId = "wi-invalid-root";
    try {
      assert.throws(() => injectArtifactScope({
        task_mode: "image",
        output_root: "../../outside-project",
        create_roots: [],
        input_roots: [],
      }, scopeId, projectDir), /escapes project scope/);

      assert.equal(fs.existsSync(artifactsDir(scopeId, projectDir)), false);
      assert.equal(fs.existsSync(workspaceDir(scopeId, projectDir)), false);
      assert.equal(fs.existsSync(inputsDir(scopeId, projectDir)), false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("rebases planner-provided artifact files_to_create into output_root while preserving relative subpaths", () => {
    const projectDir = path.resolve(__dirname, "..");
    const payload = {
      task_mode: "report",
      output_root: ".posse/resources/artifacts/wi-test-report/task-01-bug-report",
      create_roots: [".posse/resources/artifacts/wi-test-report/task-01-bug-report"],
      files_to_create: [
        ".posse/resources/artifacts/wi-999/bug-report.md",
        "reports/summary.md",
      ],
      _planner_set_files: true,
    };
    const originalFiles = [...payload.files_to_create];
    const scoped = injectArtifactScope(payload, "wi-test-report", projectDir);

    assert.deepEqual(scoped.files_to_create, [
      `${path.resolve(projectDir, ".posse/resources/artifacts/wi-test-report/task-01-bug-report").replace(/\\/g, "/")}/bug-report.md`,
      `${path.resolve(projectDir, ".posse/resources/artifacts/wi-test-report/task-01-bug-report").replace(/\\/g, "/")}/reports/summary.md`,
    ]);
    assert.deepEqual(payload.files_to_create, originalFiles);
    assert.ok(scoped._artifact_scope_warnings.some((warning) => warning.type === "artifact_path_reanchored"));
  });

  it("drops artifact files_to_create entries that traverse outside output_root", () => {
    const warnings = [];
    const normalized = normalizeArtifactCreateFiles(
      ["reports/ok.md", "../../../etc/passwd", "..\\..\\escape.txt"],
      "resources/artifacts/wi-5/task-1",
      { warnings },
    );
    assert.deepEqual(normalized, ["resources/artifacts/wi-5/task-1/reports/ok.md"]);
    assert.equal(warnings.filter((warning) => warning.type === "artifact_path_dropped").length, 2);
  });

  it("preserves safe subpaths when reanchoring rooted artifact files_to_create entries", () => {
    const warnings = [];
    const normalized = normalizeArtifactCreateFiles(
      [".posse/resources/artifacts/wi-999/posters/wide.png"],
      "resources/artifacts/wi-5/task-1",
      { warnings },
    );
    assert.deepEqual(normalized, ["resources/artifacts/wi-5/task-1/posters/wide.png"]);
    assert.ok(warnings.some((warning) => warning.type === "artifact_path_reanchored"));
  });

  it("prunes scope dirs when recursive emptiness checks cannot read them", () => {
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-artifact-prune-unreadable-"));
    const scopeId = "wi-prune-unreadable";
    const scopeDir = artifactsDir(scopeId, projectDir);
    const originalReaddirSync = fs.readdirSync;
    try {
      fs.mkdirSync(scopeDir, { recursive: true });
      fs.readdirSync = (dir, opts) => {
        if (path.resolve(String(dir)) === path.resolve(scopeDir)) {
          const err = new Error("permission denied");
          err.code = "EACCES";
          throw err;
        }
        return originalReaddirSync.call(fs, dir, opts);
      };

      assert.equal(pruneEmptyArtifactDirs(projectDir), 1);
      assert.equal(fs.existsSync(scopeDir), false);
    } finally {
      fs.readdirSync = originalReaddirSync;
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("preserves artifact deliverables by default during direct cleanup", () => {
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-artifact-cleanup-default-"));
    const scopeId = "wi-cleanup-default";
    try {
      fs.mkdirSync(inputsDir(scopeId, projectDir), { recursive: true });
      fs.mkdirSync(workspaceDir(scopeId, projectDir), { recursive: true });
      fs.mkdirSync(artifactsDir(scopeId, projectDir), { recursive: true });
      fs.writeFileSync(path.join(inputsDir(scopeId, projectDir), "upload.txt"), "input\n", "utf-8");
      fs.writeFileSync(path.join(workspaceDir(scopeId, projectDir), "scratch.txt"), "scratch\n", "utf-8");
      const deliverablePath = path.join(artifactsDir(scopeId, projectDir), "report.md");
      fs.writeFileSync(deliverablePath, "done\n", "utf-8");

      cleanupArtifactDirs(scopeId, projectDir);

      assert.equal(fs.existsSync(inputsDir(scopeId, projectDir)), false);
      assert.equal(fs.existsSync(workspaceDir(scopeId, projectDir)), false);
      assert.equal(fs.existsSync(deliverablePath), true);

      cleanupArtifactDirs(scopeId, projectDir, { keepArtifacts: false });
      assert.equal(fs.existsSync(artifactsDir(scopeId, projectDir)), false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("cleans transient artifact inputs and workspace on terminal cleanup while preserving deliverables", async () => {
    const { cleanupWorktreeIfDone } = await import("../../../lib/domains/worker/functions/helpers/worktree-lifecycle.js");
    const { queueMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-artifact-terminal-cleanup-"));
    try {
      const wi = queueMod.createWorkItem("Artifact cleanup", "desc");
      const scopeId = wiScopeId(wi.id);
      fs.mkdirSync(inputsDir(scopeId, projectDir), { recursive: true });
      fs.mkdirSync(workspaceDir(scopeId, projectDir), { recursive: true });
      fs.mkdirSync(artifactsDir(scopeId, projectDir), { recursive: true });
      fs.writeFileSync(path.join(inputsDir(scopeId, projectDir), "upload.txt"), "input\n", "utf-8");
      fs.writeFileSync(path.join(workspaceDir(scopeId, projectDir), "scratch.txt"), "scratch\n", "utf-8");
      fs.writeFileSync(path.join(artifactsDir(scopeId, projectDir), "report.md"), "done\n", "utf-8");

      queueMod.updateWorkItemStatus(wi.id, "complete");
      cleanupWorktreeIfDone({ projectDir, silent: true, display: null }, wi.id);

      assert.equal(fs.existsSync(inputsDir(scopeId, projectDir)), false);
      assert.equal(fs.existsSync(workspaceDir(scopeId, projectDir)), false);
      assert.equal(fs.existsSync(path.join(artifactsDir(scopeId, projectDir), "report.md")), true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
