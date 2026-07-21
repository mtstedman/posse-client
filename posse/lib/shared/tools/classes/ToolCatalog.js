import {
  TOOL_CATALOG,
  WEB_TOOL_ROLES,
  getBaseToolNamesForRole,
  getDeterministicMcpToolNames,
  getAtlasToolNames,
  getToolCatalogEntry,
  getToolExecutionSpec,
  getToolSchema,
  getToolSchemaForRole,
} from "../../../domains/integrations/functions/deterministic-mcp/tool-descriptors.js";

const RUNTIME_TOOL_OVERRIDES = new Map();

function freezeEntry(entry = {}) {
  return Object.freeze({
    name: String(entry.name || "").trim(),
    schema: entry.schema || null,
    access: String(entry.access || "unknown"),
    summary: String(entry.summary || ""),
    budgetExempt: !!entry.budgetExempt,
    roleAllowlist: entry.roleAllowlist instanceof Set
      ? new Set(entry.roleAllowlist)
      : new Set(Array.isArray(entry.roleAllowlist) ? entry.roleAllowlist : []),
    gateTier: String(entry.gateTier || "native"),
    capabilityFlags: Object.freeze({
      read: !!entry?.capabilityFlags?.read,
      write: !!entry?.capabilityFlags?.write,
      shell: !!entry?.capabilityFlags?.shell,
      atlas: !!entry?.capabilityFlags?.atlas,
      coordination: !!entry?.capabilityFlags?.coordination,
    }),
  });
}

function deriveCapabilityFlags(access = "unknown") {
  return Object.freeze({
    read: access === "read",
    write: access === "write",
    shell: access === "shell",
    atlas: access === "atlas",
    coordination: access === "coordination",
  });
}

export class ToolCatalog {
  static get(name) {
    const key = String(name || "").trim();
    if (!key) return null;
    const runtime = RUNTIME_TOOL_OVERRIDES.get(key);
    if (runtime) return runtime;
    return getToolCatalogEntry(key) || null;
  }

  static getSchema(name, { role = null } = {}) {
    const entry = this.get(name);
    if (entry) {
      if (String(name || "").trim() === "agent_handoff" && role) {
        return getToolSchemaForRole(name, role);
      }
      return entry.schema || null;
    }
    return getToolSchema(name) || null;
  }

  static getExecutionSpec(name) {
    const entry = this.get(name);
    if (entry) {
      return {
        access: entry.access || "unknown",
        summary: entry.summary || "",
        budgetExempt: !!entry.budgetExempt,
      };
    }
    const spec = getToolExecutionSpec(name);
    if (!spec) throw new Error(`ToolCatalog missing execution metadata for ${name}`);
    return spec;
  }

  static forRole(roleName, {
    allowWrite = false,
    needsImageGeneration = false,
    agentHandoff = false,
    subAgent = false,
  } = {}) {
    return getBaseToolNamesForRole(roleName, !!allowWrite, { needsImageGeneration, agentHandoff, subAgent });
  }

  static forProvider(providerName, roleName, {
    allowWrite = false,
    needsImageGeneration = false,
    agentHandoff = false,
    subAgent = false,
  } = {}) {
    const _provider = String(providerName || "").trim().toLowerCase();
    const names = this.forRole(roleName, { allowWrite, needsImageGeneration, agentHandoff, subAgent });
    return names.filter((name) => !!this.get(name));
  }

  static deterministicToolNames(roleName, opts = {}) {
    return getDeterministicMcpToolNames(roleName, opts);
  }

  static atlasToolNames() {
    return getAtlasToolNames();
  }

  static webToolRoles() {
    return new Set(WEB_TOOL_ROLES);
  }

  static all() {
    const allNames = new Set([
      ...Object.keys(TOOL_CATALOG || {}),
      ...RUNTIME_TOOL_OVERRIDES.keys(),
    ]);
    return [...allNames].sort().map((name) => this.get(name)).filter(Boolean);
  }

  static register(descriptor = {}) {
    const name = String(descriptor?.name || descriptor?.schema?.name || "").trim();
    if (!name) throw new Error("ToolCatalog.register requires a descriptor name");
    const access = String(descriptor.access || "unknown");
    const summary = String(descriptor.summary || "");
    const roleAllowlist = descriptor.roleAllowlist instanceof Set
      ? descriptor.roleAllowlist
      : new Set(Array.isArray(descriptor.roleAllowlist) ? descriptor.roleAllowlist : []);
    const gateTier = String(
      descriptor.gateTier
        || (access === "atlas" ? "atlas" : "native"),
    );
    const entry = freezeEntry({
      name,
      schema: descriptor.schema || null,
      access,
      summary,
      budgetExempt: !!descriptor.budgetExempt,
      roleAllowlist,
      gateTier,
      capabilityFlags: descriptor.capabilityFlags || deriveCapabilityFlags(access),
    });
    RUNTIME_TOOL_OVERRIDES.set(name, entry);
    return entry;
  }

  static resetRuntimeRegistryForTests() {
    RUNTIME_TOOL_OVERRIDES.clear();
  }
}
