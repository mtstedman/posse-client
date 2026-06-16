// lib/artifacts.js — Artifact directory management
//
// Three-layer storage for non-code tasks:
//   inputs/{scopeId}/      — read-only user-provided source material
//   workspace/{scopeId}/   — mutable scratch space for processing
//   artifacts/{scopeId}/   — final deliverables (reports, images, content)
//
// scopeId = "wi-{id}" (work-item scoped) or "run-{token}" (pre-WI scoped)
//
// These live under the runtime resources dir (default: .posse/resources/).
// Boot-time: initArtifactRoots() creates the three parent dirs.
// Intake-time: ensureArtifactDirs(scopeId, mode) creates per-task subdirs.
// Runtime: injectArtifactScope(payload, scopeId) auto-fills roots so planners can't forget.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getRuntimeResourcesDir } from "../../runtime/functions/paths.js";
import { assertTestContext } from "../../runtime/functions/test-context.js";
import { getAccountSetting } from "../../settings/functions/account-settings.js";
import { resolvePathWithin } from "../../worker/functions/helpers/scope.js";
import {
  IMAGE_PROVIDER_OPTIONS,
  getDefaultImageModel,
  getDefaultImageProvider,
  normalizeGrokImageModelName,
} from "../../providers/functions/model-catalog.js";
import { resolveEffectiveImageModel } from "../../providers/functions/model-catalog-validate.js";

// ─── Config ──────────────────────────────────────────────────────────────────

// TASK_MODES (task-level execution context) and WI_MODES (work-item-level
// intent that constrains the planner) live in the catalogue alongside
// ARTIFACT_TYPES. Imported for local use and re-exported so existing call
// sites keep working.
import { TASK_MODES, WI_MODES } from "../../../catalog/artifact.js";
export { TASK_MODES, WI_MODES };

/** Validate that a WI mode string is recognized. */
export function isValidWiMode(mode) {
  return mode in WI_MODES;
}

/** Get WI mode config, defaulting to build. */
export function getWiModeConfig(mode) {
  return WI_MODES[mode] || WI_MODES.build;
}

// ─── Artifact Protocols (config-driven) ─────────────────────────────────────

/** Load artifact protocols from config/artifact-protocols.json. */
let _protocols = null;
let _protocolsSignature = null;
let _protocolsStatKey = null;
let _protocolsWarned = false;
let _protocolsOverrideForTests = null;
const _invalidImageProviderWarnings = new Set();
const DEFAULT_MANIFEST_MAX_DEPTH = 64;
const DEFAULT_MANIFEST_MAX_FILES = 10000;
const DEFAULT_MANIFEST_MAX_ERRORS = 200;
const ARTIFACT_PROTOCOLS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "config",
  "artifact-protocols.json",
);

function warnProtocolLoadFailure(err, { usingCache = false } = {}) {
  if (_protocolsWarned) return;
  _protocolsWarned = true;
  const reason = err?.code === "ENOENT" ? "file not found" : err?.message?.split("\n")[0] || "unknown error";
  const suffix = usingCache ? "; using last known protocols" : " — image routing may use defaults";
  console.error(`[artifacts] Warning: config/artifact-protocols.json not loaded (${reason})${suffix}`);
}

export function getArtifactProtocols() {
  if (_protocolsOverrideForTests) return _protocolsOverrideForTests;
  try {
    const stat = fs.statSync(ARTIFACT_PROTOCOLS_PATH);
    const statKey = `${stat.size}:${stat.mtimeMs}`;
    if (_protocols && _protocolsStatKey === statKey) return _protocols;

    const raw = fs.readFileSync(ARTIFACT_PROTOCOLS_PATH, "utf-8");
    const signature = crypto.createHash("sha256").update(raw).digest("hex");
    if (!_protocols || _protocolsSignature !== signature) {
      _protocols = JSON.parse(raw);
      _protocolsSignature = signature;
      _protocolsWarned = false;
    }
    _protocolsStatKey = statKey;
  } catch (err) {
    if (!_protocols) {
      _protocols = {};
      _protocolsSignature = null;
      _protocolsStatKey = null;
      warnProtocolLoadFailure(err);
    } else {
      warnProtocolLoadFailure(err, { usingCache: true });
    }
  }
  return _protocols;
}

