// Characterization snapshot for the per-provider tool surface.
//
// Locks the exact set of tools each provider exposes per (role, allowWrite) so
// the tool-catalog/registry refactor (suite-namespaced catalog, unified
// executor registry, parity checks) can be proven behavior-preserving. If a
// refactor legitimately changes the surface, regenerate the fixture with:
//   node -e "import('./test/support/dump-tool-surface.mjs')"  (or rerun the
//   one-off dump) and review the diff deliberately.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildExecutionContract,
  buildClaudeCliToolConfig,
  adaptExecutionContractForProvider,
} from "../lib/functions/tools/contract.js";
import { __testGetToolsForRole as openaiTools } from "../lib/domains/providers/functions/openai.js";
import { __testGetToolsForRole as grokTools } from "../lib/domains/providers/functions/grok.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE = path.join(__dirname, "fixtures", "tool-surface-snapshot.json");

const ROLES = ["dev", "artificer", "assessor", "researcher", "planner", "preflight", "delegator"];

function toolName(def) {
  return def?.function?.name || def?.name;
}

function buildContractFor(provider, role, allowWrite) {
  return buildExecutionContract({
    provider,
    role,
    allowWrite,
    needsImageGeneration: true,
    scopedFiles: [],
    createFiles: [],
    createRoots: [],
    deleteFiles: [],
    platform: "linux",
  });
}

function computeSurface() {
  const out = {};
  for (const role of ROLES) {
    for (const allowWrite of [false, true]) {
      out[`${role}/${allowWrite}`] = {
        openai: openaiTools(buildContractFor("openai", role, allowWrite)).map(toolName).sort(),
        grok: grokTools(buildContractFor("grok", role, allowWrite)).map(toolName).sort(),
        claude: buildClaudeCliToolConfig(buildContractFor("claude", role, allowWrite), {}),
        codex: adaptExecutionContractForProvider(buildContractFor("codex", role, allowWrite), "codex")
          .tools.map((t) => t.name).sort(),
      };
    }
  }
  return out;
}

describe("tool surface snapshot", () => {
  it("matches the committed golden fixture for every provider/role/allowWrite", () => {
    const expected = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    const actual = computeSurface();
    assert.deepEqual(actual, expected);
  });

  it("openai and grok expose an identical deterministic surface (pre-unification invariant)", () => {
    for (const role of ROLES) {
      for (const allowWrite of [false, true]) {
        const oa = openaiTools(buildContractFor("openai", role, allowWrite)).map(toolName).sort();
        const gk = grokTools(buildContractFor("grok", role, allowWrite)).map(toolName).sort();
        assert.deepEqual(oa, gk, `${role}/${allowWrite}: openai and grok tool sets diverged`);
      }
    }
  });

  it("assessor bash is a read-only variant distinct from dev bash", () => {
    const assessorBash = openaiTools(buildContractFor("openai", "assessor", false))
      .map((d) => d.function || d)
      .find((d) => d.name === "bash");
    const devBash = openaiTools(buildContractFor("openai", "dev", true))
      .map((d) => d.function || d)
      .find((d) => d.name === "bash");
    assert.ok(assessorBash, "assessor should expose bash");
    assert.ok(devBash, "dev should expose bash");
    assert.notDeepEqual(assessorBash, devBash, "assessor bash should differ from dev bash (read-only variant)");
  });
});
