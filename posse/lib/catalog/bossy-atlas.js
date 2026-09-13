// Bossy repository inspection is a closed subset of the canonical Atlas
// catalog. Do not admit gateways/workflows: they can dispatch write actions.
import { ATLAS_TOOL_DEFS_RAW } from "./atlas-tools.js";

export const BOSSY_ATLAS_READ_ACTIONS = Object.freeze([
  "symbol.search", "symbol.get", "symbol.card", "symbol.callers", "symbol.overview",
  "tree.branch", "tree.expand", "code.skeleton", "code.lens", "code.window",
  "code.structure", "code.survey",
]);
export const BOSSY_ATLAS_READ_LIMITS = Object.freeze({
  inputBytes: 16 * 1024, outputChars: 24000, timeoutMs: 30000,
  maxWindowLines: 400, maxWindowTokens: 6000,
});

function publicSchema(value, field = "") {
  if (Array.isArray(value)) return value.map((item) => publicSchema(item));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "internalOnly") continue;
    if (key === "properties") {
      result.properties = Object.fromEntries(Object.entries(entry)
        .filter(([, schema]) => schema.internalOnly !== true)
        .map(([name, schema]) => [name, publicSchema(schema, name)]));
    } else result[key] = publicSchema(entry);
  }
  const types = Array.isArray(result.type) ? result.type : [result.type];
  if (types.includes("string")) result.maxLength = Math.min(result.maxLength ?? 4096, 4096);
  if (types.includes("array")) result.maxItems = Math.min(result.maxItems ?? 64, 64);
  const caps = { maxTokens: 6000, limit: 100, maxFiles: 64, depth: 4, maxDepth: 4 };
  if (caps[field]) {
    result.minimum = Math.max(result.minimum ?? 1, 1);
    result.maximum = Math.min(result.maximum ?? caps[field], caps[field]);
  }
  return result;
}

export const BOSSY_ATLAS_READ_DEFINITIONS = Object.freeze(Object.fromEntries(
  BOSSY_ATLAS_READ_ACTIONS.map((action) => {
    const definition = ATLAS_TOOL_DEFS_RAW[action];
    if (!definition) throw new Error(`Missing Atlas read definition: ${action}`);
    return [action, Object.freeze({
      action, description: definition.description,
      parameters: publicSchema(definition.parameters),
    })];
  }),
));