/** Clear cached protocols — forces reload on next access. */
export function reloadArtifactProtocols() {
  _protocols = null;
  _protocolsSignature = null;
  _protocolsStatKey = null;
  _protocolsWarned = false;
  _invalidImageProviderWarnings.clear();
}

export function setArtifactProtocolsForTests(protocols = null) {
  assertTestContext("setArtifactProtocolsForTests");
  _protocolsOverrideForTests = protocols && typeof protocols === "object"
    ? JSON.parse(JSON.stringify(protocols))
    : null;
  reloadArtifactProtocols();
}

/** Get the protocol for a specific artifact type (task_mode). */
export function getArtifactProtocol(taskMode) {
  return getArtifactProtocols()[taskMode] || null;
}

function normalizeImageModelForProvider(provider, model) {
  const selectedProvider = String(provider || getDefaultImageProvider()).trim().toLowerCase();
  const selectedModel = String(model || "").trim();
  if (selectedProvider === "grok") {
    return normalizeGrokImageModelName(selectedModel);
  }
  if (selectedProvider === "openai") {
    return /^(gpt-image(?:-\d+(?:\.\d+)?)?|dall-e-3|dall-e-2)$/i.test(selectedModel)
      ? selectedModel
      : getDefaultImageModel("openai");
  }
  return selectedModel || getDefaultImageModel(selectedProvider);
}

