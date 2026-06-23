import { RemotePromptClient } from "../classes/RemotePromptClient.js";
import {
  getPosseRemoteTimeoutMs,
  getPosseRemoteUrl,
} from "./mode.js";

export const SUPPORTED_PROMPT_BUNDLE_SCHEMA_VERSION = 1;

let activeBundle = null;
let activeBundlePromise = null;

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStringArray(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = normalizeKey(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function normalizeTextMap(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`remote prompt bundle missing ${fieldName}`);
  }
  const out = new Map();
  for (const [rawKey, rawEntry] of Object.entries(value)) {
    const key = normalizeKey(rawKey);
    const markdown = typeof rawEntry === "string"
      ? rawEntry
      : String(rawEntry?.markdown || "");
    if (!key || !markdown.trim()) continue;
    out.set(key, markdown);
  }
  return out;
}

function normalizeRoleContracts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
  const out = new Map();
  for (const [role, names] of Object.entries(value)) {
    const normalizedRole = normalizeKey(role);
    if (!normalizedRole) continue;
    out.set(normalizedRole, normalizeStringArray(names));
  }
  return out;
}

function normalizeSkills(value) {
  if (!Array.isArray(value)) return [];
  const skills = [];
  for (const entry of value) {
    const id = normalizeKey(entry?.id);
    if (!id) continue;
    skills.push({
      id,
      name: String(entry?.name || id).trim(),
      description: String(entry?.description || "").trim(),
      applies_to: normalizeStringArray(entry?.applies_to),
      when_to_use: String(entry?.when_to_use || "").trim(),
      recycle_session: entry?.recycle_session === true,
      body: String(entry?.body || "").trim(),
      path: `remote://prompts/skills/${id}/SKILL.md`,
      dir: `remote://prompts/skills/${id}`,
    });
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return skills;
}

function normalizePromptBundle(raw) {
  const promptVersion = String(raw?.prompt_version || "").trim();
  if (!promptVersion) throw new Error("remote prompt bundle missing prompt_version");
  const schemaVersion = Number(raw?.schema_version || 0);
  if (!Number.isFinite(schemaVersion) || schemaVersion < 1) {
    throw new Error("remote prompt bundle missing schema_version");
  }
  if (schemaVersion !== SUPPORTED_PROMPT_BUNDLE_SCHEMA_VERSION) {
    throw new Error(
      `remote prompt bundle schema_version mismatch (remote=${schemaVersion}, code=${SUPPORTED_PROMPT_BUNDLE_SCHEMA_VERSION})`,
    );
  }
  const bundle = {
    schema_version: schemaVersion,
    prompt_version: promptVersion,
    roles: normalizeTextMap(raw?.roles, "roles"),
    // Contracts and role_contracts are compiled into the system prompt by the
    // remote prompt compiler, not assembled locally, so they are optional in the
    // bundle. They are still normalized when present for wire/back-compat.
    contracts: raw?.contracts ? normalizeTextMap(raw.contracts, "contracts") : new Map(),
    role_contracts: normalizeRoleContracts(raw?.role_contracts),
    skills: normalizeSkills(raw?.skills),
    fetched_at: new Date().toISOString(),
    source: "remote",
  };
  if (bundle.roles.size === 0) throw new Error("remote prompt bundle has no roles");
  return bundle;
}

function requiredBundleError(message = "remote prompt bundle has not been loaded") {
  const err = new Error(message);
  err.code = "POSSE_REMOTE_REQUIRED";
  return err;
}

export async function loadRemotePromptBundle({
  client = null,
  baseUrl = getPosseRemoteUrl(),
  timeoutMs = getPosseRemoteTimeoutMs(),
  force = false,
} = {}) {
  if (activeBundle && !force) return activeBundle;
  if (activeBundlePromise && !force) return activeBundlePromise;

  const promptClient = client || new RemotePromptClient({ baseUrl, timeoutMs });
  const loadPromise = (async () => {
    const raw = typeof promptClient.getPromptBundle === "function"
      ? await promptClient.getPromptBundle()
      : await promptClient.requestJsonOnce({
        path: "/v1/prompts/bundle",
        method: "GET",
        operation: "remote prompt bundle",
      });
    activeBundle = normalizePromptBundle(raw);
    return activeBundle;
  })();
  activeBundlePromise = loadPromise;

  try {
    return await loadPromise;
  } finally {
    if (activeBundlePromise === loadPromise) activeBundlePromise = null;
  }
}

export function setActivePromptBundleForTest(rawBundle) {
  activeBundle = normalizePromptBundle(rawBundle);
  activeBundlePromise = null;
  return activeBundle;
}

export function resetActivePromptBundleForTest() {
  activeBundle = null;
  activeBundlePromise = null;
}

export function getActivePromptBundle({ required = true } = {}) {
  if (activeBundle) return activeBundle;
  if (!required) return null;
  throw requiredBundleError();
}

export function getPromptBundleVersion() {
  return activeBundle?.prompt_version || null;
}

export function getPromptBundleRolePrompt(role, { required = true } = {}) {
  const bundle = getActivePromptBundle({ required });
  if (!bundle) return "";
  const key = normalizeKey(role);
  const markdown = bundle.roles.get(key) || "";
  if (!markdown && required) {
    throw requiredBundleError(`remote prompt bundle missing role prompt for ${key || "(empty)"}`);
  }
  return markdown;
}

export function getPromptBundleSkillManifests() {
  const bundle = getActivePromptBundle();
  return bundle.skills.map((skill) => ({ ...skill }));
}
