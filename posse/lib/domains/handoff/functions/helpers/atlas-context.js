// lib/domains/handoff/functions/helpers/atlas-context.js
//
// ATLAS handoff-state resolution, planner slice prefetch, and context rendering.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { extractJson } from "../../../../shared/format/functions/json.js";
import { getAtlasDeterministicToolDefinitions } from "../../../../shared/tools/functions/toolkit/atlas.js";
import { materializeCodeSurveyPages } from "../../../../shared/tools/functions/hash-adder.js";
import { getAtlasIntegrationConfig, resolveAtlasExecutionAttachment } from "../../../integrations/functions/atlas.js";
import { executeEmbeddedAtlasTool } from "../../../integrations/functions/atlas-embedded.js";
import { getObservationContext, recordObservation } from "../../../observability/functions/observations.js";
import { surfaceHashRefForContext } from "../../../queue/functions/hash-refs.js";
import { chooseSurveyScope, defaultSurveyScopeDeps, MAX_SURVEY_FILES } from "./survey-scope.js";
import { resolveAtlasToolGateEnabled } from "../../../integrations/functions/deterministic-mcp/gate-settings.js";
import { isIndexableSourcePath } from "../../../integrations/functions/deterministic-mcp/source-file-gate.js";
import { resolvePathWithin } from "../../../runtime/functions/fs-safety.js";
import { isSensitiveEnvFileOrTargetPath } from "../../../runtime/functions/sensitive-paths.js";
import { readProjectDbConfig } from "../../../../shared/tools/functions/toolkit/project-db/config.js";
import { assertTestContext } from "../../../runtime/functions/test-context.js";
import { formatAtlasBackendText, atlasBackendLabel } from "../../../integrations/functions/atlas-label.js";
import { isExternallyRoutedAtlasTool } from "../../../integrations/functions/deterministic-mcp/tool-descriptors.js";
import { semanticDispatchEnabled } from "../../../atlas/functions/v2/embeddings/resources.js";
import {
  atlasResultData,
  atlasResultField,
  atlasSymbolCardField,
} from "../../../atlas/functions/v2/contracts/tool-results.js";

const ATLAS_EXACT_PREFETCH_MAX_FILES = 6;
const ATLAS_EXACT_PREFETCH_MAX_BYTES = 96 * 1024;
const ATLAS_EXACT_PREFETCH_MAX_LINES = 1200;
const ATLAS_SLICE_FILE_DISPLAY_MAX = 8;
const ATLAS_REFERENCE_PREFETCH_MAX_FILES = 8;
const ATLAS_DB_PREFETCH_MAX_FILES = 64;
const ATLAS_DB_PREFETCH_RG_MAX_BUFFER = 16 * 1024 * 1024;
const LEXICAL_PREFETCH_CACHE_TTL_MS = 30_000;
const LEXICAL_PREFETCH_CACHE_MAX = 64;
const LEXICAL_PREFETCH_SCAN_LIMIT = 120_000;
const LEXICAL_PREFETCH_RG_MAX_BUFFER = 16 * 1024 * 1024;
const LEXICAL_PREFETCH_CACHE = new Map();
const ATLAS_AREA_MAP_PREFETCH_TIMEOUT_MS = 5_000;

const ATLAS_DB_PREFETCH_RG_PATTERN = [
  "\\bselect\\b",
  "\\binsert\\s+into\\b",
  "\\bupdate\\s+\\w",
  "\\bdelete\\s+from\\b",
  "\\bupsert\\b",
  "\\bcreate\\s+table\\b",
  "\\balter\\s+table\\b",
  "\\bdrop\\s+table\\b",
  "\\bdb\\.(?:prepare|query|exec|run)\\b",
  "\\.(?:prepare|query|execute)\\s*\\(",
].join("|");

const ATLAS_DB_PREFETCH_SKIP_GLOBS = Object.freeze([
  "!node_modules/**",
  "!vendor/**",
  "!dist/**",
  "!build/**",
  "!coverage/**",
  "!.git/**",
  "!.posse/**",
  "!.posse-worktrees/**",
]);

function externallyRoutedAtlasTools(tools = []) {
  return (Array.isArray(tools) ? tools : [])
    .filter((toolName) => isExternallyRoutedAtlasTool(toolName));
}

function internalAtlasTools(packet) {
  return new Set([
    ...(Array.isArray(packet?.atlas?.internalTools) ? packet.atlas.internalTools : []),
    ...(Array.isArray(packet?.atlas?.tools) ? packet.atlas.tools : []),
  ]);
}

function rawTextSlicePrefetchEnabled(packet) {
  const config = packet?.atlas_config || getAtlasIntegrationConfig();
  return semanticDispatchEnabled(config);
}

function _isPrefetchCwdUsable(cwd) {
  if (!cwd) return false;
  try { return fs.statSync(cwd).isDirectory(); } catch { return false; }
}

export function resolveAtlasHandoffState(recipient, packet) {
  if (
    packet?.atlas_disabled ||
    packet?.disableAtlas ||
    packet?.disable_atlas ||
    packet?.context_hints?.disableAtlas ||
    packet?.context_hints?.disable_atlas ||
    packet?._raw_payload?.disableAtlas ||
    packet?._raw_payload?.disable_atlas
  ) {
    return null;
  }
  const providerName = packet.execution_provider || packet.job_provider || "claude";
  const resolved = resolveAtlasExecutionAttachment({
    role: recipient,
    providerName,
    cwd: packet.cwd,
    workItemId: packet.work_item_id ?? null,
    config: packet.atlas_config || undefined,
  });
  const gateEnabled = resolveAtlasToolGateEnabled();
  return {
    provider: resolved.provider,
    transport: resolved.transport,
    supported: resolved.supported,
    configured: resolved.configured,
    active: resolved.active,
    shouldAdvertise: !!resolved.shouldAdvertise,
    fallback: resolved.fallback,
    role: resolved.role,
    phase: resolved.phase,
    tools: externallyRoutedAtlasTools(resolved.tools),
    repo: resolved.repo,
    server: resolved.server,
    rationale: resolved.rationale,
    method: resolved.method || "baseline",
    backend: resolved.backend || null,
    atlasVersion: resolved.atlasVersion || null,
    gateEnabled,
    internalTools: Array.isArray(resolved.internalTools) ? resolved.internalTools.slice() : [],
    required: !!resolved.required,
    failClosed: !!resolved.failClosed,
    requiredFailureReason: resolved.requiredFailureReason || null,
  };
}