function normalizeImageProviderList(providerValue) {
  const raw = String(providerValue || "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const unique = raw.filter((provider, index) => raw.indexOf(provider) === index);
  const allowedProviders = new Set(IMAGE_PROVIDER_OPTIONS.map((entry) => entry.value));
  const allowed = unique.filter((provider) => allowedProviders.has(provider));
  const invalid = unique.filter((provider) => !allowedProviders.has(provider));
  if (invalid.length > 0) {
    const key = invalid.join(",");
    if (!_invalidImageProviderWarnings.has(key)) {
      _invalidImageProviderWarnings.add(key);
      console.error(`[artifacts] Warning: ignored invalid artifact_image_provider value(s): ${invalid.join(", ")}`);
    }
  }
  return allowed.length > 0 ? allowed : [getDefaultImageProvider()];
}

export function getConfiguredImageProviders() {
  const protocol = getArtifactProtocol("image") || {};
  const saved = getAccountSetting(SETTING_KEYS.ARTIFACT_IMAGE_PROVIDER);
  return normalizeImageProviderList(saved || protocol.provider);
}

export function getConfiguredImageModel(provider, protocol = null) {
  const selectedProvider = String(provider || getDefaultImageProvider()).trim().toLowerCase();
  const currentProtocol = protocol || getArtifactProtocol("image") || {};
  const saved = getAccountSetting(`${selectedProvider}_image_model`);
  const fallback = currentProtocol.provider === selectedProvider ? currentProtocol.model : null;
  const normalized = normalizeImageModelForProvider(selectedProvider, saved || fallback);
  // Stale-model guard (after typo normalization): a model the remote catalog
  // marks deprecated/removed warns and resolves to the provider default.
  const effective = resolveEffectiveImageModel(selectedProvider, normalized);
  return effective.model || normalized;
}

/** Resolve the effective image protocol, normalizing provider/model mismatches. */
export function getResolvedImageProtocol(providerOverride = null) {
  const protocol = getArtifactProtocol("image") || {};
  const providers = getConfiguredImageProviders();
  const provider = providerOverride || providers[0] || getDefaultImageProvider();
  return {
    ...protocol,
    provider,
    provider_list: providers,
    model: getConfiguredImageModel(provider, protocol),
  };
}

/**
 * Validate a manifest against the artifact protocol for a task mode.
 * Driven by config/artifact-protocols.json — no hardcoded rules.
 *
 * @param {{ files: Array<{path, size, ext}>, count: number }} manifest
 * @param {string} taskMode
 * @returns {{ valid: boolean, violations: string[], warnings: string[] }}
 */
export function validateManifestAgainstContract(manifest, taskMode) {
  const protocol = getArtifactProtocol(taskMode);
  if (!protocol) {
    if (!taskMode || taskMode === "code") return { valid: true, violations: [], warnings: [] };
    return {
      valid: false,
      violations: [`No artifact protocol configured for task_mode "${taskMode}"`],
      warnings: [],
    };
  }

  const violations = [];
  const warnings = [];
  const validation = protocol.output_validation || {};

  if (validation.min_files && manifest.count < validation.min_files) {
    violations.push(`Expected at least ${validation.min_files} file(s), got ${manifest.count}`);
  }

  if (validation.min_bytes && manifest.count > 0) {
    const tooSmall = manifest.files.filter(f => f.size < validation.min_bytes);
    if (tooSmall.length > 0) {
      violations.push(`${tooSmall.length} file(s) below minimum size (${validation.min_bytes} bytes): ${tooSmall.map(f => f.path).join(", ")}`);
    }
  }

  if (protocol.allowed_formats && manifest.count > 0) {
    const allowedSet = new Set(protocol.allowed_formats);
    // Manifest files (e.g. manifest.json alongside PNG deliverables) are
    // metadata about the output set, so they're exempt from the format check
    // even when their extension isn't listed. Entries may be exact basenames
    // (`manifest.json`) or simple `*`-globs (`manifest-*.json`) so that jobs
    // can write job-linked manifests like `manifest-78.json` without
    // colliding when two jobs share an output_root. Manifest files still do
    // not satisfy the "must contain at least one allowed-format file"
    // requirement — a manifest-only output still fails.
    const manifestPatterns = (protocol.allowed_manifest_files || []).map((entry) => {
      const str = String(entry || "");
      if (!str.includes("*")) return { kind: "exact", value: str };
      const escaped = str.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return { kind: "glob", value: new RegExp(`^${escaped}$`) };
    });
    const isManifestFile = (f) => {
      const basename = String(f.path || "").split("/").pop();
      for (const pat of manifestPatterns) {
        if (pat.kind === "exact" ? pat.value === basename : pat.value.test(basename)) return true;
      }
      return false;
    };
    const nonManifestFiles = manifest.files.filter((f) => !isManifestFile(f));
    const disallowed = nonManifestFiles.filter((f) => !allowedSet.has(f.ext));
    const hasAllowed = nonManifestFiles.some((f) => allowedSet.has(f.ext));
    if (!hasAllowed) {
      violations.push(`No files with allowed formats [${protocol.allowed_formats.join(", ")}] — found: [${[...new Set(manifest.files.map(f => f.ext))].join(", ")}]`);
    }
    if (disallowed.length > 0) {
      violations.push(`${disallowed.length} file(s) with disallowed formats: ${disallowed.slice(0, 5).map(f => `${f.path} (${f.ext})`).join(", ")}`);
    }
  }

  if (protocol.warn_formats && manifest.count > 0) {
    const warnSet = new Set(protocol.warn_formats);
    const warned = manifest.files.filter((f) => warnSet.has(f.ext));
    if (warned.length > 0) {
      warnings.push(`${warned.length} file(s) use executable or high-risk extensions: ${warned.slice(0, 5).map((f) => `${f.path} (${f.ext || "no extension"})`).join(", ")}`);
    }
  }

  if (protocol.max_outputs && manifest.count > protocol.max_outputs) {
    warnings.push(`Produced ${manifest.count} files, exceeds max_outputs (${protocol.max_outputs})`);
  }

  return { valid: violations.length === 0, violations, warnings };
}

// ─── Path Helpers ────────────────────────────────────────────────────────────

/** Get the base resources directory (resolved to absolute). */
export function getResourcesDir(projectDir = null) {
  return getRuntimeResourcesDir(projectDir);
}

function resourceCategoryRoot(category, projectDir = null) {
  return path.join(getResourcesDir(projectDir), category);
}

function printableScopeId(scopeId) {
  return String(scopeId ?? "").replace(/\0/g, "\\0");
}

export function validateArtifactScopeId(scopeId) {
  const value = String(scopeId ?? "");
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || value.includes("\0")
    || path.isAbsolute(value)
    || /[\\/]/.test(value)
  ) {
    throw new Error(`Invalid artifact scope ID: ${printableScopeId(scopeId)}`);
  }
  return value;
}

