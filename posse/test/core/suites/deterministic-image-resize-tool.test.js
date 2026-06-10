import {
  it,
  assert,
  fs,
  path,
  __dirname,
  suite,
} from "../support/core-harness.js";

let db;

suite("Deterministic image resize tool", () => {
  it("resizes PNGs through the OpenAI provider wrapper", async () => {
    const openaiMod = await import("../../../lib/domains/providers/functions/openai.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-openai-resize-"));
    try {
      const pngPath = path.join(projectDir, "pixel.png");
      const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9kAAAAASUVORK5CYII=";
      fs.writeFileSync(pngPath, Buffer.from(pngBase64, "base64"));
      const scope = openaiMod.__testBuildScopePredicates(projectDir, { createRoots: [projectDir] });

      const result = JSON.parse(openaiMod.__testResizeImage({
        path: pngPath,
        output_path: path.join(projectDir, "resized.png"),
        width: 4,
        height: 2,
        mode: "stretch",
      }, projectDir, scope));

      assert.equal(result.ok, true);
      const inspected = JSON.parse(openaiMod.__testInspectFile({ path: path.join(projectDir, "resized.png") }, projectDir, scope));
      assert.equal(inspected.width, 4);
      assert.equal(inspected.height, 2);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("resizes PNGs through the Grok provider wrapper", async () => {
    const grokMod = await import("../../../lib/domains/providers/functions/grok.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-grok-resize-"));
    try {
      const pngPath = path.join(projectDir, "pixel.png");
      const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9kAAAAASUVORK5CYII=";
      fs.writeFileSync(pngPath, Buffer.from(pngBase64, "base64"));
      const scope = grokMod.__testBuildScopePredicates(projectDir, { createRoots: [projectDir] });

      const result = JSON.parse(grokMod.__testResizeImage({
        path: pngPath,
        output_path: path.join(projectDir, "resized.png"),
        width: 3,
        height: 5,
        mode: "stretch",
      }, projectDir, scope));

      assert.equal(result.ok, true);
      const inspected = JSON.parse(grokMod.__testInspectFile({ path: path.join(projectDir, "resized.png") }, projectDir, scope));
      assert.equal(inspected.width, 3);
      assert.equal(inspected.height, 5);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("builds Grok image requests using xAI-documented params (model, prompt, n, resolution, aspect_ratio)", async () => {
    const grokMod = await import("../../../lib/domains/providers/functions/grok.js");

    const standard = grokMod.__testBuildImageGenerateParams("grok-imagine-image-quality", {
      prompt: "Generate a hero image",
      size: "1536x1024",
      quality: "standard",
    }, ".png");
    assert.equal(standard.params.model, "grok-imagine-image-quality");
    assert.equal(standard.params.prompt, "Generate a hero image");
    assert.equal(standard.params.response_format, "b64_json");
    assert.equal(standard.params.n, 1);
    assert.equal(standard.params.resolution, "1k");
    assert.equal(standard.params.aspect_ratio, "3:2");
    assert.equal("size" in standard.params, false);
    assert.equal("quality" in standard.params, false);

    const hd = grokMod.__testBuildImageGenerateParams("grok-imagine-image", {
      prompt: "Generate a hero image",
      quality: "hd",
    }, ".png");
    assert.equal(hd.params.model, "grok-imagine-image");
    assert.equal(hd.params.resolution, "2k");
    assert.equal("quality" in hd.params, false);
    assert.equal("size" in hd.params, false);

    const duplicated = grokMod.__testBuildImageGenerateParams("grok-imagine-image-image", {
      prompt: "Generate a small image",
    }, ".png");
    assert.equal(duplicated.params.model, "grok-imagine-image");

    const retiredPro = grokMod.__testBuildImageGenerateParams("grok-imagine-image-pro", {
      prompt: "Generate a quality image",
    }, ".png");
    assert.equal(retiredPro.params.model, "grok-imagine-image-pro");
  });

  it("only enables Grok reasoning effort for supported chat models", async () => {
    const grokMod = await import("../../../lib/domains/providers/functions/grok.js");
    assert.equal(grokMod.__testSupportsReasoningEffort("grok-3-mini"), true);
    assert.equal(grokMod.__testSupportsReasoningEffort("grok-code-fast-1"), false);
    assert.equal(grokMod.__testSupportsReasoningEffort("grok-4"), false);
    assert.equal(grokMod.__testSupportsReasoningEffort("grok-imagine-image"), false);
    assert.equal(grokMod.__testSupportsReasoningEffort("grok-imagine-image-quality"), false);
  });
});