function extractAtlasJsonPayload(rawText = "") {
  const text = String(rawText || "").trim();
  if (!text) return null;
  const parsed = extractJson(text);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function _normalizeAtlasRelativePath(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw || path.isAbsolute(raw)) return null;
  const segments = raw.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function _uniqueAtlasPaths(values = [], maxItems = 100) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = _normalizeAtlasRelativePath(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
}

function _isIndexedSourcePath(filePath) {
  return isIndexableSourcePath(filePath);
}

function _truthyHint(value) {
  return value === true || String(value || "").trim().toLowerCase() === "true";
}

function _pathExistsInCwd(cwd, filePath) {
  if (!cwd || !filePath) return false;
  try {
    const abs = resolvePathWithin(cwd, filePath, { allowEqual: false });
    if (!abs) return false;
    if (isSensitiveEnvFileOrTargetPath(abs)) return false;
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function _extractMentionedRepoPathsFromText(text) {
  const body = String(text || "");
  if (!body) return [];
  const out = [];
  const re = /(?:^|[\s([{"'`])((?:[A-Za-z0-9_.@-]+[\\/])+[A-Za-z0-9_.@-]+\.[A-Za-z0-9][A-Za-z0-9._-]{0,15})(?=$|[\s)\]},:;"'`]|:\d)/gu;
  let match;
  while ((match = re.exec(body)) && out.length < ATLAS_REFERENCE_PREFETCH_MAX_FILES * 4) {
    const normalized = _normalizeAtlasRelativePath(match[1]);
    if (normalized) out.push(normalized);
  }
  return _uniqueAtlasPaths(out, ATLAS_REFERENCE_PREFETCH_MAX_FILES * 4);
}

function _collectAtlasReferenceFiles(packet) {
  const hints = packet?.context_hints || {};
  const raw = packet?._raw_payload || {};
  const excluded = _pathSet([
    ...(Array.isArray(packet?.files_to_create) ? packet.files_to_create : []),
    ...(Array.isArray(packet?.files_to_delete) ? packet.files_to_delete : []),
    ...(Array.isArray(raw.files_to_create) ? raw.files_to_create : []),
    ...(Array.isArray(raw.files_to_delete) ? raw.files_to_delete : []),
  ]);
  const taskText = [
    raw.task_spec,
    raw.instructions,
    raw.fix_instructions,
    packet?.title,
    packet?.project_context,
    Array.isArray(packet?.success_criteria) ? packet.success_criteria.join("\n") : "",
  ].filter(Boolean).join("\n");
  const candidates = _uniqueAtlasPaths([
    ...(Array.isArray(hints.atlas_reference_files) ? hints.atlas_reference_files : []),
    ...(Array.isArray(hints.atlasReferenceFiles) ? hints.atlasReferenceFiles : []),
    ...(Array.isArray(raw.atlas_reference_files) ? raw.atlas_reference_files : []),
    ...(Array.isArray(raw.atlasReferenceFiles) ? raw.atlasReferenceFiles : []),
    ..._extractMentionedRepoPathsFromText(taskText),
  ], ATLAS_REFERENCE_PREFETCH_MAX_FILES * 2);
  return candidates
    .filter((filePath) => !excluded.has(filePath.toLowerCase()))
    .filter((filePath) => _pathExistsInCwd(packet?.cwd, filePath))
    .slice(0, ATLAS_REFERENCE_PREFETCH_MAX_FILES);
}

function _collectAtlasSeedFiles(packet) {
  return _uniqueAtlasPaths([
    ..._collectValidatedAtlasSeedFiles(packet),
    ..._collectLexicalAtlasCandidateFiles(packet, 8),
  ], 30);
}

// Seeds with provenance: explicit file scope, researcher-validated seeds, and
// on-disk paths the task itself names. Everything here was put in front of the
// pipeline deliberately — unlike the lexical scan, which is a guess.
function _collectValidatedAtlasSeedFiles(packet) {
  return _uniqueAtlasPaths([
    ...(Array.isArray(packet?.files_to_modify) ? packet.files_to_modify : []),
    ...(Array.isArray(packet?.related_files) ? packet.related_files : []),
    ...(Array.isArray(packet?.context_hints?.atlas_seed_files) ? packet.context_hints.atlas_seed_files : []),
    ...(Array.isArray(packet?.context_hints?.atlasSeedFiles) ? packet.context_hints.atlasSeedFiles : []),
    ..._collectAtlasReferenceFiles(packet),
  ], 30);
}

function _collectAtlasSeedSymbols(packet, maxItems = 24) {
  const raw = [
    ...(Array.isArray(packet?.context_hints?.atlas_seed_symbols) ? packet.context_hints.atlas_seed_symbols : []),
    ...(Array.isArray(packet?.context_hints?.atlasSeedSymbols) ? packet.context_hints.atlasSeedSymbols : []),
  ];
  const out = [];
  for (const value of raw) {
    const id = typeof value === "string" ? value.trim() : "";
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Role-graded discovery inputs. Each tier holds progressively stronger data —
 * task text → researcher-validated seeds → an explicit edit set — and the
 * prefetch consumes the strongest available, dropping weaker proxies:
 *   researcher          → tree.scope(taskText + lexical guesses): nothing
 *                         better exists yet, so guessing earns its keep.
 *                         In broad entrypoint-ranking mode, lexical guesses
 *                         are not sent as exact seeds because exact seeds are
 *                         pinned ahead of the ranked production entrypoints.
 *   planner w/ seeds    → tree.scope(taskText + validated seeds), lexical
 *                         scan dropped — rg-guesses only dilute the brief.
 *   dev w/ file scope   → tree.expand(edit set), no task text — dev tasks are
 *                         narrow; growth around the edit set IS the working
 *                         set, and task terms mostly re-find the seeds.
 *   any role w/o seeds  → the researcher-shaped broad scope.
 */
export function resolveAtlasPrefetchPlan(packet, atlasConfig = packet?.atlas_config || getAtlasIntegrationConfig()) {
  const role = String(packet?.recipient || "").trim().toLowerCase();
  const validatedSeeds = _collectValidatedAtlasSeedFiles(packet);
  if (role === "dev" && validatedSeeds.length > 0) {
    return { mode: "dev-grow", action: "tree.expand", seedFiles: validatedSeeds, useTaskText: false };
  }
  if (role === "planner" && validatedSeeds.length > 0) {
    return { mode: "planner-seeded", action: "tree.scope", seedFiles: validatedSeeds, useTaskText: true };
  }
  const entrypointRank = atlasConfig?.prefetchEntrypointRank === true;
  return {
    mode: "broad",
    action: "tree.scope",
    seedFiles: entrypointRank ? validatedSeeds : _collectAtlasSeedFiles(packet),
    useTaskText: true,
  };
}

function _collectExplicitAtlasPrefetchFiles(packet) {
  const hints = packet?.context_hints || {};
  const raw = packet?._raw_payload || {};
  return _uniqueAtlasPaths([
    ...(Array.isArray(packet?.files_to_modify) ? packet.files_to_modify : []),
    ...(Array.isArray(hints.atlas_prefetch_files) ? hints.atlas_prefetch_files : []),
    ...(Array.isArray(hints.atlasPrefetchFiles) ? hints.atlasPrefetchFiles : []),
    ...(Array.isArray(hints.atlas_seed_files) ? hints.atlas_seed_files : []),
    ...(Array.isArray(hints.atlasSeedFiles) ? hints.atlasSeedFiles : []),
    ...(Array.isArray(raw.atlas_prefetch_files) ? raw.atlas_prefetch_files : []),
    ...(Array.isArray(raw.atlasPrefetchFiles) ? raw.atlasPrefetchFiles : []),
    ..._collectAtlasReferenceFiles(packet),
    ...(_truthyHint(hints.allow_related_atlas_prefetch) || _truthyHint(hints.allowRelatedAtlasPrefetch)
      ? (Array.isArray(packet?.related_files) ? packet.related_files : [])
      : []),
  ], ATLAS_EXACT_PREFETCH_MAX_FILES);
}

function _pathSet(values = []) {
  return new Set(_uniqueAtlasPaths(values).map((filePath) => filePath.toLowerCase()));
}

export function selectAtlasPrefetchTargets(packet, sliceFilePaths = []) {
  const role = String(packet?.recipient || "").trim().toLowerCase();
  const exactFiles = _collectExplicitAtlasPrefetchFiles(packet);
  const exactSet = _pathSet(exactFiles);
  const lexicalFiles = _collectLexicalAtlasCandidateFiles(packet, 8);
  const rankedFiles = _uniqueAtlasPaths([...sliceFilePaths, ...lexicalFiles], 24);
  // When explicit prefetch files exist, complement them with ATLAS-ranked
  // files that are NOT already in the exact set. The previous filter used
  // exactSet.has(...), keeping only the intersection — which is a subset
  // of exactFiles itself, making the merge a no-op and discarding the ATLAS
  // slice's discoveries entirely whenever an exact file was specified.
  const filePaths = exactFiles.length > 0
    ? _uniqueAtlasPaths([
      ...exactFiles,
      ...rankedFiles.filter((filePath) => !exactSet.has(filePath.toLowerCase())),
    ], ATLAS_SLICE_FILE_DISPLAY_MAX)
    : _uniqueAtlasPaths([...lexicalFiles, ...rankedFiles], ATLAS_SLICE_FILE_DISPLAY_MAX);
  const skeletonFiles = (role === "planner" || role === "dev")
    ? exactFiles
    : [];
  return {
    sliceSeedFiles: _collectAtlasSeedFiles(packet),
    exactFiles,
    skeletonFiles,
    filePaths,
    rankedFiles,
  };
}

function _pickObjectFields(value, fields) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  for (const field of fields) {
    if (value[field] != null) out[field] = value[field];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function projectGeneratedContextPacket(value) {
  if (!value || typeof value !== "object") return null;
  if (value.notModified) {
    return _pickObjectFields(value, ["notModified", "etag"]) || { notModified: true };
  }

  const packet = _pickObjectFields(value, [
    "taskId",
    "taskType",
    "success",
    "summary",
    "answer",
    "nextBestAction",
    "contextQuality",
    "error",
    "etag",
  ]) || {};

  const path = _pickObjectFields(value.path, [
    "rungs",
    "estimatedTokens",
    "estimatedDurationMs",
    "reasoning",
  ]);
  if (path) packet.path = path;

  if (Array.isArray(value.finalEvidence)) {
    packet.finalEvidence = value.finalEvidence.slice(0, 16).map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      return _pickObjectFields(entry, ["type", "reference", "summary"]) || entry;
    });
  }

  const metrics = _pickObjectFields(value.metrics, [
    "totalTokens",
    "totalActions",
    "successfulActions",
    "failedActions",
    "cacheHits",
  ]);
  if (metrics) packet.metrics = metrics;

  if (value.retrievalEvidence && typeof value.retrievalEvidence === "object") {
    packet.retrievalEvidence = value.retrievalEvidence;
  }

  return Object.keys(packet).length > 0 ? packet : null;
}

function buildPlannerAtlasTaskText(packet) {
  const payload = packet?._raw_payload || {};
  const parts = [
    payload.task_spec,
    packet?.title ? `Job: ${packet.title}` : "",
    packet?.project_context || "",
    Array.isArray(packet?.success_criteria) && packet.success_criteria.length > 0
      ? `Success criteria: ${packet.success_criteria.join("; ")}`
      : "",
  ].map((value) => String(value || "").trim()).filter(Boolean);
  if (parts.length === 0) return "";
  return parts.join("\n\n").slice(0, 1500);
}

function _collectAtlasDbHintPaths(packet) {
  const hints = packet?.context_hints || {};
  const raw = packet?._raw_payload || {};
  return _uniqueAtlasPaths([
    ...(Array.isArray(hints.atlas_db_prefetch_paths) ? hints.atlas_db_prefetch_paths : []),
    ...(Array.isArray(hints.atlasDbPrefetchPaths) ? hints.atlasDbPrefetchPaths : []),
    ...(Array.isArray(hints.database_prefetch_paths) ? hints.database_prefetch_paths : []),
    ...(Array.isArray(hints.databasePrefetchPaths) ? hints.databasePrefetchPaths : []),
    ...(Array.isArray(raw.atlas_db_prefetch_paths) ? raw.atlas_db_prefetch_paths : []),
    ...(Array.isArray(raw.atlasDbPrefetchPaths) ? raw.atlasDbPrefetchPaths : []),
    ...(Array.isArray(raw.database_prefetch_paths) ? raw.database_prefetch_paths : []),
    ...(Array.isArray(raw.databasePrefetchPaths) ? raw.databasePrefetchPaths : []),
  ], ATLAS_DB_PREFETCH_MAX_FILES);
}

function _looksLikeDatabasePrefetchTask(packet) {
  const raw = packet?._raw_payload || {};
  const hints = packet?.context_hints || {};
  if (_truthyHint(hints.atlas_db_prefetch) || _truthyHint(hints.database_prefetch)) return true;
  if (_truthyHint(raw.atlas_db_prefetch) || _truthyHint(raw.database_prefetch)) return true;
  if (String(packet?.task_mode || raw.task_mode || "").trim().toLowerCase() === "db") return true;
  const text = [
    buildPlannerAtlasTaskText(packet),
    raw.task_spec,
    raw.instructions,
    raw.fix_instructions,
    packet?.title,
    Array.isArray(packet?.success_criteria) ? packet.success_criteria.join(" ") : "",
  ].filter(Boolean).join("\n");
  return /\b(database|db|sql|query|queries|select|insert|update|delete|upsert|schema|migration|table|transaction|mysql|postgres|sqlite|project_db)\b/i.test(text);
}

function _existingAtlasDbRoots(cwd, values = []) {
  if (!cwd) return [];
  const out = [];
  for (const value of values) {
    const rel = _normalizeAtlasRelativePath(value);
    if (!rel) continue;
    try {
      const abs = resolvePathWithin(cwd, rel, { allowEqual: false });
      if (!abs || isSensitiveEnvFileOrTargetPath(abs)) continue;
      const stat = fs.statSync(abs);
      if ((stat.isFile() || stat.isDirectory()) && !out.includes(rel)) out.push(rel);
    } catch {
      // Drop missing or unsafe roots.
    }
    if (out.length >= ATLAS_DB_PREFETCH_MAX_FILES) break;
  }
  return out;
}

function _listAtlasDbPrefetchFiles(cwd, roots = [], maxItems = ATLAS_DB_PREFETCH_MAX_FILES) {
  if (!_isPrefetchCwdUsable(cwd)) return [];
  const safeRoots = _existingAtlasDbRoots(cwd, roots);
  try {
    const output = execFileSync("rg", [
      "-l",
      "-i",
      ...ATLAS_DB_PREFETCH_SKIP_GLOBS.flatMap((glob) => ["--glob", glob]),
      ATLAS_DB_PREFETCH_RG_PATTERN,
      ...(safeRoots.length > 0 ? safeRoots : []),
    ], {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: ATLAS_DB_PREFETCH_RG_MAX_BUFFER,
      windowsHide: true,
    });
    return _uniqueAtlasPaths(
      output.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((filePath) => filePath && _isIndexedSourcePath(filePath)),
      maxItems,
    );
  } catch {
    return [];
  }
}

function _collectAtlasDbPrefetchPaths(packet) {
  const hints = _collectAtlasDbHintPaths(packet);
  const scoped = _uniqueAtlasPaths([
    ...(Array.isArray(packet?.files_to_modify) ? packet.files_to_modify : []),
    ...(Array.isArray(packet?.related_files) ? packet.related_files : []),
    ..._collectValidatedAtlasSeedFiles(packet),
    ..._collectAtlasReferenceFiles(packet),
  ], ATLAS_DB_PREFETCH_MAX_FILES);
  const roots = hints.length > 0 ? hints : scoped;
  const grepFiles = _listAtlasDbPrefetchFiles(packet?.cwd, roots, ATLAS_DB_PREFETCH_MAX_FILES);
  return _uniqueAtlasPaths([
    ...hints,
    ...grepFiles,
    ...scoped.filter((filePath) => _isIndexedSourcePath(filePath)),
  ], ATLAS_DB_PREFETCH_MAX_FILES);
}

function _normalizeDbEngineHint(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "postgresql") return "postgres";
  if (["mysql", "postgres", "sqlite"].includes(raw)) return raw;
  return null;
}

function _resolveAtlasDbEngine(packet, queries = []) {
  const hints = packet?.context_hints || {};
  const raw = packet?._raw_payload || {};
  const hinted = [
    hints.db,
    hints.db_type,
    hints.dbType,
    hints.database_type,
    hints.databaseType,
    hints.project_db_type,
    hints.projectDbType,
    raw.db,
    raw.db_type,
    raw.dbType,
    raw.database_type,
    raw.databaseType,
    raw.project_db_type,
    raw.projectDbType,
  ].map(_normalizeDbEngineHint).find(Boolean);
  if (hinted) return hinted;
  try {
    const cfg = readProjectDbConfig({ projectDir: packet?.cwd || null });
    if (cfg?.enabled && cfg.dbType) return String(cfg.dbType).toLowerCase();
  } catch {
    // Config is optional; source inventory still has value without it.
  }
  const access = new Set((Array.isArray(queries) ? queries : []).map((query) => String(query?.access || "").toLowerCase()).filter(Boolean));
  if (access.size > 0) return "source";
  return "unknown";
}

function _normalizeDbOperation(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return key || "unknown";
}

function _dbOperationLabel(operation) {
  const key = _normalizeDbOperation(operation);
  if (key === "ddl") return "DDL";
  return key.split("_").map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : "").join(" ");
}

function _dbDisplayName(db) {
  const key = String(db || "").trim().toLowerCase();
  if (key === "mysql") return "MySql";
  if (key === "sqlite") return "SQLite";
  if (key === "postgres" || key === "postgresql") return "Postgres";
  if (key === "source") return "Source";
  return key ? `${key[0].toUpperCase()}${key.slice(1)}` : "Unknown";
}

function _dbCallerLine(query) {
  const pathLine = `${query?.path || "(unknown)"}${query?.line != null ? `:${query.line}` : ""}`;
  const target = query?.target ? ` target=${query.target}` : "";
  const symbols = _dbQuerySymbols(query);
  const symbolList = symbols.length > 0
    ? ` symbols=[${symbols.slice(0, 6).map(_dbInlineSymbolLabel).join(", ")}${symbols.length > 6 || query?.symbolsTruncated ? ", ..." : ""}]`
    : "";
  const surface = query?.symbolSurface && query.symbolSurface !== "range" && query.symbolSurface !== "none"
    ? ` symbolSurface=${query.symbolSurface}`
    : "";
  const site = query?.site ? ` site=${String(query.site).replace(/\s+/g, " ").slice(0, 120)}` : "";
  const classification = query?.classification ? ` class=${query.classification}` : "";
  const confidence = query?.confidence ? ` confidence=${query.confidence}` : "";
  return `- ${pathLine}${target}${symbolList}${surface}${classification}${confidence}${site}`;
}

function _renderDbRefPayload({ db, operation, queries }) {
  const symbols = _aggregateDbSymbols(queries);
  const lines = [
    `Database: ${_dbDisplayName(db)}`,
    `Operation: ${_dbOperationLabel(operation)}`,
    `Callers: ${queries.length}`,
    "",
  ];
  if (symbols.length > 0) {
    lines.push("Symbols:");
    for (const symbol of symbols.slice(0, 24)) lines.push(_dbSymbolLine(symbol));
    if (symbols.length > 24) lines.push(`- ... ${symbols.length - 24} more symbols`);
    lines.push("");
  }
  for (const query of queries) {
    lines.push(_dbCallerLine(query));
    if (query?.evidence) lines.push(`  evidence: ${String(query.evidence).replace(/\s+/g, " ").slice(0, 220)}`);
  }
  return lines.join("\n").trimEnd();
}

function _dbQuerySymbols(query) {
  return Array.isArray(query?.symbols)
    ? query.symbols.filter((symbol) => symbol && typeof symbol === "object")
    : [];
}

function _dbInlineSymbolLabel(symbol) {
  const name = symbol?.qualifiedName || symbol?.name || "(anonymous)";
  return `${name}#${_shortSymbolId(symbol?.symbolId)}`;
}

function _shortSymbolId(symbolId) {
  const text = String(symbolId || "");
  const idx = text.indexOf(":");
  if (idx > 0) return `${text.slice(0, 8)}${text.slice(idx)}`;
  return text.slice(0, 12);
}

function _aggregateDbSymbols(queries) {
  const byId = new Map();
  for (const query of Array.isArray(queries) ? queries : []) {
    for (const symbol of _dbQuerySymbols(query)) {
      const symbolId = String(symbol?.symbolId || "").trim();
      if (!symbolId) continue;
      const existing = byId.get(symbolId) || {
        symbolId,
        name: symbol?.name || "",
        qualifiedName: symbol?.qualifiedName || null,
        kind: symbol?.kind || "",
        path: symbol?.path || query?.path || "",
        startLine: symbol?.startLine ?? null,
        endLine: symbol?.endLine ?? null,
        operations: new Set(),
        access: new Set(),
        targets: new Set(),
        relations: new Set(),
        callers: 0,
      };
      if (query?.operation) existing.operations.add(String(query.operation));
      if (query?.access) existing.access.add(String(query.access));
      if (query?.target) existing.targets.add(String(query.target));
      if (symbol?.relation) existing.relations.add(String(symbol.relation));
      existing.callers += 1;
      byId.set(symbolId, existing);
    }
  }
  return [...byId.values()].sort((a, b) => {
    const pathCmp = String(a.path || "").localeCompare(String(b.path || ""));
    if (pathCmp) return pathCmp;
    return Number(a.startLine || 0) - Number(b.startLine || 0)
      || String(a.qualifiedName || a.name || "").localeCompare(String(b.qualifiedName || b.name || ""));
  });
}

function _dbSymbolLine(symbol) {
  const label = symbol.qualifiedName || symbol.name || "(anonymous)";
  const loc = `${symbol.path || "(unknown)"}${symbol.startLine ? `:${symbol.startLine}` : ""}${symbol.endLine && symbol.endLine !== symbol.startLine ? `-${symbol.endLine}` : ""}`;
  const access = [...symbol.access].sort().join(",");
  const operations = [...symbol.operations].sort().join(",");
  const targets = [...symbol.targets].sort().slice(0, 8).join(",");
  const relations = [...symbol.relations].sort().join(",");
  return `- ${label} [${symbol.kind || "symbol"}] ${loc} id=${symbol.symbolId} access=${access || "unknown"} operations=${operations || "unknown"}${targets ? ` targets=${targets}` : ""}${relations ? ` relation=${relations}` : ""}`;
}

function _hashRefContextForPacket(packet) {
  const obs = getObservationContext() || {};
  return {
    work_item_id: packet?.work_item_id ?? obs.work_item_id ?? null,
    job_id: packet?.job_id ?? obs.job_id ?? null,
    attempt_id: obs.attempt_id ?? null,
    agent_call_id: obs.agent_call_id ?? null,
  };
}

function _surfaceAtlasSurveyRef(packet, data) {
  const context = _hashRefContextForPacket(packet);
  const ownerScope = context.job_id != null && context.work_item_id != null
    ? "job"
    : context.work_item_id != null
      ? "work_item"
      : null;
  if (!ownerScope || !data || typeof data !== "object") return null;
  return materializeCodeSurveyPages(data, {
    context,
    ownerScope,
    source: "atlas:prefetch:code.survey",
    objectType: "atlas.code.survey",
    pageSize: SURVEY_REF_PAGE_FILES,
  });
}

export function __testSurfaceAtlasSurveyRef(packet, data) {
  assertTestContext("__testSurfaceAtlasSurveyRef");
  return _surfaceAtlasSurveyRef(packet, data);
}

function _surfaceDbBucketRef(packet, { db, operation, queries, metadata = {} }) {
  const context = _hashRefContextForPacket(packet);
  const ownerScope = context.job_id && context.work_item_id ? "job" : "work_item";
  const payloadText = _renderDbRefPayload({ db, operation, queries });
  const surfaced = surfaceHashRefForContext(context, {
    payloadText,
    objectType: "atlas_db_prefetch",
    source: "atlas:code.db",
    note: `${_dbOperationLabel(operation)} database callers (${queries.length})`,
    sizeChars: payloadText.length,
    metadata: {
      surfaced_by: "atlas_db_prefetch",
      db,
      operation,
      caller_count: queries.length,
      ...metadata,
    },
  }, { ownerScope });
  return surfaced?.ok ? surfaced.entry?.ref || null : null;
}

function _buildAtlasDbContext(packet, data, paths) {
  const queries = Array.isArray(data?.queries) ? data.queries : [];
  if (queries.length === 0) return null;
  const db = _resolveAtlasDbEngine(packet, queries);
  const byOperation = new Map();
  for (const query of queries) {
    const operation = _normalizeDbOperation(query?.operation);
    if (!byOperation.has(operation)) byOperation.set(operation, []);
    byOperation.get(operation).push(query);
  }

  const out = {
    ok: true,
    db,
    operations: {},
    counts: {},
    paths: Array.isArray(paths) ? paths.slice(0, ATLAS_DB_PREFETCH_MAX_FILES) : [],
    scanned_files: Number(data?.metrics?.scannedFileCount ?? data?.metrics?.fileCount ?? 0) || null,
    query_count: queries.length,
  };

  for (const operation of [...byOperation.keys()].sort()) {
    const bucket = byOperation.get(operation);
    const ref = _surfaceDbBucketRef(packet, { db, operation, queries: bucket });
    if (!ref) continue;
    out[operation] = ref;
    out.counts[operation] = bucket.length;
    out.operations[operation] = { ref, callers: bucket.length };
  }

  const telemetryQueries = queries.filter((query) => String(query?.classification || "").toLowerCase() === "telemetry");
  if (telemetryQueries.length > 0) {
    const ref = _surfaceDbBucketRef(packet, {
      db,
      operation: "telemetry",
      queries: telemetryQueries,
      metadata: { classification: "telemetry" },
    });
    if (ref) {
      out.telemetry = ref;
      out.telemetry_count = telemetryQueries.length;
    }
  }

  if (Object.keys(out.operations).length === 0 && !out.telemetry) return null;
  if (data?.metrics && typeof data.metrics === "object") out.metrics = data.metrics;
  if (data?.truncated != null) out.truncated = !!data.truncated;
  return out;
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function _collectLexicalAtlasCandidateFiles(packet, maxItems = 8) {
  if (!_isPrefetchCwdUsable(packet?.cwd)) return [];
  const taskText = buildPlannerAtlasTaskText(packet);
  const terms = lexicalTaskTerms(taskText);
  if (terms.length === 0) return [];
  const cacheKey = lexicalPrefetchCacheKey(packet.cwd, taskText);
  const cached = readLexicalPrefetchCache(cacheKey);
  if (cached) return diverseLexicalFiles(cached, maxItems);
  const files = listLexicalPrefetchFiles(packet.cwd);
  const scored = [];
  for (const file of files) {
    const rel = _normalizeAtlasRelativePath(file);
    if (!rel || !_isIndexedSourcePath(rel)) continue;
    if (hasLexicalPrefetchSkipSegment(rel)) continue;
    const score = lexicalFileScore(rel, terms);
    if (score > 0) scored.push({ file: rel, score });
  }
  const ranked = diverseLexicalFiles(scored
    .sort((a, b) => b.score - a.score || a.file.length - b.file.length || a.file.localeCompare(b.file))
    .map((entry) => entry.file), 24);
  writeLexicalPrefetchCache(cacheKey, ranked);
  return diverseLexicalFiles(ranked, maxItems);
}

const LEXICAL_PREFETCH_SKIP_DIRS = new Set([
  ".git",
  ".posse",
  ".posse-worktrees",
  ".posse-test-suites",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
]);

function lexicalPrefetchCacheKey(cwd, taskText) {
  let root = String(cwd || "");
  try { root = path.resolve(root); } catch { /* keep raw */ }
  return `${root}\0${String(taskText || "")}`;
}

function readLexicalPrefetchCache(key) {
  const row = LEXICAL_PREFETCH_CACHE.get(key);
  if (!row) return null;
  if (Date.now() - Number(row.at || 0) > LEXICAL_PREFETCH_CACHE_TTL_MS) {
    LEXICAL_PREFETCH_CACHE.delete(key);
    return null;
  }
  return Array.isArray(row.files) ? row.files.slice() : null;
}

function writeLexicalPrefetchCache(key, files) {
  LEXICAL_PREFETCH_CACHE.set(key, { at: Date.now(), files: files.slice(0, 24) });
  while (LEXICAL_PREFETCH_CACHE.size > LEXICAL_PREFETCH_CACHE_MAX) {
    const oldest = LEXICAL_PREFETCH_CACHE.keys().next().value;
    if (!oldest) break;
    LEXICAL_PREFETCH_CACHE.delete(oldest);
  }
}

function listLexicalPrefetchFiles(cwd) {
  try {
    const output = execFileSync("rg", ["--files"], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: LEXICAL_PREFETCH_RG_MAX_BUFFER,
      windowsHide: true,
    });
    return output.split(/\r?\n/).filter(Boolean);
  } catch {
    return walkLexicalPrefetchFiles(cwd);
  }
}

function walkLexicalPrefetchFiles(cwd) {
  const root = path.resolve(String(cwd || "."));
  const out = [];
  const stack = [{ abs: root, rel: "" }];
  while (stack.length > 0 && out.length < LEXICAL_PREFETCH_SCAN_LIMIT) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current.abs, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (LEXICAL_PREFETCH_SKIP_DIRS.has(entry.name)) continue;
        stack.push({ abs: path.join(current.abs, entry.name), rel });
      } else if (entry.isFile()) {
        out.push(rel);
        if (out.length >= LEXICAL_PREFETCH_SCAN_LIMIT) break;
      }
    }
  }
  return out;
}

function hasLexicalPrefetchSkipSegment(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => LEXICAL_PREFETCH_SKIP_DIRS.has(segment));
}

function lexicalTaskTerms(taskText) {
  const stop = new Set(["with", "from", "that", "this", "into", "only", "should", "would", "could", "there", "their", "using", "agent", "task", "work"]);
  const terms = [];
  const seen = new Set();
  for (const match of String(taskText || "").toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) {
    const term = match[0].replace(/[_-]+/g, " ").trim();
    for (const part of term.split(/\s+/)) {
      if (part.length < 3 || stop.has(part) || seen.has(part)) continue;
      seen.add(part);
      terms.push(part);
      if (terms.length >= 24) return terms;
    }
  }
  return terms;
}

function lexicalFileScore(filePath, terms) {
  const lower = filePath.toLowerCase();
  const base = path.basename(lower);
  const stem = base.replace(/\.[^.]+$/, "");
  const segments = lower.split(/[\/._-]+/).filter(Boolean);
  let score = 0;
  for (const term of terms) {
    if (segments.includes(term)) score += 7;
    else if (stem.includes(term)) score += 5;
    else if (base.includes(term)) score += 4;
    else if (lower.includes(`/${term}/`)) score += 3;
    else if (lower.includes(term)) score += 1;
  }
  if (terms.includes("api") && /(^|[._-])api([._-]|$)/.test(stem)) score += 3;
  if ((terms.includes("route") || terms.includes("page")) && /(^|[._-])(route|page|index)([._-]|$)/.test(stem)) score += 2;
  if ((terms.includes("type") || terms.includes("types")) && /(^|[._-])types?([._-]|$)/.test(stem)) score += 2;
  if (!terms.includes("test") && /(^|[\/._-])(test|spec)([\/._-]|$)/.test(lower)) score -= 2;
  return score;
}

function diverseLexicalFiles(files, maxItems) {
  const out = [];
  const familyCounts = new Map();
  for (const file of files) {
    const family = lexicalPathFamily(file);
    const count = familyCounts.get(family) || 0;
    if (count >= 3) continue;
    familyCounts.set(family, count + 1);
    out.push(file);
    if (out.length >= maxItems) break;
  }
  return out;
}

function lexicalPathFamily(filePath) {
  const parts = String(filePath || "").toLowerCase().split("/");
  if (parts.length <= 2) return parts.slice(0, -1).join("/") || ".";
  if (parts[0] === "apps" && parts[1] === "web" && parts[2] === "src") {
    return parts.slice(0, Math.min(parts.length - 1, 5)).join("/");
  }
  if (parts[0] === "www" && parts.length > 4) {
    return parts.slice(0, Math.min(parts.length - 1, 4)).join("/");
  }
  return parts.slice(0, Math.min(parts.length - 1, 3)).join("/");
}

function atlasMemoryStatsFromRepoStatus(status) {
  const data = atlasResultData("repo.status", status) || status?.data || status;
  const stats = data?.memoryStats;
  if (!stats || typeof stats !== "object") return null;
  return {
    memories: Number(stats.memories || 0),
    feedbackSignals: Number(stats.feedbackSignals || 0),
  };
}

function deriveVersionFromRepoStatus(parsed, key) {
  if (!parsed || typeof parsed !== "object") return null;
  if (key === "latest") {
    return pickFirstString(
      parsed.latestVersionId,
      parsed.latestVersion,
      parsed.versionId,
      parsed.headVersionId,
      parsed.repo?.latestVersionId,
      parsed.status?.latestVersionId,
    );
  }
  if (key === "previous") {
    return pickFirstString(
      parsed.previousVersionId,
      parsed.priorVersionId,
      parsed.lastIndexedVersionId,
      parsed.baseVersionId,
      parsed.repo?.previousVersionId,
      parsed.status?.previousVersionId,
    );
  }
  return null;
}

function _summarizeAtlasDelta(delta) {
  if (!delta || typeof delta !== "object") return null;
  return {
    ok: true,
    cardCount: Array.isArray(delta?.cards) ? delta.cards.length : (Array.isArray(delta?.c) ? delta.c.length : 0),
    filePaths: Array.isArray(delta?.files) ? delta.files.slice(0, 16) : (Array.isArray(delta?.fp) ? delta.fp.slice(0, 16) : []),
  };
}

function _summarizeAtlasRisk(risk) {
  if (!risk || typeof risk !== "object") return null;
  const findings = Array.isArray(risk?.findings) ? risk.findings : [];
  const recommendedTests = Array.isArray(risk?.recommendedTests) ? risk.recommendedTests : [];
  return {
    ok: true,
    score: Number.isFinite(Number(risk?.score)) ? Number(risk.score) : null,
    findingCount: findings.length,
    topFindings: findings.slice(0, 6).map((finding) => ({
      title: pickFirstString(finding?.title, finding?.summary, finding?.message) || "(unnamed)",
      score: Number.isFinite(Number(finding?.score)) ? Number(finding.score) : null,
    })),
    recommendedTests: recommendedTests
      .slice(0, 8)
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        if (entry && typeof entry === "object") {
          return pickFirstString(entry.path, entry.test, entry.id) || "";
        }
        return "";
      })
      .filter(Boolean),
  };
}

export async function attachAtlasAssessorPrefetch(packet) {
  try {
    if (!packet?.atlas?.active) return;
    if (packet.recipient !== "assessor") return;
    if (!_isPrefetchCwdUsable(packet.cwd)) return;
    const tools = internalAtlasTools(packet);
    if (!tools.has("repo.status")) return;

    const statusRaw = await executeEmbeddedAtlasTool("repo.status", {
      detail: "standard",
    }, {
      cwd: packet.cwd,
      config: packet.atlas_config || undefined,
      origin: "prefetch",
    });

    if (String(statusRaw || "").startsWith("Error:")) {
      return;
    }

    const status = extractAtlasJsonPayload(statusRaw);
    if (!status) {
      return;
    }

    const latestVersion = deriveVersionFromRepoStatus(status, "latest");
    const previousVersion = deriveVersionFromRepoStatus(status, "previous");

    const baseline = {
      ok: true,
      latestVersionId: latestVersion,
      previousVersionId: previousVersion,
      repoId: packet.atlas?.repo?.repoId || pickFirstString(status.repoId, status.repo?.repoId) || null,
      indexedAt: pickFirstString(status.indexedAt, status.lastIndexedAt) || null,
      health: pickFirstString(status.health, status.status?.health) || null,
    };
    const memoryStats = atlasMemoryStatsFromRepoStatus(status);
    if (memoryStats && packet.atlas) packet.atlas.memoryStats = memoryStats;

    const compositeRiskPromise = (latestVersion && previousVersion && tools.has("review.risk"))
      ? executeEmbeddedAtlasTool("review.risk", {
        fromVersion: previousVersion,
        toVersion: latestVersion,
        maxCards: 10,
        maxTokens: 1500,
      }, { cwd: packet.cwd, config: packet.atlas_config || undefined, origin: "prefetch" }).then(
        (riskRaw) => {
          if (String(riskRaw || "").startsWith("Error:")) {
            return { ok: false, error: String(riskRaw).slice(0, 300) };
          }
          const parsed = extractAtlasJsonPayload(riskRaw);
          if (!parsed) {
            return { ok: false, error: "ATLAS returned non-JSON review.risk payload." };
          }
          return {
            ok: true,
            delta: _summarizeAtlasDelta(parsed.delta),
            risk: _summarizeAtlasRisk(parsed.risk),
          };
        },
        (err) => ({ ok: false, error: String(err?.message || err).slice(0, 300) }),
      )
      : Promise.resolve(null);

    // Legacy fallback for old route packets that still expose the split ATLAS risk tools.
    const deltaPromise = (!tools.has("review.risk") && latestVersion && previousVersion && tools.has("review.delta"))
      ? executeEmbeddedAtlasTool("review.delta", {
        fromVersion: previousVersion,
        toVersion: latestVersion,
        maxCards: 10,
        maxTokens: 1500,
      }, { cwd: packet.cwd, config: packet.atlas_config || undefined, origin: "prefetch" }).then(
        (deltaRaw) => {
          if (String(deltaRaw || "").startsWith("Error:")) {
            return { ok: false, error: String(deltaRaw).slice(0, 300) };
          }
          const delta = extractAtlasJsonPayload(deltaRaw);
          return delta
            ? {
              ok: true,
              ..._summarizeAtlasDelta(delta),
            }
            : { ok: false, error: "ATLAS returned non-JSON review.delta payload." };
        },
        (err) => ({ ok: false, error: String(err?.message || err).slice(0, 300) }),
      )
      : Promise.resolve(null);

    const riskPromise = (!tools.has("review.risk") && latestVersion && previousVersion && tools.has("review.analyze"))
      ? executeEmbeddedAtlasTool("review.analyze", {
        fromVersion: previousVersion,
        toVersion: latestVersion,
      }, { cwd: packet.cwd, config: packet.atlas_config || undefined, origin: "prefetch" }).then(
        (riskRaw) => {
          if (String(riskRaw || "").startsWith("Error:")) {
            return { ok: false, error: String(riskRaw).slice(0, 300) };
          }
          const risk = extractAtlasJsonPayload(riskRaw);
          if (!risk) {
            return { ok: false, error: "ATLAS returned non-JSON review.analyze payload." };
          }
          return { ok: true, ..._summarizeAtlasRisk(risk) };
        },
        (err) => ({ ok: false, error: String(err?.message || err).slice(0, 300) }),
      )
      : Promise.resolve(null);

    const [compositeRiskResult, deltaResult, riskResult] = await Promise.all([compositeRiskPromise, deltaPromise, riskPromise]);
    if (compositeRiskResult?.ok) {
      if (compositeRiskResult.delta) baseline.delta = compositeRiskResult.delta;
      if (compositeRiskResult.risk) baseline.risk = compositeRiskResult.risk;
    } else if (compositeRiskResult) {
      baseline.risk = compositeRiskResult;
    }
    if (deltaResult) baseline.delta = deltaResult;
    if (riskResult) baseline.risk = riskResult;

    packet.atlas_assessment_baseline = baseline;
  } catch (err) {
    packet.atlas_assessment_baseline = {
      ok: false,
      error: String(err?.message || err).slice(0, 300),
    };
  }
}

export async function attachAtlasResearcherPrefetch(packet) {
  try {
    if (!packet?.atlas?.active) return;
    if (packet.recipient !== "researcher") return;
    if (!_isPrefetchCwdUsable(packet.cwd)) return;
    const tools = internalAtlasTools(packet);
    const taskText = buildPlannerAtlasTaskText(packet);
    if (!taskText) return;

    const statusPromise = tools.has("repo.status")
      ? executeEmbeddedAtlasTool("repo.status", {
        detail: "standard",
      }, {
        cwd: packet.cwd,
        config: packet.atlas_config || undefined,
        origin: "prefetch",
      }).then(
        (raw) => {
          if (String(raw || "").startsWith("Error:")) return { ok: false, error: String(raw).slice(0, 300) };
          const parsed = extractAtlasJsonPayload(raw);
          return parsed ? { ok: true, raw: parsed } : { ok: false, error: "ATLAS returned non-JSON repo.status payload." };
        },
        (err) => ({ ok: false, error: String(err?.message || err).slice(0, 300) }),
      )
      : Promise.resolve(null);

    const allowGeneratedContext = packet.context_hints?.allow_researcher_atlas_context_prefetch === true
      || packet.context_hints?.allow_researcher_atlas_context_prefetch === "true"
      || packet._raw_payload?.allow_researcher_atlas_context_prefetch === true
      || packet._raw_payload?.allow_researcher_atlas_context_prefetch === "true";
    const canFetchGeneratedContext = allowGeneratedContext && (tools.has("context") || tools.has("agent.context"));
    const contextPromise = canFetchGeneratedContext
      ? executeEmbeddedAtlasTool("context", {
        taskText,
        taskType: "explain",
        contextMode: "broad",
        maxTokens: 1600,
      }, {
        cwd: packet.cwd,
        config: packet.atlas_config || undefined,
        origin: "prefetch",
      }).then(
        (raw) => {
          if (String(raw || "").startsWith("Error:")) return { ok: false, error: String(raw).slice(0, 300) };
          const parsed = extractAtlasJsonPayload(raw);
          return parsed
            ? { ok: true, raw: parsed, packet: projectGeneratedContextPacket(parsed) }
            : { ok: false, error: "ATLAS returned non-JSON atlas.context payload." };
        },
        (err) => ({ ok: false, error: String(err?.message || err).slice(0, 300) }),
      )
      : Promise.resolve(null);

    const [status, context] = await Promise.all([statusPromise, contextPromise]);
    const memoryStats = status?.ok ? atlasMemoryStatsFromRepoStatus(status.raw) : null;
    if (memoryStats && packet.atlas) packet.atlas.memoryStats = memoryStats;
    const failures = [context].filter((entry) => entry && !entry.ok);
    const successes = [context].filter((entry) => entry?.ok);
    if (successes.length === 0 && failures.length === 0) return;
    packet.atlas_research_context = {
      ok: successes.length > 0,
      repoStatus: null,
      agentContext: context,
      error: successes.length === 0 && failures.length > 0
        ? failures.map((entry) => entry.error).filter(Boolean).join("; ").slice(0, 300)
        : null,
    };
  } catch (err) {
    packet.atlas_research_context = {
      ok: false,
      error: String(err?.message || err).slice(0, 300),
    };
  }
}

export async function attachAtlasDbPrefetch(packet) {
  try {
    if (!packet?.atlas?.active) return;
    if (packet.recipient !== "researcher" && packet.recipient !== "planner" && packet.recipient !== "dev") return;
    if (!_isPrefetchCwdUsable(packet.cwd)) return;
    if (!_looksLikeDatabasePrefetchTask(packet)) return;
    const tools = internalAtlasTools(packet);
    if (!tools.has("code.db")) return;

    const paths = _collectAtlasDbPrefetchPaths(packet);
    if (paths.length === 0) return;

    const raw = await executeEmbeddedAtlasTool("code.db", {
      paths,
      maxFiles: Math.min(ATLAS_DB_PREFETCH_MAX_FILES, paths.length),
    }, {
      cwd: packet.cwd,
      config: packet.atlas_config || undefined,
      origin: "prefetch",
    });
    if (String(raw || "").startsWith("Error:")) return;
    const parsed = extractAtlasJsonPayload(raw);
    const data = atlasResultData("code.db", parsed) || parsed;
    const context = _buildAtlasDbContext(packet, data, paths);
    if (context) packet.atlas_db_context = context;
  } catch {
    // DB prefetch is a compact side package. Missing it should not change the
    // main ATLAS fallback decision or block handoff rendering.
  }
}

// Normalize a card from either compact wire format (c[i].n/.k/.fi/.r/.sum/.sig)
// or verbose format (cards[i].name/.kind/.file/.range/.summary/.signature) into a
// single shape the renderer can consume. File paths come from the slice-level
// `fp` array (compact) or inlined on each card (verbose); we keep them as-is.
function _normalizeSliceCard(card, filePaths) {
  if (!card || typeof card !== "object") return null;
  const name = card.n || card.name || null;
  if (!name) return null;
  const kind = card.k || card.kind || null;
  let file = null;
  const catalogFile = atlasSymbolCardField(card, "filePath");
  if (typeof catalogFile === "string" && catalogFile.trim()) {
    file = catalogFile;
  } else if (card.file) {
    file = String(card.file);
  } else if (Number.isInteger(card.fi) && Array.isArray(filePaths) && filePaths[card.fi]) {
    file = String(filePaths[card.fi]);
  }
  const catalogStartLine = atlasSymbolCardField(card, "startLine");
  const startLine = Number.isInteger(catalogStartLine)
    ? catalogStartLine
    : Array.isArray(card.r) && Number.isInteger(card.r[0])
    ? card.r[0]
    : (card.range && Number.isInteger(card.range.startLine) ? card.range.startLine : null);
  const summary = card.sum || card.summary || null;
  const sigSrc = card.sig || card.signature || null;
  let signature = null;
  if (sigSrc) {
    const sigName = sigSrc.name || name;
    const params = Array.isArray(sigSrc.params)
      ? sigSrc.params.map((p) => {
        if (!p || typeof p !== "object") return "";
        const pn = p.name || "";
        const pt = p.type ? `: ${p.type}` : "";
        return `${pn}${pt}`;
      }).filter(Boolean).join(", ")
      : "";
    const returns = sigSrc.returns ? ` → ${sigSrc.returns}` : "";
    signature = `${sigName}(${params})${returns}`;
  }
  return {
    name,
    kind,
    file,
    startLine,
    summary,
    signature,
    exported: !!(card.x ?? card.exported),
  };
}

// One skeleton fetch per file per handoff: the slice/tree prefetch and the
// exact-scoped-file prefetch both want skeletons and routinely overlap on the
// same key files. Memoizing the in-flight promise on the packet keeps the
// second caller from re-running (and re-logging) an identical embedded call.
function _memoizedSkeletonFetch(packet, file, perFileTimeoutMs) {
  if (!(packet._atlasSkeletonPrefetchMemo instanceof Map)) {
    packet._atlasSkeletonPrefetchMemo = new Map();
  }
  const memo = packet._atlasSkeletonPrefetchMemo;
  const key = String(file);
  if (memo.has(key)) return memo.get(key);
  const promise = executeEmbeddedAtlasTool(
    "code.skeleton",
    { file },
    { cwd: packet.cwd, config: packet.atlas_config || undefined, timeoutMs: perFileTimeoutMs, origin: "prefetch" },
  );
  memo.set(key, promise);
  return promise;
}

async function _prefetchSliceSkeletons(filePaths, {
  packet,
  toolsAvailable,
  maxFiles = 3,
  perFileTimeoutMs = 8000,
}) {
  if (!toolsAvailable.includes("code.skeleton")) return [];
  if (!Array.isArray(filePaths) || filePaths.length === 0) return [];
  const targets = _uniqueAtlasPaths(filePaths)
    .filter((file) => _isIndexedSourcePath(file))
    .slice(0, Math.max(1, maxFiles));
  if (targets.length === 0) return [];
  const results = await Promise.all(targets.map((file) => _memoizedSkeletonFetch(packet, file, perFileTimeoutMs).then(
    (raw) => {
      if (String(raw || "").startsWith("Error:")) {
        return { file, ok: false, error: String(raw).slice(0, 240) };
      }
      const parsed = extractAtlasJsonPayload(raw);
      if (!parsed) {
        return { file, ok: false, error: "ATLAS returned non-JSON skeleton payload." };
      }
      if (parsed.notModified) {
        return { file, ok: false, error: "not modified (no skeleton returned)" };
      }
      const skeletonField = atlasResultField("code.skeleton", parsed, "content");
      const skeleton = typeof skeletonField === "string"
        ? skeletonField
        : (typeof parsed.skeleton === "string" ? parsed.skeleton : null);
      if (!skeleton) {
        return { file, ok: false, error: "skeleton field missing" };
      }
      const fileField = atlasResultField("code.skeleton", parsed, "filePath");
      return {
        file: typeof fileField === "string" && fileField ? fileField : (parsed.file || file),
        ok: true,
        skeleton,
        truncated: !!parsed.truncated,
        estimatedTokens: Number.isFinite(Number(parsed.estimatedTokens)) ? Number(parsed.estimatedTokens) : null,
        originalLines: Number.isFinite(Number(parsed.originalLines)) ? Number(parsed.originalLines) : null,
      };
    },
    (err) => ({ file, ok: false, error: String(err?.message || err).slice(0, 240) }),
  )));
  return results;
}

function _truncateUtf8String(text, maxBytes) {
  let used = 0;
  let out = "";
  for (const char of String(text || "")) {
    const next = Buffer.byteLength(char, "utf8");
    if (used + next > maxBytes) break;
    out += char;
    used += next;
  }
  return out;
}

function _truncateUtf8AtLineBoundary(content, maxBytes) {
  const text = String(content || "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { content: text, truncated: false };
  }
  const lines = text.split(/\r?\n/u);
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const prefix = kept.length > 0 ? "\n" : "";
    const nextBytes = Buffer.byteLength(prefix + line, "utf8");
    if (used + nextBytes <= maxBytes) {
      kept.push(line);
      used += nextBytes;
      continue;
    }
    if (kept.length === 0) {
      return { content: _truncateUtf8String(line, maxBytes), truncated: true };
    }
    break;
  }
  return { content: kept.join("\n"), truncated: true };
}

