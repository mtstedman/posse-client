// lib/handoff/helpers/atlas-context.js
//
// ATLAS handoff-state resolution, planner slice prefetch, and context rendering.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { extractJson } from "../../../../shared/format/functions/json.js";
import { getAtlasDeterministicToolDefinitions } from "../../../../functions/toolkit/atlas.js";
import { getAtlasIntegrationConfig, resolveAtlasExecutionAttachment } from "../../../integrations/functions/atlas.js";
import { executeEmbeddedAtlasTool } from "../../../integrations/functions/atlas-embedded.js";
import { resolveAtlasToolGateEnabled } from "../../../integrations/functions/deterministic-mcp/gate-settings.js";
import { isIndexableSourcePath } from "../../../integrations/functions/deterministic-mcp/source-file-gate.js";
import { resolvePathWithin } from "../../../runtime/functions/fs-safety.js";
import { isSensitiveEnvFileOrTargetPath } from "../../../runtime/functions/sensitive-paths.js";
import { formatAtlasBackendText, atlasBackendLabel } from "../../../integrations/functions/atlas-label.js";
import { isExternallyRoutedAtlasTool } from "../../../integrations/functions/deterministic-mcp/tool-descriptors.js";
import { semanticDispatchEnabled } from "../../../atlas/functions/v2/embeddings/resources.js";
import { inspectLocalOnnxStatus } from "../../../atlas/functions/v2/embeddings/local-onnx.js";
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
const LEXICAL_PREFETCH_CACHE_TTL_MS = 30_000;
const LEXICAL_PREFETCH_CACHE_MAX = 64;
const LEXICAL_PREFETCH_SCAN_LIMIT = 120_000;
const LEXICAL_PREFETCH_RG_MAX_BUFFER = 16 * 1024 * 1024;
const LEXICAL_PREFETCH_CACHE = new Map();

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
  if (!semanticDispatchEnabled(config)) return false;
  return inspectLocalOnnxStatus({ repoRoot: packet?.cwd || undefined, config }).enabled === true;
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
    ...(Array.isArray(packet?.files_to_modify) ? packet.files_to_modify : []),
    ...(Array.isArray(packet?.related_files) ? packet.related_files : []),
    ...(Array.isArray(packet?.context_hints?.atlas_seed_files) ? packet.context_hints.atlas_seed_files : []),
    ...(Array.isArray(packet?.context_hints?.atlasSeedFiles) ? packet.context_hints.atlasSeedFiles : []),
    ..._collectAtlasReferenceFiles(packet),
    ..._collectLexicalAtlasCandidateFiles(packet, 8),
  ], 30);
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

    const compositeRiskPromise = (latestVersion && previousVersion && tools.has("pr.risk"))
      ? executeEmbeddedAtlasTool("pr.risk", {
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
            return { ok: false, error: "ATLAS returned non-JSON pr.risk payload." };
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
    const deltaPromise = (!tools.has("pr.risk") && latestVersion && previousVersion && tools.has("delta.get"))
      ? executeEmbeddedAtlasTool("delta.get", {
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
            : { ok: false, error: "ATLAS returned non-JSON delta.get payload." };
        },
        (err) => ({ ok: false, error: String(err?.message || err).slice(0, 300) }),
      )
      : Promise.resolve(null);

    const riskPromise = (!tools.has("pr.risk") && latestVersion && previousVersion && tools.has("pr.risk.analyze"))
      ? executeEmbeddedAtlasTool("pr.risk.analyze", {
        fromVersion: previousVersion,
        toVersion: latestVersion,
      }, { cwd: packet.cwd, config: packet.atlas_config || undefined, origin: "prefetch" }).then(
        (riskRaw) => {
          if (String(riskRaw || "").startsWith("Error:")) {
            return { ok: false, error: String(riskRaw).slice(0, 300) };
          }
          const risk = extractAtlasJsonPayload(riskRaw);
          if (!risk) {
            return { ok: false, error: "ATLAS returned non-JSON pr.risk.analyze payload." };
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

async function _prefetchSliceSkeletons(filePaths, {
  packet,
  toolsAvailable,
  maxFiles = 3,
  perFileTimeoutMs = 8000,
}) {
  if (!toolsAvailable.includes("code.getSkeleton")) return [];
  if (!Array.isArray(filePaths) || filePaths.length === 0) return [];
  const targets = _uniqueAtlasPaths(filePaths)
    .filter((file) => _isIndexedSourcePath(file))
    .slice(0, Math.max(1, maxFiles));
  if (targets.length === 0) return [];
  const results = await Promise.all(targets.map((file) => executeEmbeddedAtlasTool(
    "code.getSkeleton",
    { file },
    { cwd: packet.cwd, config: packet.atlas_config || undefined, timeoutMs: perFileTimeoutMs, origin: "prefetch" },
  ).then(
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
      const skeletonField = atlasResultField("code.getSkeleton", parsed, "content");
      const skeleton = typeof skeletonField === "string"
        ? skeletonField
        : (typeof parsed.skeleton === "string" ? parsed.skeleton : null);
      if (!skeleton) {
        return { file, ok: false, error: "skeleton field missing" };
      }
      const fileField = atlasResultField("code.getSkeleton", parsed, "filePath");
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

async function _prefetchExactScopedFiles(filePaths, {
  packet,
  toolsAvailable,
  maxFiles = ATLAS_EXACT_PREFETCH_MAX_FILES,
  perFileTimeoutMs = 8000,
}) {
  const targets = _uniqueAtlasPaths(filePaths, maxFiles);
  if (targets.length === 0) return [];
  const tools = new Set(Array.isArray(toolsAvailable) ? toolsAvailable : []);

  const readFile = (file) => Promise.resolve().then(() => {
    // Realpath-based containment (symlink-safe) + sensitive-env skip, matching
    // the guards every other handoff read path enforces (see file-attach.js).
    const absolute = resolvePathWithin(packet.cwd || ".", file, { allowEqual: false });
    if (!absolute) {
      return { file, ok: false, kind: "read_file", error: "path escaped repository root" };
    }
    if (isSensitiveEnvFileOrTargetPath(absolute)) {
      return { file, ok: false, kind: "read_file", error: "sensitive_env file skipped" };
    }
    const source = fs.readFileSync(absolute, "utf8");
    const totalBytes = Buffer.byteLength(source, "utf8");
    const allLines = source.split(/\r?\n/);
    const limitedLines = allLines.slice(0, ATLAS_EXACT_PREFETCH_MAX_LINES);
    let content = limitedLines.join("\n");
    let truncated = limitedLines.length < allLines.length;
    const buf = Buffer.from(content, "utf8");
    if (buf.length > ATLAS_EXACT_PREFETCH_MAX_BYTES) {
      content = buf.subarray(0, ATLAS_EXACT_PREFETCH_MAX_BYTES).toString("utf8");
      truncated = true;
    }
    return {
      file,
      ok: true,
      kind: "read_file",
      content,
      bytes: totalBytes,
      totalBytes,
      totalLines: allLines.length,
      returnedLines: limitedLines.length,
      truncated,
    };
  }).catch((err) => ({ file, ok: false, kind: "read_file", error: String(err?.message || err).slice(0, 240) }));

  const readSkeleton = (file) => executeEmbeddedAtlasTool(
    "code.getSkeleton",
    { file },
    { cwd: packet.cwd, config: packet.atlas_config || undefined, timeoutMs: perFileTimeoutMs, origin: "prefetch" },
  ).then(
    (raw) => {
      if (String(raw || "").startsWith("Error:")) {
        return { file, ok: false, kind: "code.getSkeleton", error: String(raw).slice(0, 240) };
      }
      const parsed = extractAtlasJsonPayload(raw);
      if (!parsed) {
        return { file, ok: false, kind: "code.getSkeleton", error: "ATLAS returned non-JSON skeleton payload." };
      }
      const skeletonField = atlasResultField("code.getSkeleton", parsed, "content");
      const skeleton = typeof skeletonField === "string"
        ? skeletonField
        : (typeof parsed.skeleton === "string" ? parsed.skeleton : "");
      if (!skeleton) {
        return { file, ok: false, kind: "code.getSkeleton", error: "skeleton field missing" };
      }
      const fileField = atlasResultField("code.getSkeleton", parsed, "filePath");
      return {
        file: typeof fileField === "string" && fileField ? fileField : (parsed.file || file),
        ok: true,
        kind: "code.getSkeleton",
        skeleton,
        truncated: !!parsed.truncated,
        estimatedTokens: Number.isFinite(Number(parsed.estimatedTokens)) ? Number(parsed.estimatedTokens) : null,
        originalLines: Number.isFinite(Number(parsed.originalLines)) ? Number(parsed.originalLines) : null,
      };
    },
    (err) => ({ file, ok: false, kind: "code.getSkeleton", error: String(err?.message || err).slice(0, 240) }),
  );

  return Promise.all(targets.map((file) => {
    if (!_isIndexedSourcePath(file)) return readFile(file);
    if (tools.has("code.getSkeleton")) return readSkeleton(file);
    return {
      file,
      ok: false,
      kind: _isIndexedSourcePath(file) ? "code.getSkeleton" : "read_file",
      error: "required ATLAS exact-file tool is not routed to this role",
    };
  }));
}

export function atlasSliceSkeletonPrefetchLimit(recipient) {
  const role = String(recipient || "").trim().toLowerCase();
  if (role === "planner") return 3;
  if (role === "dev") return 2;
  return 0;
}

export async function attachAtlasPlannerSlice(packet) {
  try {
    if (!packet?.atlas?.active) return;
    if (packet.recipient !== "researcher" && packet.recipient !== "planner" && packet.recipient !== "dev") return;
    if (!_isPrefetchCwdUsable(packet.cwd)) return;
    const tools = internalAtlasTools(packet);
    if (!tools.has("slice.build")) return;

    const taskText = buildPlannerAtlasTaskText(packet);
    if (!taskText) return;

    const seedFiles = selectAtlasPrefetchTargets(packet).sliceSeedFiles;
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
        error: String(raw).slice(0, 300),
      };
      return;
    }

    const parsed = extractAtlasJsonPayload(raw);
    if (!parsed) {
      packet.atlas_slice_context = {
        ok: false,
        error: "ATLAS returned non-JSON slice payload.",
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
      raw: data,
    };
  } catch (err) {
    packet.atlas_slice_context = {
      ok: false,
      error: String(err?.message || err).slice(0, 300),
    };
  }
}

// ─── Shared rendering vocabulary ─────────────────────────────────────────────
// All ATLAS prefetch sections share these primitives so phrasing stays unified
// when new prefetch tools are added.
const ATLAS_MISSING_VALUE = "(unknown)";
const ATLAS_EMPTY_LIST_LINE = "- (none)";
const ATLAS_FAILURE_FALLBACK = "Fallback: continue with deterministic preload context.";

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

function atlasListLines(items, mapper) {
  if (!Array.isArray(items) || items.length === 0) return [ATLAS_EMPTY_LIST_LINE];
  return items.map(mapper);
}

function atlasSubFailureLine(label, error) {
  return `${label} prefetch failed: ${error || "unknown error"}`;
}

function renderAtlasFailureSection(title, label, error) {
  return [
    atlasHeading(title),
    atlasSubFailureLine(label, error),
    ATLAS_FAILURE_FALLBACK,
  ].join("\n");
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
    "pr.risk",
    "delta.get",
    "pr.risk.analyze",
    "symbol.getCard",
    "code.getSkeleton",
    "code.getHotPath",
    "code.needWindow",
  ];
  const discoveryOrder = [
    "symbol.search",
    "slice.build",
    "context.summary",
    "code.getSkeleton",
    "code.getHotPath",
    "code.needWindow",
    "context",
    "symbol.getCard",
  ];
  const order = available.has("pr.risk") || available.has("delta.get") || available.has("pr.risk.analyze")
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
  const gateEnabled = packet?.atlas?.gateEnabled != null
    ? !!packet.atlas.gateEnabled
    : resolveAtlasToolGateEnabled();
  const prefetchStatus = String(packet?.atlas?.prefetchStatus || "").toLowerCase();
  if (!gateEnabled) {
    if (isAtlasPrefetchStatusRelevant(prefetchStatus)) {
      return `${label} PREFETCH RELEVANT: initial ${label} retrieval supplied task-relevant context. Use that prefetch as a comprehension scaffold: form the first mental model of the domain, key files, symbols, and likely data flow before deciding what to inspect next. A useful ${label} pass should improve your understanding of the content and behavior, not merely list matching files; if results only show names or signatures, follow with targeted symbol/slice/skeleton/window tools or standard reads under the fallback policy. Make additional ${label} calls only for specific gaps, preferably with targeted symbol/slice/skeleton tools rather than repeated broad overview or memory calls. Use standard tools when ${label} is unavailable, insufficient, you have mutated files and need exact current worktree state, or git/test/build/shell operations are required.`;
    }
    if (prefetchStatus === "ok_unhelpful" || prefetchStatus === "prefetch_ok_unhelpful") {
      return `${label} PREFETCH UNHELPFUL: initial ${label} retrieval completed but did not match the requested scope. Try a task-relevant ${label} retrieval first when possible, then use standard tools if ${label} cannot provide sufficient information.`;
    }
    const firstTools = selectFirstRetrievalTools(packet?.atlas?.tools, packet?.atlas);
    const examples = firstTools.length > 0
      ? ` (start with ${firstTools.join(" / ")})`
      : "";
    return `${label} RETRIEVAL ORDER: use ${label} tools when possible for repository discovery, codebase understanding, and line-level inspection${examples}. Treat ${label} output as a map of concepts, relationships, content, and likely behavior, then read only the few decisive files needed to verify exact behavior. Use standard tools when ${label} is unavailable, insufficient, you have mutated files and need exact current worktree state, git/test/build/shell operations are required, or ${label} does not expose the needed operation.`;
  }
  if (isAtlasPrefetchStatusRelevant(prefetchStatus)) {
    return `${label} PREFETCH RELEVANT: initial ${label} retrieval supplied task-relevant context. Use prefetch as a comprehension scaffold for the first mental model of the code's content and behavior; it does not count as active ${label} use or unlock fallback. Make the minimum targeted ${label} calls needed for remaining evidence or gate unlocks, and avoid calls made only to satisfy usage.`;
  }
  if (prefetchStatus === "ok_unhelpful" || prefetchStatus === "prefetch_ok_unhelpful") {
    return `${label} PREFETCH UNHELPFUL: initial ${label} retrieval completed but did not match the requested scope. Make focused ${label} retrieval calls for the exact task or scoped files before broad native reads; stop once the needed context or fallback unlock is obtained.`;
  }
  const firstTools = selectFirstRetrievalTools(packet?.atlas?.tools, packet?.atlas);
  const examples = firstTools.length > 0
    ? ` (start with ${firstTools.join(" / ")})`
    : "";
  return `REQUIRED RETRIEVAL ORDER: use task-relevant ${label} retrieval calls${examples} to build the codebase map and unlock fallback before standard list/search/read tools. Prefetch and internal bookkeeping calls do not count. Use standard tools only when ${label} is unavailable, fails to answer after the required real retrieval attempts, you have mutated files and need exact current worktree state, git/test/build/shell operations are required, or ${label} does not expose the needed operation.`;
}

function renderAtlasContextSection(packet) {
  const label = atlasBackendLabel(packet?.atlas);
  if (packet.atlas?.prefetchFailed) {
    // Prefetch failed but we're in a fallback-eligible mode. Keep phase/repo
    // for debuggability but replace the "active" framing and tool guidance
    // with a single fallback notice so the agent doesn't try to call ATLAS tools.
    const detail = packet.atlas.prefetchFailureDetail
      ? `Failure detail: ${String(packet.atlas.prefetchFailureDetail).split(/\r?\n/)[0].slice(0, 240)}`
      : null;
    return [
      atlasHeading(`${label} CONTEXT`),
      packet.atlas.fallbackNotice
        ? formatAtlasBackendText(packet.atlas.fallbackNotice, label)
        : `${label} prefetch failed. Do not call ${label} tools for this handoff; continue with deterministic file/search/edit tools and preload context.`,
      `${label} TOOL STATUS: unavailable for this handoff. Normal tools remain available; keep working without ${label}.`,
      detail,
      atlasField("Phase", packet.atlas.phase),
      atlasField("Repo target", packet.atlas.repo?.repoPath),
    ].filter(Boolean).join("\n");
  }
  const provider = packet.atlas?.provider || "unknown";
  const transport = String(packet.atlas?.transport || "").trim().toLowerCase();
  const route = transport === "mcp-gateway" || transport === "posse-gateway" || transport === "deterministic-mcp"
    ? "through the Posse MCP gateway as the atlas.* suite"
    : (transport ? `through ${packet.atlas.transport}` : "through the configured provider tool surface");
  return [
    atlasHeading(`${label} CONTEXT`),
    `${label} is active for this handoff via provider ${provider} ${route}.`,
    atlasField("Phase", packet.atlas.phase),
    atlasField("Repo target", packet.atlas.repo?.repoPath),
    packet.atlas.tools?.length > 0 ? atlasField(`Preferred ${label} tools`, displayAtlasToolList(packet.atlas.tools, packet.atlas)) : null,
    // Explicit priority framing keeps the loaded ATLAS backend as the default
    // discovery path while
    // preserving deterministic tools for exact worktree state and edits.
    renderRequiredRetrievalOrderLine(packet),
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
  } else if (item.kind === "code.getSkeleton") {
    lines.push(..._renderIndentedPrefetchContent(item.skeleton, {
      maxChars: trim >= 2 ? 1000 : trim >= 1 ? 1600 : 2600,
    }));
  }
  return lines;
}

function renderAtlasSliceSection(packet, { trim = 0 } = {}) {
  const slice = packet.atlas_slice_context;
  const label = atlasBackendLabel(packet?.atlas);
  const lines = [
    atlasHeading(`${label} SLICE PRUNING`),
    atlasField("Slice handle", slice.sliceHandle || ATLAS_MISSING_VALUE),
    atlasField("Cards", slice.cardCount || 0),
    atlasField("Repo", slice.repoId || ATLAS_MISSING_VALUE),
  ].filter(Boolean);

  if (Array.isArray(slice.exactFiles) && slice.exactFiles.length > 0) {
    lines.push(`Scoped ${label} prefetch evidence:`);
    for (const item of slice.exactFiles) {
      lines.push(..._renderExactFileBlock(item, trim));
    }
  }

  if (Array.isArray(slice.cards) && slice.cards.length > 0) {
    lines.push("Top cards (semantic summaries):");
    for (const card of slice.cards) {
      lines.push(_renderCardLine(card));
      for (const detail of _renderCardDetailLines(card)) lines.push(detail);
    }
  } else if ((slice.cardCount || 0) > 0) {
    lines.push("Top cards unavailable in this payload; rely on file paths below.");
  }

  const displayedFiles = Array.isArray(slice.filePaths) ? slice.filePaths : [];
  const rankedFiles = Array.isArray(slice.rankedFiles) ? slice.rankedFiles : displayedFiles;
  if (displayedFiles.length > 0) {
    const exactTargets = Array.isArray(slice.exactFiles) && slice.exactFiles.length > 0;
    lines.push(exactTargets
      ? "Explicit ATLAS file targets:"
      : "Slice-ranked candidate files (not prefetched):");
    lines.push(...atlasListLines(displayedFiles, (filePath) => `- ${filePath}`));
  }
  const displayedSet = _pathSet(displayedFiles);
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

  if (!_sliceShouldDropFrontier(trim) && Array.isArray(slice.frontier) && slice.frontier.length > 0) {
    lines.push("Top frontier hints:");
    lines.push(...atlasListLines(slice.frontier, atlasFrontierLine));
  }

  lines.push(skeletons.length > 0
    ? "Use the summaries + skeletons above before escalating to raw file reads."
    : "Use the summaries above before escalating to raw file reads.");
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
    lines.push(`Use prefetch as the first codebase map, then make targeted real ${label} retrieval calls only for remaining code-evidence gaps or native fallback unlocks; prefetch does not count toward gate unlocks.`);
  } else {
    const label = atlasBackendLabel(packet.atlas);
    lines.push(`Use prefetch as the first codebase map. Make additional task-relevant ${label} calls only for specific code-evidence gaps; use native file/search tools when ${label} cannot provide sufficient information.`);
  }
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
    lines.push("Previous version is unknown; call pr.risk directly with a known baseline before requesting broader context.");
  }

  return lines.join("\n");
}

function _buildAtlasSections(packet, trim) {
  const sections = [];

  if (packet.atlas?.active) {
    sections.push(renderAtlasContextSection(packet));
  }

  if (packet.atlas_assessment_baseline) {
    if (packet.atlas_assessment_baseline.ok) {
      sections.push(renderAtlasAssessmentBaselineSection(packet, { trim }));
    } else if (packet.atlas?.active) {
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
    } else if (packet.atlas?.active) {
      sections.push(renderAtlasFailureSection(
        "ATLAS RESEARCH PREFETCH",
        "ATLAS research",
        packet.atlas_research_context.error,
      ));
    }
  }

  if (packet.atlas_slice_context) {
    if (packet.atlas_slice_context.ok) {
      sections.push(renderAtlasSliceSection(packet, { trim }));
    } else if (packet.atlas?.active) {
      sections.push(renderAtlasFailureSection(
        "ATLAS SLICE PRUNING",
        "ATLAS slice",
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
