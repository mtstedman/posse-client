import {
  SCRIPT_TOOL_EFFECTS, SCRIPT_TOOL_INTERPRETERS, SCRIPT_TOOL_LIMITS, SCRIPT_TOOL_RESERVED_ENV,
  SCRIPT_TOOL_RESERVED_ENV_PREFIXES, SCRIPT_TOOL_SCHEMA, SCRIPT_TOOL_TEMPLATES,
} from "../../../catalog/custom-tools.js";
import { assertValidSchema, demand, object } from "./policy.js";

export const EMPTY_SCRIPT_PARAMS = Object.freeze({ type: "object", additionalProperties: false, properties: {} });
const NAME_RE = /^[a-z][a-z0-9-]{0,39}(\.[a-z][a-z0-9_-]{0,39})?$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MANIFEST_KEYS = ["schema", "name", "description", "entry", "interpreter", "params", "inputs", "env", "effect", "timeout_seconds", "max_output_bytes"];

// `lookup` or a qualified `orders.lookup`; posse.* belongs to built-in tools.
export function validScriptToolName(name) {
  return typeof name === "string" && NAME_RE.test(name) && name.split(".")[0] !== "posse";
}

export function validScriptEnvName(name) {
  return typeof name === "string" && ENV_RE.test(name) && !SCRIPT_TOOL_RESERVED_ENV.includes(name)
    && !SCRIPT_TOOL_RESERVED_ENV_PREFIXES.some(prefix => name.startsWith(prefix));
}

// Validates a manifest's shape and fills defaults. Unknown fields are refused
// so a typo never silently changes what runs.
export function normalizeScriptManifest(raw) {
  object(raw, MANIFEST_KEYS, ["schema", "name", "description", "entry", "effect"]);
  const fail = message => demand(false, `Script tool ${JSON.stringify(raw.name)}: ${message}`, "script_invalid");
  if (raw.schema !== SCRIPT_TOOL_SCHEMA) fail(`schema must be ${SCRIPT_TOOL_SCHEMA}`);
  if (!validScriptToolName(raw.name)) fail("name must be lower-case like orders.lookup, outside the posse namespace");
  const description = String(raw.description || "").trim();
  if (!description || description.length > SCRIPT_TOOL_LIMITS.MAX_DESCRIPTION) fail(`description is required (at most ${SCRIPT_TOOL_LIMITS.MAX_DESCRIPTION} characters); agents read it to decide when to call the tool`);
  const entry = String(raw.entry || "").replaceAll("\\", "/");
  if (!entry || entry.startsWith("/") || entry.includes(":") || entry.split("/").some(part => !part || part === "." || part === "..")) fail("entry must be a file inside the tool folder");
  const interpreter = raw.interpreter || "bash";
  if (!Object.hasOwn(SCRIPT_TOOL_INTERPRETERS, interpreter)) fail(`interpreter must be one of ${Object.keys(SCRIPT_TOOL_INTERPRETERS).join(", ")}`);
  if (!SCRIPT_TOOL_EFFECTS.includes(raw.effect)) fail("effect must be read or write");
  const timeout = raw.timeout_seconds ?? SCRIPT_TOOL_LIMITS.DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > SCRIPT_TOOL_LIMITS.MAX_TIMEOUT_SECONDS) fail(`timeout_seconds must be 1-${SCRIPT_TOOL_LIMITS.MAX_TIMEOUT_SECONDS}`);
  const output = raw.max_output_bytes ?? SCRIPT_TOOL_LIMITS.DEFAULT_OUTPUT_BYTES;
  if (!Number.isInteger(output) || output < SCRIPT_TOOL_LIMITS.MIN_OUTPUT_BYTES || output > SCRIPT_TOOL_LIMITS.MAX_OUTPUT_BYTES) fail(`max_output_bytes must be ${SCRIPT_TOOL_LIMITS.MIN_OUTPUT_BYTES}-${SCRIPT_TOOL_LIMITS.MAX_OUTPUT_BYTES}`);
  const env = raw.env ?? [];
  if (!Array.isArray(env) || env.length > SCRIPT_TOOL_LIMITS.MAX_ENV) fail(`env must be a list of at most ${SCRIPT_TOOL_LIMITS.MAX_ENV} entries`);
  const seen = new Set();
  const normalizedEnv = env.map(item => {
    object(item, ["name", "secret", "default", "description"], ["name"]);
    if (!validScriptEnvName(item.name)) fail(`env ${JSON.stringify(item.name)} must be UPPER_CASE and not a name the runtime sets (PATH, HOME, PARAM_*, POSSE_TOOL_*)`);
    if (seen.has(item.name)) fail(`env ${item.name} is declared twice`);
    seen.add(item.name);
    if (item.secret === true && item.default !== undefined) fail(`secret ${item.name} cannot have a default; set it with \`posse tools secret set ${raw.name} ${item.name}\``);
    if (item.default !== undefined && (typeof item.default !== "string" || /[\0\r\n]/.test(item.default))) fail(`env ${item.name} default must be one line of text`);
    return { name: item.name, ...(item.secret === true ? { secret: true } : {}), ...(item.default !== undefined ? { default: item.default } : {}), ...(item.description ? { description: String(item.description).trim() } : {}) };
  });
  const params = raw.params ?? EMPTY_SCRIPT_PARAMS;
  demand(params && typeof params === "object" && !Array.isArray(params) && params.type === "object", `Script tool ${raw.name}: params must be a JSON schema with type object`, "script_invalid");
  assertValidSchema(params, `Script tool ${raw.name} params`);
  const inputs = raw.inputs;
  if (inputs !== undefined) {
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs) || inputs.type !== "object"
      || !inputs.properties || typeof inputs.properties !== "object" || Array.isArray(inputs.properties)
      || inputs.additionalProperties !== false) fail("inputs must be a closed JSON object schema with properties");
    if (Object.keys(inputs).some(key => !["type", "properties", "required", "additionalProperties", "description"].includes(key)))
      fail("inputs may only declare properties, required fields, and a description");
    if (params.additionalProperties !== false) fail("agent-facing params must be closed when inputs are declared");
    assertValidSchema(inputs, `Script tool ${raw.name} inputs`);
    for (const key of Object.keys(inputs.properties)) {
      if (Object.hasOwn(params.properties || {}, key)) fail(`input ${key} is also an agent-facing parameter`);
    }
  }
  return { schema: raw.schema, name: raw.name, description, entry, interpreter, params,
    ...(inputs === undefined ? {} : { inputs }), env: normalizedEnv, effect: raw.effect, timeout_seconds: timeout, max_output_bytes: output };
}

