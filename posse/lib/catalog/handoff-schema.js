import { AGENT_HANDOFF_PROFILE_POLICY } from "./handoff.js";
import { RESEARCH_CHILD_PROFILE } from "./sub-agent.js";

function matchesProfile(rule, profile) {
  if (rule.const != null) return rule.const === profile;
  if (Array.isArray(rule.enum)) return rule.enum.includes(profile);
  if (rule.not) return !matchesProfile(rule.not, profile);
  throw new Error("Unsupported handoff profile constraint");
}

function hasProfileConstraint(value) {
  if (!value || typeof value !== "object") return false;
  if (value.if?.properties?.profile) return true;
  return Object.values(value).some(hasProfileConstraint);
}

// Protocol/profile are supplied by the runtime. Preserve conditional report
// validation by specializing fixed roles and using outcome for the two
// ordinary researcher forms, whose outcome sets are disjoint.
export function projectRuntimeHandoffMetadata(tool, role) {
  const normalizedRole = role === "fix" ? "dev" : role;
  const profiles = Object.entries(AGENT_HANDOFF_PROFILE_POLICY)
    .filter(([profile, policy]) => policy.roles.includes(normalizedRole) && profile !== RESEARCH_CHILD_PROFILE);
  if (!profiles.length) return tool; // Internal unscoped catalog access.
  function project(schema) {
    if (!schema || typeof schema !== "object") return schema;
    if (Array.isArray(schema)) return schema.map(project);
    const out = { ...schema };
    if (Object.values(out.properties || {}).some(hasProfileConstraint) || hasProfileConstraint(out.items)) {
      throw new Error("Nested handoff profile constraints are unsupported");
    }
    if (out.properties) {
      const { protocol: _protocol, profile: _profile, ...properties } = out.properties;
      out.properties = properties;
    }
    if (out.required) out.required = out.required.filter((key) => !["protocol", "profile"].includes(key));
    if (out.if?.properties?.profile) {
      const matching = profiles.filter(([profile]) => matchesProfile(out.if.properties.profile, profile));
      const { if: _if, then: yes, else: no, ...rest } = out;
      if (matching.length === 0) return { ...project(rest), ...project(no || {}) };
      if (matching.length === profiles.length) return { ...project(rest), ...project(yes || {}) };
      out.if = { properties: { outcome: { enum: [...new Set(matching.flatMap(([, policy]) => policy.outcomes))] } }, required: ["outcome"] };
    }
    for (const key of ["allOf", "anyOf", "oneOf", "not", "then", "else"]) {
      if (out[key]) out[key] = project(out[key]);
    }
    return out;
  }
  return { ...tool, parameters: project(tool.parameters) };
}