function _countReturnedLines(content, requestedLines) {
  if (content === "") return requestedLines > 0 ? 1 : 0;
  return String(content).split(/\r?\n/u).length;
}

async function _prefetchExactScopedFiles(filePaths, {
  packet,
  toolsAvailable,
  maxFiles = ATLAS_EXACT_PREFETCH_MAX_FILES,
  perFileTimeoutMs = 8000,
}) {
  const targets = _uniqueAtlasPaths(filePaths, maxFiles);
  if (targets.length === 0) return [];
  const tools = new Set(Array.isArray(toolsAvailable) ? toolsAvailable : []);

  const readFile = async (file) => {
    try {
      // Realpath-based containment (symlink-safe) + sensitive-env skip, matching
      // the guards every other handoff read path enforces (see file-attach.js).
      const absolute = resolvePathWithin(packet.cwd || ".", file, { allowEqual: false });
      if (!absolute) {
        return { file, ok: false, kind: "read_file", error: "path escaped repository root" };
      }
      if (isSensitiveEnvFileOrTargetPath(absolute)) {
        return { file, ok: false, kind: "read_file", error: "sensitive_env file skipped" };
      }
      // Async read: keeps the disk wait on the libuv threadpool so the worker's
      // event loop — which the scheduler's lock-renewal timer shares — is not
      // blocked. The previous readFileSync froze the loop ~2-3s per prefetch
      // batch (measured), stacking into the lock-renewal "starved" warnings.
      const source = await fs.promises.readFile(absolute, "utf8");
      const totalBytes = Buffer.byteLength(source, "utf8");
      const allLines = source.split(/\r?\n/);
      const limitedLines = allLines.slice(0, ATLAS_EXACT_PREFETCH_MAX_LINES);
      let content = limitedLines.join("\n");
      let truncated = limitedLines.length < allLines.length;
      const capped = _truncateUtf8AtLineBoundary(content, ATLAS_EXACT_PREFETCH_MAX_BYTES);
      content = capped.content;
      if (capped.truncated) truncated = true;
      const bytes = Buffer.byteLength(content, "utf8");
      const returnedLines = _countReturnedLines(content, limitedLines.length);
      return {
        file,
        ok: true,
        kind: "read_file",
        content,
        bytes,
        totalBytes,
        totalLines: allLines.length,
        returnedLines,
        truncated,
      };
    } catch (err) {
      return { file, ok: false, kind: "read_file", error: String(err?.message || err).slice(0, 240) };
    }
  };

  const readSkeleton = (file) => _memoizedSkeletonFetch(packet, file, perFileTimeoutMs).then(
    (raw) => {
      if (String(raw || "").startsWith("Error:")) {
        return { file, ok: false, kind: "code.skeleton", error: String(raw).slice(0, 240) };
      }
      const parsed = extractAtlasJsonPayload(raw);
      if (!parsed) {
        return { file, ok: false, kind: "code.skeleton", error: "ATLAS returned non-JSON skeleton payload." };
      }
      const skeletonField = atlasResultField("code.skeleton", parsed, "content");
      const skeleton = typeof skeletonField === "string"
        ? skeletonField
        : (typeof parsed.skeleton === "string" ? parsed.skeleton : "");
      if (!skeleton) {
        return { file, ok: false, kind: "code.skeleton", error: "skeleton field missing" };
      }
      const fileField = atlasResultField("code.skeleton", parsed, "filePath");
      return {
        file: typeof fileField === "string" && fileField ? fileField : (parsed.file || file),
        ok: true,
        kind: "code.skeleton",
        skeleton,
        truncated: !!parsed.truncated,
        estimatedTokens: Number.isFinite(Number(parsed.estimatedTokens)) ? Number(parsed.estimatedTokens) : null,
        originalLines: Number.isFinite(Number(parsed.originalLines)) ? Number(parsed.originalLines) : null,
      };
    },
    (err) => ({ file, ok: false, kind: "code.skeleton", error: String(err?.message || err).slice(0, 240) }),
  );

  return Promise.all(targets.map((file) => {
    if (!_isIndexedSourcePath(file)) return readFile(file);
    if (tools.has("code.skeleton")) return readSkeleton(file);
    return {
      file,
      ok: false,
      kind: _isIndexedSourcePath(file) ? "code.skeleton" : "read_file",
      error: "required ATLAS exact-file tool is not routed to this role",
    };
  }));
}

