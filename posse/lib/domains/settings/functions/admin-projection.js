import {
  IMAGE_PROVIDER_OPTIONS,
  MODEL_SETTING_DEFS,
  PROVIDER_LABELS,
  getDefaultImageModel,
  getDefaultImageProvider,
  getDefaultTierModel,
} from "../../providers/functions/model-catalog.js";
import {
  ADMIN_AGENT_SETTING_SECTIONS,
  ADMIN_CREDENTIAL_SETTING_DEFS,
  ADMIN_IMAGE_SETTING_SECTIONS,
  ADMIN_PROVIDER_CATALOG_SETTING_KEYS,
  ADMIN_PROVIDER_SETTING_SECTIONS,
  ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS,
  HIDDEN_SETTING_KEYS,
  PROJECT_DB_SETTING_DEFS,
  PROVIDER_SETTING_KEYS,
  SETTINGS_GROUPS,
  SETTINGS_PANES,
  SKILL_SETTING_PREFIX,
  SYNTHETIC_SETTING_KEYS,
  getAdminSettingPresentation,
  settingsGroupForKey,
  settingsPaneForKey,
  toDisplaySettingKey,
} from "./admin-catalog.js";
import {
  SETTINGS_CATALOG,
  getCatalogNumericRule,
  getCatalogOptions,
  getCatalogRuntimeFallback,
  isAdminVisibleCatalogKey,
  isCatalogBooleanSetting,
} from "./catalog.js";

export const ADMIN_PROTOCOL = "posse.admin.v1";
export const ADMIN_MAX_SETTINGS = 2048;
export const ADMIN_MAX_OPTIONS_PER_SETTING = 256;
export const ADMIN_MAX_TEXT_CHARS = 2048;
export const ADMIN_MAX_VALUE_CHARS = 16384;
export const ADMIN_MAX_JSON_BYTES = 2 * 1024 * 1024;

const MODEL_SETTING_KEYS = new Set(MODEL_SETTING_DEFS.map((def) => def.key));
const IMAGE_PROVIDER_VALUES = new Set(IMAGE_PROVIDER_OPTIONS.map((option) => option.value));

function boundedText(value, max = ADMIN_MAX_TEXT_CHARS) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function valueString(value) {
  if (value == null) return null;
  const text = String(value);
  if (text.length > ADMIN_MAX_VALUE_CHARS) {
    const error = new Error("admin setting value exceeds the v1 description bound");
    error.code = "description_too_large";
    throw error;
  }
  return text;
}

function normalizeOptions(options = []) {
  const normalized = (Array.isArray(options) ? options : [])
    .map((option) => {
      const value = valueString(option?.value ?? option);
      if (value == null) return null;
      return {
        value,
        label: boundedText(option?.label ?? value),
      };
    })
    .filter(Boolean);
  return normalized;
}

function settingValueType(definition = {}) {
  if (definition.sensitive) return "secret";
  if (definition.multi) return "multi";
  if (Array.isArray(definition.options) && definition.options.length > 0) return "enum";
  if (definition.valueType === "boolean") return "boolean";
  if (definition.numeric) return "number";
  return "string";
}

function createRow({
  key,
  storageKey = key,
  section,
  group = null,
  label,
  description,
  scope = "account",
  definition = {},
  effectiveValue = null,
  storedValue = null,
  defaultValue = null,
  source = "default",
  sensitive = false,
  valuePresent = false,
  editable = true,
  unavailableReason = null,
  origin = "catalog",
}) {
  let options = normalizeOptions(definition.options || []);
  const valueType = settingValueType({ ...definition, sensitive });
  if (options.length > ADMIN_MAX_OPTIONS_PER_SETTING) {
    options = [];
    editable = false;
    unavailableReason = "options_exceed_contract_limit";
  }
  if (editable && (valueType === "enum" || valueType === "multi") && options.length === 0) {
    editable = false;
    unavailableReason = "no_selectable_options";
  }
  const row = {
    key: String(key),
    section: String(section),
    group: group == null ? null : String(group),
    label: boundedText(label),
    description: boundedText(description),
    scope: scope === "repo" ? "repo" : "account",
    value_type: valueType,
    numeric: definition.numeric ? { ...definition.numeric } : null,
    options,
    multi: definition.multi === true,
    sensitive: sensitive === true,
    editable: editable === true,
    unavailable_reason: editable ? null : String(unavailableReason || "unavailable"),
  };
  if (sensitive) {
    row.value_present = valuePresent === true;
  } else {
    row.effective_value = valueString(effectiveValue);
    row.stored_value = valueString(storedValue);
    row.default_value = valueString(defaultValue);
    row.source = String(source || "default");
  }
  Object.defineProperties(row, {
    _storageKey: { value: String(storageKey), enumerable: false },
    _origin: { value: origin, enumerable: false },
  });
  return row;
}

