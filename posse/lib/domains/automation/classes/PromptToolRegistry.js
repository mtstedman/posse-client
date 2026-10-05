import { demand, digest } from "../functions/policy.js";

export const PROMPT_TOOL_SCHEMA = "posse.prompt_tool.v1";
const NAME = /^[a-z][a-z0-9_-]{0,63}(?:\.[a-z][a-z0-9_-]{0,63})?$/;

function normalize(definition) {
  demand(definition && typeof definition === "object" && !Array.isArray(definition), "Prompt tool definition is required", "prompt_tool_invalid");
  demand(Object.keys(definition).every(key => ["schema", "name", "description"].includes(key)), "Prompt tool has an unknown field", "prompt_tool_invalid");
  demand(definition.schema === PROMPT_TOOL_SCHEMA, `schema must be ${PROMPT_TOOL_SCHEMA}`, "prompt_tool_invalid");
  demand(NAME.test(String(definition.name || "")), "Prompt tool name must be lower-case and file-safe", "prompt_tool_invalid");
  const description = String(definition.description || "").trim();
  demand(description && description.length <= 1000, "Prompt tool description is required and must be at most 1000 characters", "prompt_tool_invalid");
  return { schema: PROMPT_TOOL_SCHEMA, name: definition.name, description };
}

// Prompt tools declare caller-built pre-run context. They are global
// definitions, not executable tools: Posse never exposes them through MCP or
// reaches into the caller's application database to produce them.
export class PromptToolRegistry {
  constructor(store, { now = () => Date.now() } = {}) { this.store = store; this.now = now; }

  save(definition) {
    const checked = normalize(definition), prior = this.store.get("prompt_tools", checked.name);
    const record = {
      definition: checked, digest: digest(checked),
      created_at: prior?.created_at || new Date(this.now()).toISOString(),
      updated_at: new Date(this.now()).toISOString(),
    };
    this.store.put("prompt_tools", checked.name, record);
    return this.status(checked.name);
  }

  load(name) {
    const record = this.store.get("prompt_tools", name);
    demand(record, `No prompt tool named ${name}`, "prompt_tool_not_found");
    const definition = normalize(record.definition);
    demand(record.digest === digest(definition), `Prompt tool ${name} digest does not match its definition`, "schema_mismatch");
    return { definition, digest: record.digest };
  }

  status(name) {
    const loaded = this.load(name);
    return { ...loaded.definition, digest: loaded.digest, tested: true, published_digest: loaded.digest, scope: { kind: "global" }, storage: "central_db" };
  }

  list() { return this.store.list("prompt_tools").map(record => this.status(record.definition.name)).sort((a, b) => a.name.localeCompare(b.name)); }

  remove(name) { this.load(name); this.store.remove("prompt_tools", name); return { name, removed: true }; }
}