export async function __testPrefetchExactScopedFiles(filePaths, opts = {}) {
  assertTestContext("__testPrefetchExactScopedFiles");
  return await _prefetchExactScopedFiles(filePaths, opts);
}

export function atlasSliceSkeletonPrefetchLimit(recipient) {
  const role = String(recipient || "").trim().toLowerCase();
  if (role === "planner") return 3;
  if (role === "dev") return 2;
  return 0;
}

const ATLAS_TREE_SCOPE_MAX_FILES = 24;
const ATLAS_TREE_SCOPE_RANK_POOL_FILES = 40;

function _atlasConfidenceBand(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.max(0, Math.min(1, n));
  if (clamped >= 0.75) return "high";
  if (clamped >= 0.45) return "medium";
  return "low";
}


function _atlasCandidateVersionFamily(filePath) {
  const parts = String(filePath || "").replace(/\\/g, "/").split("/");
  for (let index = 0; index < parts.length - 1; index += 1) {
    const match = /^v(\d+)$/i.exec(parts[index]);
    if (match) {
      return {
        prefix: parts.slice(0, index).join("/").toLowerCase(),
        label: parts[index].toLowerCase(),
        version: Number(match[1]),
      };
    }
  }
  return null;
}

function _atlasPrefetchCandidateScore(entry, versionFamilies, taskText) {
  const score = Number(entry?.score || 0);
  const family = _atlasCandidateVersionFamily(entry?.path);
  if (!family || family.version >= (versionFamilies.get(family.prefix) || family.version)) {
    return score;
  }
  const mentioned = String(taskText || "").toLowerCase().split(/[^a-z0-9]+/).includes(family.label);
  return mentioned ? score : score * 0.65;
}


export function rankAtlasTreeScopeCandidates(candidates, {
  prefetchMode = null,
  entrypointRank = false,
  taskText = "",
  maxFiles = ATLAS_TREE_SCOPE_MAX_FILES,
} = {}) {
  const rows = (Array.isArray(candidates) ? candidates : [])
    .filter((entry) => entry && !entry.generated);
  if (!entrypointRank || prefetchMode !== "broad") return rows.slice(0, maxFiles);
  const versionFamilies = new Map();
  for (const entry of rows) {
    const family = _atlasCandidateVersionFamily(entry.path);
    if (family) versionFamilies.set(family.prefix, Math.max(versionFamilies.get(family.prefix) || 0, family.version));
  }
  return rows
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aNonProduction = !!(a.entry.test || a.entry.example || a.entry.config);
      const bNonProduction = !!(b.entry.test || b.entry.example || b.entry.config);
      if (aNonProduction !== bNonProduction) return aNonProduction ? 1 : -1;
      const scoreDelta = _atlasPrefetchCandidateScore(b.entry, versionFamilies, taskText)
        - _atlasPrefetchCandidateScore(a.entry, versionFamilies, taskText);
      return scoreDelta || a.index - b.index;
    })
    .slice(0, maxFiles)
    .map(({ entry }) => entry);
}

// Tree-first discovery: condense the task text + known seed files into the
// tree-derived candidate scope (deterministic containment tree + scope sidecar
// + compressed-tree seed annotations). When usable, this IS the handoff
// prefetch; the graph slice only runs as a fallback when the tree is
// unavailable or empty.
async function _prefetchAtlasTreeScope(packet, { taskText = null, seedFiles, action = "tree.scope", prefetchMode = null, atlasConfig = null }) {
  try {
    const effectiveAtlasConfig = atlasConfig || packet.atlas_config || getAtlasIntegrationConfig();
    const entrypointRank = effectiveAtlasConfig?.prefetchEntrypointRank === true && prefetchMode === "broad";
    const raw = await executeEmbeddedAtlasTool(action, {
      ...(taskText ? { taskText } : {}),
      paths: seedFiles,
      maxFiles: entrypointRank
        ? ATLAS_TREE_SCOPE_RANK_POOL_FILES
        : ATLAS_TREE_SCOPE_MAX_FILES,
    }, {
      cwd: packet.cwd,
      config: effectiveAtlasConfig
        ? { ...effectiveAtlasConfig, prefetchEntrypointRank: entrypointRank }
        : undefined,
      origin: "prefetch",
    });
    if (String(raw || "").startsWith("Error:")) {
      return { ok: false, action, error: String(raw).slice(0, 300) };
    }
    const parsed = extractAtlasJsonPayload(raw);
    if (!parsed) {
      return { ok: false, action, error: `ATLAS returned non-JSON ${action} payload.` };
    }
    const data = atlasResultData(action, parsed) || {};
    if (data.available === false) {
      return { ok: false, action, error: String(data.reason || `${action}_unavailable`).slice(0, 300) };
    }
    const rawCandidates = atlasResultField(action, parsed, "candidateFiles");
    const candidates = rankAtlasTreeScopeCandidates(rawCandidates, {
      prefetchMode,
      entrypointRank,
      taskText,
    });
    const candidateFiles = _uniqueAtlasPaths(
      candidates.map((entry) => entry.path),
      ATLAS_TREE_SCOPE_MAX_FILES,
    );
    const rawDirs = atlasResultField(action, parsed, "candidateDirs");
    const candidateDirs = (Array.isArray(rawDirs) ? rawDirs : [])
      .map((entry) => (entry && typeof entry.path === "string" ? entry.path : null))
      .filter(Boolean)
      .slice(0, 6);
    const metrics = atlasResultField(action, parsed, "metrics") || {};
    const compression = atlasResultField(action, parsed, "compression") || null;
    // Surface the scope-widening sidecar (callers of the seed from outside its
    // area), carrying each caller's fan-in so the render can ELEVATE a
    // load-bearing hub by name — surfacing the path alone was shown insufficient.
    const widening = data?.sidecar?.scopeWidening;
    const scopeWidening =
      widening?.used && Array.isArray(widening.callers)
        ? widening.callers.filter((c) => c && typeof c.path === "string").slice(0, 8)
        : (widening?.used && Array.isArray(widening.paths)
            ? _uniqueAtlasPaths(widening.paths, 8).map((p) => ({ path: p, callerName: null, callerCount: 0, loadBearing: false }))
            : []);
    return {
      ok: true,
      action,
      candidateFiles,
      candidateDirs,
      scopeRisk: metrics.scopeRisk || null,
      // Banded, not numeric: an unanchored "0.83" means nothing to the agent
      // reading the handoff; "high" does. Ranking already happened upstream.
      confidence: _atlasConfidenceBand(metrics.confidence),
      candidateFileCount: Number(metrics.candidateFileCount || candidateFiles.length),
      compressionSeeds: Array.isArray(compression?.matchedSeeds) ? compression.matchedSeeds.slice(0, 6) : [],
      areaMap: Array.isArray(compression?.areaMap) ? compression.areaMap.slice(0, 16) : [],
      scopeWidening,
    };
  } catch (err) {
    return { ok: false, action, error: String(err?.message || err).slice(0, 300) };
  }
}

export function atlasAreaMapFromTreeScope(treeScope) {
  return Array.isArray(treeScope?.areaMap) ? treeScope.areaMap.slice(0, 16) : [];
}

// Top-level orientation fallback for handoffs whose tree.scope/tree.expand did
// not already carry the compressed-tree area map. This is deliberately
// bounded below the whole handoff budget: orientation is optional and must not
// discard a usable scope result if tree.overview stalls on a very large tree.
async function _prefetchAtlasAreaMap(packet) {
  try {
    const raw = await executeEmbeddedAtlasTool("tree.overview", {
      maxDepth: 0,
      limit: 1,
      includeLatestRun: false,
    }, {
      cwd: packet.cwd,
      config: packet.atlas_config || undefined,
      origin: "prefetch",
      timeoutMs: ATLAS_AREA_MAP_PREFETCH_TIMEOUT_MS,
    });
    if (String(raw || "").startsWith("Error:")) return [];
    const parsed = extractAtlasJsonPayload(raw);
    const areaMap = atlasResultField("tree.overview", parsed, "areaMap");
    return Array.isArray(areaMap) ? areaMap.slice(0, 16) : [];
  } catch {
    return [];
  }
}

// Batch-hydrate the brief's key symbols (researcher-validated symbol IDs) so
// planner/dev open with the cards already in hand instead of re-searching.
async function _prefetchSeedSymbolCards(packet, { symbolIds }) {
  try {
    const raw = await executeEmbeddedAtlasTool("symbol.card", { symbolIds }, {
      cwd: packet.cwd,
      config: packet.atlas_config || undefined,
      origin: "prefetch",
    });
    if (String(raw || "").startsWith("Error:")) return [];
    const parsed = extractAtlasJsonPayload(raw);
    const cards = Array.isArray(parsed?.cards) ? parsed.cards : [];
    return cards.slice(0, 12).map((card) => ({
      name: card?.name || card?.symbolId || "(unnamed)",
      kind: card?.kind || null,
      file: card?.location?.repo_rel_path || null,
      startLine: Number.isInteger(card?.location?.startLine) ? card.location.startLine : null,
      summary: card?.summary || null,
      signature: typeof card?.signature === "string" ? card.signature : null,
    }));
  } catch {
    return [];
  }
}

export async function attachAtlasPlannerSlice(packet) {
  try {
    if (!packet?.atlas?.active) return;
    if (packet.recipient !== "researcher" && packet.recipient !== "planner" && packet.recipient !== "dev") return;
    if (!_isPrefetchCwdUsable(packet.cwd)) return;
    const tools = internalAtlasTools(packet);
    if (!tools.has("tree.scope") && !tools.has("slice.build")) return;

    const taskText = buildPlannerAtlasTaskText(packet);
    if (!taskText) return;

    // Role-graded inputs: consume the strongest data this tier holds (see
    // resolveAtlasPrefetchPlan). Tree-first: when the tree pass is usable it
    // IS the prefetch — no graph slice runs; slice.build remains only as the
    // fallback when the tree is unavailable or produced nothing.
    const atlasConfig = packet.atlas_config || getAtlasIntegrationConfig();
    const plan = resolveAtlasPrefetchPlan(packet, atlasConfig);
    const seedSymbols = _collectAtlasSeedSymbols(packet);
    const treeAction = plan.action === "tree.expand" && tools.has("tree.expand") ? "tree.expand" : "tree.scope";
    const treeToolAvailable = tools.has("tree.scope") || (plan.action === "tree.expand" && tools.has("tree.expand"));
    const wantSymbolCards = seedSymbols.length > 0 && tools.has("symbol.card");

    let treeScope = null;
    let seedSymbolCards = [];
    let areaMap = [];
    if (treeToolAvailable || wantSymbolCards || tools.has("tree.overview")) {
      packet.atlas_slice_prefetch_attempted = true;
      [treeScope, seedSymbolCards] = await Promise.all([
        treeToolAvailable
          ? _prefetchAtlasTreeScope(packet, {
            taskText: plan.useTaskText ? taskText : null,
            seedFiles: plan.seedFiles,
            action: treeAction,
            prefetchMode: plan.mode,
            atlasConfig,
          })
          : Promise.resolve(null),
        wantSymbolCards
          ? _prefetchSeedSymbolCards(packet, { symbolIds: seedSymbols })
          : Promise.resolve([]),
      ]);
    }
    // tree.scope/tree.expand already carries the same compressed-tree area map.
    // Reuse it instead of redundantly traversing the entire tree. Only the
    // slice-fallback path needs the separately bounded overview request.
    areaMap = atlasAreaMapFromTreeScope(treeScope);
    if (areaMap.length === 0 && tools.has("tree.overview")) {
      areaMap = await _prefetchAtlasAreaMap(packet);
    }

    if (treeScope?.ok && treeScope.candidateFiles.length > 0) {
      await _attachAtlasTreePrefetchContext(packet, { tools, treeScope, seedSymbolCards, areaMap, prefetchMode: plan.mode, taskText, seedSymbols });
      return;
    }

    await _attachAtlasSlicePrefetchContext(packet, { tools, taskText, seedFiles: plan.seedFiles, treeScope, seedSymbolCards, areaMap });
  } catch (err) {
    packet.atlas_slice_context = {
      ok: false,
      error: String(err?.message || err).slice(0, 300),
    };
  }
}

