// @ts-check
//
// Deterministic native ATLAS v2 tool inventory used by docs and drift tests.

import { ATLAS_TOOL_ACTIONS } from "./tool-params.js";
import { ATLAS_TOOL_PARAM_SCHEMAS } from "./tool-schemas.js";
import { ATLAS_TOOL_DEFS, TOOL_EXECUTION_SPECS, isAtlasActionSurfaced } from "../../../../integrations/functions/deterministic-mcp/tool-descriptors.js";

export const ATLAS_TOOL_INVENTORY_SCHEMA_VERSION = 1;

export function buildAtlasToolInventory() {
  const actions = ATLAS_TOOL_ACTIONS.filter(isAtlasActionSurfaced).map((action) => {
    const def = ATLAS_TOOL_DEFS[action] || {};
    const params = def.parameters || {};
    const nativeSchema = ATLAS_TOOL_PARAM_SCHEMAS[action] || {};
    return {
      action,
      toolName: def.name || `atlas_${action.replace(/\./g, "_")}`,
      namespace: namespaceOf(action),
      summary: TOOL_EXECUTION_SPECS[action]?.summary || def.description || "",
      required: Array.isArray(params.required) ? [...params.required].sort() : [],
      parameterCount: Object.keys(params.properties || {}).length,
      additionalProperties: params.additionalProperties === undefined ? null : params.additionalProperties,
      dispatcherSchema: {
        required: Array.isArray(nativeSchema.required) ? [...nativeSchema.required].sort() : [],
        parameterCount: Object.keys(nativeSchema.properties || {}).length,
        additionalProperties: nativeSchema.additionalProperties === undefined ? null : nativeSchema.additionalProperties,
      },
    };
  });
  return {
    schemaVersion: ATLAS_TOOL_INVENTORY_SCHEMA_VERSION,
    actionCount: actions.length,
    actions,
  };
}

function namespaceOf(action) {
  const text = String(action || "");
  const idx = text.indexOf(".");
  return idx === -1 ? text : text.slice(0, idx);
}
