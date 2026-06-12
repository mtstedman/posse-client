import {
  it,
  after,
  assert,
  fs,
  os,
  path,
  execFileSync,
  spawnSync,
  __dirname,
  suite,
  runtimeModules,
  createJob,
} from "../support/core-harness.js";

let db;

function fakeGitHistoryManager(capture = []) {
  return {
    shouldUse(name) {
      assert.equal(name, "git");
      return true;
    },
    binary(name) {
      assert.equal(name, "git");
      return {
        runSync(command, args, opts) {
          assert.equal(command, "git.history");
          assert.deepEqual(args, []);
          const envelope = JSON.parse(String(opts.input));
          const payload = envelope.payload;
          capture.push(payload);
          let data = "No results.";
          if (!fs.existsSync(path.join(payload.cwd, ".git"))) {
            data = "Error: git_history can only run inside a git repository.";
          } else if (String(payload.ref || "").includes(";") || String(payload.ref || "").startsWith("--")) {
            data = "Error: ref contains unsupported characters.";
          } else if (payload.path && (
            (Array.isArray(payload.scopeFiles) && payload.scopeFiles.length > 0)
            || (Array.isArray(payload.scopeRoots) && payload.scopeRoots.length > 0)
          )) {
            const inFileScope = Array.isArray(payload.scopeFiles) && payload.scopeFiles.includes(payload.path);
            const inRootScope = Array.isArray(payload.scopeRoots) && payload.scopeRoots.some((root) => (
              root === "*" || payload.path === root || payload.path.startsWith(`${root}/`)
            ));
            if (!inFileScope && !inRootScope) {
              data = "Error: path is outside the active file scope.";
            }
          } else if (payload.op === "log") {
            data = "abc1234\tTest User\t2026-01-01\tsecond\n123abcd\tTest User\t2026-01-01\tfirst";
          } else if (payload.op === "show") {
            data = "CommitDate: 2026-01-01";
          } else if (payload.op === "blame") {
            data = "1\tabc1234\tTest User\t2026-01-01\tline-1";
          } else if (payload.op === "diff") {
            data = "diff --git a/tracked.txt b/tracked.txt\n... 300 more lines";
          }
          const json = { ok: true, data };
          return { ok: true, code: 0, stdout: JSON.stringify(json), stderr: "", error: null, json };
        },
      };
    },
  };
}

