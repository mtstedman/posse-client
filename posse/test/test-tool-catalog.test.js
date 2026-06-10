import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ToolCatalog } from "../lib/classes/tools/ToolCatalog.js";
import {
  TOOL_BASH,
  TOOL_CHAIN_READ,
  TOOL_CHAIN_VERDICT,
  TOOL_CLEAN_IMAGE,
  TOOL_COPY_FILE,
  TOOL_CREATE_TEST,
  TOOL_CREATE_TEST_SUITE,
  TOOL_EDIT_FILE,
  TOOL_EXTRACT_IMAGE_TEXT,
  TOOL_GENERATE_IMAGE,
  TOOL_GIT_HISTORY,
  TOOL_HASH_FILE,
  TOOL_INSPECT_FILE,
  TOOL_LIST_FILES,
  TOOL_MAKE_DIR,
  TOOL_MOVE_FILE,
  TOOL_OPTIMIZE_IMAGE,
  TOOL_PRUNE_ARTIFACT_OUTPUT,
  TOOL_PULL_BRIEF,
  TOOL_READ_FILE,
  TOOL_READ_IMAGE_METADATA,
  TOOL_REENCODE_IMAGE,
  TOOL_RESIZE_IMAGE,
  TOOL_RUN_SCOPED_CHECKS,
  TOOL_RUN_TEST,
  TOOL_RUN_TEST_SUITE,
  TOOL_SEARCH_FILES,
  TOOL_VALIDATE_ARTIFACT_OUTPUT,
  TOOL_WRITE_FILE,
} from "../lib/functions/toolkit/index.js";
import {
  ATLAS_TOOL_DEFS,
  HIDDEN_ATLAS_SURFACE_ACTIONS,
  TOOL_CATALOG,
  buildFoldedAtlasToolDescriptor,
  getBaseToolNamesForRole,
  getDeterministicMcpToolNames,
  getAtlasRouteDefinitionForRole,
  getAtlasToolNames,
  getToolExecutionSpec,
  isBlockedFoldedAtlasTool,
  isFallbackOnlyAtlasTool,
  renderAtlasRoleContract,
  SURFACED_ATLAS_TOOL_DEFS,
} from "../lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js";
import { prepareAtlasDeterministicPayload } from "../lib/functions/toolkit/atlas.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoDir = path.resolve(__dirname, "..");

const EXPORTED_NATIVE_SCHEMAS = [
  TOOL_BASH,
  TOOL_CHAIN_READ,
  TOOL_CHAIN_VERDICT,
  TOOL_CLEAN_IMAGE,
  TOOL_COPY_FILE,
  TOOL_CREATE_TEST,
  TOOL_CREATE_TEST_SUITE,
  TOOL_EDIT_FILE,
  TOOL_EXTRACT_IMAGE_TEXT,
  TOOL_GENERATE_IMAGE,
  TOOL_GIT_HISTORY,
  TOOL_HASH_FILE,
  TOOL_INSPECT_FILE,
  TOOL_LIST_FILES,
  TOOL_MAKE_DIR,
  TOOL_MOVE_FILE,
  TOOL_OPTIMIZE_IMAGE,
  TOOL_PRUNE_ARTIFACT_OUTPUT,
  TOOL_PULL_BRIEF,
  TOOL_READ_FILE,
  TOOL_READ_IMAGE_METADATA,
  TOOL_REENCODE_IMAGE,
  TOOL_RESIZE_IMAGE,
  TOOL_RUN_SCOPED_CHECKS,
  TOOL_RUN_TEST,
  TOOL_RUN_TEST_SUITE,
  TOOL_SEARCH_FILES,
  TOOL_VALIDATE_ARTIFACT_OUTPUT,
  TOOL_WRITE_FILE,
];

