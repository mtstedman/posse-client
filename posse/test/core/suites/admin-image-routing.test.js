import {
  it,
  assert,
  path,
  __dirname,
  suite,
  beforeEach,
  resetRuntimeDb,
  runtimeModules,
  withEnv,
  withArtifactProtocols,
  getArtifactProtocol,
  getResolvedImageProtocol,
  AdminTUI,
} from "../support/core-harness.js";

suite("Admin image routing", () => {
  // Reset per test so image-route settings written here don't leak across the
  // aggregate run (and prior suites' settings don't leak in).
  beforeEach(() => resetRuntimeDb());


  it("cycles the image route through account settings without rewriting protocol config", () => {
    const { queueMod } = runtimeModules;
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");
    const previousOpenAiImageModel = queueMod.getSetting("openai_image_model");
    withArtifactProtocols((config) => {
      config.image.provider = "openai";
      config.image.model = "gpt-image-1.5";
    }, () => {
      try {
        queueMod.setSetting("artifact_image_provider", "openai");
        queueMod.setSetting("openai_image_model", "gpt-image-1.5");
        const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
        tui._render = () => {};
        tui._cycleImageModel();

        const imageProtocol = getArtifactProtocol("image");
        const resolvedProtocol = getResolvedImageProtocol();
        assert.equal(queueMod.getSetting("artifact_image_provider"), "openai");
        assert.equal(queueMod.getSetting("openai_image_model"), "gpt-image-1");
        assert.equal(resolvedProtocol.provider, "openai");
        assert.equal(resolvedProtocol.model, "gpt-image-1");
        assert.equal(imageProtocol.provider, "openai");
        assert.equal(imageProtocol.model, "gpt-image-1.5");
      } finally {
        queueMod.setSetting("artifact_image_provider", previousImageProvider);
        queueMod.setSetting("openai_image_model", previousOpenAiImageModel);
      }
    });
  });

  it("exposes current Grok image model choices in the admin model editor", () => {
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    tui._render = () => {};
    withEnv({
      OPENAI_API_KEY: null,
      XAI_API_KEY: "xai-test",
      CODEX_API_KEY: null,
    }, () => {
      const settings = tui._getEditableSettings();
      const index = settings.findIndex((entry) => entry.setting_key === "grok_image_model");
      assert.notEqual(index, -1);
      tui._settingsIndex = index;

      const originalWrite = process.stdout.write;
      process.stdout.write = () => true;
      try {
        tui._startEdit();
      } finally {
        process.stdout.write = originalWrite;
      }

      assert.deepEqual(tui._editModelChoices.map((choice) => choice.value), [
        "grok-imagine-image-quality",
        "grok-imagine-image-quality-latest",
        "grok-imagine-image-quality-20260403",
        "grok-imagine-image-pro",
        "grok-imagine-image",
        "grok-imagine-image-2026-03-02",
      ]);
      assert.equal(tui._editModelIndex, 0);
      tui._resetEditState();
    });
  });

  it("does not present stale Grok image typos as the stored admin model value", () => {
    const { queueMod } = runtimeModules;
    const previousGrokImageModel = queueMod.getSetting("grok_image_model");
    try {
      queueMod.setSetting("grok_image_model", "grok-imagine-image-image");
      withEnv({ XAI_API_KEY: "xai-test" }, () => {
        const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
        const entry = tui._getModelSettingEntries().find((row) => row.setting_key === "grok_image_model");

        assert.ok(entry);
        assert.equal(entry.setting_value, "");
        assert.equal(entry.effective_model, "grok-imagine-image-quality");
        assert.equal(entry.source, "default");
      });
    } finally {
      queueMod.setSetting("grok_image_model", previousGrokImageModel);
    }
  });

  it("renders image artifact routing from account settings instead of protocol config defaults", () => withArtifactProtocols((config) => {
    config.image.provider = "grok";
    config.image.model = "grok-imagine-image";
  }, () => withEnv({ OPENAI_API_KEY: "test-key", XAI_API_KEY: null }, () => {
    const { queueMod } = runtimeModules;
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");

    try {
      queueMod.setSetting("artifact_image_provider", "openai");
      const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
      const snapshot = tui._getSettingsSnapshot({ maxAgeMs: 0 });
      const imageEntry = snapshot.artifactSettings.find((entry) => entry.setting_key === "artifact_image_provider");
      const rendered = tui.renderSnapshot();

      assert.equal(imageEntry.setting_value, "openai");
      assert.equal(imageEntry.source, "global");
      assert.match(rendered, /Image route: openai/);
      assert.doesNotMatch(rendered, /Image route: grok/);
    } finally {
      queueMod.setSetting("artifact_image_provider", previousImageProvider);
    }
  })));
});
