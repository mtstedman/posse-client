// Shared vocabulary for the optional Lazyload > Custom Tools surface.
export const CUSTOM_TOOLS_PROTOCOL = "posse.custom_tools.v1";
export const CUSTOM_TOOLS_NAME = "custom_tools";
export const CUSTOM_TOOLS_SOURCE_KINDS = Object.freeze(["skill", "builtin", "mcp"]);
export const CUSTOM_TOOLS_OPERATIONS = Object.freeze(["search", "describe", "invoke", "status", "cancel"]);
export const CUSTOM_TOOLS_TERMINAL = Object.freeze(["succeeded", "failed", "canceled", "interrupted"]);
export const TOOL_CUSTOM_TOOLS = Object.freeze({
  name: CUSTOM_TOOLS_NAME,
  description: "Lazyload > Custom Tools: search approved Bossy skills and connector tools, describe one contract, invoke it, or inspect/cancel your run. Repository, role and permissions come from the gate.",
  parameters: {
    type: "object", additionalProperties: false, required: ["operation"],
    properties: {
      operation: { type: "string", enum: CUSTOM_TOOLS_OPERATIONS },
      query: { type: "string", maxLength: 200 },
      tool: { type: "string", maxLength: 240 },
      grant_id: { type: "string", maxLength: 120 },
      input: { type: "object" },
      run_id: { type: "string", maxLength: 120 },
      idempotency_key: { type: "string", maxLength: 120 },
    },
  },
});
export const AUTOMATION_RESOURCE_OPERATIONS = Object.freeze(["list", "read", "write"]);
export const AUTOMATION_BUILTINS = Object.freeze({
  "files.list": { operation: "list", description: "List regular files in one approved resource", input: { type: "object", additionalProperties: false, required: ["resource"], properties: { resource: { type: "string" }, directory: { type: "string" }, extension: { type: "string" } } } },
  "files.read": { operation: "read", description: "Read a bounded UTF-8 file in one approved resource", input: { type: "object", additionalProperties: false, required: ["resource", "path"], properties: { resource: { type: "string" }, path: { type: "string" } } } },
  "files.write": { operation: "write", description: "Stage a UTF-8 artifact in one approved resource; committed only on successful completion", input: { type: "object", additionalProperties: false, required: ["resource", "path", "content"], properties: { resource: { type: "string" }, path: { type: "string" }, content: { type: "string", maxLength: 1048576 } } } },
  "csv.process": { operation: "write", description: "Validate explicitly ready CSV files and emit JSON rows, remembering completed file hashes", input: { type: "object", additionalProperties: false, required: ["source_resource", "destination_resource", "readiness"], properties: { source_resource: { type: "string" }, destination_resource: { type: "string" }, readiness: { oneOf: [
    { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "atomic_rename" } } },
    { type: "object", additionalProperties: false, required: ["kind", "manifest_path"], properties: { kind: { const: "manifest" }, manifest_path: { type: "string", minLength: 1, maxLength: 240 } } },
    { type: "object", additionalProperties: false, required: ["kind", "min_age_seconds"], properties: { kind: { const: "stability_heuristic" }, min_age_seconds: { type: "integer", minimum: 1, maximum: 86400 } } },
  ] } } } },
});