describe("tool catalog drift guard", () => {
  it("contains every deterministic toolkit schema export", () => {
    for (const schema of EXPORTED_NATIVE_SCHEMAS) {
      assert.ok(schema?.name, "schema must have a name");
      assert.ok(TOOL_CATALOG[schema.name], `${schema.name} is missing from TOOL_CATALOG`);
      assert.equal(TOOL_CATALOG[schema.name].schema, schema);
    }
  });

  it("requires execution and observation metadata for every native tool", () => {
    for (const schema of EXPORTED_NATIVE_SCHEMAS) {
      const entry = TOOL_CATALOG[schema.name];
      const spec = getToolExecutionSpec(schema.name);
      assert.ok(spec, `${schema.name} is missing execution metadata`);
      assert.notEqual(entry.access, "unknown", `${schema.name} must not use unknown access metadata`);
      assert.equal(typeof entry.summary, "string", `${schema.name} must declare a summary`);
      assert.ok(entry.summary.length > 0, `${schema.name} must declare a non-empty summary`);
      assert.ok(entry.observation, `${schema.name} is missing observation metadata`);
      assert.equal(entry.observation.type, spec.observation.type, `${schema.name} observation type drifted`);
      assert.equal(entry.observation.format, spec.observation.format, `${schema.name} observation format drifted`);
    }
  });

  it("rejects uncataloged execution metadata instead of synthesizing defaults", () => {
    assert.throws(
      () => ToolCatalog.getExecutionSpec("__missing_tool__"),
      /missing execution metadata/
    );
  });

  it("contains every tool-contract role allowlist name", () => {
    const roles = ["dev", "artificer", "assessor", "researcher", "planner", "preflight", "delegator", "unknown"];
    for (const role of roles) {
      for (const allowWrite of [false, true]) {
        const names = getBaseToolNamesForRole(role, allowWrite, { needsImageGeneration: true });
        for (const name of names) {
          assert.ok(TOOL_CATALOG[name], `${role}/${allowWrite} references uncataloged tool ${name}`);
        }
      }
    }
  });

  it("contains every deterministic MCP server role allowlist name", () => {
    const roles = ["dev", "artificer", "assessor", "researcher", "planner"];
    for (const role of roles) {
      const names = getDeterministicMcpToolNames(role, { needsImageGeneration: true });
      for (const name of names) {
        assert.ok(TOOL_CATALOG[name], `${role} MCP allowlist references uncataloged tool ${name}`);
      }
    }
  });

  it("exposes registered test tools only to dev and assessor MCP roles", () => {
    const testTools = ["run_scoped_checks", "create_test_suite", "create_test", "run_test", "run_test_suite"];
    for (const role of ["dev", "assessor"]) {
      const names = getDeterministicMcpToolNames(role, { needsImageGeneration: true });
      for (const name of testTools) {
        assert.ok(names.includes(name), `${role} should expose ${name}`);
      }
    }
    for (const role of ["artificer", "researcher", "planner"]) {
      const names = getDeterministicMcpToolNames(role, { needsImageGeneration: true });
      for (const name of testTools) {
        assert.equal(names.includes(name), false, `${role} should not expose ${name}`);
      }
    }
  });

  it("contains every ATLAS deterministic action", () => {
    for (const name of getAtlasToolNames()) {
      assert.ok(TOOL_CATALOG[name], `${name} is missing from TOOL_CATALOG`);
      assert.equal(TOOL_CATALOG[name].access, "atlas");
    }
  });

  it("keeps temporarily hidden ATLAS actions implemented but unsurfaced", () => {
    for (const action of HIDDEN_ATLAS_SURFACE_ACTIONS) {
      assert.ok(ATLAS_TOOL_DEFS[action], `${action} should keep its descriptor for internal dispatch`);
      assert.equal(SURFACED_ATLAS_TOOL_DEFS[action], undefined, `${action} should not be in surfaced descriptors`);
      assert.equal(TOOL_CATALOG[action], undefined, `${action} should not be in the public tool catalog`);
      assert.equal(getAtlasToolNames().includes(action), false, `${action} should not be advertised as a tool`);
    }
    assert.equal(ATLAS_TOOL_DEFS.query.parameters.properties.action.enum.includes("repo.overview"), false);
    assert.equal(ATLAS_TOOL_DEFS.query.parameters.properties.action.enum.includes("memory.surface"), false);
    assert.equal(ATLAS_TOOL_DEFS.repo.parameters.properties.action.enum.includes("repo.overview"), false);
    assert.equal(ATLAS_TOOL_DEFS.agent.parameters.properties.action.enum.includes("memory.surface"), false);
  });

  it("renders ATLAS role prompt contracts for every routed role", () => {
    // ATLAS contracts are generated at handoff time from the tool catalog —
    // there is no checked-in canonical to drift against. Confirm the
    // renderer produces a non-empty contract that names the role in its
    // header for every role that loads an ATLAS contract.
    for (const role of ["researcher", "planner", "dev", "assessor"]) {
      const contract = renderAtlasRoleContract(role);
      assert.ok(contract.length > 0, `expected non-empty ATLAS contract for ${role}`);
      assert.match(contract, new RegExp(`ATLAS TOOLS CONTRACT - ${role.toUpperCase()}`));
    }
  });

  it("keeps ATLAS file.read out of routed role contracts while surfacing broad repo overview", () => {
    for (const role of ["researcher", "planner", "dev", "assessor"]) {
      const route = getAtlasRouteDefinitionForRole(role);
      const contract = renderAtlasRoleContract(role);
      assert.equal(route.tools.includes("file.read"), false, `${role} route should not expose ATLAS file.read`);
      assert.equal(route.tools.includes("repo.overview"), true, `${role} route should expose repo.overview`);
      assert.equal(route.tools.includes("memory.surface"), false, `${role} route should not expose memory.surface`);
      assert.doesNotMatch(contract, /atlas\.file\.read|atlas_file_read/);
      assert.match(contract, /atlas\.repo\.overview|atlas_repo_overview/);
      assert.doesNotMatch(contract, /atlas\.memory\.surface|atlas_memory_surface/);
    }
    assert.equal(ATLAS_TOOL_DEFS.query.parameters.properties.action.enum.includes("file.read"), false);
    assert.equal(ATLAS_TOOL_DEFS.code.parameters.properties.action.enum.includes("file.read"), false);
    assert.throws(
      () => prepareAtlasDeterministicPayload("query", { action: "file.read", filePath: "README.md" }),
      /intentionally not exposed/,
    );
    assert.throws(
      () => prepareAtlasDeterministicPayload("file.read", { filePath: "README.md" }),
      /intentionally not exposed/,
    );
    assert.equal(isFallbackOnlyAtlasTool("atlas.file.read"), true);
  });

  it("renders ATLAS contracts with exact provider-visible names", () => {
    const openai = renderAtlasRoleContract("planner", {
      providerName: "openai",
      atlasAttachment: {
        provider: "openai",
        transport: "embedded",
        tools: ["context.summary", "symbol.search", "symbol.getCard", "code.getSkeleton", "code.getHotPath"],
      },
      atlasPrefetchStatus: "ok_relevant",
      atlasGateEnabled: false,
    });
    assert.match(openai, /atlas_context_summary: Task-shaped summary/);
    assert.match(openai, /OpenAI exposes ATLAS as function tools/);
    assert.match(openai, /ATLAS prefetch supplied task-relevant context/);
    assert.match(openai, /comprehension scaffold for the first codebase map/);
    assert.match(openai, /code-content understanding/);
    assert.match(openai, /specific context gap remains/);
    // The contract is only rendered when ATLAS is attached and advertised, which
    // already asserts ATLAS-is-primary — no need to restate it inside the contract.
    assert.doesNotMatch(openai, /You must use ATLAS tools first/);
    assert.doesNotMatch(openai, /3-call gate/);
    assert.doesNotMatch(openai, /make at least 3 task-relevant ATLAS retrieval calls/);
    assert.doesNotMatch(openai, /atlas\.context: Task-shaped discovery/);
    assert.doesNotMatch(openai, /atlas_code_need_window/);

    const gated = renderAtlasRoleContract("planner", {
      providerName: "openai",
      atlasGateEnabled: true,
      atlasAttachment: {
        provider: "openai",
        transport: "embedded",
        tools: ["context.summary", "symbol.search", "symbol.getCard", "code.getSkeleton", "code.getHotPath"],
      },
      atlasPrefetchStatus: "ok_relevant",
    });
    assert.match(gated, /3-call native fallback gate/);
    assert.match(gated, /required targeted ATLAS discovery/);

    const codex = renderAtlasRoleContract("planner", {
      providerName: "codex",
      atlasGateEnabled: false,
      atlasAttachment: {
        provider: "codex",
        transport: "mcp",
        tools: ["context.summary", "symbol.search", "symbol.getCard", "code.getSkeleton", "code.getHotPath"],
      },
    });
    assert.match(codex, /atlas\.context\.summary: Task-shaped summary/);
    assert.match(codex, /Codex exposes ATLAS through the Posse MCP gateway/);
    assert.doesNotMatch(codex, /atlas_context: Task-shaped discovery/);
    assert.doesNotMatch(codex, /code\.needWindow/);

    const codexV2 = renderAtlasRoleContract("planner", {
      providerName: "codex",
      atlasAttachment: {
        provider: "codex",
        transport: "mcp",
        method: "atlas-v2",
        tools: ["context.summary", "symbol.search", "symbol.getCard", "code.getSkeleton", "code.getHotPath"],
      },
    });
    assert.match(codexV2, /ATLASv2 TOOLS CONTRACT - PLANNER/);
    assert.match(codexV2, /Codex exposes ATLASv2 through the Posse MCP gateway/);
    assert.doesNotMatch(codexV2, /You must use ATLASv2 tools first/);
    // The "is the primary path" line was removed — the contract's presence
    // already asserts that. ATLASv2 vs ATLAS label distinction is now guarded
    // by the header + provider-naming line above.
    assert.doesNotMatch(codexV2, /ATLASv2 is the primary path/);
    assert.doesNotMatch(codexV2, /ATLAS is the primary path/);
    assert.doesNotMatch(codexV2, /ATLAS\/Iris/);
  });

  it("overlays gateway MCP ATLAS descriptions from Posse's canonical catalog", () => {
    const folded = buildFoldedAtlasToolDescriptor({
      name: "atlas.symbol.getCard",
      description: "upstream generic description",
      inputSchema: { type: "object" },
    });

    assert.match(folded.description, /Iris Rung 1/);
    assert.doesNotMatch(folded.description, /upstream generic description/);
  });

  it("normalizes provider-flat ATLAS names before descriptor enrichment", () => {
    const folded = buildFoldedAtlasToolDescriptor({
      name: "atlas_symbol_getCard",
      description: "upstream generic description",
      inputSchema: { type: "object" },
    });

    assert.match(folded.description, /Iris Rung 1/);
    assert.doesNotMatch(folded.description, /upstream generic description/);
    assert.equal(isBlockedFoldedAtlasTool("atlas_file_write"), true);
  });
});
