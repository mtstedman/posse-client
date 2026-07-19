import path from "node:path";

import { SETTING_KEYS } from "../../../catalog/settings.js";
import {
  MODEL_SETTING_DEFS,
  getDefaultImageModel,
  getDefaultTierModel,
} from "../../providers/functions/model-catalog.js";
import {
  getSetting,
  listSettings,
  setSetting,
} from "../../queue/functions/index.js";
import { resolveRepoSettingPath } from "../../queue/functions/settings.js";
import {
  loadSkillManifests,
  parseSkillIds,
  setSkillEnabled,
} from "../../../shared/skills/functions/registry.js";
import {
  readProjectDbConfig,
  writeProjectDbConfig,
} from "../../../shared/tools/functions/toolkit/project-db/config.js";
import {
  ADMIN_CREDENTIAL_SETTING_DEFS,
  PROJECT_DB_SETTING_KEYS,
  SKILL_SETTING_PREFIX,
} from "./admin-catalog.js";
import {
  ADMIN_MAX_JSON_BYTES,
  ADMIN_PROTOCOL,
  flattenAdminSettings,
  projectAdminDescription,
} from "./admin-projection.js";
import {
  getModelChoicesForEntry,
  getSelectableImageProviders,
  getSelectableProviders,
  validateAdminSettingValue,
} from "./admin-validation.js";

export const ADMIN_EXIT_CODES = Object.freeze({
  invalid_arguments: 2,
  unknown_setting: 3,
  invalid_value: 4,
  setting_unavailable: 5,
  mutation_failed: 6,
  description_unavailable: 6,
  description_too_large: 6,
});

function singleLine(message) {
  return String(message || "Admin command failed.")
    .split(/\r?\n/, 1)[0]
    .slice(0, 1024);
}

export class AdminContractError extends Error {
  constructor(code, message, exitCode = null) {
    super(singleLine(message));
    this.name = "AdminContractError";
    this.code = String(code || "mutation_failed");
    this.exitCode = exitCode || ADMIN_EXIT_CODES[this.code] || ADMIN_EXIT_CODES.mutation_failed;
  }
}

function settingValue(settingKey, projectDir) {
  try {
    return getSetting(settingKey, { projectDir });
  } catch {
    return null;
  }
}

function modelState(def, projectDir) {
  const storedValue = settingValue(def.key, projectDir) || "";
  const options = getModelChoicesForEntry({ ...def, currentValue: storedValue });
  let effectiveValue = storedValue;
  if (!effectiveValue) {
    effectiveValue = def.kind === "image"
      ? getDefaultImageModel(def.provider)
      : getDefaultTierModel(def.provider, def.tier);
  }
  return {
    key: def.key,
    storedValue: storedValue || null,
    effectiveValue: effectiveValue || null,
    options,
  };
}

function credentialPresence(env = {}) {
  return Object.fromEntries(ADMIN_CREDENTIAL_SETTING_DEFS.map((definition) => [
    definition.env,
    typeof env[definition.env] === "string" && env[definition.env].length > 0,
  ]));
}

function ensureDescriptionBound(description) {
  const bytes = Buffer.byteLength(JSON.stringify(description), "utf8");
  if (bytes > ADMIN_MAX_JSON_BYTES) {
    throw new AdminContractError(
      "description_too_large",
      `Admin description is ${bytes} bytes; maximum is ${ADMIN_MAX_JSON_BYTES}.`,
    );
  }
}

export function describeAdminSettings({
  projectDir = process.cwd(),
  env = process.env,
  now = () => new Date(),
} = {}) {
  try {
    const repositoryPath = resolveRepoSettingPath(projectDir);
    const selectableProviders = getSelectableProviders();
    const selectableImageProviders = getSelectableImageProviders();
    const description = projectAdminDescription({
      generatedAt: now().toISOString(),
      repository: {
        identity: path.basename(repositoryPath) || "repository",
        path: repositoryPath,
      },
      settingRows: listSettings({ projectDir }),
      selectableProviders,
      selectableImageProviders,
      modelStates: MODEL_SETTING_DEFS
        .filter((def) => selectableProviders.includes(def.provider))
        .map((def) => modelState(def, projectDir)),
      skillManifests: loadSkillManifests(),
      disabledSkillIds: parseSkillIds(settingValue(SETTING_KEYS.SKILLS_DISABLED_IDS, projectDir) || ""),
      projectDbConfig: readProjectDbConfig({ projectDir }),
      credentialPresence: credentialPresence(env),
    });
    ensureDescriptionBound(description);
    return description;
  } catch (error) {
    if (error instanceof AdminContractError) throw error;
    if (error?.code === "description_too_large") {
      throw new AdminContractError("description_too_large", error.message);
    }
    throw new AdminContractError("description_unavailable", "Admin settings description is unavailable.");
  }
}

function projectDbPatch(storageKey, value) {
  switch (storageKey) {
    case "project_db_enabled": return { enabled: value === "true" };
    case "project_db_type": return { dbType: value || null };
    case "project_db_permissions": return { permissions: value };
    case "project_db_database": return { database: value || null };
    case "project_db_host": return { host: value || null };
    case "project_db_port": return { port: value === "" ? null : Number(value) };
    case "project_db_username": return { username: value || null };
    case "project_db_password": return { password: value || null };
    default: throw new AdminContractError("unknown_setting", `Unknown project database setting: ${storageKey}`);
  }
}