function scopedResourceDir(category, scopeId, projectDir = null) {
  const safeScopeId = validateArtifactScopeId(scopeId);
  const base = resourceCategoryRoot(category, projectDir);
  const resolved = resolvePathWithin(base, safeScopeId, { allowEqual: false });
  if (!resolved) {
    throw new Error(`Artifact scope path escapes ${category} root: ${printableScopeId(scopeId)}`);
  }
  return resolved;
}

/** Get the inputs root for a scope. */
export function inputsDir(scopeId, projectDir = null) {
  return scopedResourceDir("inputs", scopeId, projectDir);
}

/** Get the workspace root for a scope. */
export function workspaceDir(scopeId, projectDir = null) {
  return scopedResourceDir("workspace", scopeId, projectDir);
}

/** Get the artifacts root for a scope. */
export function artifactsDir(scopeId, projectDir = null) {
  return scopedResourceDir("artifacts", scopeId, projectDir);
}

/** Get the artifact namespace root owned by a work item. */
export function workItemArtifactRoot(wiId, projectDir = null) {
  return artifactsDir(wiScopeId(wiId), projectDir);
}

/** Get a stable child artifact output root under a work item namespace. */
export function artifactTaskOutputRoot(wiId, childSegment, projectDir = null) {
  return path.join(workItemArtifactRoot(wiId, projectDir), String(childSegment || "task"));
}

/** Get the context root for a scope (pre-staged files for the planner). */
export function contextDir(scopeId, projectDir = null) {
  return scopedResourceDir("context", scopeId, projectDir);
}

/** Generate a scope ID for a work item. */
export function wiScopeId(wiId) {
  return `wi-${wiId}`;
}

/** Generate a scope ID for a pre-WI run (before DB insert). */
export function runScopeId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = crypto.randomUUID().slice(0, 6);
  return `run-${date}-${rand}`;
}

// ─── Boot-Time Initialization ────────────────────────────────────────────────

/**
 * Verify and create the three top-level resource directories.
 * Call at orchestrator boot. Fails fast if permissions are bad.
 *
 * @param {string} [projectDir]
 * @returns {{ resourcesDir, inputsBase, workspaceBase, artifactsBase }}
 */