// Tree-sourced prefetch context. Shares the slice context's shape (cards stay
// an empty list) so every downstream consumer — relevance classification,
// insight promotion, step-0 insights — keeps working unchanged; `source`
// tells the renderer which discovery pass produced the candidates.
async function _attachAtlasTreePrefetchContext(packet, { tools, treeScope, seedSymbolCards = [], areaMap = [], prefetchMode = null, taskText = null, seedSymbols = [] }) {
  const prefetchTargets = selectAtlasPrefetchTargets(packet, treeScope.candidateFiles);
  packet.atlas_slice_candidates = {
    filePaths: prefetchTargets.filePaths,
    rankedFiles: prefetchTargets.rankedFiles,
    exactFiles: prefetchTargets.exactFiles,
    cards: [],
  };

  const exactFiles = await _prefetchExactScopedFiles(prefetchTargets.exactFiles, {
    packet,
    toolsAvailable: [...tools],
    maxFiles: ATLAS_EXACT_PREFETCH_MAX_FILES,
  });

  // Area handoffs: pre-surface a compact code.survey summary plus a job-visible
  // hash and ten-file continuation pages. The agent can expand the exact
  // prefetched result without executing the survey again. Any miss falls back
  // to the skeleton pass below.
  // Embedded prefetch call: code.survey runs via executeEmbeddedAtlasTool
  // (origin:"prefetch") and does NOT require the agent/internal tool surface to
  // expose it (it is an agent-surface action, absent from internalAtlasTools).
  // The tree-prefetch gate above already ensured ATLAS is usable; any survey
  // miss returns { ok:false } and falls back to the skeleton pass below.
  // Include tree.scope's widened caller paths (callers reaching the seeds from
  // OUTSIDE their area) in the survey candidate set. On fan-in/inventory tasks
  // the answer lives in these sibling files; adding them both puts them in the
  // file-list survey and dilutes any single-dir dominance.
  const wideningCallerPaths = Array.isArray(treeScope.scopeWidening)
    ? treeScope.scopeWidening.map((c) => (c && typeof c === "object" ? c.path : c)).filter(Boolean)
    : [];
  const surveyRankedFiles = _uniqueAtlasPaths(
    [...(Array.isArray(prefetchTargets.rankedFiles) ? prefetchTargets.rankedFiles : []), ...wideningCallerPaths],
    MAX_SURVEY_FILES,
  );
  const surveyContext = await _prefetchAtlasSurvey(packet, {
    taskText,
    rankedFiles: surveyRankedFiles,
    candidateDirs: Array.isArray(treeScope.candidateDirs) ? treeScope.candidateDirs : [],
    seedFiles: prefetchTargets.exactFiles,
    keySymbols: seedSymbols,
  });
  const surveyOk = surveyContext?.ok === true;

  // The compact survey evidence is rendered even at higher trim levels. If the
  // survey is unavailable, keep a bounded structural floor by skeletonizing
  // the top ranked files instead of only explicit prefetch files.
  const skeletonMaxFiles = atlasSliceSkeletonPrefetchLimit(packet.recipient);
  const exactOkPaths = _pathSet(exactFiles.filter((item) => item?.ok).map((item) => item.file));
  const skeletons = (!surveyOk && skeletonMaxFiles > 0)
    ? await _prefetchSliceSkeletons(_atlasSkeletonFloorFiles(prefetchTargets).filter((file) => !exactOkPaths.has(file.toLowerCase())), {
      packet,
      toolsAvailable: [...tools],
      maxFiles: skeletonMaxFiles,
    })
    : [];

  packet.atlas_slice_context = {
    ok: true,
    source: treeScope.action === "tree.expand" ? "tree.expand" : "tree.scope",
    prefetchMode,
    seedSymbolCards,
    areaMap,
    sliceHandle: null,
    knownVersion: null,
    ledgerVersion: null,
    repoId: packet.atlas?.repo?.repoId || null,
    cardCount: 0,
    cards: [],
    filePaths: prefetchTargets.filePaths,
    rankedFiles: prefetchTargets.rankedFiles,
    exactFiles,
    frontier: [],
    skeletons,
    surveyContext,
    treeScope,
  };
}

function _atlasSkeletonFloorFiles(prefetchTargets = {}) {
  return _uniqueAtlasPaths([
    ...(Array.isArray(prefetchTargets.skeletonFiles) ? prefetchTargets.skeletonFiles : []),
    ...(Array.isArray(prefetchTargets.rankedFiles) ? prefetchTargets.rankedFiles : []),
    ...(Array.isArray(prefetchTargets.filePaths) ? prefetchTargets.filePaths : []),
  ], ATLAS_SLICE_FILE_DISPLAY_MAX);
}

// Prefetch a code.survey for area-shaped handoffs. Scope (dir vs file-list,
// symbols) is chosen by the pure chooseSurveyScope ladder from the relevance
// signal the tree pass already produced. origin:"prefetch" -> logs as
// tool.atlas.prefetch/code.survey (system lane). Never throws; a miss returns
// { ok:false } and the caller falls back to the skeleton pass.
async function _prefetchAtlasSurvey(packet, { taskText, rankedFiles, candidateDirs, seedFiles, keySymbols }) {
  const startedAt = Date.now();
  let scope = null;
  try {
    scope = chooseSurveyScope(
      { taskText, rankedFiles, candidateDirs, seedFiles, keySymbols },
      defaultSurveyScopeDeps(packet.cwd),
    );
    if (!scope.inject) {
      return _finishAtlasSurveyPrefetch(packet, { ok: false, attempted: false, scope }, startedAt);
    }
    const args = { paths: scope.paths, maxFiles: MAX_SURVEY_FILES };
    if (scope.symbols) args.symbols = scope.symbols;
    const { raw, retries } = await _executeAtlasSurveyWithRetry(args, {
      cwd: packet.cwd,
      config: packet.atlas_config || undefined,
      origin: "prefetch",
    });
    if (String(raw || "").startsWith("Error:")) {
      return _finishAtlasSurveyPrefetch(packet, { ok: false, attempted: true, scope, error: String(raw).slice(0, 200), retries }, startedAt);
    }
    let data = extractAtlasJsonPayload(raw);
    data = data?.result ?? data?.data ?? data;
    if (!data || !Array.isArray(data.files) || data.files.length === 0) {
      return _finishAtlasSurveyPrefetch(packet, {
        ok: false,
        attempted: true,
        scope,
        error: "survey returned no files",
        metrics: data?.metrics || null,
        retries,
      }, startedAt);
    }
    const evidenceRef = _surfaceAtlasSurveyRef(packet, data);
    return _finishAtlasSurveyPrefetch(packet, {
      ok: true,
      attempted: true,
      scope,
      symbols: scope.symbols || null,
      files: data.files,
      callMap: data.callMap || null,
      metrics: data.metrics || null,
      granularity: data.granularity || null,
      truncated: !!data.truncated,
      evidenceRef,
      retries,
    }, startedAt);
  } catch (err) {
    return _finishAtlasSurveyPrefetch(packet, {
      ok: false,
      attempted: !!scope?.inject,
      scope,
      error: String(err?.message || err).slice(0, 200),
    }, startedAt);
  }
}

async function _executeAtlasSurveyWithRetry(args, opts) {
  let raw = await executeEmbeddedAtlasTool("code.survey", args, opts);
  if (!_isTransientAtlasSurveyError(raw)) return { raw, retries: 0 };
  await new Promise((resolve) => setTimeout(resolve, 150));
  raw = await executeEmbeddedAtlasTool("code.survey", args, opts);
  return { raw, retries: 1 };
}

function _isTransientAtlasSurveyError(raw) {
  const text = String(raw || "");
  if (!text.startsWith("Error:")) return false;
  return /\b(timeout|timed out|busy|locked|sqlite_busy|gate|temporarily disabled|transport|econnreset|epipe)\b/i.test(text);
}

function _finishAtlasSurveyPrefetch(packet, result, startedAt) {
  const durationMs = Date.now() - startedAt;
  const out = { ...result, durationMs };
  _recordAtlasSurveyPrefetchDiagnostic(packet, out);
  return _compactAtlasSurveyPrefetchResult(out, {
    edgeLimit: _surveyBriefEdgeLimit(packet),
  });
}

const MAX_SURVEY_BRIEF_FILES = 10;
const MAX_SURVEY_BRIEF_EDGES = 8;
const MAX_SURVEY_BRIEF_SYMBOLS = 8;
const MAX_SURVEY_BRIEF_SYMBOLS_PER_FILE = 4;
const SURVEY_REF_PAGE_FILES = 10;

function _surveyBriefEdgeLimit(packet) {
  const config = packet?.atlas_config || getAtlasIntegrationConfig();
  const parsed = Number(config?.surveyBriefEdgeCount);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(32, Math.floor(parsed))) : MAX_SURVEY_BRIEF_EDGES;
}

function _compactAtlasSurveyPrefetchResult(result, { edgeLimit = MAX_SURVEY_BRIEF_EDGES } = {}) {
  if (!result?.ok) return result;
  const files = Array.isArray(result.files) ? result.files : [];
  const callMap = result.callMap && typeof result.callMap === "object" ? result.callMap : null;
  const metrics = result.metrics && typeof result.metrics === "object" ? result.metrics : {};
  const summary = _compactSurveyCallMap(callMap, metrics, { edgeLimit });
  const fileCount = Number.isFinite(Number(metrics.fileCount))
    ? Number(metrics.fileCount)
    : files.length;
  const fileSummaries = files.slice(0, MAX_SURVEY_BRIEF_FILES).map((file) => ({
    path: String(file?.path || "").trim(),
    symbolCount: Number.isFinite(Number(file?.symbolCount))
      ? Number(file.symbolCount)
      : (Array.isArray(file?.symbols) ? file.symbols.length : 0),
    truncated: !!file?.truncated,
    symbols: (Array.isArray(file?.symbols) ? file.symbols : [])
      .slice(0, MAX_SURVEY_BRIEF_SYMBOLS_PER_FILE)
      .map((symbol) => ({
        name: String(symbol?.qualifiedName || symbol?.name || "").trim(),
        kind: String(symbol?.kind || "symbol").trim(),
        line: Number.isFinite(Number(symbol?.line ?? symbol?.startLine))
          ? Number(symbol.line ?? symbol.startLine)
          : null,
      }))
      .filter((symbol) => symbol.name),
  })).filter((file) => file.path);
  return {
    ok: true,
    attempted: !!result.attempted,
    scope: result.scope || null,
    symbols: result.symbols || null,
    metrics,
    granularity: result.granularity || null,
    truncated: !!result.truncated,
    retries: Number(result.retries || 0),
    durationMs: result.durationMs,
    fileCount,
    fileSummaries,
    topFiles: fileSummaries.map((file) => file.path),
    callMapSummary: summary,
    evidenceRef: result.evidenceRef || null,
    fullPayloadOmitted: true,
  };
}

function _compactSurveyCallMap(callMap, metrics = {}, { edgeLimit = MAX_SURVEY_BRIEF_EDGES } = {}) {
  const internal = Array.isArray(callMap?.edges) ? callMap.edges : [];
  const inbound = Array.isArray(callMap?.inbound) ? callMap.inbound : [];
  const outbound = Array.isArray(callMap?.outbound) ? callMap.outbound : [];
  const unresolved = Array.isArray(callMap?.unresolved) ? callMap.unresolved : [];
  const topEdges = _compactSurveyTopEdges({ inbound, outbound, internal, unresolved }, edgeLimit);
  return {
    counts: {
      internal: _finiteMetric(metrics.internalEdgeCount, internal.length),
      inbound: _finiteMetric(metrics.inboundEdgeCount, inbound.length),
      outbound: _finiteMetric(metrics.outboundEdgeCount, outbound.length),
      unresolved: _finiteMetric(metrics.unresolvedEdgeCount, unresolved.length),
    },
    topEdges,
    topSymbols: _compactSurveyEdgeSymbols(topEdges, edgeLimit > MAX_SURVEY_BRIEF_EDGES ? 16 : MAX_SURVEY_BRIEF_SYMBOLS),
    truncated: !!(callMap?.edgesTruncated || callMap?.inboundTruncated || callMap?.outboundTruncated),
  };
}

function _compactSurveyTopEdges({ inbound = [], outbound = [], internal = [], unresolved = [] } = {}, limit = MAX_SURVEY_BRIEF_EDGES) {
  const boundedLimit = Math.max(0, Math.min(32, Math.floor(Number(limit) || 0)));
  const groups = [
    _compactSurveyEdges(inbound, "inbound", boundedLimit),
    _compactSurveyEdges(outbound, "outbound", boundedLimit),
    _compactSurveyEdges(internal, "internal", boundedLimit),
    _compactSurveyEdges(unresolved, "unresolved", boundedLimit),
  ];
  if (boundedLimit <= MAX_SURVEY_BRIEF_EDGES) return groups.flat().slice(0, boundedLimit);

  // Expanded previews should reveal more kinds of topology, not merely extend
  // a long list of inbound test hubs. Round-robin each count-ranked category;
  // the complete unabridged map remains in the retained survey pages.
  const balanced = [];
  for (let rank = 0; balanced.length < boundedLimit; rank += 1) {
    let added = false;
    for (const group of groups) {
      if (!group[rank]) continue;
      balanced.push(group[rank]);
      added = true;
      if (balanced.length >= boundedLimit) break;
    }
    if (!added) break;
  }
  return balanced;
}

