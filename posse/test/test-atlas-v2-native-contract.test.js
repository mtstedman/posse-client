import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildAtlasProcessEnv,
  buildAtlasServerSpec,
  getAtlasIntegrationConfig,
  resolveAtlasExecutionAttachment,
} from "../lib/domains/integrations/functions/atlas.js";
import {
  buildEmbeddedAtlasInvocation,
  getAtlasEmbeddedToolDefinitions,
} from "../lib/domains/integrations/functions/atlas-embedded.js";
import {
  isAtlasShadowEnabled,
  normalizeAtlasV2Mode,
  shadowAuthorityMode,
  shouldRunDualBackends,
  shouldUseAtlasV2,
} from "../lib/domains/integrations/functions/atlas-v2-mode.js";

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), "..");

describe("ATLAS v2 native contract", () => {
  it("normalizes historical v2 mode aliases without dual-backend execution", () => {
    assert.equal(normalizeAtlasV2Mode(""), "on");
    assert.equal(normalizeAtlasV2Mode("v2"), "on");
    assert.equal(normalizeAtlasV2Mode("preferred"), "on");
    assert.equal(normalizeAtlasV2Mode("shadow"), "on");
    assert.equal(normalizeAtlasV2Mode("required"), "required");
    assert.equal(normalizeAtlasV2Mode("legacy"), "off");
    assert.equal(shouldRunDualBackends({}), false);
    assert.equal(isAtlasShadowEnabled("shadow"), false);
    assert.equal(shadowAuthorityMode("preferred"), "required");
  });

  it("does not ship the removed sidecar/shadow modules", () => {
    for (const rel of [
      "lib/functions/integrations/atlas-v2-shim.js",
      "lib/functions/integrations/atlas-shared-runtime.js",
      "lib/functions/integrations/atlas-runtime-controller.js",
      "lib/functions/integrations/atlas-shadow.js",
      "lib/functions/integrations/atlas-drift-reconciliation.js",
      "lib/functions/integrations/atlas-capability.js",
    ]) {
      assert.equal(fs.existsSync(path.join(repoDir, rel)), false, rel);
    }
  });

  it("builds native process env and specs without a command", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "posse-atlas-v2-native-"));
    try {
      const config = getAtlasIntegrationConfig({
        POSSE_ATLAS_MODE: "on",
        POSSE_ATLAS_V2: "on",
        POSSE_ATLAS_PHASES: "research",
        POSSE_ATLAS_REPO_PATH: cwd,
        POSSE_ATLAS_REPO_ID: "native-repo",
      });
      const env = buildAtlasProcessEnv({ cwd, config, ensureDir: false });
      const spec = buildAtlasServerSpec({ cwd, config });
      const invocation = buildEmbeddedAtlasInvocation("symbol.search", { cwd, config });

      assert.equal(shouldUseAtlasV2({ config }), true);
      assert.match(env.ATLAS_V2_LEDGER_DB_PATH, /ledger\.db$/);
      assert.match(env.ATLAS_V2_MAIN_VIEW_DB_PATH, /main\.view\.db$/);
      assert.equal(spec.transport, "v2");
      assert.equal(spec.command, null);
      assert.deepEqual(spec.args, []);
      assert.equal(invocation.command, null);
      assert.equal(invocation.source, "atlas-v2-native");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps embedded tool definitions aligned with deterministic ATLAS tools", () => {
    const definitions = getAtlasEmbeddedToolDefinitions(["symbol.search", "context"]);
    assert.deepEqual(definitions.map((tool) => tool.name), ["atlas_symbol_search", "atlas_context"]);
  });

  it("resolves disabled attachments when atlas_v2 is off", () => {
    const config = getAtlasIntegrationConfig({
      POSSE_ATLAS_MODE: "on",
      POSSE_ATLAS_V2: "off",
      POSSE_ATLAS_PHASES: "research",
    });
    const attachment = resolveAtlasExecutionAttachment({
      role: "researcher",
      providerName: "claude",
      config,
    });

    assert.equal(config.enabled, false);
    assert.equal(attachment.active, false);
    assert.equal(attachment.backend, "atlas-v2");
    assert.equal(attachment.transport, "none");
  });
});
