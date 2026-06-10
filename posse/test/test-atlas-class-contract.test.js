import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), "..");

describe("atlas cutover contract", () => {
  it("keeps removed ATLAS class modules out of lib/classes/atlas", () => {
    // The ATLAS classes root was removed entirely when the implementation moved
    // to lib/domains/atlas. Guard that lib/classes/atlas does not reappear.
    const classDir = path.join(repoDir, "lib", "classes", "atlas");
    assert.equal(fs.existsSync(classDir), false);
    assert.equal(fs.existsSync(path.join(repoDir, "lib", "domains", "atlas", "classes", "v2")), true);
  });

  it("keeps deprecated mode aliases normalized through integration config", async () => {
    const { getAtlasModeState } = await import("../lib/domains/integrations/functions/atlas/config.js");

    assert.deepEqual(getAtlasModeState("preferred"), {
      mode: "preferred",
      normalizedMode: "on",
      telemetryOnly: false,
      abEnabled: false,
      modeAlias: "preferred",
    });
    assert.equal(getAtlasModeState("shadow").telemetryOnly, true);
    assert.equal(getAtlasModeState("split").abEnabled, true);
    assert.equal(getAtlasModeState("required").normalizedMode, "required");
  });

  it("defaults ATLAS integration config to preferred and all live phases", async () => {
    const { getAtlasIntegrationConfig } = await import("../lib/domains/integrations/functions/atlas/config.js");

    const config = getAtlasIntegrationConfig({});

    assert.equal(config.enabled, true);
    assert.equal(config.mode, "preferred");
    assert.equal(config.normalizedMode, "on");
    assert.deepEqual(config.phases, ["research", "planning", "assessment", "dev"]);
    assert.equal(config.liveFunnel, true);
    assert.equal(config.liveIndexEnabled, true);
    assert.equal(config.liveBuffersEnabled, true);
    assert.equal(config.bootReindexPolicy, "smart");
    assert.equal(config.reindexOnCommit, true);
    assert.equal(config.scipRestagePolicy, "smart");
    assert.equal(config.embeddingThreads, 2);
  });

  it("clamps ATLAS embedding thread config to the supported worker range", async () => {
    const { getAtlasIntegrationConfig } = await import("../lib/domains/integrations/functions/atlas/config.js");

    assert.equal(getAtlasIntegrationConfig({ atlas_embedding_threads: "1" }).embeddingThreads, 1);
    assert.equal(getAtlasIntegrationConfig({ atlas_embedding_threads: "12" }).embeddingThreads, 8);
    assert.equal(getAtlasIntegrationConfig({ atlas_embedding_threads: "nope" }).embeddingThreads, 2);
  });

  it("ignores the removed local ONNX cache env key", async () => {
    const { getAtlasIntegrationConfig } = await import("../lib/domains/integrations/functions/atlas/config.js");
    const { resolveLocalOnnxCacheDir } = await import("../lib/domains/atlas/functions/v2/embeddings/local-onnx.js");
    const repoRoot = path.join(repoDir, "fixture-repo");
    const ignoredCacheDir = path.join(repoDir, "ignored-model-cache");

    const config = getAtlasIntegrationConfig({
      POSSE_ATLAS_LOCAL_ONNX_CACHE_DIR: ignoredCacheDir,
      POSSE_ATLAS_MODE: "on",
      POSSE_ATLAS_V2: "on",
    });

    assert.equal(config.localOnnxCacheDir, null);
    assert.equal(
      resolveLocalOnnxCacheDir({ repoRoot, config }),
      path.join(repoRoot, ".posse", "atlas", "models", "onnx"),
    );
  });

  it("keeps embedded ATLAS toolkit wrapper aligned with deterministic tool definitions", async () => {
    const embedded = await import("../lib/domains/integrations/functions/atlas-embedded.js");
    const fromFn = embedded.getAtlasEmbeddedToolDefinitions(["symbol.search", "context"]);
    const toolkit = embedded.createAtlasEmbeddedToolkit();
    const fromToolkit = toolkit.toolDefinitions(["symbol.search", "context"]);
    assert.deepEqual(fromToolkit, fromFn);
  });

  it("keeps deleted runtime controller modules out of the integration surface", async () => {
    const atlas = await import("../lib/domains/integrations/functions/atlas.js");
    assert.equal(typeof atlas.buildAtlasServerSpec, "function");
    assert.equal(fs.existsSync(path.join(repoDir, "lib", "functions", "integrations", "atlas-runtime-controller.js")), false);
    assert.equal(fs.existsSync(path.join(repoDir, "lib", "functions", "integrations", "atlas-shared-runtime.js")), false);
  });
});
