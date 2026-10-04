// settings-controller.js — Settings tab of the admin TUI: pane layout,
// rendering, and the inline editors. Methods run with the AdminTUI instance as
// `this` (AdminTUI delegates to them).

import readline from "readline";
import {
  buildProviderUsageWindowMap,
  clipPlainTail,
  correspondingLimitSettingKey,
  fit,
  fmtDate,
  formatModelSettingDisplayValue,
  formatProviderSettingValue,
  formatProviderUsageHeader,
  formatProviderUsageWindow,
  getModelProviderDefaults,
  getPrintableInput,
  getProviderUsageSettingHint,
  isBackspaceKey,
  isBooleanSettingValue,
  isEnterKey,
  loadIndexedReport,
  loadReportIndex,
  loadReports,
  matchesHotkey,
  normalizeRawInput,
  parseProviderList,
  parseProviderUsageSettingKey,
  parseReportTimestamp,
  renderUsageBar,
  runtimeDbLooksBusyOrCorrupt,
  toDisplaySettingEntry,
  visibleLength,
} from "../../functions/admin/shared-helpers.js";
import fs from "fs";
import path from "path";
import { C } from "../../../../shared/format/functions/colors.js";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import {
  listWorkItems,
  listJobs,
  getAgentCallStats,
  getScopeContextHealthMetrics,
  listSettings,
  getSetting,
  setSetting,
  listWorkItemsWithCallRollups,
  getAgentCallsWithToolCountsByWorkItem,
  getAgentCallById,
  getToolInvocationsForAgentCall,
  getJob,
} from "../../../queue/functions/index.js";
import {
  getConfiguredImageModel,
  getConfiguredImageProviders,
} from "../../../artifacts/functions/index.js";
import { getConfiguredProviderUsage, inferProviderWindowLimit } from "../../../providers/functions/provider.js";
import { getRuntimeDbPath, getRuntimeLogDir, getRuntimeReportsDir } from "../../../runtime/functions/paths.js";
import { jobReportStatus, workItemDisplayStatus } from "../display/Display.js";
import { getAccountSetting, getAccountSettingsPathForDisplay } from "../../../settings/functions/account-settings.js";
import { closePromptLog, promptPreviewText, readRecentPrompts } from "../../../../shared/telemetry/functions/logging/prompt-log.js";
import { closeOutputLog, readRecentOutputs } from "../../../../shared/telemetry/functions/logging/output-log.js";
import { closeLog } from "../../../../shared/telemetry/functions/logging/logger.js";
import { buildCurrentRoleContract } from "../../../worker/functions/role-contract-view.js";
import { getCatalogEntry, isAdminVisibleCatalogKey } from "../../../settings/functions/catalog.js";
import {
  loadSkillManifests,
  parseSkillIds,
  setSkillEnabled,
} from "../../../../shared/skills/functions/registry.js";
import {
  IMAGE_PROVIDER_OPTIONS,
  MODEL_SETTING_DEFS,
  PROVIDER_LABELS,
  PROVIDER_OPTIONS,
  getDefaultTierModel,
  getImageModelOptions,
  getProviderTierDefaults,
} from "../../../providers/functions/model-catalog.js";
import { PROVIDER_ROLE_NAMES } from "../../../providers/functions/roles.js";
import { fit as fitAnsi, stripAnsi } from "../../../../shared/format/functions/ansi.js";
import {
  formatDuration as fmtDuration,
  formatRelativeTime as fmtRelativeTime,
  formatSignedTokens as fmtSignedTokens,
  formatTokens as fmtTokens,
  formatUsd as fmtUsd,
} from "../../../../shared/format/functions/units.js";
import {
  ADMIN_DEFAULT_SETTINGS_PANE,
  ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS,
  ADMIN_AGENT_SETTING_SECTIONS as AGENT_SETTING_SECTIONS,
  ADMIN_CREDENTIAL_SETTING_DEFS,
  ADMIN_IMAGE_SETTING_SECTIONS as IMAGE_SETTING_SECTIONS,
  ADMIN_PROVIDER_CATALOG_SETTING_KEYS as PROVIDER_CATALOG_SETTING_KEYS,
  ADMIN_PROVIDER_SETTING_SECTIONS as PROVIDER_SETTING_SECTIONS,
  BOOLEAN_SETTING_KEYS,
  DEFAULT_ACCOUNT_SETTING_ROWS,
  ENUM_SETTING_OPTIONS,
  HIDDEN_SETTING_KEYS,
  MULTI_SETTING_KEYS,
  MULTI_SETTING_OPTIONS,
  MULTI_SETTING_VALUES,
  NUMERIC_SETTING_RULES,
  PROVIDER_SETTING_KEYS,
  PROJECT_DB_SETTING_KEYS,
  PROJECT_DB_TYPE_OPTIONS,
  PROJECT_DB_PERMISSION_OPTIONS,
  REPO_SCOPED_DISPLAY_KEYS,
  SETTINGS_GROUPS,
  SETTINGS_PANES,
  adminUnsetValueLabel,
  formatAdminSettingValue,
  getAdminSettingPresentation,
  settingsPaneForKey,
  SKILL_SETTING_PREFIX,
  toDisplaySettingKey,
  toStorageSettingKey,
} from "../../../settings/functions/admin-catalog.js";
import {
  getModelChoicesForEntry,
  getSelectableImageProviders,
  isAdminProviderOption,
  validateAdminSettingValue,
} from "../../../settings/functions/admin-validation.js";
export { validateAdminSettingValue };
import {
  readProjectDbConfig,
  writeProjectDbConfig,
} from "../../../../shared/tools/functions/toolkit/project-db/config.js";
import { installScipLanguageDependencies } from "../../../atlas/functions/v2/scip/dependencies.js";
import { brandRule } from "../../functions/display/helpers/brand.js";
const PROVIDER_USAGE_SETTING_DEFS = [
  { provider: "claude", key: "claude_limit_tokens_session", label: "Claude session token limit", description: "Token cap for Claude's 5-hour rolling session window." },
  { provider: "claude", key: "claude_limit_tokens_week", label: "Claude weekly token limit", description: "Token cap for Claude's 7-day rolling weekly window." },
  { provider: "claude", key: "claude_observed_pct_session", label: "Claude session observed %", description: "Observed Claude session usage percent; saving this calibrates the 5-hour token cap." },
  { provider: "claude", key: "claude_observed_pct_week", label: "Claude weekly observed %", description: "Observed Claude weekly usage percent; saving this calibrates the 7-day token cap." },
];

const MODEL_SETTING_KEYS = new Set(MODEL_SETTING_DEFS.map((def) => def.key));
const PROVIDER_USAGE_SETTING_KEYS = new Set(PROVIDER_USAGE_SETTING_DEFS.map((def) => def.key));
function setSettingWithRuntimeSync(settingKey, value, projectDir = null) {
  setSetting(settingKey, value, { projectDir });
}

