import {
  assert,
  fs,
  it,
  os,
  path,
  suite,
  withEnv,
  buildAtlasBootEnv,
  buildAtlasCapability,
  buildAtlasIntegrationPlan,
  buildAtlasMcpServerConfig,
  buildAtlasServerSpec,
  getAtlasIntegrationConfig,
  getAtlasRouteForRole,
  resolveAtlasExecutionAttachment,
  summarizeAtlasIntegrationPlan,
  getProviderAtlasSupport,
} from "../support/core-harness.js";

suite("ATLAS v2 native integration routing", () => {
  it("defaults to the native v2 backend and ignores removed runtime settings", () => {
    const config = getAtlasIntegrationConfig({
      POSSE_ATLAS_MODE: "off",
      POSSE_ATLAS_V2: "on",
      POSSE_ATLAS_PHASES: "research,planning",
      POSSE_ATLAS_INSTALL_PATH: "C:/development/claude/tools/external-atlas",
      POSSE_ATLAS_NODE_PATH: "C:/nvm4w/nodejs/node.exe",
      POSSE_ATLAS_COMMAND: "external-atlas",
    });

    assert.equal(config.enabled, true);
    assert.equal(config.atlasVersion, "v2");
    assert.equal(config.atlasV2Mode, "on");
    assert.equal(config.transport, "v2");
    assert.equal(config.installPath, null);
    assert.equal(config.command, null);
    assert.deepEqual(config.args, []);
    assert.equal(Object.hasOwn(config, "nodePath"), false);
    assert.equal(Object.hasOwn(config, "sharedRuntime"), false);
  });

  it("keeps off aliases as a hard ATLAS disable", () => {
    for (const value of ["off", "0", "false", "no", "legacy"]) {
      const config = getAtlasIntegrationConfig({
        POSSE_ATLAS_MODE: "on",
        POSSE_ATLAS_V2: value,
        POSSE_ATLAS_PHASES: "research",
      });
      assert.equal(config.enabled, false, value);
      assert.equal(config.atlasV2Mode, "off", value);
    }
  });

  it("maps provider MCP support through the Posse gateway instead of a sidecar", () => {
    const config = getAtlasIntegrationConfig({
      POSSE_ATLAS_MODE: "on",
      POSSE_ATLAS_V2: "required",
      POSSE_ATLAS_PHASES: "research,planning",
      atlas_live_funnel: "true",
    });

    const claude = getProviderAtlasSupport("claude", { config });
    const codex = getProviderAtlasSupport("codex", { config });
    const openai = getProviderAtlasSupport("openai", { config });

    assert.equal(claude.transport, "mcp-gateway");
    assert.equal(codex.transport, "mcp-gateway");
    assert.equal(openai.transport, "embedded");
    assert.equal(claude.backend, "atlas-v2");
  });

  it("builds server specs without a process command", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "posse-atlas-v2-spec-"));
    try {
      const config = getAtlasIntegrationConfig({
        POSSE_ATLAS_MODE: "on",
        POSSE_ATLAS_V2: "on",
        POSSE_ATLAS_PHASES: "research",
        POSSE_ATLAS_REPO_PATH: cwd,
        POSSE_ATLAS_REPO_ID: "repo-a",
      });
      const spec = buildAtlasServerSpec({ cwd, config });
      const mcpSpec = buildAtlasMcpServerConfig("researcher", { cwd, config });

      assert.equal(spec.name, "atlas-v2");
      assert.equal(spec.transport, "v2");
      assert.equal(spec.command, null);
      assert.deepEqual(spec.args, []);
      assert.equal(spec.installPath, null);
      assert.equal(spec.backend, "atlas-v2");
      assert.equal(mcpSpec.transport, "v2");
      assert.match(spec.ledgerDbPath, /ledger\.db$/);
      assert.match(spec.viewDbPath, /main\.view\.db$/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("advertises ATLAS only through v2 route phases", () => {
    const config = getAtlasIntegrationConfig({
      POSSE_ATLAS_MODE: "on",
      POSSE_ATLAS_V2: "on",
      POSSE_ATLAS_PHASES: "research",
      atlas_live_funnel: "true",
    });

    const researcher = getAtlasRouteForRole("researcher", { config });
    const dev = getAtlasRouteForRole("dev", { config });
    const plan = buildAtlasIntegrationPlan({ config });
    const summary = summarizeAtlasIntegrationPlan({ config });

    assert.equal(researcher.shouldAdvertise, true);
    assert.equal(researcher.active, true);
    assert.equal(dev.shouldAdvertise, false);
    assert.equal(plan.every((entry) => entry.backend === "atlas-v2"), true);
    assert.equal(summary.every((entry) => entry.backend === "atlas-v2"), true);
  });

  it("resolves execution attachments without legacy server metadata", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "posse-atlas-v2-attachment-"));
    try {
      const config = getAtlasIntegrationConfig({
        POSSE_ATLAS_MODE: "on",
        POSSE_ATLAS_V2: "required",
        POSSE_ATLAS_PHASES: "research",
        atlas_live_funnel: "true",
        POSSE_ATLAS_REPO_PATH: cwd,
        POSSE_ATLAS_REPO_ID: "repo-b",
      });
      const attachment = resolveAtlasExecutionAttachment({
        role: "researcher",
        providerName: "claude",
        cwd,
        config,
      });
      const capability = buildAtlasCapability("researcher", { cwd, config });

      assert.equal(attachment.active, true);
      assert.equal(attachment.backend, "atlas-v2");
      assert.equal(attachment.transport, "mcp-gateway");
      assert.equal(attachment.server, null);
      assert.equal(capability.backend, "atlas-v2");
      assert.equal(capability.server, null);
      assert.match(capability.ledgerDbPath, /ledger\.db$/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not project deleted runtime env vars into boot env", () => {
    const bootEnv = withEnv({}, () => buildAtlasBootEnv({}));

    assert.equal(Object.hasOwn(bootEnv, "POSSE_ATLAS_INSTALL_PATH"), false);
    assert.equal(Object.hasOwn(bootEnv, "POSSE_ATLAS_NODE_PATH"), false);
    assert.equal(Object.hasOwn(bootEnv, "POSSE_ATLAS_SHARED_RUNTIME"), false);
  });
});