function rowStateForCatalog(entry, settingRowsByKey) {
  const defaultValue = entry.default == null ? "" : String(entry.default);
  const row = settingRowsByKey.get(entry.key) || null;
  const currentValue = row ? String(row.setting_value ?? "") : defaultValue;
  const scope = entry.scope === "repo" ? "repo" : "account";
  const hasStoredValue = scope === "repo"
    ? row?.updated_at != null
    : !!row && currentValue !== defaultValue;
  const storedValue = hasStoredValue ? currentValue : null;
  const baseEffective = hasStoredValue ? currentValue : defaultValue;
  const runtimeFallback = getCatalogRuntimeFallback(entry.key);
  const effectiveValue = baseEffective === "" ? runtimeFallback : baseEffective;
  return {
    scope,
    effectiveValue: effectiveValue == null || effectiveValue === "" ? null : String(effectiveValue),
    storedValue,
    defaultValue,
    source: hasStoredValue ? scope : "default",
  };
}

function catalogDefinition(entry, optionOverrides = null) {
  const options = optionOverrides || getCatalogOptions(entry.key);
  const numeric = getCatalogNumericRule(entry.key);
  return {
    options,
    multi: entry.multi === true,
    valueType: isCatalogBooleanSetting(entry.key) ? "boolean" : entry.valueType,
    numeric,
  };
}

function projectDbValue(key, cfg = {}) {
  switch (key) {
    case "project_db_enabled": return cfg.enabled ? "true" : "false";
    case "project_db_type": return cfg.dbType || "";
    case "project_db_permissions": return Array.isArray(cfg.permissions) ? cfg.permissions.join(",") : "";
    case "project_db_database": return cfg.database || "";
    case "project_db_host": return cfg.host || "";
    case "project_db_port": return cfg.port == null ? "" : String(cfg.port);
    case "project_db_username": return cfg.username || "";
    default: return "";
  }
}

function safeSkillDescription(skill = {}) {
  return `${skill.name || skill.id}: ${skill.when_to_use || skill.description || "planner-selectable skill"}`;
}

/**
 * Pure projection of canonical admin catalog data plus already-sanitized
 * runtime state. This function performs no I/O and never receives secret
 * values: sensitive inputs are booleans indicating presence only.
 */
