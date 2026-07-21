// Shared builder for the embedded (function-calling) tool definitions used by
// OpenAI and Grok. Both providers expose the same deterministic tool surface;
// the only per-provider differences are a couple of overrides (the assessor's
// read-only bash variant and the provider-specific image tool). Schemas are
// derived from the canonical ToolCatalog so the function surface tracks the
// catalog instead of a hand-maintained, duplicated map.

import { ToolCatalog } from "../../../../shared/tools/classes/ToolCatalog.js";
import { buildProviderToolDefinitions } from "../../../../shared/tools/functions/contract.js";
import { getAtlasEmbeddedToolDefinitions } from "../../../integrations/functions/atlas-embedded.js";
import { embeddedAdvertisedToolNames } from "../../../../shared/tools/functions/tool-suites.js";

// Deterministic tools advertised on the function-calling (embedded) transport
// used by OpenAI and Grok. Sourced from the shared ToolRegistry metadata
// (suite `tools`, advertise includes "function") rather than a hand-list, so
// the embedded surface tracks one declaration. Tools that are MCP/bridge-only
// (e.g. the test-runner tools) are not advertised here.
const EMBEDDED_DETERMINISTIC_TOOLS = new Set(embeddedAdvertisedToolNames());

function isAtlasTool(tool) {
  return String(tool?.access || "") === "atlas" || String(tool?.name || "").startsWith("atlas");
}

/**
 * Build provider function-tool definitions for everything the execution
 * contract advertises.
 *
 * @param {object} contract - execution contract (contract.tools drives the set)
 * @param {object} overrides - per-provider schema overrides keyed by tool name
 *   (e.g. { bash, generate_image }). A null/undefined override drops the tool.
 */
export function buildEmbeddedToolDefinitions(contract, overrides = {}) {
  const map = {};
  for (const tool of (contract?.tools || [])) {
    const name = tool?.name;
    if (!name || map[name]) continue;
    if (Object.prototype.hasOwnProperty.call(overrides, name)) {
      if (overrides[name]) map[name] = overrides[name];
      continue;
    }
    if (isAtlasTool(tool)) {
      const defs = getAtlasEmbeddedToolDefinitions([name]);
      if (defs.length > 0) map[name] = defs[0];
      continue;
    }
    if (!EMBEDDED_DETERMINISTIC_TOOLS.has(name)) continue;
    const schema = ToolCatalog.getSchema(name, { role: contract?.role });
    if (schema) map[name] = schema;
  }
  return buildProviderToolDefinitions(map, contract);
}
