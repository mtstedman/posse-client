import {
  it,
  assert,
  suite,
  runtimeModules,
  withEnv,
  withArtifactProtocols,
  getProviderHealth,
  isProviderReady,
} from "../support/core-harness.js";

let db;

suite("Provider health routes", () => {
  it("treats claude as unavailable for image generation capability checks", () => {
    const readiness = isProviderReady("claude", "images");
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason || "", /does not support image generation/i);
  });

  it("reports openai image health when the image protocol is routed to openai", () => {
    const { queueMod } = runtimeModules;
    // Provider-role routing lives in the global account settings DB, which is
    // shared across the whole aggregate core run. Clear every role provider so a
    // leaked openai role assignment from an earlier suite cannot add an "openai"
    // (non-image) health row and mask the image-only routing under test.
    const providerRoles = ["dev", "artificer", "researcher", "planner", "preflight", "assessor", "delegator"];
    const previousRoleProviders = providerRoles.map((role) => [role, queueMod.getSetting(`provider_${role}`)]);
    const previousImageProvider = queueMod.getSetting("artifact_image_provider");
    try {
      for (const [role] of previousRoleProviders) queueMod.setSetting(`provider_${role}`, null);
      queueMod.setSetting("artifact_image_provider", "openai");
      const health = getProviderHealth();
      const openai = health.find((row) => row.provider === "openai");
      const openaiImages = health.find((row) => row.provider === "openai-images");

      assert.equal(openai, undefined);
      assert.ok(openaiImages);
      assert.equal(openaiImages.status, isProviderReady("openai").ready ? "available" : "unavailable");
      assert.equal(health.some((row) => row.provider === "grok-images"), false);
    } finally {
      queueMod.setSetting("artifact_image_provider", previousImageProvider);
      for (const [role, value] of previousRoleProviders) queueMod.setSetting(`provider_${role}`, value);
    }
  });

  it("reports grok image health when the image protocol is routed to grok", () => {
    withArtifactProtocols((config) => {
      config.image.provider = "grok";
      config.image.model = "grok-imagine-image";
    }, () => {
      const health = withEnv({ XAI_API_KEY: null }, () => getProviderHealth());
      const grok = health.find((row) => row.provider === "grok");
      const grokImages = health.find((row) => row.provider === "grok-images");

      assert.equal(grok, undefined);
      assert.ok(grokImages);
      assert.equal(grokImages.status, "unavailable");
      assert.equal(health.some((row) => row.provider === "openai-images"), false);
    });
  });

  it("reports copilot health when configured for a role", () => {
    const { queueMod } = runtimeModules;
    const previousProviderDev = queueMod.getSetting("provider_dev");
    try {
      queueMod.setSetting("provider_dev", "copilot");
      const ready = isProviderReady("copilot");
      const health = getProviderHealth();
      const copilot = health.find((row) => row.provider === "copilot");

      assert.ok(copilot);
      assert.equal(copilot.status, ready.ready ? "available" : "unavailable");
      assert.equal(copilot.detail, ready.reason);
    } finally {
      queueMod.setSetting("provider_dev", previousProviderDev);
    }
  });
});
