// lib/shared/skills/functions/registry.js
//
// Deterministic skill manifest registry. Production skill pieces come from the
// in-memory remote prompt bundle; explicit skillsDir overrides remain for tests.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { slugify } from "../../format/functions/slug.js";
import { getSetting, setSetting } from "../../../domains/queue/functions/index.js";
import {
  getActivePromptBundle,
  getPromptBundleSkillManifests,
} from "../../../domains/remote/functions/prompt-bundle.js";

export const DEFAULT_SKILLS_DIR = null;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_SKILLS_DIR = path.resolve(__dirname, "..", "..", "..", "..", "prompts", "skills");

const registryCache = new Map();

function truthySetting(value, fallback = true) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function normalizeSkillId(value) {
  return slugify(value, { alphabet: "id", fallback: "" });
}

function parseScalar(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineList(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((entry) => parseScalar(entry))
      .filter(Boolean);
  }
  return trimmed
    .split(",")
    .map((entry) => parseScalar(entry))
    .filter(Boolean);
}

function parseFrontmatter(markdown) {
  const match = String(markdown || "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { attrs: {}, body: String(markdown || "") };
  const attrs = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    attrs[key] = value.startsWith("[") ? parseInlineList(value) : parseScalar(value);
  }
  return { attrs, body: match[2] || "" };
}

function skillDirEntries(skillsDir) {
  try {
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function registrySignature(skillsDir) {
  let dirStat;
  try {
    dirStat = fs.statSync(skillsDir);
  } catch {
    return "missing";
  }
  const parts = [`dir:${dirStat.mtimeMs}:${dirStat.size}`];
  for (const dirName of skillDirEntries(skillsDir)) {
    const skillPath = path.join(skillsDir, dirName, "SKILL.md");
    try {
      const stat = fs.statSync(skillPath);
      parts.push(`${dirName}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${dirName}:missing`);
    }
  }
  return parts.join("|");
}

function buildManifest(skillsDir, dirName) {
  const filePath = path.join(skillsDir, dirName, "SKILL.md");
  const markdown = fs.readFileSync(filePath, "utf-8");
  const { attrs, body } = parseFrontmatter(markdown);
  const id = normalizeSkillId(attrs.id || dirName);
  if (!id) return null;
  const appliesTo = parseInlineList(attrs.applies_to)
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean);
  return {
    id,
    name: String(attrs.name || id).trim(),
    description: String(attrs.description || "").trim(),
    applies_to: appliesTo,
    when_to_use: String(attrs.when_to_use || "").trim(),
    recycle_session: truthySetting(attrs.recycle_session, false),
    body: String(body || "").trim(),
    path: filePath,
    dir: path.dirname(filePath),
  };
}

export function parseSkillIds(value) {
  let raw = [];
  if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) raw = [];
    else if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        raw = Array.isArray(parsed) ? parsed : [];
      } catch {
        raw = trimmed.split(",");
      }
    } else {
      raw = trimmed.split(",");
    }
  }
  const seen = new Set();
  const ids = [];
  for (const entry of raw) {
    const id = normalizeSkillId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function serializeSkillIds(value) {
  const ids = parseSkillIds(value);
  return ids.length > 0 ? JSON.stringify(ids) : null;
}

export function loadSkillManifests({ skillsDir = DEFAULT_SKILLS_DIR, force = false } = {}) {
  if (!skillsDir && getActivePromptBundle({ required: false })?.source === "remote") {
    return getPromptBundleSkillManifests();
  }
  if (!skillsDir) skillsDir = LOCAL_SKILLS_DIR;

  const resolvedDir = path.resolve(skillsDir);
  const signature = registrySignature(resolvedDir);
  const cached = registryCache.get(resolvedDir);
  if (!force && cached && cached.signature === signature) return cached.manifests;

  const manifests = [];
  for (const dirName of skillDirEntries(resolvedDir)) {
    const skillPath = path.join(resolvedDir, dirName, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    try {
      const manifest = buildManifest(resolvedDir, dirName);
      if (manifest) manifests.push(manifest);
    } catch {
      // Invalid skill files are ignored by the registry instead of breaking all planning.
    }
  }
  registryCache.set(resolvedDir, { signature, manifests });
  return manifests;
}

export function getSkillById(id, opts = {}) {
  const wanted = normalizeSkillId(id);
  return loadSkillManifests(opts).find((manifest) => manifest.id === wanted) || null;
}

export function isSkillsEnabled() {
  try {
    return truthySetting(getSetting(SETTING_KEYS.SKILLS_ENABLED), true);
  } catch {
    return true;
  }
}

export function getDisabledSkillIdSet() {
  try {
    return new Set(parseSkillIds(getSetting(SETTING_KEYS.SKILLS_DISABLED_IDS)));
  } catch {
    return new Set();
  }
}

export function getEnabledSkillsForRole(role, opts = {}) {
  const roleName = String(role || "").trim().toLowerCase();
  if (roleName !== "dev") return [];
  const enabled = opts.skillsEnabled ?? isSkillsEnabled();
  if (!enabled) return [];
  const disabled = opts.disabledIds instanceof Set ? opts.disabledIds : getDisabledSkillIdSet();
  return loadSkillManifests(opts)
    .filter((manifest) => manifest.applies_to.includes(roleName))
    .filter((manifest) => !disabled.has(manifest.id));
}

export function validateSkillIds(ids, role, opts = {}) {
  const requested = parseSkillIds(ids);
  const roleName = String(role || "").trim().toLowerCase();
  const manifests = loadSkillManifests(opts);
  const manifestById = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const disabled = opts.disabledIds instanceof Set ? opts.disabledIds : getDisabledSkillIdSet();
  const skillsEnabled = opts.skillsEnabled ?? isSkillsEnabled();
  const valid = [];
  const invalid = [];
  const disabledIds = [];

  for (const id of requested) {
    const manifest = manifestById.get(id);
    if (!manifest) {
      invalid.push(id);
      continue;
    }
    if (roleName !== "dev" || !skillsEnabled || disabled.has(id) || !manifest.applies_to.includes(roleName)) {
      disabledIds.push(id);
      continue;
    }
    valid.push(id);
  }

  return { valid, invalid, disabled: disabledIds };
}

export function setSkillEnabled(skillId, enabled) {
  const id = normalizeSkillId(skillId);
  if (!id) throw new Error("skill id is required");
  const disabled = getDisabledSkillIdSet();
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  setSetting(SETTING_KEYS.SKILLS_DISABLED_IDS, [...disabled].sort().join(","));
}

export function clearSkillRegistryCache() {
  registryCache.clear();
}
