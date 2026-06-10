import {
  it,
  beforeEach,
  after,
  assert,
  path,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  buildGateLockedToolError,
  checkNativeToolAllowed,
  configureGate,
  getFallbackStrikeLimit,
  getMeaningfulAtlasCalls,
  getRequiredMeaningfulAtlasCalls,
  getUnhelpfulStrikes,
  getUnlockReason,
  isFallbackAtlasPrefetchStatus,
  isRelevantAtlasPrefetchStatus,
  isGateActive,
  isFileDiscoveredForGate,
  isGatedTool,
  isGateUnlocked,
  noteAtlasCall,
  unlockForAtlasPrefetch,
  unlockForAtlasUnavailable,
  __resetGateForTests,
  buildFoldedAtlasToolDescriptor,
  buildNativeToolDescriptor,
  isBlockedFoldedAtlasTool,
} from "../support/core-harness.js";

let db;

suite("Researcher ATLAS gate", () => {
  beforeEach(() => __resetGateForTests());

  it("is active for every gated role when ATLAS is available", () => {
    for (const role of ["researcher", "planner", "dev", "assessor"]) {
      configureGate({ role, atlasAvailable: true });
      assert.equal(isGateActive(), true, `${role} should be gated when ATLAS is available`);
    }
  });

  it("is inactive for artificer and delegator even when ATLAS is available", () => {
    for (const role of ["artificer", "delegator"]) {
      configureGate({ role, atlasAvailable: true });
      assert.equal(isGateActive(), false, `${role} should not be gated`);
    }
  });

  it("is inactive for researcher when ATLAS is unavailable", () => {
    configureGate({ role: "researcher", atlasAvailable: false });
    assert.equal(isGateActive(), false);
  });

  it("is inactive when the ATLAS native-tool gate setting is disabled", () => {
    configureGate({ role: "researcher", atlasAvailable: true, enabled: false });
    assert.equal(isGateActive(), false);
  });

  it("keeps explicit gate scopes independent without observation context", () => {
    const firstScope = configureGate({ role: "researcher", atlasAvailable: true, scopeKey: "job:901" });
    for (let i = 0; i < getRequiredMeaningfulAtlasCalls(); i++) {
      noteAtlasCall({ action: "symbol.search", ok: true, empty: false, scopeKey: firstScope });
    }
    const secondScope = configureGate({ role: "researcher", atlasAvailable: true, scopeKey: "job:902" });

    assert.equal(firstScope, "job:901");
    assert.equal(secondScope, "job:902");
    assert.equal(isGateUnlocked({ scopeKey: firstScope }), true);
    assert.equal(isGateUnlocked({ scopeKey: secondScope }), false);
  });

  it("releases the configured gate scope after observation context teardown", async () => {
    const { runWithObservationContext } = await import("../../../lib/domains/observability/functions/observations.js");
    const { releaseGate } = await import("../../../lib/domains/integrations/functions/deterministic-mcp/gate.js");
    let configuredScope = null;

    await runWithObservationContext({ job_id: 903 }, () => {
      configuredScope = configureGate({ role: "researcher", atlasAvailable: true });
      assert.equal(configuredScope, "job:903");
      assert.equal(isGateActive(), true);
    });

    releaseGate({ scopeKey: configuredScope });

    await runWithObservationContext({ job_id: 903 }, () => {
      assert.equal(isGateActive(), false);
    });
  });

  it("unlocks immediately when ATLAS prefetch degraded and fallback is active", () => {
    configureGate({ role: "dev", atlasAvailable: true });
    assert.equal(isGateActive(), true);
    assert.equal(isGateUnlocked(), false);
    unlockForAtlasUnavailable({ reason: "prefetch_failed" });
    assert.equal(isGateUnlocked(), true);
    assert.equal(getUnlockReason(), "prefetch_failed");
  });

  it("does not treat relevant ATLAS prefetch as satisfying ATLAS-first discovery", () => {
    configureGate({ role: "researcher", atlasAvailable: true });
    assert.equal(isGateActive(), true);
    assert.equal(isGateUnlocked(), false);
    assert.equal(isRelevantAtlasPrefetchStatus("prefetch_ok_relevant"), true);
    assert.equal(unlockForAtlasPrefetch({ reason: "prefetch_ok_relevant" }), false);
    assert.equal(isGateUnlocked(), false);
    assert.equal(getUnlockReason(), null);
    assert.equal(getMeaningfulAtlasCalls(), 0);
  });

  it("treats only relevant ATLAS prefetch statuses as context-relevant", () => {
    assert.equal(isRelevantAtlasPrefetchStatus("ok_relevant"), true);
    assert.equal(isRelevantAtlasPrefetchStatus("prefetch_ok_relevant"), true);
    assert.equal(isRelevantAtlasPrefetchStatus("ok"), true);
    assert.equal(isRelevantAtlasPrefetchStatus("ok_unhelpful"), false);
    assert.equal(isRelevantAtlasPrefetchStatus("failed"), false);
    assert.equal(isFallbackAtlasPrefetchStatus("ok_unhelpful"), false);
    assert.equal(isFallbackAtlasPrefetchStatus("skipped"), false);
    assert.equal(isFallbackAtlasPrefetchStatus("failed"), true);
  });

  it("is active for researcher with ATLAS available and starts locked", () => {
    configureGate({ role: "researcher", atlasAvailable: true });
    assert.equal(isGateActive(), true);
    assert.equal(isGateUnlocked(), false);
    assert.equal(getUnlockReason(), null);
  });

  it("primary-unlocks after the required real ATLAS calls include non-empty content", () => {
    configureGate({ role: "researcher", atlasAvailable: true });
    const required = getRequiredMeaningfulAtlasCalls();
    for (let i = 0; i < required - 1; i++) {
      noteAtlasCall({ action: "symbol.search", ok: true, empty: false });
      assert.equal(isGateUnlocked(), false);
    }
    noteAtlasCall({ action: "slice.build", ok: true, empty: false });
    assert.equal(isGateUnlocked(), true);
    assert.equal(getUnlockReason(), "primary");
    assert.equal(getMeaningfulAtlasCalls(), required);
  });

  it("does not unlock on a single meaningful-but-empty ATLAS call", () => {
    configureGate({ role: "researcher", atlasAvailable: true });
    noteAtlasCall({ action: "symbol.search", ok: true, empty: true });
    assert.equal(isGateUnlocked(), false);
    assert.equal(getMeaningfulAtlasCalls(), 1);
    assert.equal(getUnhelpfulStrikes(), 1);
  });

  it("fallback-unlocks after the strike-limit consecutive unhelpful meaningful calls", () => {
    configureGate({ role: "researcher", atlasAvailable: true });
    const limit = getFallbackStrikeLimit();
    for (let i = 0; i < limit - 1; i++) {
      noteAtlasCall({ action: "slice.build", ok: true, empty: true });
    }
    assert.equal(isGateUnlocked(), false);
    noteAtlasCall({ action: "slice.build", ok: true, empty: true });
    assert.equal(isGateUnlocked(), true);
    assert.equal(getUnlockReason(), "fallback");
    assert.equal(getMeaningfulAtlasCalls(), limit);
  });

  it("counts errored meaningful calls as strikes toward the fallback", () => {
    configureGate({ role: "researcher", atlasAvailable: true });
    const limit = getFallbackStrikeLimit();
    for (let i = 0; i < limit; i++) {
      noteAtlasCall({ action: "code.getSkeleton", ok: false, empty: false });
    }
    assert.equal(isGateUnlocked(), true);
    assert.equal(getUnlockReason(), "fallback");
  });

  it("ignores non-meaningful actions entirely (repo.status and agent.feedback)", () => {
    configureGate({ role: "researcher", atlasAvailable: true });
    noteAtlasCall({ action: "repo.status", ok: true, empty: false });
    noteAtlasCall({ action: "agent.feedback", ok: true, empty: false });
    noteAtlasCall({ action: "repo.status", ok: true, empty: true });
    assert.equal(isGateUnlocked(), false);
    assert.equal(getMeaningfulAtlasCalls(), 0);
    assert.equal(getUnhelpfulStrikes(), 0);
  });

  it("counts repo.overview as meaningful broad ATLAS retrieval", () => {
    configureGate({ role: "researcher", atlasAvailable: true });
    noteAtlasCall({ action: "repo.overview", ok: true, empty: false });
    assert.equal(getMeaningfulAtlasCalls(), 1);
  });

  it("unlocks native reads file by file for indexable source files", () => {
    configureGate({ role: "researcher", atlasAvailable: true });
    const cwd = "C:/repo";

    let decision = checkNativeToolAllowed("chain_read", { path: "src/app.ts" }, { cwd });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "indexed_file_discovery_required");
    assert.equal(decision.target, "src/app.ts");

    noteAtlasCall({
      action: "code.getSkeleton",
      ok: false,
      empty: true,
      args: { file: "src/app.ts" },
      cwd,
    });
    assert.equal(isFileDiscoveredForGate("src/app.ts", { cwd }), true);
    assert.equal(checkNativeToolAllowed("chain_read", { path: "src/app.ts" }, { cwd }).allowed, true);
    assert.equal(checkNativeToolAllowed("chain_read", { path: "src/other.ts" }, { cwd }).allowed, false);
  });

  it("does not let global primary unlock bypass per-file source read discovery", () => {
    configureGate({ role: "planner", atlasAvailable: true });
    const cwd = "C:/repo";
    for (let i = 0; i < getRequiredMeaningfulAtlasCalls(); i++) {
      noteAtlasCall({ action: "symbol.search", ok: true, empty: false, args: { query: `thing ${i}` }, cwd });
    }
    assert.equal(isGateUnlocked(), true);
    assert.equal(getUnlockReason(), "primary");
    assert.equal(checkNativeToolAllowed("read_file", { path: "src/app.ts" }, { cwd }).allowed, false);

    noteAtlasCall({
      action: "symbol.search",
      ok: true,
      empty: false,
      args: { query: "app" },
      artifacts: { symbols: [{ symbolId: "a".repeat(64) + ":1", filePath: "src/app.ts" }] },
      cwd,
    });
    assert.equal(checkNativeToolAllowed("read_file", { path: "src/app.ts" }, { cwd }).allowed, true);
  });

  it("allows non-indexed reads and chain verdict while the source-file gate is locked", () => {
    configureGate({ role: "researcher", atlasAvailable: true });
    const cwd = "C:/repo";
    assert.equal(checkNativeToolAllowed("chain_read", { path: "README.md" }, { cwd }).allowed, true);
    assert.equal(checkNativeToolAllowed("chain_verdict", { relevant: true }, { cwd }).allowed, true);
    unlockForAtlasUnavailable({ reason: "atlas_proxy_init_failed" });
    assert.equal(checkNativeToolAllowed("chain_read", { path: "src/app.ts" }, { cwd }).allowed, true);
  });

  it("stays unlocked once primary-unlocked — no re-locking on later empty calls", () => {
    configureGate({ role: "researcher", atlasAvailable: true });
    noteAtlasCall({ action: "symbol.search", ok: true, empty: false });
    noteAtlasCall({ action: "slice.build", ok: true, empty: false });
    noteAtlasCall({ action: "code.getSkeleton", ok: true, empty: false });
    assert.equal(isGateUnlocked(), true);
    assert.equal(getUnlockReason(), "primary");
    const beforeCalls = getMeaningfulAtlasCalls();
    noteAtlasCall({ action: "slice.build", ok: true, empty: true });
    noteAtlasCall({ action: "code.getSkeleton", ok: false, empty: false });
    assert.equal(getMeaningfulAtlasCalls(), beforeCalls);
  });

  it("exposes the gated native tool set", () => {
    for (const name of [
      "chain_read", "chain_verdict",
      "list_files", "search_files", "git_history", "inspect_file", "hash_file", "read_file",
      "write_file", "edit_file", "move_file", "copy_file", "make_dir",
      "bash",
      "read_image_metadata", "validate_artifact_output", "optimize_image", "resize_image", "prune_artifact_output", "extract_image_text",
    ]) {
      assert.equal(isGatedTool(name), true, `${name} should be gated`);
    }
    for (const name of ["symbol.search", "repo.status", "generate_image"]) {
      assert.equal(isGatedTool(name), false, `${name} should not be gated`);
    }
  });

  it("produces a verbose locked-tool error that names the attempted tool and the strike count", () => {
    configureGate({ role: "researcher", atlasAvailable: true });
    noteAtlasCall({ action: "symbol.search", ok: true, empty: true });
    const msg = buildGateLockedToolError("chain_read");
    assert.match(msg, /Standard tools are fallback-only for the researcher role/);
    assert.match(msg, /Attempted tool: chain_read/);
    assert.match(msg, /Real ATLAS retrieval calls so far: 1\//);
    assert.match(msg, /Unhelpful ATLAS attempts so far: 1\//);
    assert.match(msg, /atlas\.symbol\.search/);
    assert.match(msg, /ATLAS prefetch and internal bookkeeping calls do NOT count/);
  });

  it("renders embedded-provider locked-tool hints with callable snake_case names", () => {
    configureGate({ role: "researcher", atlasAvailable: true });
    const msg = buildGateLockedToolError("chain_read", { atlasNameStyle: "embedded" });
    assert.match(msg, /atlas_symbol_search/);
    assert.match(msg, /atlas_slice_build/);
    assert.match(msg, /atlas_context_summary/);
    assert.doesNotMatch(msg, /atlas\.symbol\.search/);
  });

  it("counts meaningful nested ATLAS gateway actions without counting bookkeeping wrappers", () => {
    configureGate({ role: "researcher", atlasAvailable: true });
    noteAtlasCall({ action: "atlas.repo", args: { action: "policy.get" }, ok: true, empty: false });
    assert.equal(getMeaningfulAtlasCalls(), 0);
    noteAtlasCall({ action: "atlas.query", args: { action: "symbol.search", query: "auth" }, ok: true, empty: false });
    assert.equal(getMeaningfulAtlasCalls(), 1);
    noteAtlasCall({ action: "atlas.agent", args: { action: "memory.query", query: "auth" }, ok: true, empty: false });
    assert.equal(getMeaningfulAtlasCalls(), 2);
  });

  it("advertises gateway ATLAS retrieval tools with Codex-safe annotations", () => {
    const searchTool = buildFoldedAtlasToolDescriptor({
      name: "atlas.symbol.search",
      description: "Search symbols",
      inputSchema: { type: "object", properties: {} },
      annotations: { title: "ATLAS Symbol Search" },
    });
    assert.equal(searchTool.annotations.title, "ATLAS Symbol Search");
    assert.equal(searchTool.annotations.readOnlyHint, true);
    assert.equal(searchTool.annotations.destructiveHint, false);
    assert.equal(searchTool.annotations.idempotentHint, false);
    assert.equal(searchTool.annotations.openWorldHint, false);
    assert.equal(isBlockedFoldedAtlasTool("atlas.symbol.search"), false);
  });

  it("keeps mutating ATLAS tools out of the gateway proxy surface", () => {
    const writeTool = buildFoldedAtlasToolDescriptor({
      name: "atlas.file.write",
      description: "Write file",
      inputSchema: { type: "object", properties: {} },
    });
    assert.equal(isBlockedFoldedAtlasTool("atlas.file.write"), true);
    assert.equal(writeTool.annotations.readOnlyHint, false);
    assert.equal(writeTool.annotations.destructiveHint, false);

    const nativeEdit = buildNativeToolDescriptor({
      name: "edit_file",
      description: "Patch a scoped file",
      parameters: { type: "object", properties: {} },
    });
    assert.equal(nativeEdit.annotations.destructiveHint, false);
    assert.equal(nativeEdit.annotations.openWorldHint, false);
  });

  it("scopes state per job via observation context — concurrent jobs don't share unlock", async () => {
    const { runWithObservationContext } = await import("../../../lib/domains/observability/functions/observations.js");
    await runWithObservationContext({ job_id: 101 }, async () => {
      configureGate({ role: "researcher", atlasAvailable: true });
      for (let i = 0; i < getRequiredMeaningfulAtlasCalls(); i++) {
        noteAtlasCall({ action: "symbol.search", ok: true, empty: false });
      }
      assert.equal(isGateUnlocked(), true, "job 101 should be primary-unlocked");
    });
    await runWithObservationContext({ job_id: 202 }, async () => {
      configureGate({ role: "researcher", atlasAvailable: true });
      assert.equal(isGateUnlocked(), false, "job 202 must start locked despite job 101 being unlocked");
      assert.equal(isGateActive(), true);
    });
    // Job 101's state is still present until released
    await runWithObservationContext({ job_id: 101 }, async () => {
      assert.equal(isGateUnlocked(), true, "job 101 should still be unlocked across await boundary");
    });
  });

  it("releaseGate clears only the current scope", async () => {
    const { runWithObservationContext } = await import("../../../lib/domains/observability/functions/observations.js");
    const { releaseGate } = await import("../../../lib/domains/integrations/functions/deterministic-mcp/gate.js");
    await runWithObservationContext({ job_id: 301 }, () => {
      configureGate({ role: "researcher", atlasAvailable: true });
      noteAtlasCall({ action: "symbol.search", ok: true, empty: false });
    });
    await runWithObservationContext({ job_id: 302 }, () => {
      configureGate({ role: "researcher", atlasAvailable: true });
    });
    await runWithObservationContext({ job_id: 301 }, () => {
      releaseGate();
      // After release, the scope is fresh — isGateActive falls back to default (false)
      assert.equal(isGateActive(), false, "released scope should no longer be active");
    });
    await runWithObservationContext({ job_id: 302 }, () => {
      assert.equal(isGateActive(), true, "other scope must remain untouched");
    });
  });
});
