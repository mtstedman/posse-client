import fs from "node:fs";
import path from "node:path";

import { AGENT_DEFINITION_MAX_BYTES, AGENT_NAME_PATTERN } from "../../../catalog/agent.js";
import { automationDataDir } from "../../automation/functions/paths.js";
import { agentDefinitionDigest, scaffoldAgentDefinition, validateAgentDefinition } from "../functions/definition.js";

export class AgentDefinitionStore {
  constructor({ dir = path.join(automationDataDir(), "agents") } = {}) { this.dir = dir; }

  path(name) {
    if (!AGENT_NAME_PATTERN.test(String(name || ""))) throw Object.assign(new Error("Agent name must be lower-case and file-safe"), { code: "agent_invalid" });
    return path.join(this.dir, `${name}.json`);
  }

  load(name) {
    const filename = this.path(name);
    let before;
    try { before = fs.lstatSync(filename); } catch (error) {
      if (error?.code === "ENOENT") throw Object.assign(new Error(`No agent named ${name} (expected ${filename})`), { code: "agent_not_found" });
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink()) throw Object.assign(new Error(`${filename} must be a regular file`), { code: "agent_invalid" });
    let handle;
    try { handle = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); } catch (error) {
      if (error?.code === "ENOENT") throw Object.assign(new Error(`No agent named ${name} (expected ${filename})`), { code: "agent_not_found" });
      if (["ELOOP", "EMLINK"].includes(error?.code)) throw Object.assign(new Error(`${filename} must be a regular file`), { code: "agent_invalid" });
      throw error;
    }
    let bytes;
    try {
      const info = fs.fstatSync(handle);
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) throw Object.assign(new Error(`${filename} changed while it was opened`), { code: "agent_invalid" });
      if (info.size > AGENT_DEFINITION_MAX_BYTES) throw Object.assign(new Error(`${filename} exceeds ${AGENT_DEFINITION_MAX_BYTES} bytes`), { code: "agent_invalid" });
      bytes = fs.readFileSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    if (bytes.length > AGENT_DEFINITION_MAX_BYTES) throw Object.assign(new Error(`${filename} exceeds ${AGENT_DEFINITION_MAX_BYTES} bytes`), { code: "agent_invalid" });
    let parsed;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      parsed = JSON.parse(text);
    } catch (error) {
      throw Object.assign(new Error(`${filename} is not valid UTF-8 JSON: ${error.message}`), { code: "agent_invalid" });
    }
    const checked = validateAgentDefinition(parsed, { filename: name });
    if (!checked.ok) throw Object.assign(new Error(checked.errors.join("; ")), { code: "agent_invalid", errors: checked.errors });
    return { definition: checked.definition, digest: agentDefinitionDigest(checked.definition), path: filename };
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir, { withFileTypes: true })
      .filter(item => item.isFile() && item.name.endsWith(".json") && !item.name.startsWith("."))
      .map(item => item.name.slice(0, -5)).sort()
      .map(name => {
        try { return { name, ...this.load(name), errors: [] }; }
        catch (error) { return { name, path: this.path(name), definition: null, digest: null, errors: error.errors || [error.message] }; }
      });
  }

  create(name) {
    const filename = this.path(name);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const definition = scaffoldAgentDefinition(name);
    try { fs.writeFileSync(filename, `${JSON.stringify(definition, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error?.code === "EEXIST") throw Object.assign(new Error(`${filename} already exists`), { code: "agent_invalid" });
      throw error;
    }
    return { definition, digest: agentDefinitionDigest(definition), path: filename };
  }
}