suite("Deterministic toolkit", () => {
  it("documents chain_read continuation paging in the tool descriptor", async () => {
    const { TOOL_CHAIN_READ } = await import("../../../lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js");
    assert.match(TOOL_CHAIN_READ.description, /Large files may be paged with offset\/limit/);
    assert.match(TOOL_CHAIN_READ.description, /continuation pages for the same file are allowed/);
    assert.doesNotMatch(TOOL_CHAIN_READ.description, /each file may only be read once/);
  });

  it("logs deterministic tool calls directly from the toolkit using observation context", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const { observationsMod, queueMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-tool-logging-"));

    try {
      fs.writeFileSync(path.join(projectDir, "alpha.txt"), "hello\nworld\n");
      const wi = queueMod.createWorkItem("Toolkit logging", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Deterministic toolkit logging job",
      });
      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scope = toolkitMod.buildScopePredicates(projectDir, {});

      await observationsMod.runWithObservationContext({
        work_item_id: wi.id,
        job_id: job.id,
        attempt_id: null,
      }, async () => {
        toolkit.execReadFile({ path: "alpha.txt" }, projectDir, scope);
        toolkit.execListFiles({ directory: ".", recursive: false }, projectDir, scope);
      });

      const rows = observationsMod.getObservationsByJob(job.id, 20);
      const summaries = rows.map((row) => `${row.observation_type}:${row.summary}`);
      assert.ok(summaries.some((s) => /tool\.read:Read: alpha\.txt/.test(s)));
      assert.ok(summaries.some((s) => /tool\.list:List: \./.test(s)));
    } finally {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("falls back to the Windows shell when argv execution cannot find an allowlisted command", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-bash-win-fallback-"));

    try {
      const calls = [];
      const bash = toolkitMod.createBashExecutor({
        platform: "win32",
        spawnSyncImpl(command, args, options) {
          calls.push({ type: "spawn", command, args, options });
          return {
            error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
            stdout: "",
            stderr: "",
            status: null,
          };
        },
        execSyncImpl(command, options) {
          calls.push({ type: "exec", command, options });
          return "hello\r\n";
        },
      });

      assert.equal(bash({ command: "echo hello" }, projectDir, false, false), "hello");
      assert.equal(calls.length, 2);
      assert.equal(calls[0].command, "echo");
      assert.deepEqual(calls[0].args, ["hello"]);
      assert.equal(calls[0].options.shell, false);
      assert.equal(calls[1].command, "echo hello");
      assert.equal(calls[1].options.shell, true);
    } finally {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("uses one shared read-only suite for file reads, search, listing, and inspection", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-toolkit-"));
    const siblingRoot = path.resolve(projectDir, "..", ".posse", "resources", "artifacts", "wi-1", "shared");
    const managedExternalRoot = path.resolve(projectDir, "..", ".posse");
    try {
      const nestedDir = path.join(projectDir, "nested");
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "alpha.txt"), "hello\nworld\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, ".env"), "SERVICE_ACCESS_TOKEN=do-not-inspect\n", "utf-8");
      fs.writeFileSync(path.join(nestedDir, "beta.js"), "const marker = 'world';\n", "utf-8");
      fs.mkdirSync(path.join(projectDir, "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "node_modules", "skip.txt"), "should not appear", "utf-8");
      fs.mkdirSync(path.join(projectDir, ".posse-worktrees", "wi-1"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, ".posse-worktrees", "wi-1", "hidden.txt"), "hidden worktree\n", "utf-8");
      fs.mkdirSync(path.join(projectDir, ".posse-test-suites", "area"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, ".posse-test-suites", "area", "suite.test.js"), "hidden test suite\n", "utf-8");
      const pngPath = path.join(projectDir, "pixel.png");
      const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9kAAAAASUVORK5CYII=";
      fs.writeFileSync(pngPath, Buffer.from(pngBase64, "base64"));

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scope = toolkitMod.buildScopePredicates(projectDir, { createRoots: [projectDir, siblingRoot] });

      const readResult = toolkit.execReadFile({ path: "alpha.txt" }, projectDir, scope);
      assert.match(readResult, /1\s+hello/);

      const listResult = toolkit.execListFiles({ directory: ".", recursive: true }, projectDir, scope);
      assert.match(listResult, /alpha\.txt/);
      assert.match(listResult, /nested[\\/]beta\.js/);
      assert.doesNotMatch(listResult, /node_modules[\\/]skip\.txt/);
      assert.doesNotMatch(listResult, /\.posse-worktrees/);
      assert.doesNotMatch(listResult, /\.posse-test-suites/);
      assert.throws(
        () => toolkitMod.safePath(projectDir, ".posse-worktrees/wi-1/hidden.txt", scope),
        /private workspace metadata/,
      );
      assert.throws(
        () => toolkitMod.safePath(projectDir, ".posse-test-suites/area/suite.test.js", scope),
        /private workspace metadata/,
      );

      const searchResult = toolkit.execSearchFiles({ pattern: "world", path: "." }, projectDir, scope);
      assert.match(searchResult, /alpha\.txt:2:world/);
      assert.match(searchResult, /beta\.js:1:const marker = 'world';/);

      const inspectResult = JSON.parse(toolkit.execInspectFile({ path: "pixel.png" }, projectDir, scope));
      assert.equal(inspectResult.exists, true);
      assert.equal(inspectResult.format, "png");
      assert.equal(inspectResult.width, 1);
      assert.equal(inspectResult.height, 1);
      const envInspectResult = JSON.parse(toolkit.execInspectFile({ path: ".env" }, projectDir, scope));
      assert.equal(envInspectResult.exists, false);
      assert.match(envInspectResult.error, /Access to \.env files is blocked/);
      assert.equal(envInspectResult.size, undefined);

      const resizeResult = JSON.parse(toolkit.execResizeImage({
        path: "pixel.png",
        output_path: "pixel-2x3.png",
        width: 2,
        height: 3,
        mode: "stretch",
      }, projectDir, scope));
      assert.equal(resizeResult.ok, true);
      const resizedInspect = JSON.parse(toolkit.execInspectFile({ path: "pixel-2x3.png" }, projectDir, scope));
      assert.equal(resizedInspect.width, 2);
      assert.equal(resizedInspect.height, 3);

      // Batch form: echoes each input as `loc`, per-item missing-file doesn't poison the batch
      const batchResult = JSON.parse(toolkit.execInspectFile(
        { paths: ["pixel.png", "pixel-2x3.png", "does-not-exist.png"] },
        projectDir,
        scope,
      ));
      assert.ok(Array.isArray(batchResult.results), "batch returns results array");
      assert.equal(batchResult.results.length, 3);
      assert.equal(batchResult.results[0].loc, "pixel.png");
      assert.equal(batchResult.results[0].exists, true);
      assert.equal(batchResult.results[0].width, 1);
      assert.equal(batchResult.results[1].loc, "pixel-2x3.png");
      assert.equal(batchResult.results[1].width, 2);
      assert.equal(batchResult.results[1].height, 3);
      assert.equal(batchResult.results[2].loc, "does-not-exist.png");
      assert.equal(batchResult.results[2].exists, false);

      const hashResult = JSON.parse(toolkit.execHashFile({ path: "alpha.txt" }, projectDir, scope));
      assert.equal(hashResult.algorithm, "sha256");
      assert.match(hashResult.hash, /^[a-f0-9]{64}$/);
      const throwingToolkit = toolkitMod.createDeterministicToolkit({
        safePath: () => { throw new Error("blocked test path"); },
        skipObservationLogging: true,
      });
      const blockedHash = throwingToolkit.execHashFile({ path: "alpha.txt" }, projectDir, scope);
      assert.match(blockedHash, /^Error:/);

      const siblingFile = path.join(siblingRoot, "shared.txt");
      const resolvedSibling = toolkitMod.safePath(projectDir, siblingFile, scope);
      assert.equal(resolvedSibling, siblingFile);

      const writeResult = toolkit.execWriteFile({ path: siblingFile, content: "shared scope file\n" }, projectDir, scope);
      assert.match(writeResult, /File written:/);
      assert.equal(fs.readFileSync(siblingFile, "utf-8"), "shared scope file\n");

      const editResult = toolkit.execEditFile({ path: siblingFile, old_string: "shared", new_string: "verified" }, projectDir, scope);
      assert.match(editResult, /File edited:/);
      assert.equal(fs.readFileSync(siblingFile, "utf-8"), "verified scope file\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(managedExternalRoot, { recursive: true, force: true });
    }
  });

  it("hides config and gitignore paths from agent-visible file tools", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-hidden-paths-"));
    try {
      fs.mkdirSync(path.join(projectDir, "config"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "config", "secret.json"), "{\"token\":\"hidden\"}\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, ".gitignore"), "config/\n*.secret\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "visible.txt"), "visible needle\n", "utf-8");

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scope = toolkitMod.buildScopePredicates(projectDir, {});

      assert.match(
        toolkit.execReadFile({ path: "config/secret.json" }, projectDir, scope),
        /Access to hidden workspace path is blocked/,
      );
      assert.match(
        toolkit.execReadFile({ path: ".gitignore" }, projectDir, scope),
        /Access to hidden workspace path is blocked/,
      );

      const listResult = toolkit.execListFiles({ directory: ".", recursive: true }, projectDir, scope);
      assert.match(listResult, /visible\.txt/);
      assert.doesNotMatch(listResult, /config[\\/]secret\.json/);
      assert.doesNotMatch(listResult, /\.gitignore/);

      const searchResult = toolkit.execSearchFiles({ pattern: "needle|hidden|config", path: "." }, projectDir, scope);
      assert.match(searchResult, /visible\.txt:1:visible needle/);
      assert.doesNotMatch(searchResult, /secret\.json/);
      assert.doesNotMatch(searchResult, /\.gitignore/);
      assert.match(
        toolkit.execSearchFiles({ pattern: "hidden", path: "config" }, projectDir, scope),
        /Access to hidden workspace path is blocked/,
      );

      const inspectConfig = JSON.parse(toolkit.execInspectFile({ path: "config/secret.json" }, projectDir, scope));
      assert.equal(inspectConfig.exists, false);
      assert.match(inspectConfig.error, /Access to hidden workspace path is blocked/);
      const hashGitignore = JSON.parse(toolkit.execHashFile({ path: ".gitignore" }, projectDir, scope));
      assert.match(hashGitignore.error, /Access to hidden workspace path is blocked/);

      const bash = toolkitMod.createBashExecutor();
      assert.match(
        bash({ command: "ls config" }, projectDir, false, false),
        /Access to config\/ and \.gitignore is blocked/,
      );
      assert.match(
        bash({ command: "cat .gitignore" }, projectDir, false, false),
        /Access to config\/ and \.gitignore is blocked/,
      );
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("validates and prunes image artifact output without helper scripts", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-artifact-output-tools-"));
    const artifactRoot = path.join(projectDir, ".posse", "resources", "artifacts", "wi-1", "task-01-images");
    try {
      fs.mkdirSync(path.join(artifactRoot, "_removed_helpers"), { recursive: true });
      fs.mkdirSync(path.join(artifactRoot, ".posse", "logs"), { recursive: true });
      const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9kAAAAASUVORK5CYII=";
      fs.writeFileSync(path.join(artifactRoot, "favicon.png"), Buffer.concat([
        Buffer.from(pngBase64, "base64"),
        Buffer.alloc(2048, 0),
      ]));
      fs.writeFileSync(path.join(artifactRoot, "_generate.py"), "print('nope')\n", "utf-8");
      fs.writeFileSync(path.join(artifactRoot, "_removed_helpers", "check.disabled"), "", "utf-8");
      fs.writeFileSync(path.join(artifactRoot, ".posse", "logs", "observations.log"), "runtime sidecar\n", "utf-8");

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scope = toolkitMod.buildScopePredicates(projectDir, { createRoots: [artifactRoot] });

      const failed = JSON.parse(toolkit.execValidateArtifactOutput({
        output_root: artifactRoot,
        task_mode: "image",
        expected_images: [{ path: "favicon.png", width: 1, height: 1 }],
      }, projectDir, scope));
      assert.equal(failed.ok, false);
      assert.ok(failed.violations.some((line) => /disallowed formats/i.test(line)));

      const dryRun = JSON.parse(toolkit.execPruneArtifactOutput({
        output_root: artifactRoot,
        task_mode: "image",
        dry_run: true,
      }, projectDir, scope));
      assert.deepEqual(dryRun.would_delete.sort(), [
        ".posse/logs/observations.log",
        "_generate.py",
        "_removed_helpers/check.disabled",
      ].sort());
      assert.equal(fs.existsSync(path.join(artifactRoot, "_generate.py")), true);

      const pruned = JSON.parse(toolkit.execPruneArtifactOutput({
        output_root: artifactRoot,
        task_mode: "image",
      }, projectDir, scope));
      assert.equal(pruned.ok, true);
      assert.equal(fs.existsSync(path.join(artifactRoot, "_generate.py")), false);
      assert.equal(fs.existsSync(path.join(artifactRoot, "_removed_helpers")), false);
      assert.equal(fs.existsSync(path.join(artifactRoot, ".posse")), false);

      const passed = JSON.parse(toolkit.execValidateArtifactOutput({
        output_root: artifactRoot,
        task_mode: "image",
        expected_files: ["favicon.png"],
        expected_images: [{ path: "favicon.png", width: 1, height: 1 }],
      }, projectDir, scope));
      assert.equal(passed.ok, true);
      assert.deepEqual(passed.violations, []);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("transcodes generated PNG artifact outputs to true JPEG through clean_image", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const codec = await import("../../../lib/functions/toolkit/image-codec.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-artifact-jpeg-clean-"));
    const artifactRoot = path.join(projectDir, ".posse", "resources", "artifacts", "wi-1", "task-jpeg-clean");
    try {
      fs.mkdirSync(artifactRoot, { recursive: true });
      const width = 256;
      const height = 144;
      const rgba = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          rgba[idx] = 20 + x * 3;
          rgba[idx + 1] = 40 + y * 5;
          rgba[idx + 2] = 80 + ((x + y) % 32);
          rgba[idx + 3] = 255;
        }
      }
      fs.writeFileSync(path.join(artifactRoot, "hero-source.png"), codec.encodeRgbaToPng(width, height, rgba));

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scope = toolkitMod.buildScopePredicates(artifactRoot, { createRoots: [artifactRoot] });
      const cleanedText = toolkit.execCleanImage({
        path: "hero-source.png",
        output_path: "hero-bg.jpg",
        mode: "clean",
        quality: 92,
      }, artifactRoot, scope);
      assert.doesNotMatch(cleanedText, /^Error:/);
      const cleaned = JSON.parse(cleanedText);
      assert.equal(cleaned.ok, true);
      assert.equal(cleaned.output_format, "jpeg");
      assert.equal(cleaned.metadata.format, "jpeg");
      assert.equal(cleaned.metadata.width, width);
      assert.equal(cleaned.metadata.height, height);

      const inPlaceText = toolkit.execCleanImage({
        path: "hero-bg.jpg",
        mode: "reencode",
        quality: 88,
      }, artifactRoot, scope);
      assert.doesNotMatch(inPlaceText, /^Error:/);
      const inPlace = JSON.parse(inPlaceText);
      assert.equal(inPlace.ok, true);
      assert.equal(inPlace.output_format, "jpeg");

      const heroPath = path.join(artifactRoot, "hero-bg.jpg");
      const beforeFailedPublish = fs.readFileSync(heroPath);
      const realRenameSync = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (String(from).includes(".hero-bg.jpg.") && String(from).endsWith(".tmp.jpg") && String(to).endsWith("hero-bg.jpg")) {
          throw new Error("simulated jpeg publish failure");
        }
        return realRenameSync(from, to);
      };
      try {
        const failedText = toolkit.execReencodeImage({
          path: "hero-bg.jpg",
          output_format: "jpeg",
          quality: 84,
        }, artifactRoot, scope);
        assert.match(failedText, /^Error: reencode_image failed/);
      } finally {
        fs.renameSync = realRenameSync;
      }
      assert.deepEqual(fs.readFileSync(heroPath), beforeFailedPublish);
      assert.deepEqual(
        fs.readdirSync(artifactRoot).filter((name) => name.includes("hero-bg.jpg") && /\.tmp\.(?:jpg|bak)$/.test(name)),
        [],
      );

      const resizedText = toolkit.execCleanImage({
        path: "hero-source.png",
        output_path: "hero-bg-wide.jpg",
        mode: "resize",
        width: 384,
        height: 216,
        resize_mode: "stretch",
      }, artifactRoot, scope);
      assert.doesNotMatch(resizedText, /^Error:/);
      const resized = JSON.parse(resizedText);
      assert.equal(resized.ok, true);
      assert.equal(resized.output_format, "jpeg");
      const resizedMeta = JSON.parse(toolkit.execReadImageMetadata({ path: "hero-bg-wide.jpg" }, artifactRoot, scope));
      assert.equal(resizedMeta.format, "jpeg");
      assert.equal(resizedMeta.width, 384);
      assert.equal(resizedMeta.height, 216);

      const passed = JSON.parse(toolkit.execValidateArtifactOutput({
        output_root: ".",
        task_mode: "image",
        expected_images: [
          { path: "hero-bg.jpg", width, height },
          { path: "hero-bg-wide.jpg", min_width: 384, min_height: 216 },
        ],
      }, artifactRoot, scope));
      assert.equal(passed.ok, true);
      assert.deepEqual(passed.violations, []);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("keys edge-connected image backgrounds to alpha through clean_image", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const codec = await import("../../../lib/functions/toolkit/image-codec.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-artifact-alpha-key-"));
    const artifactRoot = path.join(projectDir, ".posse", "resources", "artifacts", "wi-1", "task-alpha-key");
    try {
      fs.mkdirSync(artifactRoot, { recursive: true });
      const width = 96;
      const height = 96;
      const rgba = Buffer.alloc(width * height * 4);
      for (let i = 0; i < rgba.length; i += 4) {
        rgba[i] = 255;
        rgba[i + 1] = 255;
        rgba[i + 2] = 255;
        rgba[i + 3] = 255;
      }
      const subjectMin = 16;
      const subjectMax = 79;
      for (let y = subjectMin; y <= subjectMax; y++) {
        for (let x = subjectMin; x <= subjectMax; x++) {
          const idx = (y * width + x) * 4;
          rgba[idx] = 160 + ((x * 7 + y * 3) % 72);
          rgba[idx + 1] = (x * 5 + y * 11) % 96;
          rgba[idx + 2] = (x * 13 + y * 17) % 96;
        }
      }
      const center = (48 * width + 48) * 4;
      rgba[center] = 255;
      rgba[center + 1] = 255;
      rgba[center + 2] = 255;
      fs.writeFileSync(path.join(artifactRoot, "icon.png"), codec.encodeRgbaToPng(width, height, rgba));

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scope = toolkitMod.buildScopePredicates(artifactRoot, { createRoots: [artifactRoot] });
      const result = JSON.parse(toolkit.execCleanImage({
        path: "icon.png",
        mode: "alpha_key",
        target_color: "#ffffff",
        tolerance: 0,
      }, artifactRoot, scope));
      assert.equal(result.ok, true);
      assert.equal(result.transparent_pixels, width * height - ((subjectMax - subjectMin + 1) ** 2));
      assert.equal(result.metadata.hasTransparency, true);

      const decoded = codec.decodePngToRgba(fs.readFileSync(path.join(artifactRoot, "icon.png")));
      assert.equal(decoded.data[3], 0);
      assert.equal(decoded.data[center + 3], 255);

      const passed = JSON.parse(toolkit.execValidateArtifactOutput({
        output_root: ".",
        task_mode: "image",
        expected_images: [{ path: "icon.png", width, height, transparent: true }],
      }, artifactRoot, scope));
      assert.equal(passed.ok, true);
      assert.deepEqual(passed.violations, []);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("enforces create/edit scope for write_file and edit_file within the cwd", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-scope-write-"));
    try {
      fs.writeFileSync(path.join(projectDir, "allowed.txt"), "allowed\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "blocked-existing.txt"), "original\n", "utf-8");

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scoped = toolkitMod.buildScopePredicates(projectDir, {
        modifyFiles: ["allowed.txt"],
        createFiles: ["allowed.txt"],
        createRoots: [],
      });

      const allowedWrite = toolkit.execWriteFile({ path: "allowed.txt", content: "updated\n" }, projectDir, scoped);
      assert.match(allowedWrite, /File written:/);
      assert.equal(fs.readFileSync(path.join(projectDir, "allowed.txt"), "utf-8"), "updated\n");

      const blockedWrite = toolkit.execWriteFile({ path: "blocked-new.txt", content: "nope\n" }, projectDir, scoped);
      assert.match(blockedWrite, /outside the allowed creation scope/i);
      assert.equal(fs.existsSync(path.join(projectDir, "blocked-new.txt")), false);

      const blockedEdit = toolkit.execEditFile(
        { path: "blocked-existing.txt", old_string: "original", new_string: "mutated" },
        projectDir,
        scoped,
      );
      assert.match(blockedEdit, /outside the allowed edit scope/i);
      assert.equal(fs.readFileSync(path.join(projectDir, "blocked-existing.txt"), "utf-8"), "original\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("blocks write_file and edit_file from creating or changing .env files", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-env-write-"));
    try {
      fs.writeFileSync(path.join(projectDir, ".env.local"), "SECRET=old\n", "utf-8");

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scoped = toolkitMod.buildScopePredicates(projectDir, {
        modifyFiles: [".env.local"],
        createFiles: [".env"],
        createRoots: [],
      });

      const blockedCreate = toolkit.execWriteFile({ path: ".env", content: "SECRET=new\n" }, projectDir, scoped);
      assert.match(blockedCreate, /Writing \.env files is blocked/);
      assert.equal(fs.existsSync(path.join(projectDir, ".env")), false);

      const blockedEdit = toolkit.execEditFile(
        { path: ".env.local", old_string: "old", new_string: "new" },
        projectDir,
        scoped,
      );
      assert.match(blockedEdit, /Editing \.env files is blocked/);
      assert.equal(fs.readFileSync(path.join(projectDir, ".env.local"), "utf-8"), "SECRET=old\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("blocks deterministic file tools through symlinks to .env files", async (t) => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-env-symlink-"));
    try {
      fs.writeFileSync(path.join(projectDir, ".env"), "SECRET=old\n", "utf-8");
      try {
        fs.symlinkSync(".env", path.join(projectDir, "linked-config.txt"), "file");
      } catch (err) {
        t.skip(`symlink creation is unavailable in this environment: ${err?.code || err?.message || err}`);
        return;
      }

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scoped = toolkitMod.buildScopePredicates(projectDir, {
        modifyFiles: ["linked-config.txt"],
        createFiles: [],
        createRoots: [],
      });

      assert.match(
        toolkit.execReadFile({ path: "linked-config.txt" }, projectDir, scoped),
        /Access to \.env files is blocked/,
      );
      assert.match(
        toolkit.execSearchFiles({ path: "linked-config.txt", pattern: "SECRET" }, projectDir, scoped),
        /Access to \.env files is blocked/,
      );
      assert.match(
        toolkit.execHashFile({ path: "linked-config.txt" }, projectDir, scoped),
        /Access to \.env files is blocked/,
      );
      assert.match(
        toolkit.execEditFile({ path: "linked-config.txt", old_string: "old", new_string: "new" }, projectDir, scoped),
        /Editing \.env files is blocked/,
      );
      assert.match(
        toolkit.execWriteFile({ path: "linked-config.txt", content: "SECRET=new\n" }, projectDir, scoped),
        /Writing \.env files is blocked/,
      );
      assert.equal(fs.readFileSync(path.join(projectDir, ".env"), "utf-8"), "SECRET=old\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("edits CRLF files when old_string only differs by line endings", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-crlf-edit-"));
    try {
      const target = path.join(projectDir, "win.txt");
      fs.writeFileSync(target, "alpha\r\nbeta\r\n", "utf-8");
      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scope = toolkitMod.buildScopePredicates(projectDir, {
        modifyFiles: ["win.txt"],
        createFiles: [],
        createRoots: [],
      });
      const result = toolkit.execEditFile(
        { path: "win.txt", old_string: "alpha\nbeta\n", new_string: "alpha\ngamma\n" },
        projectDir,
        scope,
      );
      assert.match(result, /File edited:/);
      assert.equal(fs.readFileSync(target, "utf-8"), "alpha\r\ngamma\r\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("supports targeted edit_file modes through the scoped deterministic toolkit", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-targeted-edit-"));
    try {
      const textTarget = path.join(projectDir, "notes.txt");
      const jsonTarget = path.join(projectDir, "package.json");
      const fourSpaceJsonTarget = path.join(projectDir, "package4.json");
      fs.writeFileSync(textTarget, "zero\none\ntwo\n", "utf-8");
      fs.writeFileSync(jsonTarget, JSON.stringify({ scripts: { test: "old" } }) + "\n", "utf-8");
      fs.writeFileSync(fourSpaceJsonTarget, "{\n    \"scripts\": {\n        \"test\": \"old\"\n    }\n}\n", "utf-8");

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scope = toolkitMod.buildScopePredicates(projectDir, {
        modifyFiles: ["notes.txt", "package.json", "package4.json"],
        createFiles: [],
        createRoots: [],
      });

      const replaceLines = toolkit.execEditFile(
        { path: "notes.txt", replaceLines: { start: 1, end: 2, content: "ONE\nTWO" } },
        projectDir,
        scope,
      );
      assert.match(replaceLines, /replaceLines 1:2/);
      assert.equal(fs.readFileSync(textTarget, "utf-8"), "zero\nONE\nTWO\ntwo\n");

      const replacePattern = toolkit.execEditFile(
        { path: "notes.txt", replacePattern: { pattern: "TWO", replacement: "three" } },
        projectDir,
        scope,
      );
      assert.match(replacePattern, /replacePattern 1 match/);
      assert.equal(fs.readFileSync(textTarget, "utf-8"), "zero\nONE\nthree\ntwo\n");

      const insertAt = toolkit.execEditFile(
        { path: "notes.txt", insertAt: { line: 1, content: "inserted" } },
        projectDir,
        scope,
      );
      assert.match(insertAt, /insertAt 1/);

      const append = toolkit.execEditFile({ path: "notes.txt", append: "tail\n" }, projectDir, scope);
      assert.match(append, /\(append\)/);
      assert.equal(fs.readFileSync(textTarget, "utf-8"), "zero\ninserted\nONE\nthree\ntwo\ntail\n");

      const jsonEdit = toolkit.execEditFile(
        { path: "package.json", jsonPath: "scripts.test", jsonValue: "node --test" },
        projectDir,
        scope,
      );
      assert.match(jsonEdit, /jsonPath scripts\.test/);
      assert.deepEqual(JSON.parse(fs.readFileSync(jsonTarget, "utf-8")), { scripts: { test: "node --test" } });

      const fourSpaceJsonEdit = toolkit.execEditFile(
        { path: "package4.json", jsonPath: "scripts.test", jsonValue: "node --test" },
        projectDir,
        scope,
      );
      assert.match(fourSpaceJsonEdit, /jsonPath scripts\.test/);
      assert.equal(
        fs.readFileSync(fourSpaceJsonTarget, "utf-8"),
        "{\n    \"scripts\": {\n        \"test\": \"node --test\"\n    }\n}\n",
      );
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous or unsafe targeted edit_file requests", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-targeted-edit-errors-"));
    try {
      const target = path.join(projectDir, "notes.txt");
      fs.writeFileSync(target, "alpha\nalpha\n", "utf-8");

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scope = toolkitMod.buildScopePredicates(projectDir, {
        modifyFiles: ["notes.txt"],
        createFiles: [],
        createRoots: [],
      });

      const ambiguousMode = toolkit.execEditFile(
        { path: "notes.txt", old_string: "alpha", new_string: "beta", append: "tail\n" },
        projectDir,
        scope,
      );
      assert.match(ambiguousMode, /only one edit mode/i);

      const nonUniquePattern = toolkit.execEditFile(
        { path: "notes.txt", replacePattern: { pattern: "alpha", replacement: "beta" } },
        projectDir,
        scope,
      );
      assert.match(nonUniquePattern, /matched 2 times/i);

      const unsafePattern = toolkit.execEditFile(
        { path: "notes.txt", replacePattern: { pattern: "(a+)+", replacement: "b" } },
        projectDir,
        scope,
      );
      assert.match(unsafePattern, /unsafe nested quantifier/i);

      const timeoutToolkit = toolkitMod.createDeterministicToolkit({
        safePath: toolkitMod.safePath,
        spawnSyncImpl: () => ({ error: { code: "ETIMEDOUT", message: "timed out" }, stdout: "" }),
      });
      const timedOutPattern = timeoutToolkit.execEditFile(
        { path: "notes.txt", replacePattern: { pattern: "alpha", replacement: "beta", global: true } },
        projectDir,
        scope,
      );
      assert.match(timedOutPattern, /time budget/i);
      assert.equal(fs.readFileSync(target, "utf-8"), "alpha\nalpha\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("treats createRoots dot as wildcard scope inside deterministic toolkit predicates", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-dot-root-"));
    const outsideDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-dot-outside-"));
    try {
      const absTarget = path.join(projectDir, "nested", "new-file.txt");
      const outsideTarget = path.join(outsideDir, "outside.txt");
      const scope = toolkitMod.buildScopePredicates(projectDir, {
        modifyFiles: [],
        createFiles: [],
        createRoots: ["."],
      });
      assert.equal(scope.canCreate(absTarget), true);
      assert.equal(scope.canEdit(absTarget), true);
      assert.equal(scope.canCreate(outsideTarget), false);
      assert.equal(scope.canEdit(outsideTarget), false);
      assert.equal(scope.isWithinScopeRoot(outsideTarget), false);
      assert.throws(
        () => toolkitMod.safePath(projectDir, outsideTarget, scope),
        /Path escapes working directory/,
      );
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("allows managed external roots without allowing arbitrary sibling roots", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-explicit-root-"));
    const siblingRoot = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-explicit-sibling-"));
    const artifactRoot = path.resolve(projectDir, "..", ".posse", "resources", "artifacts", "wi-1", "explicit");
    const managedExternalRoot = path.resolve(projectDir, "..", ".posse");
    const otherRoot = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-explicit-other-"));
    try {
      const siblingFile = path.join(siblingRoot, "shared.txt");
      const artifactFile = path.join(artifactRoot, "shared.txt");
      const otherFile = path.join(otherRoot, "blocked.txt");
      const scope = toolkitMod.buildScopePredicates(projectDir, {
        modifyFiles: [],
        createFiles: [],
        createRoots: [projectDir, siblingRoot, artifactRoot],
      });
      assert.equal(scope.canCreate(path.join(projectDir, "local.txt")), true);
      assert.equal(scope.canCreate(siblingFile), false);
      assert.equal(scope.isWithinScopeRoot(siblingFile), false);
      assert.throws(
        () => toolkitMod.safePath(projectDir, siblingFile, scope),
        /Path escapes working directory/,
      );
      assert.equal(scope.canCreate(artifactFile), true);
      assert.equal(scope.isWithinScopeRoot(artifactFile), true);
      assert.equal(toolkitMod.safePath(projectDir, artifactFile, scope), artifactFile);
      assert.equal(scope.canCreate(otherFile), false);
      assert.equal(scope.isWithinScopeRoot(otherFile), false);
      assert.throws(
        () => toolkitMod.safePath(projectDir, otherFile, scope),
        /Path escapes working directory/,
      );
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(siblingRoot, { recursive: true, force: true });
      fs.rmSync(managedExternalRoot, { recursive: true, force: true });
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("supports advanced search_files options (glob braces/**, literal, context, paging, mode, multiline, binary skip)", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-search-advanced-"));
    try {
      fs.mkdirSync(path.join(projectDir, "src", "nested"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "src", "a.ts"), "Alpha\nbeta\nneedle.1\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "src", "nested", "b.tsx"), "start\nMIDDLE\nend\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "src", "nested", "c.js"), "alpha only\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "bin.dat"), Buffer.from([0, 1, 2, 3, 4, 5]));
      fs.writeFileSync(path.join(projectDir, "multi.txt"), "one\nline-two\nthree\n", "utf-8");

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scope = toolkitMod.buildScopePredicates(projectDir, {});

      const braceGlob = toolkit.execSearchFiles({
        pattern: "Alpha|start",
        include: "src/**/*.{ts,tsx}",
      }, projectDir, scope);
      assert.match(braceGlob, /src[\\/]a\.ts:1:Alpha/);
      assert.match(braceGlob, /src[\\/]nested[\\/]b\.tsx:1:start/);
      assert.doesNotMatch(braceGlob, /c\.js/);

      const literalCaseInsensitive = toolkit.execSearchFiles({
        pattern: "needle.1",
        literal: true,
        case_insensitive: true,
        include: "src/**/*.ts",
      }, projectDir, scope);
      assert.match(literalCaseInsensitive, /needle\.1/);

      const withContext = toolkit.execSearchFiles({
        pattern: "beta",
        path: "src/a.ts",
        context: 1,
      }, projectDir, scope);
      assert.match(withContext, /a\.ts:2:beta/);
      assert.match(withContext, /a\.ts:1-Alpha/);
      assert.match(withContext, /a\.ts:3\+needle\.1/);

      const fileMode = toolkit.execSearchFiles({
        pattern: "alpha",
        case_insensitive: true,
        output_mode: "files_with_matches",
      }, projectDir, scope);
      assert.match(fileMode, /a\.ts/);
      assert.match(fileMode, /c\.js/);

      const countMode = toolkit.execSearchFiles({
        pattern: "alpha",
        case_insensitive: true,
        output_mode: "count",
      }, projectDir, scope);
      assert.match(countMode, /a\.ts:1/);
      assert.match(countMode, /c\.js:1/);

      const paged = toolkit.execSearchFiles({
        pattern: "a|e|i|o|u",
        output_mode: "files_with_matches",
        head_limit: 1,
        offset: 1,
      }, projectDir, scope);
      assert.equal(paged.split("\n").length, 1);

      const multiline = toolkit.execSearchFiles({
        pattern: "one\\nline-two",
        multiline: true,
        path: "multi.txt",
      }, projectDir, scope);
      assert.match(multiline, /multi\.txt:1:one/);

      const binarySkipped = toolkit.execSearchFiles({
        pattern: ".",
        path: "bin.dat",
      }, projectDir, scope);
      assert.equal(binarySkipped, "No matches found.");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("backs search_files with required ripgrep execution", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-search-rg-"));
    try {
      fs.writeFileSync(path.join(projectDir, "hit.txt"), "needle\n", "utf-8");
      const scope = toolkitMod.buildScopePredicates(projectDir, {});
      let invocation = null;
      const toolkit = toolkitMod.createDeterministicToolkit({
        safePath: toolkitMod.safePath,
        spawnSyncImpl(command, rgArgs, options) {
          invocation = { command, rgArgs, options };
          return spawnSync(command, rgArgs, options);
        },
      });

      const result = toolkit.execSearchFiles({ pattern: "needle", path: "." }, projectDir, scope);
      assert.match(result, /hit\.txt:1:needle/);
      assert.equal(invocation.command, toolkitMod.resolveRipgrepCommand());
      assert.equal(invocation.options.cwd, projectDir);
      assert.equal(invocation.options.timeout, 30000);
      assert.ok(invocation.rgArgs.includes("--json"));
      assert.ok(invocation.rgArgs.includes("--regexp"));

      const timedOutRg = toolkitMod.createDeterministicToolkit({
        safePath: toolkitMod.safePath,
        spawnSyncImpl: () => ({
          error: Object.assign(new Error("spawn rg ETIMEDOUT"), { code: "ETIMEDOUT" }),
        }),
      });
      const timedOutResult = timedOutRg.execSearchFiles({ pattern: "needle", path: "." }, projectDir, scope);
      assert.match(timedOutResult, /timed out after 30s/);

      const missingRg = toolkitMod.createDeterministicToolkit({
        safePath: toolkitMod.safePath,
        ripgrepCommand: "rg-does-not-exist-for-posse-test",
        spawnSyncImpl: () => ({
          error: Object.assign(new Error("spawn rg ENOENT"), { code: "ENOENT" }),
        }),
      });
      const missingResult = missingRg.execSearchFiles({ pattern: "needle", path: "." }, projectDir, scope);
      assert.match(missingResult, /requires ripgrep \(rg\)/);
      assert.match(missingResult, /available on PATH/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("exposes globToRegex helper with ** and brace patterns", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const regex = toolkitMod.globToRegex("src/**/*.{ts,tsx}");
    assert.equal(regex.test("src/a.ts"), true);
    assert.equal(regex.test("src/nested/b.tsx"), true);
    assert.equal(regex.test("src/nested/c.js"), false);
  });

  it("supports git_history deterministic operations with validation and truncation", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const repoDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-git-history-"));
    try {
      execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir, stdio: "pipe" });

      fs.writeFileSync(path.join(repoDir, "tracked.txt"), "line-1\nline-2\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "first"], { cwd: repoDir, stdio: "pipe" });

      fs.writeFileSync(path.join(repoDir, "tracked.txt"), "line-1\nline-two-edited\nline-3\n", "utf-8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "second"], { cwd: repoDir, stdio: "pipe" });

      fs.writeFileSync(path.join(repoDir, "tracked.txt"), `${Array.from({ length: 700 }, (_, i) => `row-${i}`).join("\n")}\n`, "utf-8");

      const historyCalls = [];
      const toolkit = toolkitMod.createDeterministicToolkit({
        safePath: toolkitMod.safePath,
        gitNativeParity: { manager: fakeGitHistoryManager(historyCalls) },
      });
      const scope = toolkitMod.buildScopePredicates(repoDir, {});

      const logOut = toolkit.execGitHistory({ op: "log", limit: 5 }, repoDir, scope);
      assert.match(logOut, /\tTest User\t/);
      assert.match(logOut, /\tsecond|\tfirst/);

      const showOut = toolkit.execGitHistory({ op: "show", ref: "HEAD" }, repoDir, scope);
      assert.match(showOut, /CommitDate:/);

      const blameOut = toolkit.execGitHistory({ op: "blame", path: "tracked.txt" }, repoDir, scope);
      assert.match(blameOut, /^1\t[0-9a-f]{7,40}\t/m);

      const diffOut = toolkit.execGitHistory({ op: "diff" }, repoDir, scope);
      assert.match(diffOut, /\.\.\. \d+ more lines/);

      const badRef = toolkit.execGitHistory({ op: "show", ref: "HEAD;rm -rf /" }, repoDir, scope);
      assert.match(badRef, /ref contains unsupported characters/);

      const flagRef = toolkit.execGitHistory({ op: "log", ref: "--all" }, repoDir, scope);
      assert.match(flagRef, /ref contains unsupported characters/);

      const notRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-not-repo-"));
      try {
        const notRepo = toolkit.execGitHistory({ op: "log" }, notRepoDir, toolkitMod.buildScopePredicates(notRepoDir, {}));
        assert.match(notRepo, /inside a git repository/);
      } finally {
        fs.rmSync(notRepoDir, { recursive: true, force: true });
      }
      const scoped = toolkitMod.buildScopePredicates(repoDir, { modifyFiles: ["tracked.txt"] });
      const scopedBlocked = toolkit.execGitHistory({ op: "blame", path: "outside.txt" }, repoDir, scoped);
      assert.match(scopedBlocked, /outside the active file scope/);
      assert.deepEqual(historyCalls.at(-1).scopeFiles, ["tracked.txt"]);
      assert.deepEqual(historyCalls.map((call) => call.op), ["log", "show", "blame", "diff", "show", "log", "log", "blame"]);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("builds a guarded pull_brief snapshot without shell access", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-pull-brief-"));
    try {
      fs.mkdirSync(path.join(projectDir, "api", "user", "refresh"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "includes", "user"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "api", "user", "refresh", "index.php"), "POST /api/user/refresh/\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "includes", "user", "JWTAuth.php"), "function refresh() { revokeRefreshToken('x'); }\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "README.md"), "documentation only\n", "utf-8");

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scope = toolkitMod.buildScopePredicates(projectDir, {});
      const output = toolkit.execPullBrief({
        mode: "gap_fill",
        query: "How does auth token refresh work?",
        missing: ["api/user/refresh/index.php", "includes/user/JWTAuth.php"],
        max_files: 5,
      }, projectDir, scope);
      const parsed = JSON.parse(output);

      assert.equal(parsed.mode, "gap_fill");
      assert.ok(Array.isArray(parsed.files));
      assert.ok(parsed.files.length >= 1);
      assert.ok(parsed.files.some((entry) => /api\/user\/refresh\/index\.php/i.test(entry.path)));
      assert.ok(parsed.files.some((entry) => /includes\/user\/jwtauth\.php/i.test(entry.path)));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("boosts pull_brief results for one-hop importers of high-signal files", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-import-graph-"));
    try {
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "src", "service.js"), "export function revokeJwtToken() { return true; }\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "src", "controller.js"), "import { helper } from './service.js';\nexport function handle() { return helper(); }\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "src", "noise-a.js"), "const a = 1;\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "src", "noise-b.js"), "const b = 2;\n", "utf-8");

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scope = toolkitMod.buildScopePredicates(projectDir, {});
      const output = toolkit.execPullBrief({
        mode: "tree_pull",
        query: "revoke jwt token flow",
        max_files: 2,
      }, projectDir, scope);
      const parsed = JSON.parse(output);
      const paths = (parsed.files || []).map((entry) => entry.path);

      assert.ok(paths.some((p) => /src\/service\.js$/i.test(p)));
      assert.ok(paths.some((p) => /src\/controller\.js$/i.test(p)));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("prefers recent git-touched files in low-signal tree_pull mode", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const briefMod = await import("../../../lib/functions/toolkit/brief.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-recency-"));
    try {
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "src", "recent.js"), "const shared = true;\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "src", "stale.js"), "const shared = true;\n", "utf-8");

      const scope = toolkitMod.buildScopePredicates(projectDir, {});
      const pullBrief = briefMod.createPullBriefExecutor(toolkitMod.safePath, {
        gitLogImpl() {
          return "src/recent.js\n";
        },
      });
      const output = pullBrief({
        mode: "tree_pull",
        query: "unlikely_non_matching_token",
        max_files: 1,
      }, projectDir, scope);
      const parsed = JSON.parse(output);

      assert.equal(parsed.files?.[0]?.path, "src/recent.js");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("rejects trailing dot-dot path segments in pull_brief seed paths", async () => {
    const briefMod = await import("../../../lib/functions/toolkit/brief.js");
    assert.equal(briefMod.__testIsSafeRelativePath("foo/.."), false);
    assert.equal(briefMod.__testIsSafeRelativePath("foo/../bar"), false);
    assert.equal(briefMod.__testIsSafeRelativePath("foo/bar"), true);
  });

  it("does not emit sensitive env seed paths from pull_brief tree_pull", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-pull-brief-env-"));
    try {
      fs.writeFileSync(path.join(projectDir, ".env"), "SECRET_TOKEN=do-not-emit\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "README.md"), "public token refresh notes\n", "utf-8");

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scope = toolkitMod.buildScopePredicates(projectDir, {});
      const output = toolkit.execPullBrief({
        mode: "tree_pull",
        query: "token",
        seed_paths: [".env", "README.md"],
        include_ext: [".env", ".md"],
        max_files: 10,
      }, projectDir, scope);
      const parsed = JSON.parse(output);

      assert.equal(JSON.stringify(parsed).includes("do-not-emit"), false);
      assert.equal((parsed.files || []).some((entry) => entry.path === ".env"), false);
      assert.equal((parsed.files || []).some((entry) => entry.path === "README.md"), true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("keeps tree_pull more permissive than gap_fill for low-signal queries", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-tree-pull-"));
    try {
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "src", "alpha.js"), "const alpha = 1;\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "src", "beta.js"), "const beta = 2;\n", "utf-8");

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scope = toolkitMod.buildScopePredicates(projectDir, {});
      const query = "zzzz_unlikely_token";
      const gapFill = JSON.parse(toolkit.execPullBrief({
        mode: "gap_fill",
        query,
        max_files: 5,
      }, projectDir, scope));
      const treePull = JSON.parse(toolkit.execPullBrief({
        mode: "tree_pull",
        query,
        max_files: 5,
      }, projectDir, scope));

      assert.equal(gapFill.files.length, 0);
      assert.ok(treePull.files.length >= 1);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("sanitizes ATLAS path segments and blocks unsanitized slice payload fields", async () => {
    const atlasToolkitMod = await import("../../../lib/functions/toolkit/atlas.js");
    const symbolId = `${"b".repeat(64)}:3`;
    assert.equal(atlasToolkitMod.__testIsSafeRelativePath("foo/.."), false);
    assert.equal(atlasToolkitMod.__testIsSafeRelativePath("foo/../bar"), false);
    assert.equal(atlasToolkitMod.__testIsSafeRelativePath("foo/bar"), true);

    const prepared = atlasToolkitMod.prepareAtlasDeterministicPayload("slice.build", {
      taskText: "Investigate auth flow",
      entrySymbols: [symbolId],
      editedFiles: ["src/auth.js"],
      unexpectedField: "should-not-pass-through",
    });

    assert.equal(prepared.payload.unexpectedField, undefined);
    assert.deepEqual(prepared.payload.editedFiles, ["src/auth.js"]);
    assert.deepEqual(prepared.payload.entrySymbols, [symbolId]);
    assert.throws(() => atlasToolkitMod.prepareAtlasDeterministicPayload("slice.build", {
      taskText: "Investigate auth flow",
      entrySymbols: ["valid:symbol_1"],
    }), /opaque symbolId/i);
  });

  it("coerces common ATLAS path-as-symbol mistakes into path-aware fields", async () => {
    const atlasToolkitMod = await import("../../../lib/functions/toolkit/atlas.js");
    const symbolId = `${"d".repeat(64)}:7`;

    const card = atlasToolkitMod.prepareAtlasDeterministicPayload("symbol.getCard", {
      symbolId: "wi-63@124:www/includes/classes/Config.php",
    });
    assert.deepEqual(card.payload.symbolRef, {
      name: "Config",
      file: "www/includes/classes/Config.php",
    });
    assert.equal(card.payload.symbolId, undefined);

    const skeleton = atlasToolkitMod.prepareAtlasDeterministicPayload("code.getSkeleton", {
      symbolId: "StreamProbe.php",
    });
    assert.equal(skeleton.payload.file, "StreamProbe.php");
    assert.equal(skeleton.payload.symbolId, undefined);

    const hotPath = atlasToolkitMod.prepareAtlasDeterministicPayload("code.getHotPath", {
      symbolId: "src/auth/LoginService.ts",
      identifiersToFind: "LoginService,refreshToken",
    });
    assert.equal(hotPath.payload.file, "src/auth/LoginService.ts");
    assert.equal(hotPath.payload.symbolId, undefined);
    assert.deepEqual(hotPath.payload.identifiersToFind, ["LoginService", "refreshToken"]);

    const window = atlasToolkitMod.prepareAtlasDeterministicPayload("code.needWindow", {
      symbolId: "src/media/Recordings.ts::Recordings",
      reason: "need the raw call site",
      expectedLines: "40",
      identifiersToFind: "[\"Recordings\",\"save\"]",
    });
    assert.equal(window.payload.file, "src/media/Recordings.ts");
    assert.equal(window.payload.symbolId, undefined);
    assert.equal(window.payload.expectedLines, 40);
    assert.deepEqual(window.payload.identifiersToFind, ["Recordings", "save"]);

    const slice = atlasToolkitMod.prepareAtlasDeterministicPayload("slice.build", {
      taskText: "Investigate auth flow",
      entrySymbols: [symbolId, "src/auth/LoginService.ts"],
      editedFiles: ["src/session.ts"],
      knownCardEtags: { [symbolId]: "card-etag-1" },
      ifNoneMatch: "slice:etag-1",
      wireFormat: "packed",
      wireFormatVersion: 3,
    });
    assert.deepEqual(slice.payload.entrySymbols, [symbolId]);
    assert.deepEqual(slice.payload.editedFiles, ["src/session.ts", "src/auth/LoginService.ts"]);
    assert.deepEqual(slice.payload.knownCardEtags, { [symbolId]: "card-etag-1" });
    assert.equal(slice.payload.ifNoneMatch, "slice:etag-1");
    assert.equal(slice.payload.wireFormat, "packed");
    assert.equal(slice.payload.wireFormatVersion, 3);

    const context = atlasToolkitMod.prepareAtlasDeterministicPayload("context", {
      taskText: "Explain recordings",
      focusSymbols: ["src/media/Recordings.ts::Recordings"],
    });
    assert.deepEqual(context.payload.focusPaths, ["src/media/Recordings.ts"]);
    assert.equal(context.payload.focusSymbols, undefined);
  });

  it("allows ATLAS agent feedback without a version when a slice handle is present", async () => {
    const atlasToolkitMod = await import("../../../lib/functions/toolkit/atlas.js");
    const symbolId = `${"e".repeat(64)}:9`;
    const prepared = atlasToolkitMod.prepareAtlasDeterministicPayload("agent.feedback", {
      versionId: "stale-or-agent-supplied",
      sliceHandle: "slice-1",
      usefulSymbols: [symbolId],
      taskTags: ["role:dev"],
    });

    assert.equal(prepared.payload.versionId, undefined);
    assert.equal(prepared.payload.sliceHandle, "slice-1");
    assert.deepEqual(prepared.payload.usefulSymbols, [symbolId]);
    assert.deepEqual(prepared.payload.taskTags, ["role:dev"]);

    // Tree-first retrieval surfaces symbols without ever building a slice, so
    // feedback must be emittable without a sliceHandle (omitted, not null).
    const sliceless = atlasToolkitMod.prepareAtlasDeterministicPayload("agent.feedback", {
      usefulSymbols: [symbolId],
    });
    assert.equal("sliceHandle" in sliceless.payload, false);
    assert.deepEqual(sliceless.payload.usefulSymbols, [symbolId]);
  });

  it("sanitizes context entrySymbols values", async () => {
    const atlasToolkitMod = await import("../../../lib/functions/toolkit/atlas.js");
    const symbolId = `${"c".repeat(64)}:4`;
    const prepared = atlasToolkitMod.prepareAtlasDeterministicPayload("context", {
      taskText: "Explain auth refresh",
      entrySymbols: [symbolId],
    });

    assert.deepEqual(prepared.payload.focusSymbols, [symbolId]);
    assert.throws(() => atlasToolkitMod.prepareAtlasDeterministicPayload("context", {
      taskText: "Explain auth refresh",
      entrySymbols: ["ok:symbol"],
    }), /opaque symbolId/i);
  });

  it("keeps backslashes literal in parseCommandLine unless they escape grammar specials", async () => {
    const { parseCommandLine } = await import("../../../lib/functions/toolkit/bash-executor.js");

    assert.deepEqual(parseCommandLine("cat src\\foo.js"), ["cat", "src\\foo.js"]);
    assert.deepEqual(parseCommandLine("rg -n pattern lib\\toolkit\\index.js"), ["rg", "-n", "pattern", "lib\\toolkit\\index.js"]);
    assert.deepEqual(parseCommandLine('type "C:\\dir\\file.txt"'), ["type", "C:\\dir\\file.txt"]);
    assert.deepEqual(parseCommandLine("type 'C:\\dir\\file.txt'"), ["type", "C:\\dir\\file.txt"]);
    assert.deepEqual(parseCommandLine('echo "a\\"b"'), ["echo", 'a"b']);
    assert.deepEqual(parseCommandLine("cat a\\ b"), ["cat", "a b"]);
    assert.deepEqual(parseCommandLine("echo a\\\\b"), ["echo", "a\\b"]);
    assert.deepEqual(parseCommandLine("cat foo\\"), ["cat", "foo\\"]);
    assert.equal(parseCommandLine('echo "unterminated'), null);
  });

  it("blocks write_file and edit_file mutations through symlinks", async (t) => {
    const { ToolExecutor } = await import("../../../lib/classes/tools/ToolExecutor.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-tool-executor-symlink-write-"));
    try {
      fs.writeFileSync(path.join(projectDir, "target.txt"), "original\n", "utf-8");
      try {
        fs.symlinkSync("target.txt", path.join(projectDir, "link.txt"), "file");
      } catch (err) {
        t.skip(`symlink creation is unavailable in this environment: ${err?.code || err?.message || err}`);
        return;
      }

      const executor = new ToolExecutor({
        cwd: projectDir,
        scope: { modifyFiles: ["link.txt"], createFiles: ["link.txt"] },
        allowWrite: true,
      });

      assert.match(
        executor.execute("write_file", { path: "link.txt", content: "mutated\n" }),
        /write_file blocked - link\.txt is a symbolic link/,
      );
      assert.match(
        executor.execute("edit_file", { path: "link.txt", old_string: "original", new_string: "mutated" }),
        /edit_file blocked - link\.txt is a symbolic link/,
      );
      assert.equal(fs.readFileSync(path.join(projectDir, "target.txt"), "utf-8"), "original\n");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("writes text files atomically without leaving temp siblings behind", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-deterministic-atomic-write-"));
    try {
      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const scope = toolkitMod.buildScopePredicates(projectDir, {
        modifyFiles: ["notes.txt"],
        createFiles: ["notes.txt"],
        createRoots: [],
      });

      const written = toolkit.execWriteFile({ path: "notes.txt", content: "alpha\n" }, projectDir, scope);
      assert.match(written, /File written:/);
      assert.equal(fs.readFileSync(path.join(projectDir, "notes.txt"), "utf-8"), "alpha\n");

      const edited = toolkit.execEditFile(
        { path: "notes.txt", old_string: "alpha", new_string: "beta" },
        projectDir,
        scope,
      );
      assert.match(edited, /File edited:/);
      assert.equal(fs.readFileSync(path.join(projectDir, "notes.txt"), "utf-8"), "beta\n");

      const leftovers = fs.readdirSync(projectDir).filter((name) => name.includes(".tmp"));
      assert.deepEqual(leftovers, []);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("returns failure feedback for scoped check failures", async () => {
    const toolkitMod = await import("../../../lib/functions/toolkit/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-scoped-checks-fail-"));

    try {
      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
        type: "module",
        scripts: { typecheck: "node fail-typecheck.mjs" },
      }, null, 2));
      fs.writeFileSync(path.join(projectDir, "fail-typecheck.mjs"), "console.error('type failure details'); process.exit(1);\n");

      const toolkit = toolkitMod.createDeterministicToolkit({ safePath: toolkitMod.safePath });
      const result = JSON.parse(toolkit.execRunScopedChecks({
        checks: ["typecheck"],
        scope: { files: ["fail-typecheck.mjs"] },
      }, projectDir, null, {}));

      assert.equal(result.ok, false);
      assert.equal(result.summary, "typecheck failed");
      assert.match(JSON.stringify(result.failures), /type failure details/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