function getHistoryJobPresentation(job, jobs = []) {
  const rawStatus = job?.status || "unknown";
  const attemptCount = Number(job?.attempts || job?.attempt_count || 0) || 0;
  const displayStatus = jobReportStatus(job, jobs);

  if ((rawStatus === "queued" || rawStatus === "leased" || rawStatus === "running") && attemptCount > 1) {
    return {
      displayStatus: "retrying",
      icon: `${C.yellow}\u21bb`,
      label: `retrying after ${attemptCount - 1} failed attempt${attemptCount - 1 === 1 ? "" : "s"}`,
      attemptTag: `${attemptCount} attempts so far`,
    };
  }

  if (rawStatus === "succeeded" && attemptCount > 1) {
    return {
      displayStatus: "recovered",
      icon: `${C.yellow}\u21bb`,
      label: `recovered after retry`,
      attemptTag: `${attemptCount} attempts`,
    };
  }

  if (displayStatus === "recovered") {
    return {
      displayStatus,
      icon: `${C.yellow}\u21bb`,
      label: "recovered",
      attemptTag: attemptCount > 0 ? `${attemptCount} attempts` : null,
    };
  }

  if (displayStatus === "succeeded") {
    return {
      displayStatus,
      icon: `${C.green}\u2713`,
      label: "succeeded",
      attemptTag: attemptCount > 0 ? `${attemptCount} attempt${attemptCount === 1 ? "" : "s"}` : null,
    };
  }

  if (displayStatus === "failed" || displayStatus === "dead_letter") {
    return {
      displayStatus,
      icon: `${C.red}\u2717`,
      label: displayStatus,
      attemptTag: attemptCount > 0 ? `${attemptCount} attempt${attemptCount === 1 ? "" : "s"}` : null,
    };
  }

  if (rawStatus === "running") {
    return { displayStatus: rawStatus, icon: `${C.yellow}\u25b6`, label: "running", attemptTag: attemptCount > 0 ? `${attemptCount} attempt${attemptCount === 1 ? "" : "s"}` : null };
  }

  return {
    displayStatus: rawStatus,
    icon: `${C.dim}\u00b7`,
    label: rawStatus,
    attemptTag: attemptCount > 0 ? `${attemptCount} attempt${attemptCount === 1 ? "" : "s"}` : null,
  };
}

