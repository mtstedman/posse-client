import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ATLAS_TOOL_ACTIONS } from "../lib/domains/atlas/functions/v2/contracts/tool-params.js";
import {
  ATLAS_GATEWAY_ACTIONS,
  ATLAS_MULTI_GATEWAY_ACTIONS,
  ATLAS_TOOL_PARAM_SCHEMAS,
  atlasDescriptorSchemaForAction,
} from "../lib/domains/atlas/functions/v2/contracts/tool-schemas.js";
import { buildAtlasToolInventory } from "../lib/domains/atlas/functions/v2/contracts/tool-inventory.js";
import { manual } from "../lib/domains/atlas/functions/v2/retrieval/discovery.js";
import {
  ATLAS_TOOL_DEFS,
  isAtlasActionSurfaced,
} from "../lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY_PATH = path.resolve(__dirname, "..", "docs", "generated", "atlas-v2-tool-inventory.json");

describe("ATLAS v2 schema inventory", () => {
  it("has a dispatcher schema for every native action", () => {
    for (const action of ATLAS_TOOL_ACTIONS) {
      assert.ok(ATLAS_TOOL_PARAM_SCHEMAS[action], `${action} missing dispatcher schema`);
    }
  });

  it("derives provider descriptor parameter shapes from dispatcher schemas", () => {
    for (const action of ATLAS_TOOL_ACTIONS) {
      const expected = schemaShape(expectedProviderDescriptorSchema(action));
      const actual = schemaShape(ATLAS_TOOL_DEFS[action]?.parameters);
      assert.deepEqual(actual, expected, `${action} descriptor parameters drifted from native schema`);
    }
  });

  it("routes edit planning through the query and code gateway schemas", () => {
    const queryActions = atlasDescriptorSchemaForAction("query")?.properties?.action?.enum;
    const codeActions = atlasDescriptorSchemaForAction("code")?.properties?.action?.enum;
    assert.ok(queryActions?.includes("edit.plan"));
    assert.ok(codeActions?.includes("edit.plan"));
  });

  it("keeps fallback-only ATLAS file reads out of provider gateway schemas", () => {
    const queryActions = atlasDescriptorSchemaForAction("query")?.properties?.action?.enum;
    const codeActions = atlasDescriptorSchemaForAction("code")?.properties?.action?.enum;
    assert.equal(queryActions?.includes("file.read"), false);
    assert.equal(codeActions?.includes("file.read"), false);
  });

  it("keeps hidden ATLAS actions out while surfacing repo.overview as a direct tool", () => {
    const queryActions = atlasDescriptorSchemaForAction("query")?.properties?.action?.enum;
    const repoActions = atlasDescriptorSchemaForAction("repo")?.properties?.action?.enum;
    const agentActions = atlasDescriptorSchemaForAction("agent")?.properties?.action?.enum;
    assert.equal(queryActions?.includes("repo.overview"), false);
    assert.equal(queryActions?.includes("memory.surface"), false);
    assert.equal(repoActions?.includes("repo.overview"), false);
    assert.equal(agentActions?.includes("memory.surface"), false);
    const inventoryActions = buildAtlasToolInventory().actions.map((entry) => entry.action);
    assert.equal(inventoryActions.includes("repo.overview"), true);
    assert.equal(inventoryActions.includes("memory.surface"), false);
  });

  it("publishes enum defaults in descriptors and compact manual text", () => {
    const cardDetail = ATLAS_TOOL_DEFS["slice.build"].parameters.properties.cardDetail;
    assert.deepEqual(cardDetail.enum, ["minimal", "signature", "deps", "compact", "full"]);
    assert.equal(cardDetail.default, "compact");

    const result = manual({
      versionId: "v1",
      params: { actions: ["slice.build"], format: "text" },
    });
    assert.match(result.data.manual, /cardDetail\[minimal\|signature\|deps\|compact\|full\]=compact/);
  });

  it("keeps declared multi-gateway actions present only on their expected gateways", () => {
    for (const [action, expectedGateways] of Object.entries(ATLAS_MULTI_GATEWAY_ACTIONS)) {
      const actualGateways = Object.entries(ATLAS_GATEWAY_ACTIONS)
        .filter(([, actions]) => actions.includes(action))
        .map(([gateway]) => gateway)
        .sort();
      assert.deepEqual(actualGateways, [...expectedGateways].sort(), `${action} gateway routing drifted`);
    }
  });

  it("keeps the checked-in generated inventory current", () => {
    const expected = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8"));
    assert.deepEqual(buildAtlasToolInventory(), expected);
  });
});

function schemaShape(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(schemaShape);
  const out = {};
  for (const key of Object.keys(schema).sort()) {
    if (key === "description" || key === "default") continue;
    out[key] = schemaShape(schema[key]);
  }
  return out;
}

function expectedProviderDescriptorSchema(action) {
  const schema = cloneJson(atlasDescriptorSchemaForAction(action));
  if (["query", "code", "repo", "agent"].includes(action) && Array.isArray(schema?.properties?.action?.enum)) {
    schema.properties.action.enum = schema.properties.action.enum
      .filter((toolName) => toolName !== "file.read" && isAtlasActionSurfaced(toolName));
  }
  return schema;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