function _finiteMetric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function _compactSurveyEdges(edges, kind, limit) {
  if (!Array.isArray(edges) || limit <= 0) return [];
  return edges
    .map((edge) => ({
      kind,
      from: _compactSurveySymbolName(edge?.from),
      to: _compactSurveySymbolName(edge?.to),
      count: _finiteMetric(edge?.count, 1),
    }))
    .filter((edge) => edge.from || edge.to)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function _compactSurveySymbolName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function _compactSurveyEdgeSymbols(edges, limit = MAX_SURVEY_BRIEF_SYMBOLS) {
  const counts = new Map();
  let order = 0;
  for (const edge of Array.isArray(edges) ? edges : []) {
    const count = _finiteMetric(edge?.count, 1);
    for (const endpoint of [edge?.from, edge?.to]) {
      const symbol = _compactSurveySymbolName(endpoint);
      if (!symbol) continue;
      const current = counts.get(symbol);
      if (current) {
        current.count += count;
      } else {
        counts.set(symbol, { symbol, count, order: order++ });
      }
    }
  }
  return [...counts.values()]
    .sort((a, b) => a.order - b.order || b.count - a.count)
    .slice(0, Math.max(0, Number(limit) || 0))
    .map(({ symbol, count }) => ({ symbol, count }));
}

function _recordAtlasSurveyPrefetchDiagnostic(packet, result) {
  try {
    const context = getObservationContext() || {};
    const metrics = result?.metrics && typeof result.metrics === "object" ? result.metrics : {};
    const fileCount = Array.isArray(result?.files)
      ? result.files.length
      : (Number.isFinite(Number(metrics.fileCount)) ? Number(metrics.fileCount) : null);
    const internalEdgeCount = Number.isFinite(Number(metrics.internalEdgeCount))
      ? Number(metrics.internalEdgeCount)
      : (Array.isArray(result?.callMap?.edges) ? result.callMap.edges.length : null);
    const status = result?.ok ? "ok" : result?.attempted ? "miss" : "skipped";
    recordObservation({
      work_item_id: context.work_item_id ?? packet?.work_item_id ?? null,
      job_id: context.job_id ?? packet?.job_id ?? null,
      attempt_id: context.attempt_id ?? null,
      observation_type: "atlas.prefetch.survey",
      summary: `ATLAS code.survey prefetch ${status} (${_formatSurveyScopeCompact(result?.scope)})${result?.durationMs != null ? ` (${result.durationMs}ms)` : ""}`,
      detail: {
        kind: "atlas_survey_prefetch",
        origin: "prefetch",
        action: "code.survey",
        ok: !!result?.ok,
        attempted: !!result?.attempted,
        duration_ms: Number(result?.durationMs || 0),
        retries: Number(result?.retries || 0),
        scope: _summarizeSurveyScope(result?.scope),
        file_count: fileCount,
        internal_edge_count: internalEdgeCount,
        error: result?.error ? String(result.error).slice(0, 500) : null,
      },
    });
  } catch {
    // Diagnostic logging must never affect handoff assembly.
  }
}

function _summarizeSurveyScope(scope) {
  if (!scope || typeof scope !== "object") return null;
  const rawPaths = scope.paths;
  const paths = Array.isArray(rawPaths)
    ? rawPaths.slice(0, 16).map((p) => String(p))
    : (rawPaths ? String(rawPaths) : null);
  return {
    inject: !!scope.inject,
    source: scope.source || null,
    mode: scope.mode || null,
    paths,
    fileCount: Number.isFinite(Number(scope.files)) ? Number(scope.files) : null,
    symbols: Array.isArray(scope.symbols) ? scope.symbols.slice(0, 16).map((s) => String(s)) : null,
    reason: scope.reason || null,
  };
}

function _formatSurveyScopeCompact(scope) {
  if (!scope || typeof scope !== "object") return "no scope";
  const source = scope.source || (scope.inject ? "selected scope" : "not selected");
  const target = _formatSurveyScopeTarget(scope);
  return target ? `${source}: ${target}` : String(source);
}

function _formatSurveyScopeTarget(scope) {
  if (!scope || typeof scope !== "object") return null;
  const paths = scope.paths;
  if (typeof paths === "string" && paths) return paths;
  if (Array.isArray(paths) && paths.length > 0) return `${paths.length} files`;
  return scope.reason || null;
}

// Fallback graph-slice prefetch — runs only when tree.scope was unavailable
// or returned nothing. `treeScope` (the failed/empty attempt, if any) rides
// along so the rendered section can say why the tree pass didn't apply.
async function _attachAtlasSlicePrefetchContext(packet, { tools, taskText, seedFiles, treeScope, seedSymbolCards = [], areaMap = [] }) {
  if (!tools.has("slice.build")) {
    if (treeScope && !treeScope.ok) {
      packet.atlas_slice_context = {
        ok: false,
        source: "tree.scope",
        error: treeScope.error || "tree.scope unavailable",
        treeScope,
      };
    }
    return;
  }

  const useRawTaskText = rawTextSlicePrefetchEnabled(packet);
  if (!useRawTaskText && seedFiles.length === 0) return;

  const sliceArgs = {
    editedFiles: seedFiles,
    maxCards: packet.recipient === "planner" ? 12 : packet.recipient === "researcher" ? 10 : 8,
    maxTokens: packet.recipient === "planner" ? 1800 : packet.recipient === "researcher" ? 1600 : 1400,
  };
  if (useRawTaskText) {
    sliceArgs.taskText = taskText;
    sliceArgs.semantic = true;
  }

  packet.atlas_slice_prefetch_attempted = true;
  const raw = await executeEmbeddedAtlasTool("slice.build", sliceArgs, {
    cwd: packet.cwd,
    config: packet.atlas_config || undefined,
    origin: "prefetch",
  });

  if (String(raw || "").startsWith("Error:")) {
    packet.atlas_slice_context = {
      ok: false,
      source: "slice.build",
      error: String(raw).slice(0, 300),
      treeScope,
    };
    return;
  }

  const parsed = extractAtlasJsonPayload(raw);
  if (!parsed) {
    packet.atlas_slice_context = {
      ok: false,
      source: "slice.build",
      error: "ATLAS returned non-JSON slice payload.",
      treeScope,
    };
    return;
  }

  // Cards arrive in either compact (c) or verbose (cards) form depending on
  // ATLAS wire-format version. Normalize up to N for rendering.
  const data = atlasResultData("slice.build", parsed) || {};
  const catalogCards = atlasResultField("slice.build", parsed, "cards");
  const rawCards = Array.isArray(catalogCards)
    ? catalogCards
    : (Array.isArray(parsed?.slice?.c)
      ? parsed.slice.c
      : (Array.isArray(parsed?.slice?.cards) ? parsed.slice.cards : []));
  const legacyFilePaths = Array.isArray(parsed?.slice?.fp)
    ? parsed.slice.fp
    : (Array.isArray(parsed?.slice?.filePaths) ? parsed.slice.filePaths : []);
  const filePaths = _uniqueAtlasPaths([
    ...legacyFilePaths,
    ...rawCards.map((card) => atlasSymbolCardField(card, "filePath")).filter(Boolean),
  ], 32);
  const cardLimit = packet.recipient === "planner" ? 10 : 8;
  const cards = rawCards
    .slice(0, cardLimit)
    .map((card) => _normalizeSliceCard(card, filePaths))
    .filter(Boolean);

  const prefetchTargets = selectAtlasPrefetchTargets(packet, filePaths);
  packet.atlas_slice_candidates = {
    filePaths: prefetchTargets.filePaths,
    rankedFiles: prefetchTargets.rankedFiles,
    exactFiles: prefetchTargets.exactFiles,
    cards,
  };

  const exactFiles = await _prefetchExactScopedFiles(prefetchTargets.exactFiles, {
    packet,
    toolsAvailable: [...tools],
    maxFiles: ATLAS_EXACT_PREFETCH_MAX_FILES,
  });

  // Researcher slice results are intentionally only summaries/file paths:
  // before research/planning exists, ATLAS ranking can drift into unrelated
  // files. Defer skeleton expansion until planner/dev handoffs.
  const skeletonMaxFiles = atlasSliceSkeletonPrefetchLimit(packet.recipient);
  const exactOkPaths = _pathSet(exactFiles.filter((item) => item?.ok).map((item) => item.file));
  const skeletons = skeletonMaxFiles > 0
    ? await _prefetchSliceSkeletons(prefetchTargets.skeletonFiles.filter((file) => !exactOkPaths.has(file.toLowerCase())), {
      packet,
      toolsAvailable: [...tools],
      maxFiles: skeletonMaxFiles,
    })
    : [];

  packet.atlas_slice_context = {
    ok: true,
    source: "slice.build",
    seedSymbolCards,
    areaMap,
    sliceHandle: atlasResultField("slice.build", parsed, "sliceHandle") || parsed.sliceHandle || null,
    knownVersion: atlasResultField("slice.build", parsed, "knownVersion") || parsed.knownVersion || null,
    ledgerVersion: parsed.ledgerVersion || parsed.versionId || null,
    repoId: packet.atlas?.repo?.repoId || null,
    cardCount: Number(atlasResultField("slice.build", parsed, "totalCardCount")) || rawCards.length,
    cards,
    filePaths: prefetchTargets.filePaths,
    rankedFiles: prefetchTargets.rankedFiles,
    exactFiles,
    frontier: Array.isArray(atlasResultField("slice.build", parsed, "frontier"))
      ? atlasResultField("slice.build", parsed, "frontier").slice(0, 16)
      : (Array.isArray(parsed?.slice?.f) ? parsed.slice.f.slice(0, 16) : []),
    skeletons,
    treeScope,
    raw: data,
  };
}

// ─── Shared rendering vocabulary ─────────────────────────────────────────────
// All ATLAS prefetch sections share these primitives so phrasing stays unified
// when new prefetch tools are added.
const ATLAS_MISSING_VALUE = "(unknown)";
const ATLAS_EMPTY_LIST_LINE = "- (none)";

// Soft cap on the total rendered ATLAS section size. ~12k chars is roughly 3k
// tokens, leaving room for the rest of the handoff (editable files, related
// files, directory tree, tool policy).
// Progressive drops below aim to keep the most load-bearing signal (cards,
// top files) and shed the tail (recommended tests, frontier hints, bodies)
// before touching structural info.
const ATLAS_SECTION_CHAR_CAP = 12000;
const ATLAS_MAX_TRIM_LEVEL = 5;

function atlasHeading(title) {
  return `=== ${title} ===`;
}

function atlasField(label, value) {
  if (value == null || value === "") return null;
  return `${label}: ${value}`;
}

function atlasScoreLine(score, tail) {
  const formatted = Number.isFinite(Number(score)) ? Number(score).toFixed(3) : "?";
  const tailText = tail == null ? "" : String(tail).trim();
  return tailText ? `- score=${formatted} ${tailText}` : `- score=${formatted}`;
}

function atlasFrontierLine(edge) {
  const symbolId = edge?.symbolId || edge?.s || ATLAS_MISSING_VALUE;
  const why = edge?.why || edge?.w || "";
  return why ? `- ${symbolId} via ${why}` : `- ${symbolId}`;
}

function atlasFrontierHasSignal(edge) {
  const symbolId = String(edge?.symbolId || edge?.s || "").trim().toLowerCase();
  return !!symbolId && symbolId !== "unknown" && symbolId !== ATLAS_MISSING_VALUE;
}

function atlasListLines(items, mapper) {
  if (!Array.isArray(items) || items.length === 0) return [ATLAS_EMPTY_LIST_LINE];
  return items.map(mapper);
}

function atlasSubFailureLine(label, error) {
  return `${label} prefetch failed: ${error || "unknown error"}`;
}

// One line per independent sub-prefetch failure. The fallback policy is stated
// once in the ATLAS CONTEXT / retrieval-order guidance, not repeated here.
function renderAtlasFailureSection(title, label, error) {
  return [
    atlasHeading(title),
    atlasSubFailureLine(label, error),
  ].join("\n");
}

// Names of sub-prefetches that failed alongside a whole-prefetch failure, so
// the single consolidated notice can enumerate them instead of rendering one
// failure section per sub-prefetch carrying the same bit.
function _collectFailedSubPrefetchLabels(packet) {
  const labels = [];
  if (packet.atlas_assessment_baseline && !packet.atlas_assessment_baseline.ok) {
    labels.push("assessment baseline");
  }
  if (packet.atlas_research_context && !packet.atlas_research_context.ok) {
    labels.push("research context");
  }
  if (packet.atlas_slice_context && !packet.atlas_slice_context.ok) {
    const treeSourced = packet.atlas_slice_context.source === "tree.scope"
      || packet.atlas_slice_context.source === "tree.expand";
    labels.push(treeSourced ? "tree scope" : "slice");
  }
  return labels;
}

function displayAtlasToolName(toolName, atlas = {}) {
  const raw = String(toolName || "").trim();
  if (!raw) return raw;
  if (raw.startsWith("atlas.") || raw.startsWith("atlas_")) return raw;

  const transport = String(atlas?.transport || "").toLowerCase();
  const provider = String(atlas?.provider || "").toLowerCase();
  if (transport === "embedded" || ["openai", "grok"].includes(provider)) {
    const deterministicDef = getAtlasDeterministicToolDefinitions([raw])[0];
    if (deterministicDef?.name) return deterministicDef.name;
    return `atlas_${raw.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
  }

  return `atlas.${raw}`;
}

function displayAtlasToolList(tools = [], atlas = {}) {
  return displayableAtlasTools(tools, atlas)
    .map((toolName) => displayAtlasToolName(toolName, atlas))
    .filter(Boolean)
    .join(", ");
}

function selectFirstRetrievalTools(tools = [], atlas = {}) {
  const available = new Set(displayableAtlasTools(tools, atlas));
  const reviewOrder = [
    "repo.status",
    "review.risk",
    "review.delta",
    "review.analyze",
    "symbol.card",
    "code.skeleton",
    "code.lens",
    "code.window",
  ];
  // Start with discovery, then prefer one area-level structure/content call
  // before any named residual per-file gap. tree.scope is prefetch-only and
  // never advertised here.
  const discoveryOrder = [
    "symbol.search",
    "tree.expand",
    "code.structure",
    "code.survey",
    "context.summary",
    "code.skeleton",
    "code.lens",
    "code.window",
    "slice.build",
    "context",
    "symbol.card",
  ];
  const order = available.has("review.risk") || available.has("review.delta") || available.has("review.analyze")
    ? reviewOrder
    : discoveryOrder;
  return order
    .filter((toolName) => available.has(toolName))
    .slice(0, 4)
    .map((toolName) => displayAtlasToolName(toolName, atlas));
}

function displayableAtlasTools(tools = [], atlas = {}) {
  return externallyRoutedAtlasTools(tools)
    .filter((toolName) => !(toolName === "memory.surface" && atlasMemoryStoreEmpty(atlas)));
}

function atlasMemoryStoreEmpty(atlas = {}) {
  const stats = atlas?.memoryStats;
  if (!stats || typeof stats !== "object") return false;
  return Number(stats.memories || 0) <= 0;
}

export function isAtlasPrefetchStatusRelevant(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "ok" || normalized === "ok_relevant" || normalized === "prefetch_ok_relevant";
}

function _collectSliceEvidencePaths(slice) {
  const paths = [];
  if (!slice || typeof slice !== "object") return paths;
  for (const filePath of slice.filePaths || []) paths.push(filePath);
  for (const filePath of _collectSliceConcreteEvidencePaths(slice)) paths.push(filePath);
  return _uniqueAtlasPaths(paths);
}

function _collectSliceConcreteEvidencePaths(slice) {
  const paths = [];
  if (!slice || typeof slice !== "object") return paths;
  for (const card of slice.cards || []) paths.push(card?.file);
  for (const item of slice.exactFiles || []) {
    if (item?.ok) paths.push(item.file);
  }
  for (const item of slice.skeletons || []) {
    if (item?.ok) paths.push(item.file);
  }
  return _uniqueAtlasPaths(paths);
}

function _intersectsPathSet(paths, expectedSet) {
  if (!(expectedSet instanceof Set) || expectedSet.size === 0) return false;
  for (const filePath of _uniqueAtlasPaths(paths)) {
    if (expectedSet.has(filePath.toLowerCase())) return true;
  }
  return false;
}

const ATLAS_RELEVANCE_STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "build",
  "change",
  "code",
  "debug",
  "from",
  "into",
  "issue",
  "make",
  "need",
  "path",
  "repo",
  "task",
  "test",
  "that",
  "the",
  "this",
  "trace",
  "with",
]);

function _tokenizeAtlasRelevanceText(value) {
  const expanded = String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase();
  return expanded
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !ATLAS_RELEVANCE_STOP_WORDS.has(token));
}

function _sliceEvidenceMatchesTask(slice, packet) {
  const taskTokens = [...new Set(_tokenizeAtlasRelevanceText(buildPlannerAtlasTaskText(packet)))];
  if (taskTokens.length === 0) return false;
  const evidenceText = [
    ...(Array.isArray(slice?.filePaths) ? slice.filePaths : []),
    ...(Array.isArray(slice?.rankedFiles) ? slice.rankedFiles : []),
    ...(Array.isArray(slice?.cards) ? slice.cards.flatMap((card) => [
      card?.name,
      card?.qualifiedName,
      card?.file,
      card?.filePath,
      card?.summary,
    ]) : []),
  ].filter(Boolean).join(" ");
  const evidenceTokens = new Set(_tokenizeAtlasRelevanceText(evidenceText));
  let overlap = 0;
  for (const token of taskTokens) {
    if (evidenceTokens.has(token)) overlap += 1;
  }
  const requiredOverlap = taskTokens.length === 1 ? 1 : 2;
  return overlap >= requiredOverlap;
}

export function classifyAtlasPrefetchRelevance(packet, recipient = packet?.recipient) {
  if (!packet?.atlas?.active || packet.atlas?.prefetchFailed) return false;
  const role = String(recipient || packet?.recipient || "").trim().toLowerCase();
  const scopedFiles = _collectExplicitAtlasPrefetchFiles(packet);
  const scopedSet = _pathSet(scopedFiles);

  if (packet.atlas_db_context?.ok && _looksLikeDatabasePrefetchTask(packet)) {
    return true;
  }

  if ((role === "planner" || role === "dev") && packet.atlas_slice_context?.ok) {
    const slice = packet.atlas_slice_context;
    const evidencePaths = _collectSliceEvidencePaths(slice);
    const concreteEvidencePaths = _collectSliceConcreteEvidencePaths(slice);
    const hasExactScopedEvidence = Array.isArray(slice.exactFiles)
      && slice.exactFiles.some((item) => {
        if (!item?.ok) return false;
        const normalized = _normalizeAtlasRelativePath(item.file);
        return !!normalized && scopedSet.has(normalized.toLowerCase());
      });
    if (scopedSet.size > 0) {
      return hasExactScopedEvidence
        || _intersectsPathSet(concreteEvidencePaths, scopedSet);
    }
    return evidencePaths.length > 0 && _sliceEvidenceMatchesTask(slice, packet);
  }

  if (role === "researcher" && packet.atlas_research_context?.ok) {
    const research = packet.atlas_research_context;
    if (research.agentContext?.ok || research.agentContext?.raw) return true;
  }

  if (role === "assessor" && packet.atlas_assessment_baseline?.ok) {
    return true;
  }

  if (packet.atlas_slice_context?.ok) {
    const evidencePaths = _collectSliceEvidencePaths(packet.atlas_slice_context);
    if (scopedSet.size > 0) {
      return _intersectsPathSet(_collectSliceConcreteEvidencePaths(packet.atlas_slice_context), scopedSet);
    }
    return evidencePaths.length > 0 && _sliceEvidenceMatchesTask(packet.atlas_slice_context, packet);
  }

  return false;
}

function renderRequiredRetrievalOrderLine(packet) {
  const label = atlasBackendLabel(packet?.atlas);
  const available = new Set(displayableAtlasTools(packet?.atlas?.tools, packet?.atlas));
  const gateEnabled = packet?.atlas?.gateEnabled != null
    ? !!packet.atlas.gateEnabled
    : resolveAtlasToolGateEnabled();
  const prefetchStatus = String(packet?.atlas?.prefetchStatus || "").toLowerCase();
  if (!gateEnabled) {
    if (isAtlasPrefetchStatusRelevant(prefetchStatus)) {
      return `${label} PREFETCH RELEVANT: initial ${label} retrieval supplied task-relevant context. Use it directly when it answers the question; do not repeat the same lookup or re-read that evidence natively. Use standard tools when ${label} is unavailable or insufficient, for non-indexed config/data/docs where the raw text is the object, for exact current worktree state after mutations, or for git/test/build/shell operations.`;
    }
    if (prefetchStatus === "ok_unhelpful" || prefetchStatus === "prefetch_ok_unhelpful") {
      return `${label} PREFETCH UNHELPFUL: initial ${label} retrieval completed but did not match the requested scope. Try a task-relevant ${label} retrieval first when possible, then use standard tools for whatever ${label} could not answer, stating the gap.`;
    }
    const firstTools = selectFirstRetrievalTools(packet?.atlas?.tools, packet?.atlas);
    const examples = firstTools.length > 0
      ? ` (start with ${firstTools.join(" / ")})`
      : "";
    return `${label} RETRIEVAL POLICY: use ${label} tools when possible for repository discovery and codebase understanding${examples}. Use returned evidence directly when it answers the task. Use standard tools when ${label} is unavailable or insufficient, the target is non-indexed config/data/docs, you have mutated files and need exact current worktree state, git/test/build/shell operations are required, or ${label} does not expose the needed operation.`;
  }
  if (isAtlasPrefetchStatusRelevant(prefetchStatus)) {
    return `${label} PREFETCH RELEVANT: initial ${label} retrieval supplied task-relevant context (prefetch does not count as active ${label} use). Use it directly when it answers the task, and do not repeat the same lookup. Native read/search/list tools are for information ${label} cannot supply, non-indexed config/data/docs where raw text is the object, exact current worktree state after mutations, or git/test/build/shell operations.`;
  }
  if (prefetchStatus === "ok_unhelpful" || prefetchStatus === "prefetch_ok_unhelpful") {
    return `${label} PREFETCH UNHELPFUL: initial ${label} retrieval completed but did not match the requested scope. Make focused ${label} retrieval calls for the exact task or scoped files; if a focused attempt still cannot answer, use native tools for that named gap and state what ${label} left unanswered.`;
  }
  const firstTools = selectFirstRetrievalTools(packet?.atlas?.tools, packet?.atlas);
  const examples = firstTools.length > 0
    ? ` (start with ${firstTools.join(" / ")})`
    : "";
  return `REQUIRED RETRIEVAL POLICY: ${label} is the inspection path${examples}. Prefetch and internal bookkeeping calls do not count as retrieval. Use ${label} evidence directly when it answers the task and do not repeat the same lookup. Native list/search/read tools are for information ${label} cannot supply, non-indexed config/data/docs where raw text is the object, exact current worktree state after mutations, or operations ${label} does not expose (git/test/build/shell).`;
}

function renderAtlasContextSection(packet) {
  const label = atlasBackendLabel(packet?.atlas);
  const hasCallableTools = displayableAtlasTools(packet?.atlas?.tools, packet?.atlas).length > 0;
  if (packet.atlas?.prefetchFailed) {
    // Prefetch failed but we're in a fallback-eligible mode. Keep phase/repo
    // for debuggability but replace the "active" framing and tool guidance
    // with a single fallback notice so the agent doesn't try to call ATLAS tools.
    // One sentence + one detail line: the per-sub-prefetch failure sections are
    // suppressed in _buildAtlasSections because they share this common cause.
    const detail = packet.atlas.prefetchFailureDetail
      ? `Failure detail: ${String(packet.atlas.prefetchFailureDetail).split(/\r?\n/)[0].slice(0, 240)}`
      : null;
    const failedPrefetches = _collectFailedSubPrefetchLabels(packet);
    return [
      atlasHeading(`${label} CONTEXT`),
      packet.atlas.fallbackNotice
        ? formatAtlasBackendText(packet.atlas.fallbackNotice, label)
        : `${label} prefetch failed; ${label} tools are unavailable for this handoff. Continue with deterministic file/search/edit tools and preload context.`,
      detail,
      failedPrefetches.length > 0 ? `Failed prefetches: ${failedPrefetches.join(", ")}` : null,
      atlasField("Phase", packet.atlas.phase),
      atlasField("Repo target", packet.atlas.repo?.repoPath),
    ].filter(Boolean).join("\n");
  }
  return [
    atlasHeading(`${label} CONTEXT`),
    hasCallableTools
      ? `${label} is active for this handoff; use the listed ${label} tools when they can answer the task.`
      : `${label} context prefetch is active for this handoff. Use the prefetched context and its backed cursor pages as the initial code map.`,
    atlasField("Phase", packet.atlas.phase),
    atlasField("Repo target", packet.atlas.repo?.repoPath),
    hasCallableTools ? atlasField(`Preferred ${label} tools`, displayAtlasToolList(packet.atlas.tools, packet.atlas)) : null,
    "STORED RESULT TRAVERSAL: pagination.cursor, *Ref fields, and [bounded_result traversal] point into the already-returned stored dataset. atlas.fetch_ref follows them; it is not a fresh retrieval and does not rerun the originating tool. Traverse them when missing material is likely in that result. Call the original tool again only for a materially different path, symbol, query, or scope.",
    // Explicit priority framing keeps the loaded ATLAS backend as the default
    // discovery path while
    // preserving deterministic tools for exact worktree state and edits.
    hasCallableTools ? renderRequiredRetrievalOrderLine(packet) : null,
  ].filter(Boolean).join("\n");
}

function _renderCardLine(card) {
  const parts = [];
  const kindTag = card.kind ? `[${card.kind}]` : "[symbol]";
  parts.push(`- ${kindTag} ${card.name}`);
  if (card.file) {
    parts.push(card.startLine != null ? `(${card.file}:${card.startLine})` : `(${card.file})`);
  }
  return parts.join(" ");
}

function _renderCardDetailLines(card) {
  const detail = [];
  if (card.signature && card.signature !== card.name + "()") {
    detail.push(`    sig: ${card.signature}`);
  }
  if (card.summary) {
    // Single-line summaries preferred; collapse newlines defensively.
    detail.push(`    ${String(card.summary).replace(/\s+/g, " ").slice(0, 220)}`);
  }
  return detail;
}

function _renderSkeletonBlock(sk) {
  if (!sk || !sk.ok) return null;
  const meta = [];
  if (sk.originalLines != null) meta.push(`${sk.originalLines} lines`);
  if (sk.estimatedTokens != null) meta.push(`~${sk.estimatedTokens} tokens`);
  if (sk.truncated) meta.push("truncated");
  const metaText = meta.length > 0 ? ` (${meta.join(", ")})` : "";
  const body = String(sk.skeleton || "").trim();
  // Cap very long skeletons defensively; ATLAS already honors estimatedTokens.
  const capped = body.length > 2400 ? `${body.slice(0, 2400)}\n... (skeleton truncated)` : body;
  return `--- ${sk.file}${metaText} ---\n${capped}`;
}

// Trim levels (inclusive — each level adds on top of the previous):
//   0: full output
//   1: drop recommendedTests list
//   2: cap risk findings to top 3
//   3: drop skeleton bodies (keep file + meta headers)
//   4: drop frontier hints
//   5: drop delta file list
function _sliceMaxFindings(trim) { return trim >= 2 ? 3 : 6; }
function _sliceShouldDropRecommended(trim) { return trim >= 1; }
function _sliceShouldDropSkeletonBodies(trim) { return trim >= 3; }
function _sliceShouldDropFrontier(trim) { return trim >= 4; }
function _sliceShouldDropDeltaFiles(trim) { return trim >= 5; }
function _sliceShouldDropExactFileBodies(trim) { return trim >= 3; }

function _truncatePrefetchText(value, maxChars) {
  const text = String(value || "");
  const max = Math.max(200, Number(maxChars) || 1600);
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max - 32), truncated: true };
}

function _renderIndentedPrefetchContent(value, { maxChars = 2200 } = {}) {
  const clipped = _truncatePrefetchText(value, maxChars);
  const lines = clipped.text.split(/\r?\n/).slice(0, 120);
  const rendered = lines.map((line, index) => `  ${String(index + 1).padStart(4, " ")} | ${line}`);
  if (clipped.truncated) rendered.push("  ... (ATLAS exact-file prefetch truncated)");
  return rendered;
}

function _renderExactFileBlock(item, trim) {
  if (!item) return [];
  const file = item.file || ATLAS_MISSING_VALUE;
  if (!item.ok) {
    return [`- ${file} (${item.kind || "ATLAS exact read"} failed: ${item.error || "unknown error"})`];
  }

  const meta = [];
  if (item.kind) meta.push(item.kind);
  if (item.totalLines != null) meta.push(`${item.totalLines} total lines`);
  if (item.returnedLines != null) meta.push(`${item.returnedLines} returned`);
  if (item.bytes != null) meta.push(`${item.bytes} bytes`);
  if (item.originalLines != null) meta.push(`${item.originalLines} source lines`);
  if (item.estimatedTokens != null) meta.push(`~${item.estimatedTokens} tokens`);
  if (item.truncated) meta.push("truncated");

  const lines = [`- ${file}${meta.length > 0 ? ` (${meta.join(", ")})` : ""}`];
  if (_sliceShouldDropExactFileBodies(trim)) return lines;

  if (item.kind === "read_file") {
    lines.push(..._renderIndentedPrefetchContent(item.content, {
      maxChars: trim >= 2 ? 1000 : trim >= 1 ? 1800 : 3200,
    }));
  } else if (item.kind === "code.skeleton") {
    lines.push(..._renderIndentedPrefetchContent(item.skeleton, {
      maxChars: trim >= 2 ? 1000 : trim >= 1 ? 1600 : 2600,
    }));
  }
  return lines;
}

function _surveyRefStub(evidenceRef) {
  const ref = String(evidenceRef?.ref || "").trim();
  if (!/^#[a-z0-9]{4,12}$/i.test(ref)) return null;
  const objectType = String(evidenceRef?.objectType || "atlas.code.survey")
    .replace(/[^0-9A-Za-z_.:-]+/g, "_")
    .slice(0, 80);
  const sizeChars = Math.max(0, Number(evidenceRef?.sizeChars) || 0);
  const note = String(evidenceRef?.note || "prefetched survey page 1")
    .replace(/["\\\]\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return `[ref_hash ${objectType} ${sizeChars} chars ${ref}${note ? ` note="${note}"` : ""}]`;
}

function _surveyFileSummaries(sc) {
  if (Array.isArray(sc?.fileSummaries)) return sc.fileSummaries;
  return (Array.isArray(sc?.files) ? sc.files : []).map((file) => ({
    path: file?.path,
    symbolCount: file?.symbolCount,
    truncated: file?.truncated,
    symbols: file?.symbols,
  }));
}

// Render the compact inline part of an already-prefetched code.survey. The
// exact survey is stored as ten-file evidenceRef pages so the agent can walk
// that snapshot without paying to execute code.survey a second time.
function _renderAtlasSurveySection(sc, packet, { trim = 0 } = {}) {
  const lines = [];
  const label = displayAtlasToolName("code.survey", packet?.atlas);
  const target = _formatSurveyScopeTarget(sc?.scope) || `${Number(sc.fileCount || 0)} files`;
  const dig = sc.symbols ? `, dig: ${sc.symbols.join(", ")}` : "";
  lines.push(`Area survey (prefetched with ${label} over ${target}${dig}):`);
  const refStub = _surveyRefStub(sc?.evidenceRef);
  if (refStub) {
    lines.push(`  survey page 1: ${refStub}`);
    lines.push(`  page 1: atlas.fetch_ref {"ref":"${sc.evidenceRef.ref}"}`);
    const cursor = sc?.evidenceRef?.cursor || sc?.evidenceRef?.nextPage;
    const cursorRef = cursor?.args?.ref || cursor?.ref;
    if (cursorRef) {
      lines.push(`  next 10: atlas.fetch_ref {"ref":"${cursorRef}"}`);
    }
    lines.push(`  This survey has already run. atlas.fetch_ref opens its stored full-symbol pages; it does not rerun ${label}.`);
    lines.push(`  The inline symbols are only a ranked preview. If a needed declaration is likely covered by this survey, search/fetch page 1 or follow next 10 before making a new retrieval call. Run ${label} only for a materially different path or symbol scope.`);
    lines.push("  When parallel versions or implementations exist, search the stored survey pages for the task's exact named concepts before choosing the governing path; rank is candidate order, not a version decision.");
  }
  const fileCount = Number.isFinite(Number(sc.fileCount))
    ? Number(sc.fileCount)
    : (Array.isArray(sc.files) ? sc.files.length : 0);
  if (fileCount > 0) lines.push(`  files covered: ${fileCount}${sc.truncated ? " (survey hit file cap)" : ""}`);
  const summary = sc.callMapSummary || _compactSurveyCallMap(sc.callMap, sc.metrics || {}, {
    edgeLimit: _surveyBriefEdgeLimit(packet),
  });
  const counts = summary?.counts || {};
  const countParts = [
    Number.isFinite(Number(counts.internal)) ? `internal=${counts.internal}` : null,
    Number.isFinite(Number(counts.inbound)) ? `inbound=${counts.inbound}` : null,
    Number.isFinite(Number(counts.outbound)) ? `outbound=${counts.outbound}` : null,
    Number.isFinite(Number(counts.unresolved)) ? `unresolved=${counts.unresolved}` : null,
  ].filter(Boolean);
  if (countParts.length > 0) lines.push(`  edge counts: ${countParts.join(", ")}`);
  if ((Array.isArray(summary?.topEdges) && summary.topEdges.length > 0)
    || (Array.isArray(summary?.topSymbols) && summary.topSymbols.length > 0)) {
    lines.push("  ranked relationship preview (navigation signal, not proof): `path#symbol` identifies an endpoint; `from -> to` is a static call/reference direction, not runtime order. `[inbound]` enters this survey scope, `[outbound]` leaves it, and an untagged edge stays inside it; `xN` counts indexed sites, not executions.");
    lines.push("  Use these candidates to choose likely entrypoints, ownership handoffs, and scope boundaries, then open the retained survey page for exact sites and branch evidence.");
  }
  const topSymbols = Array.isArray(summary?.topSymbols) ? summary.topSymbols : [];
  if (topSymbols.length > 0) {
    lines.push(`  top edge symbols: ${topSymbols.map((entry) => `${entry.symbol}${entry.count > 1 ? ` (${entry.count})` : ""}`).join(", ")}`);
  }
  const topEdges = Array.isArray(summary?.topEdges) ? summary.topEdges : [];
  if (topEdges.length > 0) {
    lines.push("  top call edges:");
    for (const edge of topEdges) {
      const count = Number(edge.count || 0) > 1 ? ` (x${edge.count})` : "";
      const kind = edge.kind && edge.kind !== "internal" ? ` [${edge.kind}]` : "";
      lines.push(`    ${edge.from || "?"} -> ${edge.to || "?"}${count}${kind}`);
    }
    if (summary.truncated) lines.push("    (edge sample truncated)");
  }
  const allFileSummaries = _surveyFileSummaries(sc);
  const hasSymbolSummaries = allFileSummaries.some((file) => Array.isArray(file?.symbols) && file.symbols.length > 0);
  const topFiles = Array.isArray(sc.topFiles)
    ? sc.topFiles
    : (Array.isArray(sc.files) ? sc.files.map((file) => file?.path).filter(Boolean).slice(0, MAX_SURVEY_BRIEF_FILES) : []);
  if (topFiles.length > 0 && !hasSymbolSummaries) {
    lines.push(`  top files in survey scope: ${topFiles.join(", ")}`);
  }
  const fileCap = trim >= 2 ? 4 : trim >= 1 ? 6 : MAX_SURVEY_BRIEF_FILES;
  const symbolCap = trim >= 2 ? 2 : trim >= 1 ? 3 : MAX_SURVEY_BRIEF_SYMBOLS_PER_FILE;
  const fileSummaries = allFileSummaries.slice(0, fileCap);
  if (fileSummaries.some((file) => Array.isArray(file?.symbols) && file.symbols.length > 0)) {
    lines.push("  surveyed symbols by file (`path#symbol` means `symbol` in repo-relative `path`):");
    for (const file of fileSummaries) {
      const symbols = (Array.isArray(file?.symbols) ? file.symbols : []).slice(0, symbolCap);
      if (symbols.length === 0) continue;
      const total = Number(file?.symbolCount || symbols.length);
      const remainder = Math.max(0, total - symbols.length);
      const rendered = symbols.map((symbol) => {
        const name = String(symbol?.qualifiedName || symbol?.name || "(anonymous)");
        const kind = String(symbol?.kind || "symbol");
        const line = Number.isFinite(Number(symbol?.line ?? symbol?.startLine))
          ? `:${Number(symbol.line ?? symbol.startLine)}`
          : "";
        return `${name} [${kind}]${line}`;
      });
      lines.push(`    - ${file.path}: ${rendered.join(", ")}${remainder > 0 ? ` (+${remainder} more in survey ref)` : ""}`);
    }
  }
  return lines;
}

function _renderAtlasSurveyMissSection(sc, packet) {
  const label = displayAtlasToolName("code.survey", packet?.atlas);
  const target = _formatSurveyScopeTarget(sc?.scope) || "selected area";
  const reason = sc?.error ? String(sc.error).split(/\r?\n/)[0].slice(0, 220) : "unknown reason";
  const source = sc?.scope?.source ? ` (scope source: ${sc.scope.source})` : "";
  return [
    `Area survey (${label} over ${target}) was attempted but unavailable${source}: ${reason}.`,
    `If call edges or exhaustive area structure matter, retry ${label} over that scope when available; otherwise continue with the available indexed evidence and report the resulting limitation instead of treating tree scope as a call map.`,
  ];
}

function renderAtlasSliceSection(packet, { trim = 0 } = {}) {
  const slice = packet.atlas_slice_context;
  const label = atlasBackendLabel(packet?.atlas);
  const isTreeSourced = slice.source === "tree.scope" || slice.source === "tree.expand";
  const lines = [
    atlasHeading(`${label} ${isTreeSourced ? "TREE SCOPE PRUNING" : "SLICE PRUNING"}`),
    ...(isTreeSourced ? [] : [
      atlasField("Slice handle", slice.sliceHandle || ATLAS_MISSING_VALUE),
      atlasField("Cards", slice.cardCount || 0),
    ]),
    atlasField("Repo", slice.repoId || ATLAS_MISSING_VALUE),
  ].filter(Boolean);

  // Orientation first: the compressed tree's labeled area map tells the
  // agent what lives where before any file list — rendered regardless of
  // which discovery pass produced the candidates (tree.overview supplies it
  // even when the slice fallback ran). Dropped at higher trim levels since
  // the candidates below are the more load-bearing signal.
  const renderedAreaMap = Array.isArray(slice.areaMap) && slice.areaMap.length > 0
    ? slice.areaMap
    : (Array.isArray(slice.treeScope?.areaMap) ? slice.treeScope.areaMap : []);
  if (trim < 2 && renderedAreaMap.length > 0) {
    const walkTool = displayAtlasToolName("tree.branch", packet.atlas);
    lines.push("This is the compressed file-system tree.");
    lines.push(`A branch can be drilled into with ${walkTool} {path, maxDepth}; omit limit to use the repo-sized default (100-250 nodes).`);
    for (const area of renderedAreaMap) {
      lines.push(`- ${area.path} — ${area.label}${area.labelStale ? " (label predates recent changes here)" : ""}`);
    }
  }

  const treeScope = slice.treeScope;
  if (treeScope?.ok) {
    const meta = [];
    if (treeScope.scopeRisk) meta.push(`risk=${treeScope.scopeRisk}`);
    if (treeScope.confidence != null) meta.push(`confidence=${treeScope.confidence}`);
    lines.push(`Tree scope (deterministic candidate scope seeded into this slice${meta.length > 0 ? `; ${meta.join(", ")}` : ""}):`);
    if (Array.isArray(treeScope.candidateDirs) && treeScope.candidateDirs.length > 0) {
      lines.push(`- areas: ${treeScope.candidateDirs.join(", ")}`);
    }
    if (Array.isArray(treeScope.compressionSeeds) && treeScope.compressionSeeds.length > 0) {
      lines.push("- compressed-tree area matches:");
      for (const seed of treeScope.compressionSeeds) {
        const entry = (seed.entrypoints || [])[0];
        const notes = [
          entry ? `entry: ${entry}` : null,
          seed.labelStale ? "label predates recent changes here" : null,
        ].filter(Boolean);
        lines.push(`  - ${seed.path} — ${seed.label}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`);
      }
    }
    if (Array.isArray(treeScope.scopeWidening) && treeScope.scopeWidening.length > 0) {
      const loadBearing = treeScope.scopeWidening.filter((c) => c && c.loadBearing);
      const others = treeScope.scopeWidening.filter((c) => !(c && c.loadBearing));
      if (loadBearing.length > 0) {
        lines.push("- highest fan-in callers of these seeds (measured: distinct calling files; from outside the seeds' own area):");
        for (const c of loadBearing) {
          const who = c.callerName ? `${c.callerName} — ${c.path}` : c.path;
          lines.push(`  - ${who} (called from ${c.callerCount} file${c.callerCount === 1 ? "" : "s"})`);
        }
        if (others.length > 0) {
          lines.push("  - other callers of these seeds from outside their area (not the full caller set):");
          for (const c of others) lines.push(`    - ${c.path}`);
        }
      } else {
        lines.push("- callers that reach these seeds from outside their area (scope-widened; not the full caller set):");
        for (const c of treeScope.scopeWidening) lines.push(`  - ${c.path}`);
      }
    }
  } else if (treeScope && treeScope.error) {
    lines.push(atlasSubFailureLine(treeScope.action || "tree.scope", treeScope.error));
  }

  if (Array.isArray(slice.seedSymbolCards) && slice.seedSymbolCards.length > 0) {
    lines.push("Brief key symbols (research-validated, cards prefetched):");
    for (const card of slice.seedSymbolCards) {
      lines.push(_renderCardLine(card));
      for (const detail of _renderCardDetailLines(card)) lines.push(detail);
    }
  }

  const recipientRole = String(packet?.recipient || "").trim().toLowerCase();
  if (treeScope?.ok && (recipientRole === "planner" || recipientRole === "dev")) {
    lines.push("The seeds above are pre-expanded from the brief; call tree.expand only for files you newly validate.");
  }

  if (slice.surveyContext?.ok) {
    for (const line of _renderAtlasSurveySection(slice.surveyContext, packet, { trim })) lines.push(line);
  } else if (slice.surveyContext?.attempted) {
    for (const line of _renderAtlasSurveyMissSection(slice.surveyContext, packet)) lines.push(line);
  }

  if (Array.isArray(slice.exactFiles) && slice.exactFiles.length > 0) {
    lines.push(`Scoped ${label} prefetch evidence:`);
    for (const item of slice.exactFiles) {
      lines.push(..._renderExactFileBlock(item, trim));
    }
  }

  if (Array.isArray(slice.cards) && slice.cards.length > 0) {
    // Keep the top few cards only; the candidate file list below carries the
    // breadth signal, so the long card tail is mostly redundant chars.
    const cardCap = trim >= 1 ? 4 : 8;
    const shownCards = slice.cards.slice(0, cardCap);
    lines.push("Top cards (semantic summaries):");
    for (const card of shownCards) {
      lines.push(_renderCardLine(card));
      for (const detail of _renderCardDetailLines(card)) lines.push(detail);
    }
    if (slice.cards.length > shownCards.length) {
      lines.push(`(+${slice.cards.length - shownCards.length} more cards omitted)`);
    }
  } else if ((slice.cardCount || 0) > 0) {
    lines.push("Top cards unavailable in this payload; rely on file paths below.");
  }

  const surveyCovered = _pathSet([
    ...(Array.isArray(slice.surveyContext?.topFiles) ? slice.surveyContext.topFiles : []),
    ..._surveyFileSummaries(slice.surveyContext).map((file) => file?.path).filter(Boolean),
  ]);
  const allDisplayedFiles = Array.isArray(slice.filePaths) ? slice.filePaths : [];
  const displayedFiles = allDisplayedFiles.filter((filePath) => !surveyCovered.has(String(filePath).toLowerCase()));
  const rankedFiles = Array.isArray(slice.rankedFiles) ? slice.rankedFiles : allDisplayedFiles;
  if (displayedFiles.length > 0) {
    const exactTargets = Array.isArray(slice.exactFiles) && slice.exactFiles.length > 0;
    lines.push(exactTargets
      ? "Explicit ATLAS file targets:"
      : `${isTreeSourced ? "Tree" : "Slice"}-ranked candidate files (not prefetched):`);
    lines.push(...atlasListLines(displayedFiles, (filePath) => `- ${filePath}`));
  }
  const displayedSet = _pathSet([...displayedFiles, ...surveyCovered]);
  const hiddenRankedCount = rankedFiles.filter((filePath) => !displayedSet.has(filePath.toLowerCase())).length;
  if (hiddenRankedCount > 0 && displayedFiles.length > 0) {
    lines.push(`Additional ATLAS-ranked candidates were withheld from prefetch (${hiddenRankedCount} hidden).`);
  }

  const skeletons = Array.isArray(slice.skeletons) ? slice.skeletons.filter((sk) => sk?.ok) : [];
  if (skeletons.length > 0) {
    if (_sliceShouldDropSkeletonBodies(trim)) {
      lines.push("File skeletons (headers only — bodies dropped to fit context budget):");
      for (const sk of skeletons) {
        const meta = [];
        if (sk.originalLines != null) meta.push(`${sk.originalLines} lines`);
        if (sk.estimatedTokens != null) meta.push(`~${sk.estimatedTokens} tokens`);
        const metaText = meta.length > 0 ? ` (${meta.join(", ")})` : "";
        lines.push(`- ${sk.file}${metaText}`);
      }
    } else {
      lines.push("File skeletons (structural outline, no bodies):");
      for (const sk of skeletons) {
        const block = _renderSkeletonBlock(sk);
        if (block) lines.push(block);
      }
    }
  }

  const usefulFrontier = Array.isArray(slice.frontier) ? slice.frontier.filter(atlasFrontierHasSignal) : [];
  if (!_sliceShouldDropFrontier(trim) && usefulFrontier.length > 0) {
    lines.push("Top frontier hints:");
    lines.push(...atlasListLines(usefulFrontier, atlasFrontierLine));
  }

  return lines.join("\n");
}

function _compactJsonBlock(value, maxChars) {
  let text = "";
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value || "");
  }
  const max = Math.max(500, Number(maxChars) || 2400);
  return text.length > max ? `${text.slice(0, max - 30)}\n... (ATLAS payload truncated)` : text;
}