// The PARAM_* variable a scalar argument arrives in.
export function paramEnvName(name) {
  return "PARAM_" + String(name).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

// Top-level string, number and boolean arguments as PARAM_* variables.
// Arrays and objects arrive only in the stdin JSON.
export function scalarParamEnv(input) {
  const env = {};
  for (const [name, value] of Object.entries(input || {})) {
    if (typeof value === "string" && !value.includes("\0")) env[paramEnvName(name)] = value;
    else if (typeof value === "number" && Number.isFinite(value)) env[paramEnvName(name)] = JSON.stringify(value);
    else if (typeof value === "boolean") env[paramEnvName(name)] = String(value);
  }
  return env;
}

// Replaces every secret value, including its common encodings, before tool
// output can reach a run record, an agent, or a terminal. Values shorter than
// four characters are too ambiguous to match safely.
export function redactSecretValues(text, secrets) {
  let value = String(text ?? ""), redacted = false;
  const forms = [];
  for (const [name, secret] of Object.entries(secrets || {})) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    const label = `[REDACTED:${name}]`, bytes = Buffer.from(secret);
    const candidates = [secret, bytes.toString("base64"), bytes.toString("base64").replace(/=+$/, ""),
      bytes.toString("base64url"), encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
    for (const candidate of new Set(candidates)) if (candidate.length >= 4) forms.push([candidate, label]);
  }
  forms.sort((a, b) => b[0].length - a[0].length);
  for (const [candidate, label] of forms) {
    if (value.includes(candidate)) { value = value.split(candidate).join(label); redacted = true; }
  }
  return { text: value, redacted };
}

// `name:type[:required]` from `posse tools new --param`.
export function parseParamSpec(spec) {
  const parts = String(spec).split(":");
  demand(parts.length === 2 || parts.length === 3, `param ${JSON.stringify(spec)} must be name:type or name:type:required`);
  const [name, type, flag] = parts;
  demand(/^[a-z][a-z0-9_]{0,63}$/.test(name), `param name ${JSON.stringify(name)} must be lower_snake_case`);
  demand(["string", "integer", "number", "boolean"].includes(type), `param ${name} type must be string, integer, number, or boolean`);
  demand(flag === undefined || flag === "required", `param ${name}: the third part can only be required`);
  return { name, type, required: flag === "required" };
}

// Renders a manifest and a commented starter script that already reads the
// declared params and env, so the operator fills in only the work itself.
export function renderScriptTemplate({ name, description, template = "bash", effect = "read", params = [], inputSchema = null, env = [] }) {
  demand(SCRIPT_TOOL_TEMPLATES.includes(template), `template must be one of ${SCRIPT_TOOL_TEMPLATES.join(", ")}`);
  const properties = {}, required = [];
  for (const param of params) {
    properties[param.name] = { type: param.type, description: `TODO: describe ${param.name}` };
    if (param.required) required.push(param.name);
  }
  const schema = inputSchema == null
    ? { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) }
    : structuredClone(inputSchema);
  assertValidSchema(schema, "Tool input schema");
  demand(schema && typeof schema === "object" && !Array.isArray(schema) && schema.type === "object", "Tool input schema must have top-level type object");
  const schemaRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
  // Starter comments expose scalar convenience variables. The complete,
  // exact object (including nested objects and arrays) always arrives on
  // stdin, so accepting an authored JSON Schema never flattens its contract.
  const scriptParams = inputSchema == null ? params : Object.entries(schema.properties || {})
    .filter(([, value]) => value && typeof value === "object" && ["string", "integer", "number", "boolean"].includes(value.type))
    .map(([paramName, value]) => ({ name: paramName, type: value.type, required: schemaRequired.has(paramName) }));
  let variables = env.map(item => ({ ...item }));
  if (template === "http" && !variables.length) variables = [
    { name: "API_BASE_URL", default: "https://api.example.com", description: "service base URL" },
    { name: "API_TOKEN", secret: true, description: "bearer token for the service" },
  ];
  const files = {
    bash: ["bash", "run.sh", bashScript], http: ["bash", "run.sh", (spec, vars) => bashScript(spec, vars, true)],
    python: ["python", "run.py", pythonScript], node: ["node", "run.mjs", nodeScript],
  }[template];
  const spec = { name, description, params: scriptParams };
  const manifest = normalizeScriptManifest({ schema: SCRIPT_TOOL_SCHEMA, name, description, entry: files[1], interpreter: files[0], params: schema, env: variables, effect });
  return { manifest, entry: files[1], script: files[2](spec, variables) };
}

