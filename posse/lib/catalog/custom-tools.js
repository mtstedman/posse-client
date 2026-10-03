// Shared vocabulary for the optional Lazyload > Custom Tools surface.
export const CUSTOM_TOOLS_PROTOCOL = "posse.custom_tools.v1";
// Response frames include run metadata and JSON escaping of bounded file contents.
export const AUTOMATION_MAX_REQUEST_BYTES = 1024 * 1024;
export const AUTOMATION_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const CUSTOM_TOOLS_NAME = "custom_tools";
// One agent custom_tools call waits this long for the automation owner.
export const CUSTOM_TOOLS_AGENT_REQUEST_TIMEOUT_MS = 10_000;
export const CUSTOM_TOOLS_SOURCE_KINDS = Object.freeze(["skill", "builtin", "mcp", "script"]);
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

// Per-user automation owner process contract. A supervisor started by a
// client (not a service manager) carries the ad-hoc argument; its owner then
// reports launch "ad_hoc" in health and may be replaced by a client running
// different code. Owners without a supervisor report "foreground".
export const AUTOMATION_OWNER_LAUNCH = Object.freeze({ AD_HOC: "ad_hoc", SERVICE: "service", FOREGROUND: "foreground" });
export const AUTOMATION_SUPERVISOR_AD_HOC_ARG = "--ad-hoc";
// Caller environment that belongs to one run, agent, project or shell
// location and must not follow the caller into the long-lived owner.
// Credentials, HOME/PATH-type and test-isolation variables are kept.
export const AUTOMATION_OWNER_ENV_DROP_PREFIXES = Object.freeze([
  "POSSE_RUN_", "POSSE_DETERMINISTIC_MCP_", "POSSE_MCP_", "POSSE_AB_", "POSSE_MAINTENANCE_", "POSSE_WIN_EVENT_",
]);
export const AUTOMATION_OWNER_ENV_DROP_KEYS = Object.freeze([
  "POSSE_PROJECT_DIR", "POSSE_AUTOMATION_SUPERVISOR_PID", "POSSE_AUTOMATION_LAUNCH",
  "PWD", "OLDPWD", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX",
]);

// Operator-authored script tools: a manifest plus an entry script in
// <automation data dir>/tools/<name>/. The owner runs them with validated JSON
// arguments, a built (never inherited) environment, and tool-scoped secrets.
export const SCRIPT_TOOL_SCHEMA = "posse.script_tool.v1";
export const SCRIPT_TOOL_MANIFEST_FILE = "tool.json";
export const SCRIPT_TOOL_EFFECTS = Object.freeze(["read", "write"]);
// Entry effect stored on the automation entry for each manifest effect.
export const SCRIPT_TOOL_ENTRY_EFFECTS = Object.freeze({ read: "read_only", write: "external_write" });
// Interpreter name -> program; "exec" runs the entry itself (must be executable).
export const SCRIPT_TOOL_INTERPRETERS = Object.freeze({ bash: "bash", sh: "sh", python: "python3", node: "node", exec: "" });
export const SCRIPT_TOOL_TEMPLATES = Object.freeze(["bash", "python", "node", "http"]);
export const SCRIPT_TOOL_LIMITS = Object.freeze({
  DEFAULT_TIMEOUT_SECONDS: 30, MAX_TIMEOUT_SECONDS: 600,
  DEFAULT_OUTPUT_BYTES: 64 * 1024, MIN_OUTPUT_BYTES: 1024, MAX_OUTPUT_BYTES: 1024 * 1024,
  MAX_ENV: 32, MAX_SECRET_BYTES: 64 * 1024, MAX_MANIFEST_BYTES: 256 * 1024, MAX_ENTRY_BYTES: 4 * 1024 * 1024,
  STDERR_TAIL_BYTES: 4 * 1024, MAX_DESCRIPTION: 1000,
});
// Variables the runtime sets itself; a manifest may not declare these. Tools
// never inherit the owner's environment, so a tool may declare its own
// provider key (OPENAI_API_KEY) as a tool-scoped secret.
export const SCRIPT_TOOL_RESERVED_ENV = Object.freeze([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TEMP", "TMP", "TERM",
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "PATHEXT", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
]);
export const SCRIPT_TOOL_RESERVED_ENV_PREFIXES = Object.freeze(["PARAM_", "POSSE_TOOL_"]);
