import { createHash } from "node:crypto";
import path from "node:path";

import { execProjectDbQuery } from "../../../shared/tools/functions/toolkit/project-db/query.js";
import { authorizeProjectDbStatement } from "../../../shared/tools/functions/toolkit/project-db/permissions.js";
import { assertValidSchema, demand, digest, schemaCheck } from "../functions/policy.js";
import { repositoryID } from "../functions/paths.js";

export const SQL_CAPABILITY_SCHEMA = "posse.sql_capability.v1";
const NAME = /^[a-z][a-z0-9_-]{0,63}(?:\.[a-z][a-z0-9_-]{0,63})?$/;

function normalize(definition) {
  demand(definition && typeof definition === "object" && !Array.isArray(definition), "SQL capability definition is required", "sql_capability_invalid");
  const allowed = new Set(["schema", "name", "description", "scope", "binding", "input_schema", "parameter_order", "query", "max_rows"]);
  for (const key of Object.keys(definition)) demand(allowed.has(key), `SQL capability has unknown field ${JSON.stringify(key)}`, "sql_capability_invalid");
  demand(definition.schema === SQL_CAPABILITY_SCHEMA, `schema must be ${SQL_CAPABILITY_SCHEMA}`, "sql_capability_invalid");
  demand(NAME.test(String(definition.name || "")), "SQL capability name must be lower-case and file-safe", "sql_capability_invalid");
  const description = String(definition.description || "").trim();
  demand(description && description.length <= 1000, "SQL capability description is required and must be at most 1000 characters", "sql_capability_invalid");
  const binding = definition.binding || {};
  demand(binding.kind === "folder" && typeof binding.folder_path === "string" && path.isAbsolute(binding.folder_path) && path.normalize(binding.folder_path) === binding.folder_path,
    "SQL capabilities require a clean absolute folder binding", "sql_capability_invalid");
  const scope = definition.scope || { kind: "binding" };
  demand(scope && typeof scope === "object" && !Array.isArray(scope) && Object.keys(scope).length === 1
    && ["binding", "global"].includes(scope.kind), "SQL capability scope must be binding or global", "sql_capability_invalid");
  const inputSchema = structuredClone(definition.input_schema);
  assertValidSchema(inputSchema, "SQL capability input_schema");
  demand(inputSchema?.type === "object" && inputSchema.additionalProperties === false, "SQL capability input_schema must be a closed object", "sql_capability_invalid");
  const parameterOrder = Array.isArray(definition.parameter_order) ? definition.parameter_order.map(String) : [];
  demand(new Set(parameterOrder).size === parameterOrder.length, "SQL capability parameter_order repeats a field", "sql_capability_invalid");
  for (const name of parameterOrder) demand(Object.hasOwn(inputSchema.properties || {}, name), `SQL parameter ${name} is absent from input_schema`, "sql_capability_invalid");
  const query = String(definition.query || "").trim();
  const authorized = authorizeProjectDbStatement(query, ["read"]);
  demand(authorized.ok && authorized.isRead && !authorized.mutates, authorized.error || "SQL capability query must be read-only", "sql_capability_invalid");
  const maxRows = Math.max(1, Math.min(100, Number(definition.max_rows) || 10));
  return {
    schema: SQL_CAPABILITY_SCHEMA, name: definition.name, description,
    scope: { kind: scope.kind }, binding: { kind: "folder", folder_path: binding.folder_path },
    input_schema: inputSchema, parameter_order: parameterOrder, query: authorized.statement, max_rows: maxRows,
  };
}

export class SqlCapabilityRegistry {
  constructor(service, { now = () => Date.now() } = {}) {
    this.service = service;
    this.store = service.store;
    this.now = now;
    service.sqlCapabilities = this;
  }

  entryID(name) { return `sql:${name}`; }

  save(definition) {
    const checked = normalize(definition);
    const prior = this.store.get("sql_capabilities", checked.name);
    const record = {
      definition: checked,
      digest: digest(checked),
      created_at: prior?.created_at || new Date(this.now()).toISOString(),
      updated_at: new Date(this.now()).toISOString(),
    };
    this.store.put("sql_capabilities", checked.name, record);
    return this.status(checked.name);
  }

  load(name) {
    const record = this.store.get("sql_capabilities", name);
    demand(record, `No SQL capability named ${name}`, "sql_capability_not_found");
    const definition = normalize(record.definition);
    demand(record.digest === digest(definition), `SQL capability ${name} digest does not match its definition`, "schema_mismatch");
    return { definition, digest: record.digest };
  }

  status(name) {
    const loaded = this.load(name);
    const entry = this.store.get("entries", this.entryID(name));
    return {
      ...loaded.definition,
      digest: loaded.digest,
      tested: Boolean(entry?.enabled && entry.digest === loaded.digest),
      published_digest: entry?.enabled ? entry.digest : null,
      storage: "central_db",
    };
  }

  list() {
    return this.store.list("sql_capabilities").map(record => this.status(record.definition.name)).sort((a, b) => a.name.localeCompare(b.name));
  }

  entryFor(definition, definitionDigest) {
    return {
      id: this.entryID(definition.name), source: "sql", kind: "sql", capability: definition.name,
      description: definition.description, input_schema: definition.input_schema, output_schema: { type: "string" },
      effect: "read_only", limits: { wall_time_seconds: 30, calls: 1, turns: 1, spend_cap_usd: 1 },
      enabled: true, digest: definitionDigest, definition,
    };
  }

  available(entry) {
    try { return this.load(entry.capability).digest === entry.digest; }
    catch { return false; }
  }

  async test(name, input) {
    const { definition, digest: definitionDigest } = this.load(name);
    schemaCheck(definition.input_schema, input);
    let output, passed = false;
    try { output = await this.execute(definition, input); passed = true; }
    catch (error) { output = `Error: ${error.message || error}`; }
    if (passed) this.store.put("entries", this.entryID(name), this.entryFor(definition, definitionDigest));
    const result = { name, digest: definitionDigest, passed, output, tested_at: new Date(this.now()).toISOString() };
    this.store.put("tests", definitionDigest, result);
    return result;
  }

  grant(name, { roles = ["dev"] } = {}) {
    const { definition, digest: definitionDigest } = this.load(name);
    const entry = this.store.get("entries", this.entryID(name));
    demand(entry?.enabled && entry.digest === definitionDigest, `${name} has no passing test for its current definition`, "sql_capability_unavailable");
    const global = definition.scope.kind === "global";
    const repoID = global ? undefined : repositoryID(definition.binding.folder_path);
    const roleList = [...new Set(roles.map(role => String(role).trim()).filter(Boolean))].sort();
    const id = `sql-${name}-${createHash("sha256").update(JSON.stringify([repoID || "global", roleList])).digest("hex").slice(0, 10)}`;
    return this.service.grant({ id, tool: entry.id, digest: entry.digest, scope: global ? "standalone" : "repository",
      ...(global ? {} : { repo_id: repoID, repo_path: definition.binding.folder_path }),
      roles: roleList, operations: ["describe", "invoke"], unattended: true });
  }

  async execute(definitionOrName, input) {
    const definition = typeof definitionOrName === "string" ? this.load(definitionOrName).definition : definitionOrName;
    schemaCheck(definition.input_schema, input);
    const parameters = definition.parameter_order.map(name => input[name]);
    const output = await execProjectDbQuery({ query: definition.query, parameters, maxRows: definition.max_rows }, {
      projectDir: definition.binding.folder_path,
      capability: "read",
    });
    demand(!String(output).startsWith("Error:"), String(output).slice(7).trim(), "sql_capability_unavailable");
    return output;
  }
}