function header(comment, spec, env) {
  const lines = [
    `${comment} ${spec.name} — ${spec.description}`, comment,
    `${comment} Posse passes the arguments as JSON on stdin and each scalar param as`,
    `${comment} PARAM_<NAME>. Only the variables declared in tool.json reach this`,
    `${comment} process — nothing else from your shell is inherited. Print the`,
    `${comment} result to stdout (text or JSON); exit non-zero to report an error.`,
  ];
  for (const param of spec.params) lines.push(`${comment}   ${paramEnvName(param.name).padEnd(22)} ${param.type}${param.required ? ", required" : ""}`);
  for (const item of env) lines.push(`${comment}   ${item.name.padEnd(22)} ${item.secret ? `secret (set with: posse tools secret set ${spec.name} ${item.name})` : "env"}`);
  return lines.join("\n");
}

function bashScript(spec, env, http = false) {
  const body = spec.params.map(param => param.required
    ? `: "\${${paramEnvName(param.name)}:?missing ${param.name}}"`
    : `${paramEnvName(param.name)}="\${${paramEnvName(param.name)}:-}"`);
  if (http) {
    body.push("", "curl --fail --silent --show-error --max-time 20 \\", '  -H "Authorization: Bearer ${API_TOKEN}" \\',
      '  -H "Accept: application/json" \\', '  "${API_BASE_URL}/TODO"');
  } else {
    body.push("", "# TODO: do the work. Reference secrets by name, never hardcode them, e.g.");
    const secret = env.find(item => item.secret);
    if (secret) body.push(`#   PGPASSWORD="$${secret.name}" psql -h "$DB_HOST" -U readonly -c "select 1"`);
    // The placeholder fails its test, so an unedited template can never be
    // published or granted.
    body.push(`printf '%s\\n' "TODO: implement ${spec.name}" >&2`, "exit 1");
  }
  return `#!/usr/bin/env bash\n${header("#", spec, env)}\nset -euo pipefail\n\n${body.join("\n")}\n`;
}

function pythonScript(spec, env) {
  const body = ["import json", "import os", "import sys", "", "args = json.load(sys.stdin)"];
  for (const item of env) body.push(`${item.name.toLowerCase()} = os.environ.get(${JSON.stringify(item.name)}, "")`);
  body.push("", "# TODO: do the work and print the result, e.g. print(json.dumps({...})).", `sys.exit(${JSON.stringify(`TODO: implement ${spec.name}`)})`);
  return `#!/usr/bin/env python3\n${header("#", spec, env)}\n${body.join("\n")}\n`;
}

function nodeScript(spec, env) {
  const body = ['import { readFileSync } from "node:fs";', "", 'const args = JSON.parse(readFileSync(0, "utf8") || "{}");'];
  for (const item of env) body.push(`const ${item.name.toLowerCase()} = process.env.${item.name} ?? "";`);
  body.push("", "// TODO: do the work and print the result, e.g. console.log(JSON.stringify({ ... })).",
    `console.error(${JSON.stringify(`TODO: implement ${spec.name}`)});`, "process.exitCode = 1;");
  return `#!/usr/bin/env node\n${header("//", spec, env)}\n${body.join("\n")}\n`;
}