export function projectAdminDescription({
  generatedAt,
  repository,
  settingRows = [],
  selectableProviders = [],
  selectableImageProviders = [],
  modelStates = [],
  skillManifests = [],
  disabledSkillIds = [],
  projectDbConfig = {},
  credentialPresence = {},
} = {}) {
  const settingRowsByKey = new Map(
    (Array.isArray(settingRows) ? settingRows : []).map((row) => [String(row.setting_key), row]),
  );
  const modelStatesByKey = new Map(
    (Array.isArray(modelStates) ? modelStates : []).map((state) => [String(state.key), state]),
  );
  const selectableProviderSet = new Set(selectableProviders.map((provider) => String(provider)));
  const safeSelectableImageProviders = selectableImageProviders
    .filter((option) => IMAGE_PROVIDER_VALUES.has(String(option?.value ?? option)));
  const disabledSkills = new Set(disabledSkillIds.map((id) => String(id)));
  const skills = [...skillManifests].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const skillOptions = skills.map((skill) => ({ value: String(skill.id), label: String(skill.name || skill.id) }));

  const rowsByKey = new Map();
  for (const entry of SETTINGS_CATALOG) {
    if (!isAdminVisibleCatalogKey(entry.key) || HIDDEN_SETTING_KEYS.has(entry.key)) continue;
    if (MODEL_SETTING_KEYS.has(entry.key)) {
      const modelDef = MODEL_SETTING_DEFS.find((def) => def.key === entry.key);
      if (!modelDef || !selectableProviderSet.has(modelDef.provider)) continue;
    }
    const displayKey = toDisplaySettingKey(entry.key);
    const presentation = getAdminSettingPresentation(displayKey);
    const state = rowStateForCatalog(entry, settingRowsByKey);
    let definition = catalogDefinition(entry);
    if (entry.key === "skills_disabled_ids") {
      definition = { ...definition, options: skillOptions, multi: true };
    }
    if (PROVIDER_SETTING_KEYS.has(entry.key)) {
      definition = {
        ...definition,
        options: selectableProviders.map((provider) => ({
          value: provider,
          label: PROVIDER_LABELS[provider] || provider,
        })),
        multi: true,
      };
      state.effectiveValue ||= "claude";
    } else if (ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS.has(entry.key)) {
      definition = {
        ...definition,
        options: safeSelectableImageProviders.map((option) => ({
          value: option?.value ?? option,
          label: option?.label ?? PROVIDER_LABELS[option?.value ?? option] ?? option?.value ?? option,
        })),
      };
      state.effectiveValue ||= getDefaultImageProvider();
    } else if (MODEL_SETTING_KEYS.has(entry.key)) {
      const modelDef = MODEL_SETTING_DEFS.find((def) => def.key === entry.key);
      const modelState = modelStatesByKey.get(entry.key) || {};
      definition = { ...definition, options: modelState.options || [] };
      state.effectiveValue = modelState.effectiveValue
        || (modelDef.kind === "image"
          ? getDefaultImageModel(modelDef.provider)
          : getDefaultTierModel(modelDef.provider, modelDef.tier))
        || null;
      state.storedValue = modelState.storedValue || null;
      state.source = state.storedValue == null ? "default" : "account";
    }
    rowsByKey.set(displayKey, createRow({
      key: displayKey,
      storageKey: entry.key,
      section: settingsPaneForKey(displayKey),
      group: settingsGroupForKey(displayKey)?.id || null,
      label: presentation.label,
      description: presentation.description,
      definition,
      ...state,
      origin: "catalog",
    }));
  }

  const sections = SETTINGS_PANES.map((pane) => ({ id: pane.id, label: pane.label, settings: [] }));
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const placed = new Set();
  const push = (key, sectionId, group = null) => {
    if (placed.has(key)) return;
    const row = rowsByKey.get(key);
    if (!row) return;
    row.section = sectionId;
    if (group != null) row.group = group;
    sectionById.get(sectionId)?.settings.push(row);
    placed.add(key);
  };
  const pushCatalogPane = (paneId) => {
    for (const group of SETTINGS_GROUPS) {
      if (group.pane !== paneId) continue;
      for (const key of group.keys) push(key, paneId, group.id);
    }
    const ungrouped = [...rowsByKey.keys()]
      .filter((key) => !placed.has(key) && settingsPaneForKey(key) === paneId)
      .sort((a, b) => a.localeCompare(b));
    for (const key of ungrouped) push(key, paneId, "misc");
  };

  pushCatalogPane("atlas");

  for (const section of ADMIN_AGENT_SETTING_SECTIONS) {
    const group = `agent_${section.role}`;
    push(`provider_${section.role}`, "agents", group);
    if (section.role === "delegator") push("delegation_mode", "agents", group);
    for (const key of section.keys) {
      if (key !== "delegation_mode") push(key, "agents", group);
    }
  }

  for (const section of ADMIN_PROVIDER_SETTING_SECTIONS) {
    const group = `provider_${section.provider}`;
    for (const def of MODEL_SETTING_DEFS) {
      if ((def.kind || "text") === "text" && def.provider === section.provider) push(def.key, "providers", group);
    }
    for (const key of section.settingKeys) push(key, "providers", group);
  }
  for (const key of ADMIN_PROVIDER_CATALOG_SETTING_KEYS) push(key, "providers", "provider_catalog");

  for (const definition of ADMIN_CREDENTIAL_SETTING_DEFS) {
    const present = credentialPresence[definition.env] === true;
    sectionById.get("providers").settings.push(createRow({
      key: definition.key,
      section: "providers",
      group: "provider_credentials",
      label: definition.label,
      description: definition.description,
      scope: "account",
      definition: { sensitive: true },
      sensitive: true,
      valuePresent: present,
      editable: false,
      unavailableReason: "environment_managed",
      origin: "credential",
    }));
  }

  push("artifact_image_provider", "images", "image_routing");
  for (const section of ADMIN_IMAGE_SETTING_SECTIONS) {
    const group = `image_${section.provider}`;
    for (const def of MODEL_SETTING_DEFS) {
      if (def.kind === "image" && def.provider === section.provider) push(def.key, "images", group);
    }
    for (const key of section.settingKeys) push(key, "images", group);
  }

  pushCatalogPane("general");
  for (const skill of skills) {
    const enabled = !disabledSkills.has(String(skill.id));
    const presentation = getAdminSettingPresentation(`skill:${skill.id}`, {
      label: skill.name || skill.id,
      description: safeSkillDescription(skill),
    });
    sectionById.get("general").settings.push(createRow({
      key: `skill:${skill.id}`,
      storageKey: `${SKILL_SETTING_PREFIX}${skill.id}`,
      section: "general",
      group: "skills",
      label: presentation.label,
      description: presentation.description,
      scope: "account",
      definition: { valueType: "boolean" },
      effectiveValue: enabled ? "true" : "false",
      storedValue: enabled ? null : "false",
      defaultValue: "true",
      source: enabled ? "default" : "account",
      origin: "skill",
    }));
  }

  pushCatalogPane("repo");
  for (const definition of PROJECT_DB_SETTING_DEFS) {
    const presentation = getAdminSettingPresentation(definition.key);
    const sensitive = definition.sensitive === true;
    const currentValue = sensitive ? null : projectDbValue(definition.key, projectDbConfig);
    const defaultValue = definition.default == null ? "" : String(definition.default);
    const hasStoredValue = sensitive
      ? projectDbConfig.hasPassword === true
      : currentValue !== defaultValue;
    sectionById.get("repo").settings.push(createRow({
      key: definition.key,
      section: "repo",
      group: "project_database",
      label: presentation.label,
      description: presentation.description,
      scope: "repo",
      definition,
      effectiveValue: currentValue === "" ? null : currentValue,
      storedValue: hasStoredValue ? currentValue : null,
      defaultValue,
      source: hasStoredValue ? "repo" : "default",
      sensitive,
      valuePresent: projectDbConfig.hasPassword === true,
      origin: "project_db",
    }));
  }

  pushCatalogPane("debug");

  // Defensive catch-all. New visible catalog keys project automatically in
  // their canonical pane instead of disappearing; parity tests ensure every
  // such row still has complete metadata.
  for (const key of [...rowsByKey.keys()].sort((a, b) => a.localeCompare(b))) {
    if (placed.has(key)) continue;
    const pane = settingsPaneForKey(key);
    push(key, pane, "misc");
  }

  const settingCount = sections.reduce((count, section) => count + section.settings.length, 0);
  if (settingCount > ADMIN_MAX_SETTINGS) {
    const error = new Error(`admin description has ${settingCount} settings; maximum is ${ADMIN_MAX_SETTINGS}`);
    error.code = "description_too_large";
    throw error;
  }

  return {
    protocol: ADMIN_PROTOCOL,
    generated_at: String(generatedAt),
    repository: {
      identity: boundedText(repository?.identity || "repository"),
      path: String(repository?.path || ""),
    },
    sections,
  };
}

export function flattenAdminSettings(description) {
  return (description?.sections || []).flatMap((section) => section.settings || []);
}

export function projectedCatalogStorageKeys(description) {
  return new Set(flattenAdminSettings(description)
    .filter((row) => row._origin === "catalog")
    .map((row) => row._storageKey));
}

export function expectedAdminVisibleCatalogKeys({ selectableProviders = [] } = {}) {
  const selectable = new Set(selectableProviders);
  return new Set(SETTINGS_CATALOG
    .filter((entry) => isAdminVisibleCatalogKey(entry.key) && !HIDDEN_SETTING_KEYS.has(entry.key))
    .filter((entry) => {
      if (!MODEL_SETTING_KEYS.has(entry.key)) return true;
      const def = MODEL_SETTING_DEFS.find((candidate) => candidate.key === entry.key);
      return !!def && selectable.has(def.provider);
    })
    .map((entry) => entry.key));
}

export function isSpecializedAdminCatalogKey(key) {
  return PROVIDER_SETTING_KEYS.has(key)
    || MODEL_SETTING_KEYS.has(key)
    || ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS.has(key)
    || SYNTHETIC_SETTING_KEYS.has(key);
}