function _renderContextQualityLines(quality) {
  if (!quality || typeof quality !== "object") return [];
  const meta = [];
  if (quality.confidence) meta.push(`confidence=${quality.confidence}`);
  if (quality.evidenceItems != null) meta.push(`evidence=${quality.evidenceItems}`);
  if (quality.selectedContextItems != null) meta.push(`selected=${quality.selectedContextItems}`);

  const lines = meta.length > 0 ? [`contextQuality: ${meta.join(", ")}`] : [];
  if (Array.isArray(quality.limitations) && quality.limitations.length > 0) {
    lines.push(`- limitations: ${quality.limitations.slice(0, 8).join(", ")}`);
  }
  if (Array.isArray(quality.guidance) && quality.guidance.length > 0) {
    lines.push(`- guidance: ${quality.guidance.slice(0, 8).join(", ")}`);
  }
  return lines;
}

function renderAtlasResearchContextSection(packet, { trim = 0 } = {}) {
  const research = packet.atlas_research_context;
  const context = research.agentContext?.raw || null;
  const lines = [
    atlasHeading("ATLAS RESEARCH PREFETCH"),
    "These are the initial ATLAS calls already made for you. Use them before making additional ATLAS or native file/search calls.",
  ];

  if (context) {
    const maxChars = trim >= 3 ? 1200 : trim >= 1 ? 2200 : 3600;
    const projected = research.agentContext?.packet || projectGeneratedContextPacket(context) || context;
    lines.push("atlas.context generated packet:");
    lines.push(..._renderContextQualityLines(projected?.contextQuality || context.contextQuality));
    lines.push(_compactJsonBlock(projected, maxChars));
  } else if (research.agentContext && !research.agentContext.ok) {
    lines.push(atlasSubFailureLine("atlas.context", research.agentContext.error));
  }

  if (packet.atlas?.gateEnabled) {
    const label = atlasBackendLabel(packet.atlas);
    lines.push(`Use prefetch as the first codebase map, then make targeted ${label} retrieval calls only for remaining code-evidence gaps; never call ${label} merely to make native tools available (prefetch does not count as active retrieval).`);
  } else {
    const label = atlasBackendLabel(packet.atlas);
    lines.push(`Use prefetch as the first codebase map. Make additional task-relevant ${label} calls only for specific code-evidence gaps; use native file/search tools when ${label} cannot provide sufficient information.`);
  }
  return lines.join("\n");
}

