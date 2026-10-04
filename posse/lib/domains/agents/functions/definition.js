import { createHash } from "node:crypto";
import path from "node:path";

import {
  AGENT_DEFINITION_FIELDS,
  AGENT_DEFINITION_SCHEMA,
  AGENT_LIMITS,
  AGENT_NAME_PATTERN,
  AGENT_SCOPE_KINDS,
  AGENT_WRITE_MODES,
} from "../../../catalog/agent.js";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function exactFields(value, allowed, required, label, errors) {
  const record = object(value);
  if (!record) { errors.push(`${label} must be an object`); return null; }
  for (const key of Object.keys(record)) if (!allowed.includes(key)) errors.push(`${label} has unknown field ${JSON.stringify(key)}`);
  for (const key of required) if (!Object.hasOwn(record, key)) errors.push(`${label} is missing ${JSON.stringify(key)}`);
  return record;
}

function stringList(value, label, errors) {
  if (!Array.isArray(value)) { errors.push(`${label} must be an array`); return []; }
  const out = [], seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) { errors.push(`${label} contains an empty or non-string value`); continue; }
    const name = item.trim();
    if (seen.has(name)) errors.push(`${label} repeats ${JSON.stringify(name)}`);
    else { seen.add(name); out.push(name); }
  }
  return out;
}

export function validateAgentDefinition(value, { filename = "" } = {}) {
  const errors = [];
  const required = AGENT_DEFINITION_FIELDS.filter(field => field !== "autonomy");
  const definition = exactFields(value, AGENT_DEFINITION_FIELDS, required, "agent definition", errors);
  if (!definition) return { ok: false, errors, definition: null };
  if (definition.schema !== AGENT_DEFINITION_SCHEMA) errors.push(`schema must be ${AGENT_DEFINITION_SCHEMA}`);
  if (typeof definition.name !== "string" || !AGENT_NAME_PATTERN.test(definition.name)) errors.push("name must be lower-case and file-safe");
  if (filename && definition.name !== filename) errors.push(`name ${JSON.stringify(definition.name)} must match file stem ${JSON.stringify(filename)}`);
  if (typeof definition.description !== "string" || !definition.description.trim()) errors.push("description is required");
  if (typeof definition.prompt !== "string" || !definition.prompt.trim()) errors.push("prompt is required");
  if (typeof definition.model !== "string" || !definition.model.trim()) errors.push("model is required");

  const scope = exactFields(definition.scope, ["kind", "repo_id", "folder_path"], ["kind"], "scope", errors);
  if (scope && !AGENT_SCOPE_KINDS.includes(scope.kind)) errors.push("scope.kind must be sandbox, folder, repository, or global");
  if (scope?.kind === "repository" && (typeof scope.repo_id !== "string" || !scope.repo_id.trim())) errors.push("repository scope requires repo_id");
  if (scope?.kind === "folder" && (typeof scope.folder_path !== "string" || !path.isAbsolute(scope.folder_path) || path.normalize(scope.folder_path) !== scope.folder_path)) errors.push("folder scope requires a clean absolute folder_path");
  if (scope && scope.kind !== "repository" && Object.hasOwn(scope, "repo_id") && scope.repo_id) errors.push(`${scope.kind} scope cannot set repo_id`);
  if (scope && scope.kind !== "folder" && Object.hasOwn(scope, "folder_path") && scope.folder_path) errors.push(`${scope.kind} scope cannot set folder_path`);

  const autonomy = exactFields(definition.autonomy ?? { write_tools: "confirm" }, ["write_tools"], ["write_tools"], "autonomy", errors);
  if (autonomy && !AGENT_WRITE_MODES.includes(autonomy.write_tools)) errors.push("autonomy.write_tools must be confirm, allow, or deny");

  const limits = exactFields(definition.limits, Object.keys(AGENT_LIMITS), Object.keys(AGENT_LIMITS), "limits", errors);
  if (limits) {
    for (const key of ["turns", "calls", "wall_seconds"]) {
      if (!Number.isInteger(limits[key]) || limits[key] <= 0 || limits[key] > AGENT_LIMITS[key]) errors.push(`limits.${key} must be an integer from 1 to ${AGENT_LIMITS[key]}`);
    }
    if (!Number.isFinite(limits.spend_usd) || limits.spend_usd <= 0 || limits.spend_usd > AGENT_LIMITS.spend_usd) errors.push(`limits.spend_usd must be greater than 0 and at most ${AGENT_LIMITS.spend_usd}`);
  }

  const tools = stringList(definition.tools, "tools", errors);
  const skills = stringList(definition.skills, "skills", errors);
  return {
    ok: errors.length === 0,
    errors,
    definition: errors.length ? null : {
      schema: definition.schema,
      name: definition.name,
      description: definition.description,
      prompt: definition.prompt,
      model: definition.model,
      scope: scope.kind === "repository" ? { kind: "repository", repo_id: scope.repo_id.trim() }
        : scope.kind === "folder" ? { kind: "folder", folder_path: scope.folder_path }
          : { kind: scope.kind },
      tools,
      skills,
      autonomy: { write_tools: autonomy.write_tools },
      limits: {
        turns: limits.turns,
        calls: limits.calls,
        spend_usd: limits.spend_usd,
        wall_seconds: limits.wall_seconds,
      },
    },
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function agentDefinitionDigest(definition) {
  return createHash("sha256").update(JSON.stringify(canonical(definition))).digest("hex");
}

export function scaffoldAgentDefinition(name) {
  return {
    schema: AGENT_DEFINITION_SCHEMA,
    name,
    description: `Describe what ${name} does.`,
    prompt: `You are ${name}. Replace this with the agent's standing instructions.`,
    model: "sonnet",
    scope: { kind: "sandbox" },
    tools: [],
    skills: [],
    autonomy: { write_tools: "confirm" },
    limits: { turns: 16, calls: 32, spend_usd: 2, wall_seconds: 600 },
  };
}