function canUseAdminTui({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return !!(
    stdin?.isTTY &&
    stdout?.isTTY &&
    typeof stdin?.setRawMode === "function"
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeAdminLine(str) {
  return String(str ?? "")
    .replace(/\u00c3\u00a2\u201d\u20ac/g, "\u2500")
    .replace(/\u00e2\u201d\u20ac/g, "\u2500")
    .replace(/\u00e2\u20ac\u201d/g, "\u2014");
}

// Key column width budget — clamped so very long catalog keys
// (e.g. context_expand_file_budget_per_attempt, 38 chars) still get
// flush-aligned columns without crushing the value/description areas.
const SETTINGS_KEY_COL_MIN = 28;
const SETTINGS_KEY_COL_MAX = 42;

function clampSettingsKeyColumnWidth(longestKeyLength) {
  const n = Number(longestKeyLength) || 0;
  return Math.max(SETTINGS_KEY_COL_MIN, Math.min(SETTINGS_KEY_COL_MAX, n));
}

function getSettingsValueColumnWidth(innerWidth, keyColumnWidth = SETTINGS_KEY_COL_MIN) {
  // Reserve: 2 leading spaces + 2 (#) + 1 + keyColumnWidth + 1 + 1 (desc gap)
  // ≈ keyColumnWidth + 7. Then cap the value column at 28 so descriptions
  // still get the lion's share of the row.
  const reserved = keyColumnWidth + 7;
  return Math.max(16, Math.min(28, innerWidth - reserved));
}

// Value cell for one setting. Blank values show what they mean at runtime
// (the default) instead of an empty placeholder, and always use the default
// color: an empty stored value falls back to the same behavior.
export function adminSettingValuePresentation(value, source, {
  settingKey = "",
  defaultColor = C.magenta,
  configuredColor = C.cyan,
} = {}) {
  const blank = value == null || String(value).trim() === "";
  return {
    text: formatAdminSettingValue(settingKey, value),
    color: blank || source === "default" ? defaultColor : configuredColor,
  };
}

function withCatalogSource(entry) {
  const storageKey = entry?.storage_key || toStorageSettingKey(entry?.setting_key);
  const catalogEntry = getCatalogEntry(storageKey);
  if (!catalogEntry) return entry;
  const defaultValue = catalogEntry.default == null ? "" : String(catalogEntry.default);
  const settingValue = String(entry?.setting_value ?? "");
  return {
    ...entry,
    default_value: defaultValue,
    source: settingValue === defaultValue ? "default" : entry.source,
  };
}

function getEffectiveModelSetting(def) {
  const stored = safeGetSetting(def.key);
  const providerDefaults = getModelProviderDefaults(def.provider);
  const baseModel = def.tier ? providerDefaults?.[def.tier]?.model : null;

  let effectiveModel = "";
  let source = "default";
  if (!def.tier && stored && String(stored).trim()) {
    effectiveModel = String(stored).trim();
    source = "global";
  } else if (def.tier && stored && String(stored).trim()) {
    effectiveModel = String(stored).trim();
    source = "global";
  } else if (!def.tier && def.provider === "claude") {
    effectiveModel = stored || `${C.dim}tier-driven${C.reset}`;
    source = stored ? "global" : "default";
  } else if (baseModel != null) {
    effectiveModel = baseModel || getDefaultTierModel(def.provider, def.tier) || "";
    source = "default";
  } else if (def.provider === "claude" && def.tier === "standard") {
    effectiveModel = getDefaultTierModel("claude", "standard") || "sonnet";
    source = "default";
  }

  return {
    storedValue: stored || "",
    effectiveModel: String(effectiveModel || "").trim() || (def.provider === "claude" && def.tier === "standard" ? (getDefaultTierModel("claude", "standard") || "sonnet") : ""),
    source,
  };
}

function getEffectiveImageModelSetting(def) {
  const stored = safeGetSetting(def.key);
  const choices = getImageModelOptions(def.provider, { currentValue: stored });
  const storedIsValid = choices.some((choice) => choice.value === stored);
  const effectiveModel = storedIsValid
    ? stored
    : (choices[0]?.value || "");
  return {
    storedValue: storedIsValid ? (stored || "") : "",
    effectiveModel,
    source: storedIsValid ? "global" : "default",
  };
}

function getProviderUsageStoredValue(settingKey) {
  const globalValue = getAccountSetting(settingKey);
  if (globalValue != null && String(globalValue).trim() !== "") return String(globalValue);
  return safeGetSetting(settingKey);
}

function setProviderUsageStoredValue(settingKey, value) {
  setSettingWithRuntimeSync(settingKey, value);
}

function safeGetSetting(key, projectDir = null) {
  if (runtimeDbLooksBusyOrCorrupt()) return null;
  try {
    return getSetting(key, { projectDir });
  } catch {
    return null;
  }
}

function safeListSettings(projectDir = null) {
  if (runtimeDbLooksBusyOrCorrupt()) return [];
  try {
    return listSettings({ projectDir });
  } catch {
    return [];
  }
}

// ─── Report File Reader ─────────────────────────────────────────────────────

// ─── Admin TUI ──────────────────────────────────────────────────────────────


export class AdminSettingsController {
  _cycleImageModel() {
    const imagePresets = IMAGE_PROVIDER_OPTIONS.flatMap((providerOption) =>
      getImageModelOptions(providerOption.value).map((modelOption) => ({
        provider: providerOption.value,
        model: modelOption.value,
      }))
    );
    if (imagePresets.length === 0) return;
    try {
      const currentProvider = getConfiguredImageProviders()[0] || imagePresets[0].provider;
      const currentModel = getConfiguredImageModel(currentProvider) || imagePresets[0].model;
      const idx = imagePresets.findIndex((preset) => preset.provider === currentProvider && preset.model === currentModel);
      const next = imagePresets[(idx + 1 + imagePresets.length) % imagePresets.length];
      setSettingWithRuntimeSync("artifact_image_provider", next.provider, this.projectDir);
      setSettingWithRuntimeSync(`${next.provider}_image_model`, next.model, this.projectDir);
      this._invalidateSettingsCache();
    } catch { /* config not found */ }
    this.requestRender({ force: true });
  }

  _invalidateSettingsCache() {
    this._settingsCache = null;
    this._settingsCacheAt = 0;
  }

  _getArtifactSettingEntries() {
    const savedProvider = safeGetSetting("artifact_image_provider");
    const configuredProviders = getConfiguredImageProviders();
    const selectableProviders = getSelectableImageProviders();
    const providerValue = configuredProviders.join(",") || (selectableProviders[0]?.value || "openai");
    return [
      {
        setting_key: "artifact_image_provider",
        setting_value: providerValue,
        updated_at: null,
        description: `Provider for image artifacts; selectable: ${selectableProviders.map((option) => option.value).join(", ") || "none"}`,
        source: savedProvider ? "global" : "config",
        provider: providerValue,
      },
    ];
  }

  _getSkillSettingEntries() {
    let manifests = [];
    try {
      manifests = loadSkillManifests();
    } catch {
      manifests = [];
    }
    const disabled = new Set(parseSkillIds(safeGetSetting(SETTING_KEYS.SKILLS_DISABLED_IDS) || ""));
    return manifests.map((skill) => ({
      setting_key: `skill:${skill.id}`,
      storage_key: `${SKILL_SETTING_PREFIX}${skill.id}`,
      setting_value: disabled.has(skill.id) ? "false" : "true",
      updated_at: null,
      description: `${skill.name}: ${skill.when_to_use || skill.description || "planner-selectable skill"}`,
      label: skill.name,
      source: disabled.has(skill.id) ? "global" : "default",
      skill_id: skill.id,
    }));
  }

  _getProjectDbSettingEntries() {
    let cfg;
    try {
      cfg = readProjectDbConfig({ projectDir: this.projectDir });
    } catch {
      cfg = { enabled: false, dbType: null, host: null, port: null, database: null, username: null, hasPassword: false, permissions: [] };
    }
    const row = (key, value, description) => ({
      setting_key: key,
      storage_key: key,
      setting_value: value,
      updated_at: null,
      description,
      source: "project_db",
      projectDb: true,
    });
    return [
      row("project_db_enabled", cfg.enabled ? "true" : "false", "Enable the opt-in project_db_query agent tool for this repo."),
      row("project_db_type", cfg.dbType || "", "Project database engine: sqlite, postgres, or mysql."),
      {
        ...row("project_db_permissions", (cfg.permissions || []).join(","), "Granted SQL scopes: read (SELECT, inspection) and write (UPDATE, INSERT, DELETE, CREATE, ALTER); DROP/TRUNCATE never allowed. Read-phase roles only ever use the read scope."),
        // Shown in place of the description so a withheld legacy grant is
        // never hidden behind the standard explanation.
        warning: (cfg.suspendedLegacyGrants || []).length > 0
          ? `SUSPENDED: this repo granted ${cfg.suspendedLegacyGrants.join(", ")} under the old per-statement scheme, where write meant UPDATE only. Those grants are withheld until you save this setting again.`
          : null,
      },
      row("project_db_database", cfg.database || "", "sqlite: file path (relative to repo). postgres/mysql: database name."),
      row("project_db_host", cfg.host || "", "postgres/mysql host (ignored for sqlite)."),
      row("project_db_port", cfg.port != null ? String(cfg.port) : "", "postgres/mysql port (ignored for sqlite)."),
      row("project_db_username", cfg.username || "", "postgres/mysql username (ignored for sqlite)."),
      row("project_db_password", cfg.hasPassword ? "********" : "", "postgres/mysql password — stored in .posse/db; never displayed. Blank = unchanged."),
    ];
  }

  _getSettingsSnapshot({ maxAgeMs = 2000 } = {}) {
    const now = Date.now();
    if (this._settingsCache && now - this._settingsCacheAt <= maxAgeMs) {
      return this._settingsCache;
    }
    const storedSettings = safeListSettings(this.projectDir);
    const mergedSettings = [...storedSettings];
    const seenSettingKeys = new Set(storedSettings.map((entry) => entry.setting_key));
    for (const fallback of DEFAULT_ACCOUNT_SETTING_ROWS) {
      if (seenSettingKeys.has(fallback.setting_key)) continue;
      mergedSettings.push({
        setting_key: fallback.setting_key,
        setting_value: fallback.setting_value,
        updated_at: null,
        source: "default",
      });
    }
    const dbSettings = mergedSettings.filter((entry) =>
      isAdminVisibleCatalogKey(toStorageSettingKey(entry.setting_key)) &&
      !HIDDEN_SETTING_KEYS.has(entry.setting_key) &&
      !MODEL_SETTING_KEYS.has(entry.setting_key) &&
      !PROVIDER_USAGE_SETTING_KEYS.has(entry.setting_key) &&
      !PROVIDER_SETTING_KEYS.has(entry.setting_key) &&
      !ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS.has(entry.setting_key)
    ).map((entry) => toDisplaySettingEntry(withCatalogSource(entry)));

    // Group order first, then key name, so ungrouped keys sort to the end of
    // their pane.
    const groupOrder = new Map();
    let groupOrderCounter = 0;
    for (const group of SETTINGS_GROUPS) {
      for (const key of group.keys) groupOrder.set(key, groupOrderCounter++);
    }
    dbSettings.sort((a, b) => {
      const oa = groupOrder.has(a.setting_key) ? groupOrder.get(a.setting_key) : Number.MAX_SAFE_INTEGER;
      const ob = groupOrder.has(b.setting_key) ? groupOrder.get(b.setting_key) : Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return String(a.setting_key).localeCompare(String(b.setting_key));
    });
    const dbSettingsByPane = Object.fromEntries(SETTINGS_PANES.map((pane) => [pane.id, []]));
    for (const entry of dbSettings) {
      const pane = settingsPaneForKey(entry.setting_key);
      (dbSettingsByPane[pane] || dbSettingsByPane.debug).push(entry);
    }
    const snapshot = {
      dbSettings,
      dbSettingsByPane,
      dbSettingsByKey: new Map(dbSettings.map((entry) => [entry.setting_key, entry])),
      modelSettings: this._getModelSettingEntries(),
      artifactSettings: this._getArtifactSettingEntries(),
      providerSettings: this._getProviderSettingEntries(),
      skillSettings: this._getSkillSettingEntries(),
      projectDbSettings: this._getProjectDbSettingEntries(),
    };
    // One layout per pane drives both rendering and ↑/↓ selection, so the
    // editable order can never drift from the rows on screen.
    snapshot.paneSections = Object.fromEntries(
      SETTINGS_PANES.map((pane) => [pane.id, this._buildSettingsPaneSections(pane.id, snapshot)]),
    );
    snapshot.paneEditableSettings = Object.fromEntries(
      SETTINGS_PANES.map((pane) => [
        pane.id,
        snapshot.paneSections[pane.id].flatMap((section) => section.rows || []),
      ]),
    );
    snapshot.editableSettings = SETTINGS_PANES.flatMap((pane) => snapshot.paneEditableSettings[pane.id]);
    this._settingsCache = snapshot;
    this._settingsCacheAt = now;
    return this._settingsCache;
  }

  // Sections for one settings pane. Each section has a title, an optional
  // hint, editable `rows` (setting entries), and optional read-only `lines`
  // or a `note` shown when it has no rows.
  _buildSettingsPaneSections(paneId, snapshot) {
    const sections = [];
    const { dbSettingsByKey } = snapshot;
    const dbRows = (keys) => keys.map((key) => dbSettingsByKey.get(key)).filter(Boolean);
    const placed = new Set();
    const pushGroups = (skip = new Set()) => {
      for (const group of SETTINGS_GROUPS) {
        if (group.pane !== paneId) continue;
        const rows = dbRows(group.keys.filter((key) => !skip.has(key)));
        for (const row of rows) placed.add(row.setting_key);
        if (group.id === "skills") {
          rows.push(...snapshot.skillSettings);
          sections.push({
            id: group.id,
            title: group.label,
            hint: "new skills are allowed until disabled",
            rows,
            note: snapshot.skillSettings.length === 0 ? "No skills found in the remote prompt bundle." : null,
          });
          continue;
        }
        if (rows.length > 0) sections.push({ id: group.id, title: group.label, hint: group.hint || null, rows });
      }
      const other = (snapshot.dbSettingsByPane[paneId] || [])
        .filter((entry) => !placed.has(entry.setting_key) && !skip.has(entry.setting_key));
      if (other.length > 0) sections.push({ id: "other", title: "Other", hint: null, rows: other });
    };

    if (paneId === "general") {
      // Per-skill toggles are the readable form of the disabled-skill list.
      pushGroups(new Set([SETTING_KEYS.SKILLS_DISABLED_IDS]));
    } else if (paneId === "agents") {
      const providerByRole = new Map(snapshot.providerSettings.map((entry) => [entry.role, entry]));
      for (const section of AGENT_SETTING_SECTIONS) {
        const rows = [];
        const providerRow = providerByRole.get(section.role);
        if (providerRow) rows.push(providerRow);
        rows.push(...dbRows(section.keys));
        if (rows.length > 0) sections.push({ id: `agent_${section.role}`, title: section.label, hint: section.hint || null, rows });
      }
    } else if (paneId === "providers") {
      const textModels = snapshot.modelSettings.filter((entry) => (entry.kind || "text") === "text");
      const imageModels = snapshot.modelSettings.filter((entry) => entry.kind === "image");
      for (const section of PROVIDER_SETTING_SECTIONS) {
        const rows = [
          ...textModels.filter((entry) => entry.provider === section.provider),
          ...dbRows(section.settingKeys),
        ];
        if (rows.length > 0) sections.push({ id: `provider_${section.provider}`, title: section.label, hint: null, rows });
      }
      const imageRows = [
        ...snapshot.artifactSettings,
        ...IMAGE_SETTING_SECTIONS.flatMap((section) => [
          ...imageModels.filter((entry) => entry.provider === section.provider),
          ...dbRows(section.settingKeys),
        ]),
      ];
      if (imageRows.length > 0) sections.push({ id: "images", title: "Image Generation", hint: null, rows: imageRows });
      const catalogRows = dbRows(PROVIDER_CATALOG_SETTING_KEYS);
      if (catalogRows.length > 0) sections.push({ id: "provider_catalog", title: "Model Catalog", hint: null, rows: catalogRows });
      // Secrets stay env-only; show which ones are present without ever
      // rendering any part of the value.
      sections.push({
        id: "credentials",
        title: "Credentials",
        hint: "set in your environment; values are never shown",
        rows: [],
        lines: ADMIN_CREDENTIAL_SETTING_DEFS.map((definition) => (
          process.env[definition.env]
            ? `  ${C.green}✓${C.reset} ${C.bold}${definition.env.padEnd(26)}${C.reset} ${C.green}configured${C.reset}  ${C.dim}${definition.description}${C.reset}`
            : `  ${C.dim}· ${definition.env.padEnd(26)} not set     ${definition.description}${C.reset}`
        )),
      });
    } else if (paneId === "repo") {
      pushGroups();
      sections.push({
        id: "project_database",
        title: "Project Database",
        hint: "opt-in agent SQL access; stored in this repo's .posse/db",
        rows: snapshot.projectDbSettings,
      });
      const dbPath = getRuntimeDbPath(this.projectDir);
      sections.push({
        id: "paths",
        title: "Paths",
        hint: null,
        rows: [],
        lines: [
          `  ${C.dim}Project:${C.reset}  ${this.projectDir}`,
          `  ${C.dim}Database:${C.reset} ${dbPath}`,
          `  ${C.dim}Reports:${C.reset}  ${path.resolve(path.dirname(dbPath), "reports")}`,
        ],
      });
    } else {
      pushGroups();
    }
    return sections;
  }

  _getModelSettingEntries() {
    const selectableProviders = new Set(this._getSelectableProviders());
    return MODEL_SETTING_DEFS
      .filter((def) => def.kind === "image" || selectableProviders.has(def.provider))
      .map((def) => {
        const resolved = def.kind === "image"
          ? getEffectiveImageModelSetting(def)
          : getEffectiveModelSetting(def);
        return {
          setting_key: def.key,
          setting_value: resolved.storedValue,
          updated_at: null,
          description: def.description,
          label: def.label,
          provider: def.provider,
          source: resolved.source,
          effective_model: resolved.effectiveModel,
          tier: def.tier,
          kind: def.kind || "text",
        };
      });
  }

  _getSelectableProviders() {
    return PROVIDER_OPTIONS.filter((provider) => isAdminProviderOption(provider));
  }

  _normalizeProviderList(value) {
    const allowed = new Set(this._getSelectableProviders());
    const picked = String(value || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((provider, index, arr) => arr.indexOf(provider) === index)
      .filter((provider) => allowed.has(provider));
    return picked.length > 0 ? picked.join(",") : "claude";
  }

  _getProviderSettingEntries() {
    const selectable = this._getSelectableProviders();
    return PROVIDER_ROLE_NAMES.filter((role) => isAdminVisibleCatalogKey(`provider_${role}`)).map((role) => {
      const storedVal = safeGetSetting(`provider_${role}`);
      const effective = storedVal || "claude";
      const source = storedVal ? "global" : "default";
      return {
        setting_key: `provider_${role}`,
        setting_value: effective,
        updated_at: null,
        description: `Comma-separated providers for ${role}; selectable: ${selectable.join(", ")}`,
        label: getAdminSettingPresentation(`provider_${role}`).label,
        source,
        db_value: storedVal || "",
        role,
      };
    });
  }

  _getEditableSettings() {
    const snapshot = this._getSettingsSnapshot();
    const paneList = snapshot.paneEditableSettings?.[this._settingsPane];
    return paneList || snapshot.editableSettings;
  }

  _cycleSettingsPane(direction) {
    const paneIds = SETTINGS_PANES.map((pane) => pane.id);
    const currentIndex = paneIds.indexOf(this._settingsPane || ADMIN_DEFAULT_SETTINGS_PANE);
    const nextIndex = ((currentIndex >= 0 ? currentIndex : 0) + direction + paneIds.length) % paneIds.length;
    this._settingsPane = paneIds[nextIndex];
    this._settingsIndex = 0;
    this._scroll = 0;
    this._tabScrolls[this._tab] = 0;
  }

  _getSelectedEditableSetting() {
    const settings = this._getEditableSettings();
    if (settings.length === 0) return null;
    const idx = Math.max(0, Math.min(this._settingsIndex, settings.length - 1));
    this._settingsIndex = idx;
    return settings[idx];
  }

  _moveSettingsSelection(delta) {
    const settings = this._getEditableSettings();
    if (settings.length === 0) return;
    this._settingsIndex = Math.max(0, Math.min(this._settingsIndex + delta, settings.length - 1));
    const selected = settings[this._settingsIndex];
    const row = this._settingsRowMap.get(selected?.setting_key);
    if (typeof row === "number") {
      const visibleRows = Math.max(this.rows - 6, 5);
      if (row < this._scroll) this._scroll = row;
      else if (row >= this._scroll + visibleRows) this._scroll = Math.max(0, row - visibleRows + 1);
      this._tabScrolls[this._tab] = this._scroll;
    }
  }

  /**
   * Jump the settings selection to the start of the next (direction > 0) or
   * previous (direction < 0) section. Sections are the row indices recorded
   * during _buildSettings into this._settingsSectionRows.
   */
  _jumpSettingsSection(direction) {
    const sectionRows = Array.isArray(this._settingsSectionRows) ? this._settingsSectionRows : [];
    if (sectionRows.length === 0) return;
    const settings = this._getEditableSettings();
    if (settings.length === 0) return;
    const current = settings[this._settingsIndex];
    const currentRow = current ? this._settingsRowMap.get(current.setting_key) : null;
    const referenceRow = typeof currentRow === "number" ? currentRow : -1;
    let targetSectionRow;
    if (direction > 0) {
      targetSectionRow = sectionRows.find((r) => r > referenceRow);
    } else {
      targetSectionRow = [...sectionRows].reverse().find((r) => r < referenceRow);
    }
    if (targetSectionRow == null) return;
    // Find the first editable setting whose row is greater than the section header.
    let bestIdx = -1;
    let bestRow = Infinity;
    for (let i = 0; i < settings.length; i++) {
      const row = this._settingsRowMap.get(settings[i].setting_key);
      if (typeof row !== "number") continue;
      if (row > targetSectionRow && row < bestRow) {
        bestRow = row;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return;
    this._settingsIndex = bestIdx;
    // Scroll so the section header itself stays in view as context.
    this._scroll = Math.max(0, targetSectionRow - 1);
    this._tabScrolls[this._tab] = this._scroll;
  }

  _startEdit(initialValue = null) {
    const selected = this._getSelectedEditableSetting();
    if (!selected) return;
    this._editError = "";
    this._editLabel = getAdminSettingPresentation(selected.setting_key, selected).label;
    const storageKey = selected.storage_key || toStorageSettingKey(selected.setting_key);
    if (PROJECT_DB_SETTING_KEYS.has(storageKey)) {
      this._startProjectDbEdit(selected, storageKey, initialValue);
      return;
    }
    if (storageKey.startsWith("provider_") || ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS.has(storageKey)) {
      const allowed = storageKey.startsWith("provider_")
        ? this._getSelectableProviders()
        : getSelectableImageProviders().map((option) => option.value);
      const enabled = new Set(parseProviderList(selected.setting_value));
      this._editing = "editProviders";
      this._editKey = selected.setting_key;
      this._editStorageKey = storageKey;
      this._editProviderChoices = allowed.map((provider) => ({
        provider,
        label: PROVIDER_LABELS[provider] || provider,
        enabled: enabled.has(provider),
      }));
      this._editProviderIndex = 0;
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    if (MODEL_SETTING_KEYS.has(storageKey)) {
      const choices = getModelChoicesForEntry(selected);
      const currentValue = selected.setting_value || "";
      this._editing = "editModel";
      this._editKey = selected.setting_key;
      this._editStorageKey = storageKey;
      this._editModelChoices = choices;
      const requestedValue = initialValue == null ? currentValue : String(initialValue);
      const pickedIndex = choices.findIndex((choice) => choice.value === requestedValue);
      this._editModelIndex = pickedIndex >= 0 ? pickedIndex : 0;
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    if (MULTI_SETTING_KEYS.has(storageKey)) {
      const allowed = MULTI_SETTING_VALUES[storageKey] || new Set();
      const options = MULTI_SETTING_OPTIONS[storageKey] || [];
      const currentValue = initialValue == null ? (selected.setting_value || "") : String(initialValue);
      const enabled = new Set(
        currentValue
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => allowed.has(entry))
      );
      this._editing = "editPhases";
      this._editKey = selected.setting_key;
      this._editStorageKey = storageKey;
      this._editPhaseChoices = options.map((option) => ({
        value: option.value,
        label: option.label,
        enabled: enabled.has(option.value),
      }));
      this._editPhaseIndex = 0;
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    const enumChoices = ENUM_SETTING_OPTIONS[storageKey];
    if (enumChoices && enumChoices.length > 0) {
      const currentValue = String(selected.setting_value || "").trim().toLowerCase();
      this._editing = "editModel";
      this._editKey = selected.setting_key;
      this._editStorageKey = storageKey;
      this._editModelChoices = enumChoices.map((choice) => ({ value: choice.value, label: choice.label }));
      // Blank-default enums (e.g. "use the researcher's provider") need an
      // explicit choice for the default, which the option list cannot carry.
      if (String(getCatalogEntry(storageKey)?.default ?? "") === "") {
        this._editModelChoices.unshift({ value: "", label: `default (${adminUnsetValueLabel(storageKey) || "not set"})` });
      }
      const requestedValue = initialValue == null ? currentValue : String(initialValue).trim().toLowerCase();
      const pickedIndex = this._editModelChoices.findIndex((choice) => choice.value === requestedValue);
      this._editModelIndex = pickedIndex >= 0 ? pickedIndex : 0;
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    const currentValue = selected.setting_value || "";
    if (BOOLEAN_SETTING_KEYS.has(storageKey) || isBooleanSettingValue(currentValue)) {
      this._editing = "editBoolean";
      this._editKey = selected.setting_key;
      this._editStorageKey = storageKey;
      this._editBooleanChoices = ["true", "false"];
      const requestedValue = initialValue == null ? currentValue : String(initialValue).toLowerCase();
      const pickedIndex = this._editBooleanChoices.indexOf(requestedValue);
      this._editBooleanIndex = pickedIndex >= 0 ? pickedIndex : (currentValue === "true" ? 0 : 1);
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    this._editing = "editValue";
    this._editKey = selected.setting_key;
    this._editStorageKey = storageKey;
    this._editBuf = initialValue == null ? currentValue : initialValue;
    this._editCursor = this._editBuf.length;
    process.stdout.write("\x1b[?25h"); // show cursor
    this.requestRender({ force: true });
  }

  _startProjectDbEdit(selected, storageKey, initialValue = null) {
    const currentValue = selected.setting_value || "";
    this._editKey = selected.setting_key;
    this._editStorageKey = storageKey;
    if (storageKey === "project_db_enabled") {
      this._editing = "editBoolean";
      this._editBooleanChoices = ["true", "false"];
      this._editBooleanIndex = currentValue === "true" ? 0 : 1;
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    if (storageKey === "project_db_type") {
      this._editing = "editModel";
      this._editModelChoices = PROJECT_DB_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
      const idx = this._editModelChoices.findIndex((c) => c.value === currentValue);
      this._editModelIndex = idx >= 0 ? idx : 0;
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    if (storageKey === "project_db_permissions") {
      const enabled = new Set(currentValue.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
      this._editing = "editPhases";
      this._editPhaseChoices = PROJECT_DB_PERMISSION_OPTIONS.map((o) => ({ value: o.value, label: o.label, enabled: enabled.has(o.value) }));
      this._editPhaseIndex = 0;
      process.stdout.write("\x1b[?25l");
      this.requestRender({ force: true });
      return;
    }
    // Free-text fields. The password starts empty (so a blank save means
    // "leave unchanged") and is masked while typing.
    this._editing = "editValue";
    this._editBuf = storageKey === "project_db_password"
      ? ""
      : (initialValue == null ? currentValue : String(initialValue));
    this._editCursor = this._editBuf.length;
    process.stdout.write("\x1b[?25h");
    this.requestRender({ force: true });
  }

  _saveProjectDbSetting(storageKey, value) {
    const patch = {};
    switch (storageKey) {
      case "project_db_enabled": patch.enabled = String(value).toLowerCase() === "true"; break;
      case "project_db_type": patch.dbType = value || null; break;
      case "project_db_permissions": patch.permissions = value; break;
      case "project_db_database": patch.database = value || null; break;
      case "project_db_host": patch.host = value || null; break;
      case "project_db_port": patch.port = value === "" ? null : Number(value); break;
      case "project_db_username": patch.username = value || null; break;
      case "project_db_password":
        if (String(value) === "") return; // blank = leave the stored password unchanged
        patch.password = value;
        break;
      default: throw new Error(`Unknown project DB setting: ${storageKey}`);
    }
    writeProjectDbConfig(patch, { projectDir: this.projectDir });
  }

  _resetEditState() {
    const hadEditing = !!this._editing;
    this._editing = false;
    this._editBuf = "";
    this._editKey = "";
    this._editLabel = "";
    this._editStorageKey = "";
    this._editProviderChoices = [];
    this._editProviderIndex = 0;
    this._editPhaseChoices = [];
    this._editPhaseIndex = 0;
    this._editModelChoices = [];
    this._editModelIndex = 0;
    this._editBooleanChoices = [];
    this._editBooleanIndex = 0;
    this._editError = "";
    if (hadEditing) process.stdout.write("\x1b[?25l");
  }

  _saveSettingValue(storageKey, value, { providerUsage = false } = {}) {
    try {
      if (PROJECT_DB_SETTING_KEYS.has(storageKey)) {
        this._saveProjectDbSetting(storageKey, value);
        this._settingsSavedFlash = { text: `Saved ${getAdminSettingPresentation(storageKey).label}`, at: Date.now() };
        return true;
      }
      if (storageKey.startsWith(SKILL_SETTING_PREFIX)) {
        setSkillEnabled(storageKey.slice(SKILL_SETTING_PREFIX.length), String(value).trim().toLowerCase() === "true");
      } else if (providerUsage) {
        setProviderUsageStoredValue(storageKey, value);
      } else {
        setSettingWithRuntimeSync(storageKey, value, this.projectDir);
        if (storageKey === SETTING_KEYS.ATLAS_SCIP_LANGUAGES) {
          this._installScipLanguageDependencies(value);
        }
      }
      // Transient nav-bar confirmation: saves are otherwise only visible as
      // the value changing in the list, which is easy to miss.
      this._settingsSavedFlash = {
        text: `Saved ${this._editLabel || getAdminSettingPresentation(toDisplaySettingKey(storageKey)).label}`,
        at: Date.now(),
      };
      return true;
    } catch (err) {
      this._editError = `Save failed: ${err?.message || err}`;
      this.requestRender({ force: true });
      return false;
    }
  }

  _installScipLanguageDependencies(value) {
    if (typeof this._runScipLanguageDependencyInstallAsync === "function") {
      this._runScipLanguageDependencyInstallAsync(value);
      return;
    }
    console.log(`SCIP deps: checking ${String(value || "").trim() || "configured languages"}`);
    installScipLanguageDependencies({
      languages: value,
      onProgress: (message) => console.log(`SCIP deps: ${message}`),
    }).then((result) => {
      for (const entry of result.results) {
        const prefix = entry.ok ? "ok" : "warn";
        console.log(`SCIP deps ${prefix}: ${entry.language}: ${entry.message}`);
      }
      if (!result.ok) {
        console.error("SCIP deps: selected languages were saved, but one or more installers did not complete; see the language messages above");
      }
    }).catch((err) => {
      console.error(`SCIP deps: installer failed: ${err?.message || err}`);
    });
  }

  _onEditKeypress(str, key) {
    if (key && key.name === "escape") {
      this._resetEditState();
      this.requestRender({ force: true });
      return;
    }

    if (this._editing === "editProviders") {
      const maxIndex = Math.max(this._editProviderChoices.length - 1, 0);
      if (isEnterKey(str, key)) {
        const picked = this._editProviderChoices
          .filter((choice) => choice.enabled)
          .map((choice) => choice.provider);
        const isImageRoute = ARTIFACT_IMAGE_PROVIDER_SETTING_KEYS.has(this._editStorageKey || toStorageSettingKey(this._editKey));
        const fallback = isImageRoute
          ? (this._editProviderChoices[0]?.provider || "openai")
          : (this._editProviderChoices.some((choice) => choice.provider === "claude") ? "claude" : this._editProviderChoices[0]?.provider || "claude");
        const savedValue = picked.length > 0 ? picked.join(",") : fallback;
        if (!this._saveSettingValue(this._editStorageKey || toStorageSettingKey(this._editKey), savedValue)) return;
        this._invalidateSettingsCache();
        this._resetEditState();
      } else if (key?.name === "left" || key?.name === "up") {
        this._editProviderIndex = Math.max(0, this._editProviderIndex - 1);
      } else if (key?.name === "right" || key?.name === "down") {
        this._editProviderIndex = Math.min(maxIndex, this._editProviderIndex + 1);
      } else {
        const printable = getPrintableInput(str, key).toLowerCase();
        if (printable >= "1" && printable <= "9") {
          const idx = parseInt(printable, 10) - 1;
          if (idx <= maxIndex) this._editProviderIndex = idx;
        } else if (printable) {
          const hotkeyIndex = this._editProviderChoices.findIndex((choice) => choice.provider[0] === printable);
          if (hotkeyIndex >= 0) this._editProviderIndex = hotkeyIndex;
        }
        if (key?.name === "space" || printable === " ") {
          const choice = this._editProviderChoices[this._editProviderIndex];
          if (choice) choice.enabled = !choice.enabled;
        } else if (["c", "a", "o", "g", "x"].includes(printable)) {
          const aliases = { c: "claude", a: "anthropic", o: "openai", g: "grok", x: "codex" };
          const target = aliases[printable];
          const choice = this._editProviderChoices.find((entry) => entry.provider === target);
          if (choice) choice.enabled = !choice.enabled;
        }
      }
    } else if (this._editing === "editPhases") {
      const maxIndex = Math.max(this._editPhaseChoices.length - 1, 0);
      if (isEnterKey(str, key)) {
        const picked = this._editPhaseChoices
          .filter((choice) => choice.enabled)
          .map((choice) => choice.value);
        const savedValue = picked.join(",");
        const storageKey = this._editStorageKey || toStorageSettingKey(this._editKey);
        const validated = validateAdminSettingValue(storageKey, savedValue);
        if (!validated.ok) {
          this._editError = validated.error;
          this.requestRender({ force: true });
          return;
        }
        if (!this._saveSettingValue(storageKey, validated.value)) return;
        this._invalidateSettingsCache();
        this._resetEditState();
      } else if (key?.name === "left" || key?.name === "up") {
        this._editPhaseIndex = Math.max(0, this._editPhaseIndex - 1);
      } else if (key?.name === "right" || key?.name === "down") {
        this._editPhaseIndex = Math.min(maxIndex, this._editPhaseIndex + 1);
      } else {
        const printable = getPrintableInput(str, key).toLowerCase();
        if (printable >= "1" && printable <= "9") {
          const idx = parseInt(printable, 10) - 1;
          if (idx <= maxIndex) this._editPhaseIndex = idx;
        }
        if (key?.name === "space" || printable === " ") {
          const choice = this._editPhaseChoices[this._editPhaseIndex];
          if (choice) choice.enabled = !choice.enabled;
        }
      }
    } else if (this._editing === "editModel") {
      const maxIndex = Math.max(this._editModelChoices.length - 1, 0);
      if (isEnterKey(str, key)) {
        const value = this._editModelChoices[this._editModelIndex]?.value || "";
        const storageKey = this._editStorageKey || toStorageSettingKey(this._editKey);
        if (!this._saveSettingValue(storageKey, value)) return;
        this._invalidateSettingsCache();
        this._resetEditState();
      } else if (key?.name === "left" || key?.name === "up") {
        this._editModelIndex = Math.max(0, this._editModelIndex - 1);
      } else if (key?.name === "right" || key?.name === "down") {
        this._editModelIndex = Math.min(maxIndex, this._editModelIndex + 1);
      } else {
        const printable = getPrintableInput(str, key).toLowerCase();
        if (printable >= "1" && printable <= "9") {
          const idx = parseInt(printable, 10) - 1;
          if (idx <= maxIndex) this._editModelIndex = idx;
        }
      }
    } else if (this._editing === "editBoolean") {
      const maxIndex = Math.max(this._editBooleanChoices.length - 1, 0);
      if (isEnterKey(str, key)) {
        const value = this._editBooleanChoices[this._editBooleanIndex] || "false";
        if (!this._saveSettingValue(this._editStorageKey || toStorageSettingKey(this._editKey), value)) return;
        this._invalidateSettingsCache();
        this._resetEditState();
      } else if (key?.name === "left" || key?.name === "up") {
        this._editBooleanIndex = Math.max(0, this._editBooleanIndex - 1);
      } else if (key?.name === "right" || key?.name === "down") {
        this._editBooleanIndex = Math.min(maxIndex, this._editBooleanIndex + 1);
      } else {
        const printable = getPrintableInput(str, key).toLowerCase();
        if (printable === " " || printable === "t") {
          this._editBooleanIndex = 0;
        } else if (printable === "f") {
          this._editBooleanIndex = 1;
        }
      }
    } else if (this._editing === "editValue") {
      if (isEnterKey(str, key)) {
        const rawValue = this._editKey.startsWith("provider_")
          ? this._normalizeProviderList(this._editBuf)
          : this._editBuf;
        const storageKey = this._editStorageKey || toStorageSettingKey(this._editKey);
        const validated = validateAdminSettingValue(storageKey, rawValue);
        if (!validated.ok) {
          this._editError = validated.error;
          this.requestRender({ force: true });
          return;
        }
        const value = validated.value;
        if (PROVIDER_USAGE_SETTING_KEYS.has(storageKey)) {
          if (!this._saveSettingValue(storageKey, value, { providerUsage: true })) return;
        } else if (!this._saveSettingValue(storageKey, value)) {
          return;
        }
        const parsedUsageKey = parseProviderUsageSettingKey(storageKey);
        if (parsedUsageKey?.kind === "observed_pct") {
          const calibration = inferProviderWindowLimit(parsedUsageKey.provider, parsedUsageKey.windowKey, value);
          const limitKey = correspondingLimitSettingKey(storageKey);
          if (limitKey && calibration?.limitTokens != null) {
            if (!this._saveSettingValue(limitKey, String(calibration.limitTokens), { providerUsage: true })) return;
          }
        }
        this._invalidateSettingsCache();
        this._resetEditState();
      } else if (isBackspaceKey(str, key)) {
        this._editError = "";
        this._editBuf = this._editBuf.slice(0, -1);
      } else if (!key?.ctrl) {
        const printable = getPrintableInput(str, key);
        if (printable) {
          this._editError = "";
          this._editBuf += printable;
        }
      }
    }

    this.requestRender({ force: true });
  }

  _buildEditValueNavLines(fullW) {
    const instructions = `${C.dim}[Enter] Save  [Esc] Cancel${C.reset}`;
    const editLabel = this._editLabel || getAdminSettingPresentation(this._editKey).label;
    const prefixText = ` Editing ${editLabel}: `;
    const available = Math.max(8, fullW - stripAnsi(prefixText).length - stripAnsi(instructions).length - 2);
    const editBuf = this._editStorageKey === "project_db_password"
      ? "*".repeat(this._editBuf.length)
      : this._editBuf;
    const visibleValue = clipPlainTail(editBuf, available);
    const clipped = visibleValue.startsWith("\u2026");
    const lines = [
      ` ${C.yellow}Editing ${editLabel}:${C.reset} ${C.bold}${visibleValue}${C.reset}  ${instructions}`,
    ];
    if (clipped) {
      lines.push(` ${C.dim}Input clipped on the left so your latest typing stays visible.${C.reset}`);
    }
    const unset = this._editStorageKey === "project_db_password" ? null : adminUnsetValueLabel(this._editStorageKey || this._editKey);
    if (unset) {
      lines.push(` ${C.dim}Leave blank to use the default: ${unset}${C.reset}`);
    }
    if (this._editError) {
      lines.push(` ${C.red}${this._editError}${C.reset}`);
    }
    return lines;
  }

  _getEditValueCursorPosition(fullW, navStartRow) {
    const instructions = `${C.dim}[Enter] Save  [Esc] Cancel${C.reset}`;
    const editLabel = this._editLabel || getAdminSettingPresentation(this._editKey).label;
    const prefixText = ` Editing ${editLabel}: `;
    const available = Math.max(8, fullW - stripAnsi(prefixText).length - stripAnsi(instructions).length - 2);
    const editBuf = this._editStorageKey === "project_db_password"
      ? "*".repeat(this._editBuf.length)
      : this._editBuf;
    const visibleValue = clipPlainTail(editBuf, available);
    const cursorCol = 2 + visibleLength(prefixText) + visibleLength(visibleValue);
    return { row: navStartRow, col: cursorCol };
  }

  _buildEditBooleanNavLines() {
    const editLabel = this._editLabel || getAdminSettingPresentation(this._editKey).label;
    const toggles = this._editBooleanChoices.map((choice, index) => {
      const selected = index === this._editBooleanIndex;
      const marker = selected ? `${C.green}[x]${C.reset}` : `${C.dim}[ ]${C.reset}`;
      const label = selected ? `${C.yellow}>${choice}<${C.reset}` : choice;
      return `${marker} ${label}`;
    }).join(` ${C.dim}|${C.reset} `);
    return [
      ` ${C.yellow}Editing ${editLabel}:${C.reset} ${toggles}`,
      ` ${C.dim}[←→/↑↓] Choose  [t/f] Jump  [Enter] Save  [Esc] Cancel${C.reset}`,
    ];
  }

  _buildEditModelNavLines() {
    const editLabel = this._editLabel || getAdminSettingPresentation(this._editKey).label;
    const lines = [` ${C.yellow}Editing ${editLabel}:${C.reset}`];
    const choices = Array.isArray(this._editModelChoices) ? this._editModelChoices : [];
    const selectedIndex = Math.max(0, Math.min(this._editModelIndex || 0, choices.length - 1));
    // Keep enough of the settings body visible for context while bounding the
    // picker footer to the terminal. An unbounded model/enum catalog pushes
    // its first numbered choices above the screen as soon as it grows.
    const terminalRows = Number.isFinite(Number(this.rows)) ? Math.max(12, Math.floor(Number(this.rows))) : 40;
    const visibleChoiceCount = Math.max(2, Math.min(choices.length, terminalRows - 10));
    const start = Math.max(
      0,
      Math.min(
        Math.max(0, choices.length - visibleChoiceCount),
        selectedIndex - Math.floor(visibleChoiceCount / 2),
      ),
    );
    const end = Math.min(choices.length, start + visibleChoiceCount);
    for (let index = start; index < end; index++) {
      const choice = this._editModelChoices[index];
      const selected = index === this._editModelIndex;
      const marker = selected ? `${C.green}[x]${C.reset}` : `${C.dim}[ ]${C.reset}`;
      const choiceLabel = String(choice?.label || choice?.value || `(option ${index + 1})`);
      const label = selected ? `${C.yellow}${choiceLabel}${C.reset}` : choiceLabel;
      const prefix = selected ? `${C.yellow}>${C.reset}` : " ";
      lines.push(` ${prefix} ${marker} ${index + 1}: ${label}`);
    }
    const range = choices.length > visibleChoiceCount
      ? `  Showing ${start + 1}–${end} of ${choices.length}`
      : "";
    lines.push(` ${C.dim}[←→/↑↓] Choose  [1-9] Jump  [Enter] Save  [Esc] Cancel${range}${C.reset}`);
    return lines;
  }

  _buildSettings(width) {
    const lines = [];
    const inner = width - 2;
    const paneIds = SETTINGS_PANES.map((pane) => pane.id);
    const settingsPane = paneIds.includes(this._settingsPane) ? this._settingsPane : "all";
    this._settingsRowMap = new Map();
    // Row indices of section headers, used by PgUp/PgDn to step between groups.
    this._settingsSectionRows = [];
    const ruleWidth = Math.max(40, Math.min(inner, 76));

    lines.push("");
    lines.push(brandRule({ label: "settings", color: C.cyan, width: ruleWidth }));
    if (settingsPane !== "all") {
      const paneBar = SETTINGS_PANES.map((pane) => (
        pane.id === settingsPane
          ? `${C.bold}${C.cyan}[${pane.label}]${C.reset}`
          : `${C.dim}${pane.label}${C.reset}`
      )).join(` ${C.dim}|${C.reset} `);
      lines.push(` ${paneBar}  ${C.dim}←/→ switch pane${C.reset}`);
    }
    lines.push(` ${C.magenta}default${C.reset} ${C.dim}·${C.reset} ${C.cyan}changed${C.reset} ${C.dim}· select a row to read its full description below${C.reset}`);

    const settingsSnapshot = this._getSettingsSnapshot();
    const editableSettings = this._getEditableSettings();
    if (editableSettings.length > 0) {
      this._settingsIndex = Math.max(0, Math.min(this._settingsIndex, editableSettings.length - 1));
    }
    const selectedSetting = editableSettings[this._settingsIndex] || null;
    const selectedKey = this._editing ? this._editKey : selectedSetting?.setting_key;
    // Size the label column from every pane (not just this one) so columns
    // stay put while switching panes; clamp so explanations keep most of the
    // row width.
    const longestKeyLen = (settingsSnapshot.editableSettings || []).reduce(
      (max, s) => Math.max(max, getAdminSettingPresentation(s.setting_key, s).label.length),
      0,
    );
    const keyWidth = clampSettingsKeyColumnWidth(longestKeyLen);
    const valueWidth = getSettingsValueColumnWidth(inner, keyWidth);
    //   2 leading + 2 (#) + 1 + keyWidth + 1 + valueWidth + 1 + descWidth = inner
    const descWidth = Math.max(20, inner - (2 + 2 + 1 + keyWidth + 1 + valueWidth + 1));
    const padKey = (k) => {
      const text = String(k || "");
      if (text.length <= keyWidth) return text.padEnd(keyWidth);
      return `${text.slice(0, keyWidth - 1)}…`;
    };
    let rowIndex = 1;

    const settingValueText = (entry) => {
      if (PROVIDER_SETTING_KEYS.has(entry.storage_key || entry.setting_key)) return formatProviderSettingValue(entry);
      if (MODEL_SETTING_KEYS.has(entry.setting_key)) return formatModelSettingDisplayValue(entry);
      return entry.setting_value;
    };
    const pushRow = (entry) => {
      const settingKey = entry.setting_key;
      const presentation = getAdminSettingPresentation(settingKey, entry);
      const paddedKey = padKey(presentation.label);
      const keyStr = selectedKey === settingKey ? `${C.yellow}${paddedKey}${C.reset}` : paddedKey;
      const value = adminSettingValuePresentation(settingValueText(entry), entry.source, {
        settingKey: entry.storage_key || settingKey,
      });
      this._settingsRowMap.set(settingKey, lines.length);
      const description = entry.warning
        ? `${C.yellow}${entry.warning}${C.reset}`
        : `${C.dim}${presentation.description}${C.reset}`;
      lines.push(
        `  ${String(rowIndex).padStart(2)} ${keyStr} ${fit(`${value.color}${value.text}${C.reset}`, valueWidth)} ${fit(description, descWidth)}`,
      );
      rowIndex += 1;
    };
    const renderSections = (paneId) => {
      if (paneId === "repo") {
        lines.push(`  ${C.dim}Saved only for this repository:${C.reset} ${C.bold}${this.projectDir}${C.reset}`);
      }
      for (const section of settingsSnapshot.paneSections?.[paneId] || []) {
        lines.push("");
        this._settingsSectionRows.push(lines.length);
        const rule = brandRule({ label: String(section.title).toLowerCase(), color: C.cyan, width: ruleWidth });
        lines.push(section.hint ? `${rule}  ${C.dim}${section.hint}${C.reset}` : rule);
        for (const entry of section.rows || []) pushRow(entry);
        for (const line of section.lines || []) lines.push(line);
        if (section.note) lines.push(`  ${C.dim}${section.note}${C.reset}`);
      }
    };

    lines.push("");
    lines.push(`${C.dim}  ${"#".padStart(2)} ${"Setting".padEnd(keyWidth)} ${"Value".padEnd(valueWidth)} Explanation${C.reset}`);
    if (settingsPane === "all") {
      // Non-interactive snapshots and tests render every pane in the same
      // order the combined editable list concatenates them.
      for (const pane of SETTINGS_PANES) {
        lines.push("");
        lines.push(` ${C.bold}${C.cyan}${pane.label.toUpperCase()}${C.reset}`);
        renderSections(pane.id);
      }
    } else {
      renderSections(settingsPane);
    }
    lines.push("");
    return lines;
  }

  // Footer for the Settings tab: key help, then the highlighted setting's
  // full description (the table truncates it), its ID, default, and scope.
  _buildSettingsFooterLines(fullW, navLabel) {
    const lines = [
      ` ${C.dim}[←→] Pane  [↑↓] Select  [PgUp/PgDn] Section  [Enter] Edit  [${navLabel}] Tab  [Esc] Exit${C.reset}`,
    ];
    const selected = this._getSelectedEditableSetting();
    if (selected) {
      const presentation = getAdminSettingPresentation(selected.setting_key, selected);
      const width = Math.max(20, fullW - 2);
      const words = `${presentation.label}: ${presentation.description}`.split(/\s+/);
      const wrapped = [];
      let current = "";
      for (const word of words) {
        if (current && (current.length + 1 + word.length) > width) {
          wrapped.push(current);
          current = word;
        } else {
          current = current ? `${current} ${word}` : word;
        }
      }
      if (current) wrapped.push(current);
      const shown = wrapped.slice(0, 3);
      if (wrapped.length > 3) shown[2] = `${shown[2].slice(0, Math.max(0, width - 1))}…`;
      shown.forEach((line, index) => {
        lines.push(index === 0
          ? ` ${C.bold}${line.slice(0, presentation.label.length + 1)}${C.reset}${line.slice(presentation.label.length + 1)}`
          : ` ${line}`);
      });
      const storageKey = selected.storage_key || toStorageSettingKey(selected.setting_key);
      const catalogEntry = getCatalogEntry(storageKey);
      const details = [];
      if (catalogEntry) {
        details.push(`ID: ${storageKey}`);
        const defaultText = formatAdminSettingValue(storageKey, catalogEntry.default);
        details.push(`default: ${defaultText}`);
        details.push(REPO_SCOPED_DISPLAY_KEYS.has(storageKey) ? "saved for this repository" : "applies to every repository");
      } else if (selected.projectDb) {
        details.push("saved for this repository");
      }
      if (details.length > 0) lines.push(` ${C.dim}${details.join("  ·  ")}${C.reset}`);
      if (selected.warning) lines.push(` ${C.yellow}${selected.warning}${C.reset}`);
    }
    if (this._settingsSavedFlash && (Date.now() - (this._settingsSavedFlash.at || 0)) < 3_000) {
      lines.push(` ${C.green}✓ ${this._settingsSavedFlash.text}${C.reset}`);
    }
    return lines;
  }

}
