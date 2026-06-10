import {
  it,
  assert,
  fs,
  path,
  __dirname,
  suite,
  runtimeModules,
} from "../support/core-harness.js";

let db;

suite("Artificer route hardening", () => {
  it("treats content jobs with image generation as image-mode for validation", () => {
    const { workerMod } = runtimeModules;
    assert.equal(
      workerMod.__testEffectiveArtifactTaskMode(
        { job_type: "artificer" },
        { task_mode: "content", needs_image_generation: true },
      ),
      "image",
    );
    assert.equal(
      workerMod.__testEffectiveArtifactTaskMode(
        { job_type: "artificer" },
        { task_mode: "content", needs_image_generation: false },
      ),
      "content",
    );
  });

  it("keeps image-task fallback inside the artificer chat provider pool", () => {
    const { workerMod } = runtimeModules;
    assert.equal(workerMod.__testSelectFallbackProvider(["openai", "grok", "claude"], "openai", true), "grok");
    assert.equal(workerMod.__testSelectFallbackProvider(["openai", "claude"], "openai", true), "claude");
    assert.equal(workerMod.__testSelectFallbackProvider(["openai"], "openai", false), "claude");
  });

  it("allows scoped workspace_root paths outside cwd in the OpenAI provider", async () => {
    const openaiMod = await import("../../../lib/domains/providers/functions/openai.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-openai-scope-"));
    try {
      // External create roots are only honored for system-owned job sandboxes:
      // .posse/resources/{artifacts,workspace}/{wi-|run-}<id>. Arbitrary paths
      // outside cwd are intentionally rejected by the sandbox hardening.
      const resourcesRoot = path.join(projectDir, ".posse", "resources");
      const outputRoot = path.join(resourcesRoot, "artifacts", "wi-scope");
      const workspaceRoot = path.join(resourcesRoot, "workspace", "wi-scope");
      fs.mkdirSync(outputRoot, { recursive: true });
      fs.mkdirSync(workspaceRoot, { recursive: true });
      const scope = openaiMod.__testBuildScopePredicates(outputRoot, { createRoots: [outputRoot, workspaceRoot] });
      const resolved = openaiMod.__testSafePath(outputRoot, path.join(workspaceRoot, "scratch.txt"), scope);
      assert.equal(resolved, path.join(workspaceRoot, "scratch.txt"));
      assert.equal(scope.canCreate(resolved), true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("allows scoped workspace_root paths outside cwd in the Grok provider", async () => {
    const grokMod = await import("../../../lib/domains/providers/functions/grok.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-grok-scope-"));
    try {
      // External create roots are only honored for system-owned job sandboxes:
      // .posse/resources/{artifacts,workspace}/{wi-|run-}<id>. Arbitrary paths
      // outside cwd are intentionally rejected by the sandbox hardening.
      const resourcesRoot = path.join(projectDir, ".posse", "resources");
      const outputRoot = path.join(resourcesRoot, "artifacts", "wi-scope");
      const workspaceRoot = path.join(resourcesRoot, "workspace", "wi-scope");
      fs.mkdirSync(outputRoot, { recursive: true });
      fs.mkdirSync(workspaceRoot, { recursive: true });
      const scope = grokMod.__testBuildScopePredicates(outputRoot, { createRoots: [outputRoot, workspaceRoot] });
      const resolved = grokMod.__testSafePath(outputRoot, path.join(workspaceRoot, "scratch.txt"), scope);
      assert.equal(resolved, path.join(workspaceRoot, "scratch.txt"));
      assert.equal(scope.canCreate(resolved), true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("inspects PNG files through the OpenAI provider without shell tools", async () => {
    const openaiMod = await import("../../../lib/domains/providers/functions/openai.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-openai-inspect-"));
    try {
      const pngPath = path.join(projectDir, "pixel.png");
      const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9kAAAAASUVORK5CYII=";
      fs.writeFileSync(pngPath, Buffer.from(pngBase64, "base64"));
      const scope = openaiMod.__testBuildScopePredicates(projectDir, { createRoots: [projectDir] });
      const inspected = JSON.parse(openaiMod.__testInspectFile({ path: pngPath }, projectDir, scope));
      assert.equal(inspected.exists, true);
      assert.equal(inspected.format, "png");
      assert.equal(inspected.width, 1);
      assert.equal(inspected.height, 1);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("reports missing files through the Grok provider without shell tools", async () => {
    const grokMod = await import("../../../lib/domains/providers/functions/grok.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-grok-inspect-"));
    try {
      const scope = grokMod.__testBuildScopePredicates(projectDir, { createRoots: [projectDir] });
      const inspected = JSON.parse(grokMod.__testInspectFile({ path: path.join(projectDir, "missing.png") }, projectDir, scope));
      assert.equal(inspected.exists, false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