export function initArtifactRoots(projectDir = null) {
  const base = getResourcesDir(projectDir);
  const inputsBase = resourceCategoryRoot("inputs", projectDir);
  const workspaceBase = resourceCategoryRoot("workspace", projectDir);
  const artifactsBase = resourceCategoryRoot("artifacts", projectDir);

  for (const dir of [base, inputsBase, workspaceBase, artifactsBase]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Verify writable
  for (const dir of [inputsBase, workspaceBase, artifactsBase]) {
    try {
      const testFile = path.join(dir, ".posse-write-test");
      fs.writeFileSync(testFile, "ok");
      try {
        fs.unlinkSync(testFile);
      } catch (cleanupErr) {
        // Some Windows environments allow write but deny immediate delete for
        // transiently locked files. A successful write proves the directory is
        // usable for runtime artifacts, so tolerate cleanup failures.
        const code = String(cleanupErr?.code || "");
        if (!["EPERM", "EACCES", "EBUSY", "ENOENT"].includes(code)) {
          throw cleanupErr;
        }
      }
    } catch (err) {
      throw new Error(`Artifact root not writable: ${dir} — ${err.message}`);
    }
  }

  return { resourcesDir: base, inputsBase, workspaceBase, artifactsBase };
}

export async function initArtifactRootsAsync(projectDir = null) {
  const base = getResourcesDir(projectDir);
  const inputsBase = resourceCategoryRoot("inputs", projectDir);
  const workspaceBase = resourceCategoryRoot("workspace", projectDir);
  const artifactsBase = resourceCategoryRoot("artifacts", projectDir);

  await Promise.all([base, inputsBase, workspaceBase, artifactsBase]
    .map((dir) => fs.promises.mkdir(dir, { recursive: true })));

  for (const dir of [inputsBase, workspaceBase, artifactsBase]) {
    try {
      const testFile = path.join(dir, ".posse-write-test");
      await fs.promises.writeFile(testFile, "ok");
      try {
        await fs.promises.unlink(testFile);
      } catch (cleanupErr) {
        const code = String(cleanupErr?.code || "");
        if (!["EPERM", "EACCES", "EBUSY", "ENOENT"].includes(code)) {
          throw cleanupErr;
        }
      }
    } catch (err) {
      throw new Error(`Artifact root not writable: ${dir} — ${err.message}`);
    }
  }

  return { resourcesDir: base, inputsBase, workspaceBase, artifactsBase };
}

// ─── Directory Setup (Intake-Time) ───────────────────────────────────────────

/**
 * Create the directory structure for a scope based on task mode.
 * Called at WI/run creation time. Idempotent.
 *
 * @param {string} scopeId - "wi-123" or "run-20260327-abc123"
 * @param {string} taskMode - One of: code, report, content, intake_processing
 * @param {string} [projectDir]
 * @returns {{ inputRoot, workspaceRoot, artifactRoot }} - Created paths (null if not needed)
 */
export function ensureArtifactDirs(scopeId, taskMode = "code", projectDir = null) {
  const mode = TASK_MODES[taskMode] || TASK_MODES.code;
  const result = { inputRoot: null, workspaceRoot: null, artifactRoot: null };

  if (mode.needsInputs) {
    result.inputRoot = inputsDir(scopeId, projectDir);
    fs.mkdirSync(result.inputRoot, { recursive: true });
  }
  if (mode.needsWorkspace) {
    result.workspaceRoot = workspaceDir(scopeId, projectDir);
    fs.mkdirSync(result.workspaceRoot, { recursive: true });
  }
  if (mode.needsArtifacts) {
    result.artifactRoot = artifactsDir(scopeId, projectDir);
    fs.mkdirSync(result.artifactRoot, { recursive: true });
  }

  return result;
}

// ─── Runtime Scope Injection ─────────────────────────────────────────────────

/**
 * Auto-inject artifact roots into a job payload for non-code modes.
 * This is the system-enforcement layer — even if the planner forgot to set
 * output_root or create_roots, the worker fills them before dispatch.
 *
 * For code mode: no-op (returns payload unchanged).
 * For artifact modes:
 *   - Sets output_root if missing
 *   - Merges artifact/workspace dirs into create_roots
 *   - Merges input dirs into input_roots
 *   - Clears files_to_modify and files_to_create (forces create_roots only)
 *
 * @param {object} payload - Parsed job payload
 * @param {string} scopeId - "wi-123" or "run-..."
 * @param {string} [projectDir]
 * @returns {object} A scoped payload copy
 */
export function injectArtifactScope(payload, scopeId, projectDir = null) {
  const scoped = { ...(payload || {}) };
  const taskMode = scoped.task_mode || "code";
  if (taskMode === "code") return scoped;

  const mode = TASK_MODES[taskMode];
  if (!mode) {
    throw new Error(`Unknown task_mode "${taskMode}" cannot be artifact-scoped`);
  }

  // Normalize path separators — dev/fix agents run in worktrees on Windows,
  // so backslashes must be normalized to forward slashes for consistency.
  const normalizePath = (p) => String(p || "").replace(/\\/g, "/");
  const resolveProjectPath = (p) => {
    const resolved = resolvePathWithin(projectDir || process.cwd(), p);
    if (!resolved) {
      throw new Error(`Artifact path escapes project scope: ${p}`);
    }
    return normalizePath(resolved);
  };

  const explicitOutputRoot = scoped.output_root ? resolveProjectPath(scoped.output_root) : null;
  const existingRoots = new Set((scoped.create_roots || []).map((root) => resolveProjectPath(root)));
  const existingInputs = mode.needsInputs
    ? new Set((scoped.input_roots || []).map((root) => resolveProjectPath(root)))
    : null;

  // Ensure dirs exist only after planner-supplied paths have been validated.
  const dirs = ensureArtifactDirs(scopeId, taskMode, projectDir);
  if (explicitOutputRoot) {
    fs.mkdirSync(explicitOutputRoot, { recursive: true });
  }

  // Always force absolute output_root — planner may have set a relative path
  // that would resolve against the wrong root (e.g. worktree cwd vs project root).
  // Absolute paths are the ground truth for where artifacts actually live.
  if (explicitOutputRoot) {
    scoped.output_root = explicitOutputRoot;
  } else if (dirs.artifactRoot) {
    scoped.output_root = normalizePath(dirs.artifactRoot);
  }

  // Merge artifact create_roots
  if (existingRoots.size === 0 && scoped.output_root) existingRoots.add(normalizePath(scoped.output_root));
  if (dirs.artifactRoot && (!explicitOutputRoot || mode.needsWorkspace)) existingRoots.add(normalizePath(dirs.artifactRoot));
  if (dirs.workspaceRoot) existingRoots.add(normalizePath(dirs.workspaceRoot));
  scoped.create_roots = [...existingRoots];

  // Merge input_roots
  if (dirs.inputRoot) {
    existingInputs.add(normalizePath(dirs.inputRoot));
    scoped.input_roots = [...existingInputs];
  }

  const hasDeclaredFileScope = [
    scoped.files_to_modify,
    scoped.files_to_create,
    scoped.files_to_delete,
  ].some((entries) => Array.isArray(entries) && entries.length > 0);

  // Artifact modes: clear file scope only when no explicit file scope exists.
  // This allows hybrid tasks (e.g., write a report AND update an index file)
  // even if an upstream repair path forgot to set the planner marker.
  if (!scoped._planner_set_files && !hasDeclaredFileScope) {
    scoped.files_to_modify = [];
    scoped.files_to_create = [];
    delete scoped._artifact_scope_warnings;
  } else if (Array.isArray(scoped.files_to_create) && scoped.output_root) {
    const warnings = [];
    scoped.files_to_create = normalizeArtifactCreateFiles(scoped.files_to_create, scoped.output_root, { warnings });
    if (warnings.length > 0) scoped._artifact_scope_warnings = warnings;
    else delete scoped._artifact_scope_warnings;
  }

  return scoped;
}

export function normalizeArtifactCreateFiles(filesToCreate = [], outputRoot, opts = {}) {
  const normalizedRoot = String(outputRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedRoot || !Array.isArray(filesToCreate) || filesToCreate.length === 0) return filesToCreate || [];

  const normalizedFiles = [];
  const rootPrefix = normalizedRoot + "/";
  const warnings = Array.isArray(opts?.warnings) ? opts.warnings : null;
  const addWarning = (type, file, normalized = null) => {
    if (!warnings) return;
    warnings.push({ type, file, normalized });
  };
  const artifactScopeLike = (part) => /^wi-[^/]+$/.test(part) || /^run-[^/]+$/.test(part);
  const rootedArtifactTail = (file) => {
    let rel = String(file || "").replace(/^\.posse\/resources\//, "");
    if (rel.startsWith(".posse/resources/")) rel = rel.slice(".posse/resources/".length);
    if (rel.startsWith("resources/")) rel = rel.slice("resources/".length);
    const parts = rel.split("/").filter(Boolean);
    if (["artifacts", "workspace", "inputs", "context"].includes(parts[0])) {
      const rest = parts.slice(1);
      return artifactScopeLike(rest[0]) ? rest.slice(1).join("/") : rest.join("/");
    }
    if (parts[0] === "resources") return parts.slice(1).join("/");
    return path.posix.basename(file);
  };
  const reanchor = (rawFile, file) => {
    const tail = path.posix.normalize(rootedArtifactTail(file).replace(/^\/+/, ""));
    if (!tail || tail === "." || tail === ".." || tail.startsWith("../")) {
      addWarning("artifact_path_dropped", rawFile, null);
      return null;
    }
    const normalized = `${normalizedRoot}/${tail}`;
    if (normalized !== file) addWarning("artifact_path_reanchored", rawFile, normalized);
    return normalized;
  };
  for (const rawFile of filesToCreate) {
    if (typeof rawFile !== "string" || !rawFile.trim()) continue;
    const file = rawFile.replace(/\\/g, "/").trim().replace(/^\.\//, "");
    if (file === normalizedRoot || file.startsWith(rootPrefix)) {
      normalizedFiles.push(file);
      continue;
    }

    const absoluteLike = path.isAbsolute(file) || /^[A-Za-z]:\//.test(file);
    const rootedArtifactLike = /^(\.posse\/resources\/)?(resources|artifacts|workspace|inputs|context)\//.test(file);
    if (absoluteLike || rootedArtifactLike) {
      const normalized = rootedArtifactLike
        ? reanchor(rawFile, file)
        : `${normalizedRoot}/${path.posix.basename(file)}`;
      if (!normalized) continue;
      if (!rootedArtifactLike && normalized !== file) addWarning("artifact_path_reanchored", rawFile, normalized);
      normalizedFiles.push(normalized);
      continue;
    }

    const candidate = path.posix.normalize(`${normalizedRoot}/${file.replace(/^\/+/, "")}`);
    if (candidate === normalizedRoot || candidate.startsWith(rootPrefix)) {
      normalizedFiles.push(candidate);
    } else {
      addWarning("artifact_path_dropped", rawFile, null);
    }
  }

  return [...new Set(normalizedFiles)];
}

// ─── Query Helpers ───────────────────────────────────────────────────────────

/** Validate that a task_mode string is recognized. */
export function isValidTaskMode(mode) {
  return mode in TASK_MODES;
}

/** Check if a task mode requires artifact directories. */
export function isArtifactMode(mode) {
  if (!mode || mode === "code") return false;
  const config = TASK_MODES[mode];
  return config ? (config.needsArtifacts || config.needsWorkspace) : false;
}

// ─── Manifest ────────────────────────────────────────────────────────────────

/**
 * Build a manifest of files produced in an artifact directory.
 *
 * @param {string} dir - Absolute path to scan
 * @param {string} [relBase] - Base for relative paths in manifest
 * @param {{ maxDepth?: number, maxFiles?: number, maxErrors?: number }} [opts]
 * @returns {{ files: Array<{ path, size, ext, mtimeMs }>, totalSize: number, count: number }}
 */
export function buildManifest(dir, relBase = null, opts = {}) {
  if (relBase && typeof relBase === "object" && !Array.isArray(relBase)) {
    opts = relBase;
    relBase = null;
  }
  const files = [];
  const errors = [];
  let totalSize = 0;
  const base = relBase || dir;
  const maxDepth = Number.isFinite(Number(opts.maxDepth))
    ? Math.max(0, Math.floor(Number(opts.maxDepth)))
    : DEFAULT_MANIFEST_MAX_DEPTH;
  const maxFiles = Number.isFinite(Number(opts.maxFiles))
    ? Math.max(0, Math.floor(Number(opts.maxFiles)))
    : DEFAULT_MANIFEST_MAX_FILES;
  const maxErrors = Number.isFinite(Number(opts.maxErrors))
    ? Math.max(0, Math.floor(Number(opts.maxErrors)))
    : DEFAULT_MANIFEST_MAX_ERRORS;
  let truncated = false;
  let suppressedErrors = 0;

  function recordError(message) {
    if (errors.length < maxErrors) {
      errors.push(message);
      return;
    }
    suppressedErrors++;
  }

  function noteTruncated(message) {
    if (!truncated) recordError(message);
    truncated = true;
  }

  function relativeManifestPath(fullPath) {
    return path.relative(base, fullPath).replace(/\\/g, "/");
  }

  function isNestedRuntimeDir(fullPath) {
    const relPath = relativeManifestPath(fullPath);
    if (!relPath || relPath.startsWith("..")) return false;
    return relPath.split("/").filter(Boolean).includes(".posse");
  }

  function walk(d, depth = 0) {
    if (depth > maxDepth) {
      recordError(`max_depth ${d}: ${maxDepth}`);
      return;
    }
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (err) {
      recordError(`readdir ${d}: ${err.code || err.message}`);
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        noteTruncated(`max_files ${maxFiles} reached`);
        return;
      }
      const full = path.join(d, entry.name);
      if (entry.isSymbolicLink()) {
        recordError(`symlink ${full}: skipped`);
      } else if (entry.isDirectory()) {
        if (isNestedRuntimeDir(full)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          const relPath = relativeManifestPath(full);
          files.push({
            path: relPath,
            size: stat.size,
            ext: path.extname(entry.name).toLowerCase(),
            mtimeMs: stat.mtimeMs,
          });
          totalSize += stat.size;
        } catch (err) {
          recordError(`stat ${full}: ${err.code || err.message}`);
        }
      }
    }
  }

  walk(dir);
  if (suppressedErrors > 0) errors.push(`... ${suppressedErrors} manifest scan errors suppressed`);
  return { files, totalSize, count: files.length, truncated, errors: errors.length > 0 ? errors : undefined };
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Remove all artifact directories for a scope.
 *
 * @param {string} scopeId - "wi-123" or "run-..."
 * @param {string} [projectDir]
 * @param {{ keepArtifacts?: boolean }} [opts] - Artifacts are preserved unless keepArtifacts is explicitly false.
 */
export function cleanupArtifactDirs(scopeId, projectDir = null, opts = {}) {
  const dirs = [
    inputsDir(scopeId, projectDir),
    workspaceDir(scopeId, projectDir),
  ];
  if (opts.keepArtifacts === false) {
    dirs.push(artifactsDir(scopeId, projectDir));
  }
  const removed = [];
  for (const dir of dirs) {
    try {
      const existed = fs.existsSync(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      if (existed) removed.push(dir);
    } catch { /* ignore */ }
  }
  return { removed };
}

export async function cleanupArtifactDirsAsync(scopeId, projectDir = null, opts = {}) {
  const dirs = [
    inputsDir(scopeId, projectDir),
    workspaceDir(scopeId, projectDir),
  ];
  if (opts.keepArtifacts === false) {
    dirs.push(artifactsDir(scopeId, projectDir));
  }
  const removed = [];
  for (const dir of dirs) {
    try {
      let existed = true;
      try { await fs.promises.access(dir); } catch { existed = false; }
      await fs.promises.rm(dir, { recursive: true, force: true });
      if (existed) removed.push(dir);
    } catch {
      // Best-effort transient cleanup.
    }
  }
  return { removed };
}

/**
 * Remove empty scope directories under .posse/resources/{inputs,workspace,artifacts}.
 * A scope dir is "empty" if it has no files (recursively).
 * Called at startup and after clear to prevent clutter.
 *
 * @param {string} [projectDir]
 * @returns {number} Number of empty dirs removed
 */
export function pruneEmptyArtifactDirs(projectDir = null) {
  const base = getResourcesDir(projectDir);
  let pruned = 0;

  for (const category of ["inputs", "workspace", "artifacts"]) {
    const catDir = path.join(base, category);
    let entries;
    try { entries = fs.readdirSync(catDir, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const scopeDir = path.join(catDir, entry.name);
      if (_isDirEmpty(scopeDir)) {
        try { fs.rmSync(scopeDir, { recursive: true, force: true }); pruned++; } catch { /* ignore */ }
      }
    }
  }
  return pruned;
}

export async function pruneEmptyArtifactDirsAsync(projectDir = null) {
  const base = getResourcesDir(projectDir);
  let pruned = 0;

  for (const category of ["inputs", "workspace", "artifacts"]) {
    const catDir = path.join(base, category);
    let entries;
    try { entries = await fs.promises.readdir(catDir, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const scopeDir = path.join(catDir, entry.name);
      if (await _isDirEmptyAsync(scopeDir)) {
        try {
          await fs.promises.rm(scopeDir, { recursive: true, force: true });
          pruned++;
        } catch {
          // Best-effort startup cleanup.
        }
      }
    }
  }
  return pruned;
}

function _isDirEmpty(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile()) return false;
      if (e.isDirectory() && !_isDirEmpty(path.join(dir, e.name))) return false;
    }
    return true;
  } catch (err) {
    // Only a vanished dir is safely "empty". Any other readdir failure (EACCES,
    // transient AV lock) must not green-light the recursive rm that follows.
    return err?.code === "ENOENT";
  }
}

async function _isDirEmptyAsync(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile()) return false;
      if (e.isDirectory() && !(await _isDirEmptyAsync(path.join(dir, e.name)))) return false;
    }
    return true;
  } catch (err) {
    return err?.code === "ENOENT";
  }
}