function clearProjectDbPatch(storageKey) {
  switch (storageKey) {
    case "project_db_enabled": return { enabled: false };
    case "project_db_type": return { dbType: null };
    case "project_db_permissions": return { permissions: [] };
    case "project_db_database": return { database: null };
    case "project_db_host": return { host: null };
    case "project_db_port": return { port: null };
    case "project_db_username": return { username: null };
    case "project_db_password": return { password: null };
    default: throw new AdminContractError("unknown_setting", `Unknown project database setting: ${storageKey}`);
  }
}

function mutationState(row) {
  if (!row) return null;
  if (row.sensitive) return JSON.stringify({ value_present: row.value_present === true });
  return JSON.stringify({
    effective_value: row.effective_value,
    stored_value: row.stored_value,
    source: row.source,
  });
}

function findProjectedSetting(description, key) {
  return flattenAdminSettings(description).find((row) => row.key === key) || null;
}

function applyValidatedSet(validation, projectDir) {
  const storageKey = validation.storageKey;
  if (PROJECT_DB_SETTING_KEYS.has(storageKey)) {
    if (storageKey === "project_db_password" && validation.value === "") {
      throw new AdminContractError("invalid_value", "project_db_password requires a non-empty value; use admin clear to remove it.");
    }
    writeProjectDbConfig(projectDbPatch(storageKey, validation.value), { projectDir });
    return;
  }
  if (storageKey.startsWith(SKILL_SETTING_PREFIX)) {
    setSkillEnabled(storageKey.slice(SKILL_SETTING_PREFIX.length), validation.value === "true");
    return;
  }
  setSetting(storageKey, validation.value, { projectDir });
}

function applyClear(row, projectDir) {
  const storageKey = row._storageKey;
  if (PROJECT_DB_SETTING_KEYS.has(storageKey)) {
    writeProjectDbConfig(clearProjectDbPatch(storageKey), { projectDir });
    return;
  }
  if (storageKey.startsWith(SKILL_SETTING_PREFIX)) {
    // Synthetic skill toggles default enabled; clearing removes the disabled
    // override rather than assigning a third state.
    setSkillEnabled(storageKey.slice(SKILL_SETTING_PREFIX.length), true);
    return;
  }
  // The shared settings accessor restores account catalog defaults and deletes
  // repo-scoped overrides when passed the canonical empty/unset value.
  setSetting(storageKey, "", { projectDir });
}

export function mutateAdminSetting({
  action,
  key,
  value,
  projectDir = process.cwd(),
  env = process.env,
  now = () => new Date(),
} = {}) {
  const normalizedAction = String(action || "").trim().toLowerCase();
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) {
    throw new AdminContractError("invalid_arguments", "Setting key is required.");
  }
  if (normalizedAction !== "set" && normalizedAction !== "clear") {
    throw new AdminContractError("invalid_arguments", `Unsupported admin mutation: ${normalizedAction || "(empty)"}.`);
  }
  if (normalizedAction === "set" && typeof value === "undefined") {
    throw new AdminContractError("invalid_arguments", "Setting value is required.");
  }

  const beforeDescription = describeAdminSettings({ projectDir, env, now });
  const before = findProjectedSetting(beforeDescription, normalizedKey);
  if (!before) {
    throw new AdminContractError("unknown_setting", `Unknown admin-visible setting: ${normalizedKey}.`);
  }
  if (!before.editable) {
    throw new AdminContractError(
      "setting_unavailable",
      `${normalizedKey} is not editable: ${before.unavailable_reason || "unavailable"}.`,
    );
  }

  try {
    if (normalizedAction === "set") {
      const validation = validateAdminSettingValue(normalizedKey, value);
      if (!validation.ok) {
        throw new AdminContractError("invalid_value", validation.error);
      }
      applyValidatedSet(validation, projectDir);
    } else {
      applyClear(before, projectDir);
    }
  } catch (error) {
    if (error instanceof AdminContractError) throw error;
    throw new AdminContractError("mutation_failed", `Failed to ${normalizedAction} ${normalizedKey}.`);
  }

  const afterDescription = describeAdminSettings({ projectDir, env, now });
  const after = findProjectedSetting(afterDescription, normalizedKey);
  const changed = before.sensitive && normalizedAction === "set"
    ? true
    : mutationState(before) !== mutationState(after);
  const response = {
    protocol: ADMIN_PROTOCOL,
    generated_at: now().toISOString(),
    repository: afterDescription.repository,
    action: normalizedAction,
    key: normalizedKey,
    scope: before.scope,
    changed,
    sensitive: before.sensitive,
  };
  if (before.sensitive) response.value_present = after?.value_present === true;
  ensureDescriptionBound(response);
  return response;
}

export function adminErrorPayload(error, { now = () => new Date() } = {}) {
  const contractError = error instanceof AdminContractError
    ? error
    : new AdminContractError("mutation_failed", "Admin command failed.");
  return {
    exitCode: contractError.exitCode,
    payload: {
      protocol: ADMIN_PROTOCOL,
      generated_at: now().toISOString(),
      error: {
        code: contractError.code,
        message: singleLine(contractError.message),
      },
    },
  };
}
