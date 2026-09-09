import { createHash } from "node:crypto";
import Ajv from "ajv";
import { PROVIDER_ROLE_NAMES } from "../../../catalog/provider.js";
import { AUTOMATION_RESOURCE_OPERATIONS } from "../../../catalog/custom-tools.js";

const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: false, ownProperties: true });
export function demand(condition, message, code = "invalid_request") {
  if (!condition) throw Object.assign(new Error(message), { code });
}
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function digest(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
export function definitionDigest(value) {
  const copy = structuredClone(value);
  for (const key of ["state", "published_by", "published_at", "deprecated_at", "created_at", "updated_at"]) delete copy[key];
  return digest(copy);
}
export function schemaCheck(schema, value) {
  const validate = ajv.compile(schema);
  demand(validate(value), `Schema validation failed: ${ajv.errorsText(validate.errors)}`, "schema_mismatch");
}
export function object(value, allowed, required = []) {
  demand(value && typeof value === "object" && !Array.isArray(value), "Expected an object");
  demand(Object.keys(value).every(key => allowed.includes(key)), "Unknown contract field");
  demand(required.every(key => Object.hasOwn(value, key)), "Required contract field missing");
  return value;
}
export function subject(value) {
  object(value, ["scope", "repo_id", "role", "job_id", "work_item_id"], ["scope", "role"]);
  demand(["repository", "standalone"].includes(value.scope), "Invalid subject scope");
  demand(PROVIDER_ROLE_NAMES.includes(value.role), "Unknown role");
  demand(value.scope === "repository" ? typeof value.repo_id === "string" && value.repo_id.length > 0 : !value.repo_id, "Scope/repository mismatch");
  return structuredClone(value);
}
export function validateGrant(value) {
  object(value, ["id", "tool", "digest", "scope", "repo_id", "roles", "operations", "resources", "unattended", "enabled", "revision", "limits"], ["id", "tool", "digest", "scope", "roles", "operations"]);
  demand(typeof value.id === "string" && /^[a-zA-Z0-9._-]{1,120}$/.test(value.id), "Invalid grant ID");
  demand(["repository", "standalone"].includes(value.scope), "Invalid grant scope");
  demand(value.scope === "repository" ? !!value.repo_id : !value.repo_id, "Grant repository mismatch");
  demand(Array.isArray(value.roles) && value.roles.length > 0 && value.roles.every(role => role === "*" || PROVIDER_ROLE_NAMES.includes(role)), "Explicit roles required");
  demand(Array.isArray(value.operations) && value.operations.length > 0 && value.operations.every(op => ["describe", "invoke"].includes(op)), "Invalid grant operations");
  for (const resource of value.resources || []) {
    object(resource, ["id", "operations"], ["id", "operations"]);
    demand(Array.isArray(resource.operations) && resource.operations.length && resource.operations.every(op => AUTOMATION_RESOURCE_OPERATIONS.includes(op)), "Invalid resource operations");
  }
  if (value.limits) validateLimits(value.limits);
  return { ...structuredClone(value), resources: value.resources || [], enabled: value.enabled !== false, unattended: value.unattended === true };
}
export function matchesGrant(grant, principal, operation) {
  return grant.enabled && grant.scope === principal.scope && (grant.repo_id || "") === (principal.repo_id || "")
    && (grant.roles.includes(principal.role) || grant.roles.includes("*")) && grant.operations.includes(operation);
}
export function authorize(grants, entry, principal, operation, grantID) {
  const matches = grants.filter(grant => grant.tool === entry.id && grant.digest === entry.digest && matchesGrant(grant, principal, operation) && (!grantID || grant.id === grantID));
  demand(matches.length > 0, "Custom tool is unavailable in this scope", "forbidden");
  demand(matches.length === 1 || operation === "describe", "Select one exact grant_id; resource grants are never unioned", "ambiguous_grant");
  return matches[0];
}
export function validateLimits(limits) {
  object(limits, ["wall_time_seconds", "turns", "calls", "spend_cap_usd"], ["wall_time_seconds", "turns", "calls", "spend_cap_usd"]);
  for (const [name, maximum] of [["wall_time_seconds", 3600], ["turns", 64], ["calls", 256]]) demand(Number.isInteger(limits[name]) && limits[name] > 0 && limits[name] <= maximum, `Invalid ${name}`);
  demand(Number.isFinite(limits.spend_cap_usd) && limits.spend_cap_usd > 0 && limits.spend_cap_usd <= 100, "Invalid spend cap");
}
export function narrowLimits(limits, narrowing = limits) {
  validateLimits(limits); validateLimits(narrowing);
  return Object.fromEntries(Object.keys(limits).map(key => [key, Math.min(limits[key], narrowing[key])]));
}
export function validateDefinition(definition) {
  object(definition, ["schema_version", "name", "version", "state", "intent", "binding", "capabilities", "required_capabilities", "resource_requirements", "contract", "runtime", "output_roots", "published_by", "published_at", "deprecated_at", "created_at", "updated_at"], ["schema_version", "name", "version", "intent", "binding", "capabilities", "contract", "runtime"]);
  demand(definition.schema_version === 1 && /^[a-z][a-z0-9-]*$/.test(definition.name), "Invalid skill identity");
  demand(/^(?:draft|(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.test(definition.version), "Invalid skill version");
  demand(typeof definition.intent === "string" && definition.intent.trim().length > 0 && definition.intent.length <= 20000, "Invalid skill intent");
  const binding = definition.binding;
  object(binding, ["kind", "repo_id"], ["kind"]);
  demand(["repository", "global", "run-only"].includes(binding.kind), "Invalid skill binding");
  demand(binding.kind !== "repository" || !!binding.repo_id, "Repository required");
  demand(binding.kind !== "global" || !binding.repo_id, "Global skill cannot bind a repository");
  for (const root of definition.output_roots || []) demand(typeof root === "string" && root.length > 0 && !root.startsWith("/") && !root.includes("\\") && !root.includes(":") && root.split("/").every(part => part && ![".", "..", ".git", ".posse"].includes(part)), "Invalid skill output root");
  const resources = new Set();
  for (const resource of definition.resource_requirements || []) {
    object(resource, ["id", "operations"], ["id", "operations"]);
    demand(typeof resource.id === "string" && /^[\w.-]{1,120}$/.test(resource.id) && !resources.has(resource.id), "Invalid/duplicate resource requirement");
    demand(Array.isArray(resource.operations) && resource.operations.length && resource.operations.every(op => AUTOMATION_RESOURCE_OPERATIONS.includes(op)), "Invalid resource requirement operation");
    resources.add(resource.id);
  }
  const contract = definition.contract;
  object(contract, ["input_schema", "output_schema", "limits", "effect", "tests"], ["input_schema", "output_schema", "limits", "effect", "tests"]);
  validateLimits(contract.limits);
  demand(["read_only", "artifact_write"].includes(contract.effect), "Unsupported skill effect");
  demand(contract.effect !== "read_only" || !definition.output_roots?.length && !(definition.resource_requirements || []).some(item => item.operations.includes("write")), "Read-only skill cannot declare writes");
  demand(contract.effect !== "artifact_write" || definition.output_roots?.length || (definition.resource_requirements || []).some(item => item.operations.includes("write")), "Artifact skills require explicit output resources");
  ajv.compile(contract.output_schema);
  schemaCheck(contract.input_schema, contract.tests.valid_input);
  let invalid = false;
  try { schemaCheck(contract.input_schema, contract.tests.invalid_input); } catch { invalid = true; }
  demand(invalid, "Invalid fixture must fail input validation");
  const granted = new Set();
  demand(Array.isArray(definition.capabilities) && definition.capabilities.length > 0, "Capabilities required");
  for (const cap of definition.capabilities) {
    object(cap, ["kind", "id", "output_schema"], ["kind", "id"]);
    demand(["tool", "child_skill", "native_tool"].includes(cap.kind) && typeof cap.id === "string" && cap.id.length > 0 && !granted.has(cap.id), "Invalid/duplicate capability");
    granted.add(cap.id);
    if (cap.output_schema) ajv.compile(cap.output_schema);
  }
  for (const id of definition.required_capabilities || []) demand(granted.has(id), `Required capability missing: ${id}`);
  object(definition.runtime, ["mode", "recipe"], ["mode"]);
  demand(["recipe", "bounded-agent"].includes(definition.runtime.mode), "Unknown runtime");
  if (definition.runtime.mode === "recipe") {
    demand(Array.isArray(definition.runtime.recipe) && definition.runtime.recipe.length > 0, "Recipe steps required");
    const steps = new Set();
    for (const step of definition.runtime.recipe) {
      object(step, ["id", "capability", "input"], ["id", "capability"]);
      demand(typeof step.id === "string" && /^[a-zA-Z][\w-]*$/.test(step.id) && !steps.has(step.id) && granted.has(step.capability), "Invalid recipe step");
      steps.add(step.id);
    }
  } else demand(!definition.runtime.recipe?.length, "Agent cannot contain recipe steps");
  return definition;
}
export function publicEntry(entry, grants = []) {
  return { id: entry.id, source: entry.source, kind: entry.kind, digest: entry.digest, description: entry.description, input_schema: entry.input_schema, output_schema: entry.output_schema, effect: entry.effect, limits: entry.limits, enabled: entry.enabled, grant_ids: grants.map(grant => grant.id) };
}