function renderAtlasDbContextSection(packet) {
  const dbContext = packet.atlas_db_context;
  if (!dbContext?.ok) return "";
  const operations = dbContext.operations && typeof dbContext.operations === "object"
    ? dbContext.operations
    : {};
  const keys = Object.keys(operations);
  const ordered = [
    "select",
    "insert",
    "update",
    "delete",
    "upsert",
    "create_table",
    "alter_table",
    "drop_table",
    ...keys.filter((key) => !["select", "insert", "update", "delete", "upsert", "create_table", "alter_table", "drop_table"].includes(key)).sort(),
  ].filter((key, index, values) => operations[key] && values.indexOf(key) === index);
  if (ordered.length === 0 && !dbContext.telemetry) return "";

  const lines = [
    atlasHeading("DATABASE PREFETCH"),
    `Database: ${_dbDisplayName(dbContext.db)}`,
  ];
  for (const operation of ordered) {
    const entry = operations[operation] || {};
    const ref = entry.ref || dbContext[operation];
    if (!ref) continue;
    const callers = Number(entry.callers ?? dbContext.counts?.[operation] ?? 0);
    lines.push(`${_dbOperationLabel(operation)}: ${ref} (${callers} caller${callers === 1 ? "" : "s"})`);
  }
  if (dbContext.telemetry && Number(dbContext.telemetry_count || 0) > 0) {
    const count = Number(dbContext.telemetry_count || 0);
    lines.push(`Telemetry: ${dbContext.telemetry} (${count} caller${count === 1 ? "" : "s"})`);
  }
  lines.push("Fetch only the operation ref that matches your database task.");
  return lines.join("\n");
}

function renderAtlasAssessmentBaselineSection(packet, { trim = 0 } = {}) {
  const baseline = packet.atlas_assessment_baseline;
  const lines = [
    atlasHeading("ATLAS ASSESSMENT BASELINE"),
    atlasField("Latest version", baseline.latestVersionId || ATLAS_MISSING_VALUE),
    atlasField("Previous version", baseline.previousVersionId),
    atlasField("Repo", baseline.repoId),
    atlasField("Last indexed", baseline.indexedAt),
    atlasField("Health", baseline.health),
  ].filter(Boolean);

  if (baseline.delta?.ok) {
    lines.push(atlasField("Semantic delta", `${baseline.delta.cardCount} cards across ${baseline.delta.filePaths?.length || 0} files`));
    if (!_sliceShouldDropDeltaFiles(trim)) {
      lines.push("Top files:");
      lines.push(...atlasListLines((baseline.delta.filePaths || []).slice(0, 8), (filePath) => `- ${filePath}`));
    }
  } else if (baseline.delta) {
    lines.push(atlasSubFailureLine("Delta", baseline.delta.error));
  }

  if (baseline.risk?.ok) {
    const scoreText = baseline.risk.score == null ? ATLAS_MISSING_VALUE : baseline.risk.score;
    lines.push(atlasField("PR risk score", `${scoreText} across ${baseline.risk.findingCount} findings`));
    lines.push("Top risk findings:");
    const maxFindings = _sliceMaxFindings(trim);
    const findings = Array.isArray(baseline.risk.topFindings) ? baseline.risk.topFindings.slice(0, maxFindings) : [];
    lines.push(...atlasListLines(findings, (finding) => atlasScoreLine(finding.score, finding.title)));
    if (!_sliceShouldDropRecommended(trim) && (baseline.risk.recommendedTests || []).length > 0) {
      lines.push("Recommended tests:");
      lines.push(...atlasListLines(baseline.risk.recommendedTests, (testPath) => `- ${testPath}`));
    }
  } else if (baseline.risk) {
    lines.push(atlasSubFailureLine("PR risk", baseline.risk.error));
  }

  if (baseline.previousVersionId) {
    lines.push("Use this baseline to drive blast-radius and risk analysis before requesting broader context.");
  } else {
    lines.push("Previous version is unknown; call review.risk directly with a known baseline before requesting broader context.");
  }

  return lines.join("\n");
}

function _buildAtlasSections(packet, trim) {
  const sections = [];

  // When the whole prefetch failed, every sub-prefetch failure shares that one
  // cause; the consolidated notice in ATLAS CONTEXT enumerates them, so the
  // per-sub-prefetch failure sections below are suppressed.
  const wholePrefetchFailed = !!packet.atlas?.prefetchFailed;

  if (packet.atlas?.active) {
    sections.push(renderAtlasContextSection(packet));
  }

  if (packet.atlas_assessment_baseline) {
    if (packet.atlas_assessment_baseline.ok) {
      sections.push(renderAtlasAssessmentBaselineSection(packet, { trim }));
    } else if (packet.atlas?.active && !wholePrefetchFailed) {
      sections.push(renderAtlasFailureSection(
        "ATLAS ASSESSMENT BASELINE",
        "ATLAS assessment",
        packet.atlas_assessment_baseline.error,
      ));
    }
  }

  if (packet.atlas_research_context) {
    if (packet.atlas_research_context.ok) {
      sections.push(renderAtlasResearchContextSection(packet, { trim }));
    } else if (packet.atlas?.active && !wholePrefetchFailed) {
      sections.push(renderAtlasFailureSection(
        "ATLAS RESEARCH PREFETCH",
        "ATLAS research",
        packet.atlas_research_context.error,
      ));
    }
  }

  if (packet.atlas_db_context?.ok) {
    const dbSection = renderAtlasDbContextSection(packet);
    if (dbSection) sections.push(dbSection);
  }

  if (packet.atlas_slice_context) {
    if (packet.atlas_slice_context.ok) {
      sections.push(renderAtlasSliceSection(packet, { trim }));
    } else if (packet.atlas?.active && !wholePrefetchFailed) {
      const treeSourced = packet.atlas_slice_context.source === "tree.scope"
        || packet.atlas_slice_context.source === "tree.expand";
      sections.push(renderAtlasFailureSection(
        treeSourced ? "ATLAS TREE SCOPE PRUNING" : "ATLAS SLICE PRUNING",
        treeSourced ? "ATLAS tree.scope" : "ATLAS slice",
        packet.atlas_slice_context.error,
      ));
    }
  }

  return sections.join("\n\n");
}

// Render ATLAS sections and return rendering metadata. Tries increasing trim
// levels until the output fits under ATLAS_SECTION_CHAR_CAP, or bottoms out at
// ATLAS_MAX_TRIM_LEVEL (whose output is always emitted, even if still over cap —
// we never drop ATLAS content entirely, just shed detail).
export function renderAtlasHandoffSectionsWithMeta(packet) {
  let text = _buildAtlasSections(packet, 0);
  let trimLevel = 0;
  const originalLength = text.length;
  while (text.length > ATLAS_SECTION_CHAR_CAP && trimLevel < ATLAS_MAX_TRIM_LEVEL) {
    trimLevel += 1;
    text = _buildAtlasSections(packet, trimLevel);
  }
  return {
    text,
    charCount: text.length,
    originalLength,
    trimLevel,
    truncated: trimLevel > 0,
    cap: ATLAS_SECTION_CHAR_CAP,
  };
}

export function renderAtlasHandoffSections(packet) {
  return renderAtlasHandoffSectionsWithMeta(packet).text;
}

// Lowercased repo-relative paths whose content the ATLAS prefetch already
// supplied (exact bodies, skeleton outlines, or symbol cards). Used to gate
// duplicate local previews (e.g. HINTED FILE PREVIEW) behind ATLAS coverage.
export function collectAtlasCoveredFiles(packet) {
  const slice = packet?.atlas_slice_context;
  if (!slice?.ok) return new Set();
  const paths = [];
  for (const item of (Array.isArray(slice.exactFiles) ? slice.exactFiles : [])) {
    if (item?.ok && item.file) paths.push(item.file);
  }
  for (const sk of (Array.isArray(slice.skeletons) ? slice.skeletons : [])) {
    if (sk?.ok && sk.file) paths.push(sk.file);
  }
  for (const card of (Array.isArray(slice.cards) ? slice.cards : [])) {
    if (card?.file) paths.push(card.file);
  }
  for (const card of (Array.isArray(slice.seedSymbolCards) ? slice.seedSymbolCards : [])) {
    if (card?.file) paths.push(card.file);
  }
  return _pathSet(paths);
}
