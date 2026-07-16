// lib/handoff.js — Routing packet builder + context enrichment
//
// Two entry points:
//
//   buildRoutingPacket(job, opts) → routing packet
//     Assembles the full routing packet from job + queue state.
//     Deterministic. No AI. This is THE contract between scheduler → worker → provider.
//
//   handoff({ recipient, data }) → enriched packet
//     Attaches filesystem context to a routing packet or raw data.
//     Reads files, builds trees. Still deterministic, still no AI.
//
// The routing packet IS the context packet. No nesting.
//
// Internal steps (explicit, not magic):
//   1. normalizePayload    — validate, set defaults
//   2. attachEditableFiles — read files_to_modify from disk
//   3. attachRelatedFiles  — read related_files from disk
//   4. attachDirectoryTree — when recipient needs filesystem awareness
//   5. attachSourcePreload — bulk preload for roles without read tools
//   6. applyToolPolicy     — per-recipient permissions + budgets

import { SETTING_KEYS } from "../../../catalog/settings.js";
import { HANDOFF_SOURCE_EXTENSIONS } from "../../../catalog/files.js";

import fs from "fs";
import path from "path";
import { getIntSetting, getSetting, logEvent } from "../../queue/functions/index.js";
import {
  HANDOFF_PRELOAD_EDITABLE_FILE_BODIES_VALUES,
} from "../../settings/functions/catalog.js";
import { extractJson } from "../../../shared/format/functions/json.js";
import {
  getSkillById,
  isSkillsEnabled,
  parseSkillIds,
  validateSkillIds,
} from "../../../shared/skills/functions/registry.js";
import { ASSESSABLE_JOB_TYPES, MUTATING_JOB_TYPES } from "../../../catalog/job.js";
import { attachDiffNarrative, attachDiffNarrativeAsync } from "../../git/functions/diff-narrator.js";
import { gitExec, gitExecAsync } from "../../git/functions/utils.js";
import { validateMutableRepoPath } from "../../runtime/functions/protected-paths.js";
import { assertTestContext } from "../../runtime/functions/test-context.js";
import { resolvePathWithin } from "../../../shared/scope/functions/path.js";
import {
  INDEXABLE_EXTENSIONS as INDEXABLE_EXTENSIONS_FROM_MODULE,
  buildSmartPreload as buildSmartPreloadFromModule,
  parseFunctions as parseFunctionsFromModule,
} from "./helpers/fn-index.js";
import {
  classifyFileRisk as classifyFileRiskFromModule,
  isHighRiskPath as isHighRiskPathFromModule,
  looksLikeConcreteRequestedFile,
  parseFileRequest as parseFileRequestFromModule,
  splitFileRequestsByRisk as splitFileRequestsByRiskFromModule,
} from "./helpers/file-request.js";
import {
  extractResearcherFiles as extractResearcherFilesFromModule,
  normalizeResearcherCitationTriage as normalizeResearcherCitationTriageFromModule,
  normalizeResearcherFilePriorities as normalizeResearcherFilePrioritiesFromModule,
  normalizeResearcherKeySymbols as normalizeResearcherKeySymbolsFromModule,
  parseResearcherStructuredOutput as parseResearcherStructuredOutputFromModule,
  researcherOutputNeedsHuman as researcherOutputNeedsHumanFromModule,
} from "./helpers/researcher-output.js";
import { detectPendingMergeAsync as detectPendingMergeAsyncFromModule } from "./helpers/merge-state.js";
import {
  buildMemoryPrefetchNotice as buildMemoryPrefetchNoticeFromModule,
  buildStep0Context as buildStep0ContextFromModule,
  loadMemorySurfaceAsync as loadMemorySurfaceAsyncFromModule,
  loadRelevantInsightsAsync as loadRelevantInsightsAsyncFromModule,
  loadRelevantInsights as loadRelevantInsightsFromModule,
} from "./helpers/insights-step0.js";
import {
  assertHandoffScopePreflight as assertHandoffScopePreflightFromModule,
  hasWritableScope as hasWritableScopeFromModule,
  isZeroEditCodeTask as isZeroEditCodeTaskFromModule,
} from "./helpers/scope-preflight.js";
import {
  attachAtlasAssessorPrefetch as attachAtlasAssessorPrefetchFromModule,
  attachAtlasDbPrefetch as attachAtlasDbPrefetchFromModule,
  attachAtlasPlannerSlice as attachAtlasPlannerSliceFromModule,
  attachAtlasResearcherPrefetch as attachAtlasResearcherPrefetchFromModule,
  classifyAtlasPrefetchRelevance as classifyAtlasPrefetchRelevanceFromModule,
  collectAtlasCoveredFiles as collectAtlasCoveredFilesFromModule,
  renderAtlasHandoffSectionsWithMeta as renderAtlasHandoffSectionsWithMetaFromModule,
  resolveAtlasHandoffState as resolveAtlasHandoffStateFromModule,
} from "./helpers/atlas-context.js";
import { classifyAtlasFailure } from "../../integrations/functions/atlas-embedded.js";
import { DEFAULT_DEV_MODE, DEFAULT_FIX_DEV_MODE, normalizeDevMode, renderSelectedDevModeContract } from "../../../shared/policies/functions/dev-modes.js";
import { runWithObservationContext, getObservationContext, recordObservation } from "../../observability/functions/observations.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import { createWorkspaceSkipDirs } from "../../runtime/functions/workspace-skip.js";
import { getAtlasHandoffPrefetchTimeoutMs, getFixScopeHandoffGuardMode } from "../../settings/functions/tunables.js";
import {
  packetToContextString as packetToContextStringFromModule,
  packetToDynamicContextString as packetToDynamicContextStringFromModule,
} from "./helpers/context-render.js";
import {
  expandHashRefHandoffPacketProofs as expandHashRefHandoffPacketProofsFromModule,
} from "./helpers/hash-ref-packet.js";
import {
  DEFAULT_TRAVERSAL_COMPLETION_MAX_CHARS,
  buildTraversalCompletionCheck as buildTraversalCompletionCheckFromModule,
} from "./helpers/traversal-completeness.js";
import {
  buildAtlasShadowGuardrails as buildAtlasShadowGuardrailsFromModule,
} from "./helpers/atlas-shadow-guardrails.js";
import {
  attachCreatableFiles as attachCreatableFilesFromModule,
  attachDirectoryTree as attachDirectoryTreeFromModule,
  attachEditableFiles as attachEditableFilesFromModule,
  attachRelatedFiles as attachRelatedFilesFromModule,
  attachSourcePreload as attachSourcePreloadFromModule,
  collectSourceFiles as collectSourceFilesFromModule,
  directoryTree as directoryTreeFromModule,
  readFile as readFileFromModule,
} from "./helpers/file-attach.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { getDefaultRemoteComposer } from "../../remote/classes/RemoteComposer.js";
import { getPosseRemoteMode, getPosseRemoteTimeoutMs } from "../../remote/functions/mode.js";

const SLOW_HANDOFF_STEP_MS = 1000;
const HANDOFF_TIMEOUT_GRACE_MS = 2000;

function positiveIntFromEnv(names = [], fallback = null) {
  for (const name of names) {
    const value = process.env?.[name];
    const parsed = Number.parseInt(String(value || "").trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function atlasHandoffPrefetchTimeoutMs() {
  return getAtlasHandoffPrefetchTimeoutMs();
}

function remoteCompileHandoffTimeoutMs() {
  const configured = positiveIntFromEnv(["POSSE_HANDOFF_REMOTE_COMPILE_TIMEOUT_MS"], null);
  if (configured) return configured;
  return Math.max(1000, getPosseRemoteTimeoutMs() + HANDOFF_TIMEOUT_GRACE_MS);
}

async function timeHandoffStep(packet, label, fn, {
  warnMs = SLOW_HANDOFF_STEP_MS,
  timeoutMs = null,
  timeoutGraceMs = 0,
} = {}) {
  const startedAt = Date.now();
  let timer = null;
  let graceTimer = null;
  try {
    const runPromise = Promise.resolve().then(fn);
    const timeout = Number(timeoutMs);
    if (Number.isFinite(timeout) && timeout > 0) {
      const settledPromise = runPromise.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => {
          const err = new Error(`Handoff step ${label} timed out after ${timeout}ms.`);
          err.code = "HANDOFF_STEP_TIMEOUT";
          err.step = label;
          err.timeoutMs = timeout;
          resolve({ status: "timeout", error: err });
        }, timeout);
        timer.unref?.();
      });
      const first = await Promise.race([settledPromise, timeoutPromise]);
      if (first.status === "fulfilled") return first.value;
      if (first.status === "rejected") throw first.error;

      const grace = Number(timeoutGraceMs);
      if (Number.isFinite(grace) && grace > 0) {
        const gracePromise = new Promise((resolve) => {
          graceTimer = setTimeout(() => resolve({ status: "grace_expired" }), grace);
          graceTimer.unref?.();
        });
        const late = await Promise.race([settledPromise, gracePromise]);
        if (late.status === "fulfilled") return late.value;
        if (late.status === "rejected") throw late.error;
      }
      throw first.error;
    }
    return await runPromise;
  } finally {
    if (timer) clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
    const durationMs = Date.now() - startedAt;
    if (durationMs >= warnMs) {
      log.warn("handoff", "Handoff step was slow", {
        role: packet?.recipient || null,
        label,
        durationMs,
        job_id: packet?.job_id ?? null,
        work_item_id: packet?.work_item_id ?? null,
      });
    }
  }
}

export const __testTimeHandoffStep = timeHandoffStep;

function formatHandoffStepFailure(err) {
  const message = err?.message || String(err || "unknown handoff failure");
  return String(message).split(/\r?\n/)[0].slice(0, 300);
}

function copyAtlasPrefetchFields(target, source) {
  for (const key of [
    "atlas_assessment_baseline",
    "atlas_db_context",
    "atlas_research_context",
    "atlas_slice_candidates",
    "atlas_slice_context",
    "atlas_slice_prefetch_attempted",
  ]) {
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
    else delete target[key];
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

const SKIP_DIRS = createWorkspaceSkipDirs();

const SOURCE_EXTENSIONS = HANDOFF_SOURCE_EXTENSIONS;

const DEFAULT_MAX_PROMPT_CHARS = 600000;
const MAX_FILE_SIZE = 150000;
const MAX_PRELOAD_TOTAL = 80000;
const MAX_SMART_PRELOAD_SIZE = 200000;
const MAX_RELATED_FILES_TOTAL = 400000;
const MAX_ATLAS_FALLBACK_FILES = 12;

function _normalizeFixScopePath(value = "") {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
}

function _looksLikeFixScopePath(value = "") {
  const normalized = _normalizeFixScopePath(value);
  if (!normalized || /\s/.test(normalized)) return false;
  if (!looksLikeConcreteRequestedFile(normalized)) return false;
  if (validateMutableRepoPath(normalized, "fix_scope") != null) return false;
  return true;
}

function _collectFixScopeCandidates(text = "") {
  const source = String(text || "");
  const candidates = new Set();
  for (const match of source.matchAll(/`([^`\r\n]+)`/g)) {
    const value = _normalizeFixScopePath(match[1]);
    if (_looksLikeFixScopePath(value)) candidates.add(value);
  }
  for (const match of source.matchAll(/\b([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+|[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)\b/g)) {
    const value = _normalizeFixScopePath(match[1]);
    if (_looksLikeFixScopePath(value)) candidates.add(value);
  }
  return [...candidates];
}

function _looksLikeReadOnlyCopySourceMention(source, candidate) {
  const haystack = String(source || "").toLowerCase();
  const needle = String(candidate || "").toLowerCase();
  if (!haystack || !needle) return false;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const before = haystack.slice(Math.max(0, index - 60), index);
    if (/\b(?:copy|copies|copied|originals?|source)\s+(?:of|from)\s+[`"']?\s*$/.test(before)) return true;
    if (/\bfrom\s+[`"']?\s*$/.test(before)) return true;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return false;
}

function _extractFixInstructionEditTargets(text = "") {
  const source = String(text || "");
  if (!source.trim()) return [];
  const lowerSource = source.toLowerCase();
  const targets = [];
  const editWord = String.raw`(?:add|update|modify|edit|fix|implement|adjust|change|patch|repair|replace|overwrite|guard|harden)`;
  const deleteWord = String.raw`(?:delete|remove|rollback|revert|restore|drop|prune)`;
  const createWord = String.raw`(?:create|new file|write|generate|missing|does not exist)`;

  for (const candidate of _collectFixScopeCandidates(source)) {
    if (_looksLikeReadOnlyCopySourceMention(source, candidate)) continue;
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wrapped = `[\\s"'\\x60]*${escaped}[\\s"'\\x60]*`;
    const editBeforeRe = new RegExp(`${editWord}(?:\\s+(?:the\\s+file|file|target|module|tests?\\s+in|validation\\s+in))?\\s+${wrapped}`, "i");
    const editAfterRe = new RegExp(`${wrapped}[^\\r\\n]{0,120}\\b${editWord}(?:ed|ing)?\\b`, "i");
    let inferredEdit = editBeforeRe.test(source) || editAfterRe.test(source);
    if (!inferredEdit) {
      const idx = lowerSource.indexOf(candidate.toLowerCase());
      if (idx >= 0) {
        const context = lowerSource.slice(Math.max(0, idx - 90), Math.min(lowerSource.length, idx + candidate.length + 90));
        const mentionsCreateOnly = new RegExp(`\\b${createWord}\\b`, "i").test(context);
        const mentionsDeleteOnly = new RegExp(`\\b${deleteWord}\\b`, "i").test(context);
        const mentionsEdit = new RegExp(`\\b${editWord}\\b`, "i").test(context);
        inferredEdit = mentionsEdit && !mentionsCreateOnly && !mentionsDeleteOnly;
      }
    }
    if (inferredEdit) targets.push(candidate);
  }

  return [...new Set(targets)];
}

export function applyFixScopeHandoffGuard(packet) {
  if (!packet || packet.job_type !== "fix") return [];
  const mode = getFixScopeHandoffGuardMode();
  if (mode === "off") return [];
  const rawPayload = packet._raw_payload || {};
  if (!packet._raw_payload) packet._raw_payload = rawPayload;
  const instructionText = [
    rawPayload.fix_instructions,
    rawPayload.instructions,
    packet.fix_instructions,
    packet.instructions,
  ].map((value) => String(value || "").trim()).filter(Boolean).join("\n\n");
  if (!instructionText || !packet.cwd) return [];

  const existing = new Set([
    ...(Array.isArray(packet.files_to_modify) ? packet.files_to_modify : []),
    ...(Array.isArray(packet.files_to_create) ? packet.files_to_create : []),
    ...(Array.isArray(packet.files_to_delete) ? packet.files_to_delete : []),
  ].map(_normalizeFixScopePath).filter(Boolean));
  const inferred = [];
  for (const candidate of _extractFixInstructionEditTargets(instructionText)) {
    if (existing.has(candidate)) continue;
    const fullPath = resolvePathWithin(packet.cwd, candidate, { allowEqual: false });
    if (!fullPath) continue;
    try {
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) continue;
    } catch {
      continue;
    }
    inferred.push(candidate);
  }
  if (inferred.length === 0) return [];

  const uniqueInferred = [...new Set(inferred)];
  if (mode === "enforce") {
    packet.fix_scope_guard_blocked = uniqueInferred;
    recordObservation({
      work_item_id: packet.work_item_id || null,
      job_id: packet.job_id || null,
      observation_type: "handoff.fix_scope_guard_blocked",
      summary: `Blocked ${uniqueInferred.length} inferred fix instruction target(s) from broadening files_to_modify`,
      detail: { files_to_modify_blocked: uniqueInferred, mode },
    });
    throw new Error(
      `Fix handoff scope guard blocked inferred write-scope expansion: ${uniqueInferred.join(", ")}. ` +
      `Add the file(s) to files_to_modify explicitly or set fix_scope_handoff_guard=warn.`,
    );
  }

  const added = [];
  for (const candidate of uniqueInferred) {
    packet.files_to_modify.push(candidate);
    packet._raw_payload.files_to_modify = [...(packet._raw_payload.files_to_modify || []), candidate];
    existing.add(candidate);
    added.push(candidate);
  }
  if (added.length > 0) {
    packet.files_to_modify = [...new Set(packet.files_to_modify.map(_normalizeFixScopePath).filter(Boolean))];
    packet._raw_payload.files_to_modify = packet.files_to_modify;
    packet.fix_scope_guard_added = added;
    try {
      log.warn(
        "handoff",
        `WARN fix_scope_handoff_guard=warn WIDENED WRITE SCOPE: added ${added.length} path(s) inferred from fix_instructions to files_to_modify: ${added.join(", ")}`,
        {
          wiId: packet.work_item_id || null,
          jobId: packet.job_id || null,
          files_to_modify_added: added,
          mode,
        },
      );
    } catch {
      // File logging is best effort only.
    }
    recordObservation({
      work_item_id: packet.work_item_id || null,
      job_id: packet.job_id || null,
      observation_type: "handoff.fix_scope_guard",
      summary: `Fix scope guard (warn mode) widened write scope: added ${added.length} fix instruction target(s) to files_to_modify`,
      detail: { files_to_modify_added: added, mode },
    });
  }
  return added;
}

function _positiveIntegerSetting(key, fallback) {
  const parsed = Number.parseInt(String(getSetting(key) || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function _maxFileSize() {
  return _positiveIntegerSetting("handoff_max_file_bytes", MAX_FILE_SIZE);
}

function _maxPreloadTotal() {
  return _positiveIntegerSetting(SETTING_KEYS.HANDOFF_MAX_PRELOAD_TOTAL_BYTES, MAX_PRELOAD_TOTAL);
}

function _maxRelatedFilesTotal() {
  return _positiveIntegerSetting("handoff_max_related_files_total_bytes", MAX_RELATED_FILES_TOTAL);
}

function _maxPromptChars() {
  return _positiveIntegerSetting("handoff_max_prompt_chars", DEFAULT_MAX_PROMPT_CHARS);
}

function _maxContextChars() {
  const explicit = getIntSetting(SETTING_KEYS.HANDOFF_MAX_CONTEXT_CHARS, NaN);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const promptCap = _maxPromptChars();
  if (Number.isFinite(promptCap) && promptCap > 0) {
    return Math.max(20000, Math.floor(promptCap * 0.65));
  }
  return 120000;
}

function _editableFilePreloadMode() {
  const raw = String(getSetting(SETTING_KEYS.HANDOFF_PRELOAD_EDITABLE_FILE_BODIES) || "off").trim().toLowerCase();
  return new Set(HANDOFF_PRELOAD_EDITABLE_FILE_BODIES_VALUES).has(raw) ? raw : "off";
}

// ─── Tool Policies (per-recipient) ──────────────────────────────────────────

// Tool policies per recipient. Controls context assembly decisions:
//   allow_read=false  → preload source files for single-call/no-read roles
//   allow_read=true   → skip bulk source preload (agent has read tools at runtime)
// Must match actual runtime tool grants in the Claude and OpenAI providers.
const TOOL_POLICIES = {
  researcher: { allow_read: true,  allow_write: false, allow_shell: false, allow_tests: false, fallback_reads: 0 },  // chain_read/chain_verdict
  planner:    { allow_read: true,  allow_write: false, allow_shell: false, allow_tests: false, fallback_reads: 0 },  // read-only deterministic tools
  assessor:   { allow_read: true,  allow_write: false, allow_shell: true,  allow_tests: true,  fallback_reads: 4 },  // has verification/test tools and read-only Bash
  delegator:  { allow_read: false, allow_write: false, allow_shell: false, allow_tests: false, fallback_reads: 0 },  // single-call, receives queue state
  dev:        { allow_read: true,  allow_write: true,  allow_shell: true,  allow_tests: true,  fallback_reads: 3 },
  artificer:  { allow_read: true,  allow_write: true,  allow_shell: true,  allow_tests: false, fallback_reads: 0 },  // writes to output_root, bash for transforms
};

function _sanitizePayloadForRecipient(recipient, payload = {}) {
  if (!payload || typeof payload !== "object") return payload;
  let sanitized = payload;
  const internalPolicyKeys = [
    "_assess_model_tier",
    "_assess_model_name",
    "_assess_reasoning_effort",
    "_assess_pass_confidence_floor",
    "_execution_policy",
  ];
  if (internalPolicyKeys.some((key) => Object.prototype.hasOwnProperty.call(sanitized, key))) {
    sanitized = { ...sanitized };
    for (const key of internalPolicyKeys) delete sanitized[key];
  }
  if (recipient === "dev" && sanitized?.needs_image_generation) {
    sanitized = { ...sanitized, needs_image_generation: false };
  }
  if (recipient !== "dev" && sanitized?.dev_brief) {
    sanitized = { ...sanitized };
    delete sanitized.dev_brief;
  }
  if (recipient !== "dev" && sanitized?.hash_ref_packet) {
    sanitized = { ...sanitized };
    delete sanitized.hash_ref_packet;
  }
  return sanitized;
}

function _resolveFallbackReadBudget(recipient, baseFallbackReads, hints = {}) {
  if (hints.allow_fallback_reads != null) return hints.allow_fallback_reads;
  const settingKey = `${recipient}_fallback_reads`;
  const raw = getSetting(settingKey);
  if (raw == null || raw === "") return baseFallbackReads;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return baseFallbackReads;
  return Math.max(0, parsed);
}

function _firstAtlasPrefetchErrorLine(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text) continue;
    return text.split(/\r?\n/)[0].slice(0, 300);
  }
  return null;
}

export function shouldAtlasPrefetchUseDeterministicFallback(failureReason) {
  const text = String(failureReason || "").toLowerCase();
  if (!text) return true;
  // A malformed prefetch request is a caller/tool-contract problem, not proof
  // that the ATLAS backend is down. Keep tools available so the model can make
  // a valid targeted retrieval instead of being forced into fallback-only mode.
  if (text.includes("bad parameter")) return false;
  return true;
}

export function hasWritableScope(scope = {}) {
  return hasWritableScopeFromModule(scope);
}

export function isZeroEditCodeTask(scope = {}) {
  return isZeroEditCodeTaskFromModule(scope);
}

export function assertHandoffScopePreflight(packet) {
  return assertHandoffScopePreflightFromModule(packet);
}

export function sanitizePendingMergeConflicts(cwd, conflicts = []) {
  const safe = [];
  const invalid = [];
  for (const rawConflict of Array.isArray(conflicts) ? conflicts : []) {
    const conflict = String(rawConflict || "").replace(/\\/g, "/").trim();
    if (!conflict) continue;
    if (path.isAbsolute(conflict) || /^[A-Za-z]:\//.test(conflict)) {
      invalid.push(conflict);
      continue;
    }
    const fullPath = resolvePathWithin(cwd, conflict, { allowEqual: false });
    if (!fullPath) {
      invalid.push(conflict);
      continue;
    }
    safe.push(conflict);
  }
  return { safe, invalid };
}

// ─── Risk classification (deterministic from job_type) ───────────────────────

const MUTATING_TYPES = MUTATING_JOB_TYPES;
const ASSESSABLE_TYPES = ASSESSABLE_JOB_TYPES;

// ─── Internal: file reading ──────────────────────────────────────────────────

/**
 * Detect a pending merge in a worktree (from rebase-on-lease that hit conflicts).
 * Returns { targetHash, mergeMsg, conflicts } or null when no merge is pending.
 * Uses git plumbing directly — works for both main repos and linked worktrees.
 */
export async function detectPendingMergeAsync(cwd) {
  return detectPendingMergeAsyncFromModule(cwd);
}

function _readFile(relPath, cwd, opts = {}) {
  return readFileFromModule(relPath, cwd, {
    fs,
    resolvePathWithin,
    maxFileSize: opts.maxFileSize || _maxFileSize(),
  });
}

// --- Function Index Parser ---------------------------------------------------
// Delegated to helper module; keep local wrappers for stable test/consumer exports.

const INDEXABLE_EXTENSIONS = INDEXABLE_EXTENSIONS_FROM_MODULE;

function _parseFunctions(raw) {
  return parseFunctionsFromModule(raw);
}

function _buildSmartPreload(raw, taskSpec) {
  return buildSmartPreloadFromModule(raw, taskSpec);
}

export function buildSmartPreload(raw, taskSpec) {
  return _buildSmartPreload(raw, taskSpec);
}

function _directoryTree(dir, maxDepth = 2) {
  return directoryTreeFromModule(dir, {
    fs,
    path,
    skipDirs: SKIP_DIRS,
    maxDepth,
  });
}

function _collectSourceFiles(dir) {
  return collectSourceFilesFromModule(dir, {
    fs,
    path,
    skipDirs: SKIP_DIRS,
    sourceExtensions: SOURCE_EXTENSIONS,
    maxPreloadTotal: _maxPreloadTotal(),
    maxFileSize: _maxFileSize(),
  });
}

// ─── Internal: enrichment steps ──────────────────────────────────────────────

function _attachEditableFiles(packet) {
  return attachEditableFilesFromModule(packet, {
    fs,
    path,
    resolvePathWithin,
    indexableExtensions: INDEXABLE_EXTENSIONS,
    maxSmartPreloadSize: MAX_SMART_PRELOAD_SIZE,
    maxFileSize: _maxFileSize(),
    buildSmartPreload: _buildSmartPreload,
    readFile: _readFile,
    preloadMode: _editableFilePreloadMode(),
    forcePreload: !!packet.pending_merge,
  });
}
function _attachCreatableFiles(packet) {
  return attachCreatableFilesFromModule(packet, {
    readFile: _readFile,
  });
}
export function applyDeterministicDeletes(packet) {
  const cwd = packet?.cwd || process.cwd();
  const targets = Array.isArray(packet?.files_to_delete) ? packet.files_to_delete : [];
  const deleted = [];
  const alreadyAbsent = [];
  const failed = [];

  for (const relPath of targets) {
    const normalized = String(relPath || "").replace(/\\/g, "/").trim();
    if (!normalized) continue;
    const protectedErr = validateMutableRepoPath(normalized, "files_to_delete");
    if (protectedErr) {
      failed.push({ path: normalized, reason: protectedErr });
      continue;
    }
    const fullPath = resolvePathWithin(cwd, normalized, { allowEqual: false });
    if (!fullPath) {
      failed.push({ path: normalized, reason: "outside project scope" });
      continue;
    }
    try {
      if (!fs.existsSync(fullPath)) {
        alreadyAbsent.push(normalized);
        continue;
      }
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) {
        failed.push({ path: normalized, reason: "not a file" });
        continue;
      }
      fs.unlinkSync(fullPath);
      deleted.push(normalized);
    } catch (err) {
      failed.push({ path: normalized, reason: err?.message || String(err) });
    }
  }

  packet.deleted_files_applied = deleted;
  packet.deleted_files_absent = alreadyAbsent;
  packet.delete_failures = failed;
  return { deleted, alreadyAbsent, failed };
}

function _attachRelatedFiles(packet) {
  return attachRelatedFilesFromModule(packet, {
    readFile: _readFile,
    maxRelatedFilesTotal: _maxRelatedFilesTotal(),
  });
}
function _attachDirectoryTree(packet) {
  return attachDirectoryTreeFromModule(packet, {
    directoryTree: _directoryTree,
  });
}
function _attachSourcePreload(packet) {
  return attachSourcePreloadFromModule(packet, {
    collectSourceFiles: _collectSourceFiles,
    readFile: _readFile,
  });
}

function _fallbackTaskSpec(packet) {
  const payload = packet?._raw_payload || {};
  return [
    payload.task_spec,
    payload.instructions,
    packet?.title,
    packet?.project_context,
  ].map((value) => String(value || "").trim()).filter(Boolean).join("\n\n").slice(0, 2000);
}

function _collectAtlasFallbackCandidateFiles(packet) {
  const candidates = [];
  const push = (value) => {
    const normalized = String(value || "").replace(/\\/g, "/").trim();
    if (normalized) candidates.push(normalized);
  };

  // NOTE: files_to_modify are intentionally NOT collected here. Editable targets
  // are owned by the editable-file subsystem (attachEditableFiles), which honors
  // the configured preload mode (off/small/always) and emits smart_preloads. Pulling
  // them into the ATLAS fallback would bypass that mode and leak full bodies even
  // when editable preload is disabled.
  for (const file of packet?.atlas_slice_candidates?.filePaths || []) push(file);
  for (const card of packet?.atlas_slice_candidates?.cards || []) push(card?.file);
  for (const file of packet?.atlas_slice_context?.filePaths || []) push(file);
  for (const card of packet?.atlas_slice_context?.cards || []) push(card?.file);
  for (const file of packet?.related_files || []) push(file);

  return [...new Set(candidates)].slice(0, MAX_ATLAS_FALLBACK_FILES);
}

function _attachAtlasFallbackSmartContext(packet) {
  if (!packet?.cwd) return;
  const taskSpec = _fallbackTaskSpec(packet);
  const files = {};
  const dropped = [];
  for (const relPath of _collectAtlasFallbackCandidateFiles(packet)) {
    if (
      packet.editable_files?.[relPath] ||
      packet.smart_preloads?.[relPath] ||
      packet.related_files_content?.[relPath] ||
      packet.source_files?.[relPath]
    ) {
      continue;
    }
    const fullPath = resolvePathWithin(packet.cwd, relPath, { allowEqual: false });
    if (!fullPath) {
      dropped.push({ path: relPath, reason: "outside_project_scope" });
      continue;
    }
    const ext = path.extname(relPath).toLowerCase();
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) {
        dropped.push({ path: relPath, reason: "not_a_file" });
        continue;
      }
      if (INDEXABLE_EXTENSIONS.has(ext) && taskSpec && stat.size > 0) {
        const smartRead = _readFile(relPath, packet.cwd, { maxFileSize: MAX_SMART_PRELOAD_SIZE });
        if (smartRead?.exists && smartRead.content) {
          const smart = _buildSmartPreload(smartRead.content, taskSpec);
          if (smart) {
            files[relPath] = { mode: "smart", smart };
            continue;
          }
        }
      }
    } catch {
      // Fall through to the normal guarded reader so we still get a reason.
    }
    const result = _readFile(relPath, packet.cwd);
    if (result?.exists && result.content) {
      files[relPath] = { mode: "full", content: result.content };
    } else if (result?.truncated) {
      dropped.push({ path: relPath, reason: "file_too_large" });
    } else if (result?.binary) {
      dropped.push({ path: relPath, reason: "binary" });
    } else if (result?.empty) {
      dropped.push({ path: relPath, reason: "empty" });
    } else {
      dropped.push({ path: relPath, reason: "missing_or_unreadable" });
    }
  }

  packet.atlas_fallback_context = {
    ok: Object.keys(files).length > 0,
    files,
    dropped,
    candidateFiles: _collectAtlasFallbackCandidateFiles(packet),
  };
}
function _resolveAtlasHandoffState(recipient, packet) {
  return resolveAtlasHandoffStateFromModule(recipient, packet);
}

// Test-only seam: the real planner-slice prefetch requires a warm ATLAS index
// for the handoff cwd, which hermetic test runners don't have. Tests that
// exercise the ATLAS-active handoff wiring (fallback gating, tree suppression,
// pruning-section rendering) stub the prefetch here with a deterministic
// success/failure shape instead of depending on developer-machine index state.
let _atlasPlannerSlicePrefetchOverride = null;

export function __testSetAtlasPlannerSlicePrefetch(fn = null) {
  assertTestContext("__testSetAtlasPlannerSlicePrefetch");
  _atlasPlannerSlicePrefetchOverride = typeof fn === "function" ? fn : null;
}

async function _attachAtlasPlannerSlice(packet) {
  if (_atlasPlannerSlicePrefetchOverride) return _atlasPlannerSlicePrefetchOverride(packet);
  return attachAtlasPlannerSliceFromModule(packet);
}

async function _attachAtlasAssessorPrefetch(packet) {
  return attachAtlasAssessorPrefetchFromModule(packet);
}

async function _attachAtlasResearcherPrefetch(packet) {
  return attachAtlasResearcherPrefetchFromModule(packet);
}

async function _attachAtlasDbPrefetch(packet) {
  return attachAtlasDbPrefetchFromModule(packet);
}

function _applyToolPolicy(recipient, packet) {
  const base = TOOL_POLICIES[recipient] || TOOL_POLICIES.dev;
  const hints = packet.context_hints || {};

  packet.tool_policy = {
    allow_read: base.allow_read,
    allow_write: base.allow_write,
    allow_shell: base.allow_shell,
    allow_tests: base.allow_tests,
  };

  packet.budgets = {
    fallback_reads_remaining: _resolveFallbackReadBudget(recipient, base.fallback_reads, hints),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// buildRoutingPacket — assembles the full routing packet from job + queue state
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Build the routing packet for a job. This is the formal contract.
 *
 * @param {object} job — the job row from the database
 * @param {object} opts
 * @param {object}   opts.workItem       — the parent work item
 * @param {object}   opts.payload        — parsed job payload
 * @param {string}   opts.role           — resolved role ("researcher", "dev", etc.)
 * @param {string}   opts.effectiveTier  — model tier after escalation
 * @param {number}   opts.attemptCount   — current attempt number
 * @param {number}   opts.maxAttempts    — max attempts before dead-letter
 * @param {string}   opts.lastError      — error from previous attempt (if any)
 * @param {string}   opts.cwd            — working directory (worktree or project)
 * @param {string[]} opts.relatedFiles   — key_files from researcher
 * @param {string}   opts.projectContext — research summary
 * @param {string}   opts.mode           — "build" | "question"
 *
 * @returns {object} The routing packet — flat, no nesting:
 *
 *   ── Identity ──
 *   recipient            "researcher" | "planner" | "dev" | "assessor"
 *   job_type             "research" | "plan" | "dev" | "fix" | "assess" | ...
 *   work_item_id         number
 *   job_id               number
 *   title                string
 *   mode                 "build" | "question"
 *
 *   ── Model ──
 *   model_tier           "cheap" | "standard" | "strong"
 *   reasoning_effort     "low" | "medium" | "high"
 *
 *   ── Attempt ──
 *   attempt.count        number (1-based)
 *   attempt.max          number
 *   attempt.last_error   string | null
 *   attempt.escalated    boolean (tier was bumped from base)
 *
 *   ── Scope ──
 *   cwd                  string
 *   files_to_modify      string[]   — existing files the bot may edit
 *   files_to_create      string[]   — exact new files the bot may create
 *   files_to_delete      string[]   — exact existing files the system should delete
 *   create_roots         string[]   — directories where new files may be created
 *   related_files        string[]
 *   success_criteria     string[]
 *   test_command         string | null
 *
 *   ── Risk (deterministic from job_type) ──
 *   risk.mutating        boolean
 *   risk.assessable      boolean
 *
 *   ── Tool policy ──
 *   tool_policy          { allow_read, allow_write, allow_shell, allow_tests }
 *   budgets              { fallback_reads_remaining }
 *
 *   ── Context (filled by handoff enrichment) ──
 *   editable_files       { path: content | null }
 *   creatable_files      { path: { exists, content } }
 *   deleted_files_applied string[]
 *   deleted_files_absent  string[]
 *   delete_failures       { path, reason }[]
 *   related_files_content { path: content }
 *   directory_tree       string | null
 *   source_files         { path: content }
 *   dropped_files        string[]
 *   project_context      string
 *
 *   ── Prompt (assembled last) ──
 *   prompt               string — the fully assembled prompt for the provider
 */
export function buildRoutingPacket(job, opts) {
  const {
    workItem,
    payload = {},
    role,
    effectiveTier,
    attemptCount = 1,
    maxAttempts = 3,
    lastError = null,
    cwd,
    relatedFiles = [],
    projectContext = "",
    mode = "build",
  } = opts;
  const sanitizedPayload = _sanitizePayloadForRecipient(role, payload);
  const contextHints = opts.context_hints || opts.contextHints || {};
  const atlasDisabled = !!(
    opts.disableAtlas ||
    opts.disable_atlas ||
    sanitizedPayload.disableAtlas ||
    sanitizedPayload.disable_atlas ||
    contextHints.disableAtlas ||
    contextHints.disable_atlas
  );
  const resolvedRole = role;
  const devMode = normalizeDevMode(
    sanitizedPayload.dev_mode,
    { fallback: job.job_type === "fix" ? DEFAULT_FIX_DEV_MODE : DEFAULT_DEV_MODE },
  );

  return {
    // ── Identity ──
    recipient: resolvedRole,
    job_type: job.job_type,
    work_item_id: job.work_item_id,
    job_id: job.id,
    title: job.title,
    mode,

    // ── Model ──
    model_tier: effectiveTier || job.model_tier || "standard",
    reasoning_effort: job.reasoning_effort || "medium",
    dev_mode: devMode,
    dev_mode_contract: renderSelectedDevModeContract(devMode),
    planner_complexity_score: _normalizePlannerScore(job.planner_complexity_score ?? sanitizedPayload.planner_complexity_score ?? sanitizedPayload.complexity),
    planner_risk_score: _normalizePlannerScore(job.planner_risk_score ?? sanitizedPayload.planner_risk_score ?? sanitizedPayload.risk),

    // ── Governance ──
    governance_tier: workItem?.governance_tier || "mvp",
    execution_provider: opts.jobProvider || job?.provider || null,

    // ── Attempt ──
    attempt: {
      count: attemptCount,
      max: maxAttempts,
      last_error: lastError,
      escalated: effectiveTier !== job.model_tier,
    },

    // ── Scope ──
    cwd: cwd || process.cwd(),
    files_to_modify: sanitizedPayload.files_to_modify || [],
    files_to_create: sanitizedPayload.files_to_create || [],
    files_to_delete: sanitizedPayload.files_to_delete || [],
    create_roots: sanitizedPayload.create_roots || [],
    related_files: relatedFiles,
    success_criteria: Array.isArray(sanitizedPayload.success_criteria) ? sanitizedPayload.success_criteria : sanitizedPayload.success_criteria ? [sanitizedPayload.success_criteria] : [],
    test_command: sanitizedPayload.test_command || null,
    skills: parseSkillIds(job.skills || sanitizedPayload.skills),
    requested_skills: parseSkillIds(job.skills || sanitizedPayload.skills),
    dev_brief: sanitizedPayload.dev_brief && typeof sanitizedPayload.dev_brief === "object"
      ? sanitizedPayload.dev_brief
      : null,
    hash_ref_packet: sanitizedPayload.hash_ref_packet && typeof sanitizedPayload.hash_ref_packet === "object"
      ? sanitizedPayload.hash_ref_packet
      : sanitizedPayload.dev_brief?.hash_ref_packet && typeof sanitizedPayload.dev_brief.hash_ref_packet === "object"
        ? sanitizedPayload.dev_brief.hash_ref_packet
        : null,

    // ── Risk (deterministic) ──
    risk: {
      mutating: MUTATING_TYPES.has(job.job_type),
      assessable: ASSESSABLE_TYPES.has(job.job_type),
    },

    // ── Tool policy + budgets (set by handoff) ──
    tool_policy: null,
    budgets: null,

    // ── Context (filled by handoff) ──
    editable_files: {},
    smart_preloads: {},   // relPath → { imports, matched, toc, totalLines }
    creatable_files: {},
    related_files_content: {},
    directory_tree: null,
    source_files: {},
    dropped_files: [],
    project_context: projectContext,
    atlas: null,
    atlas_config: opts.atlasConfig || opts.atlas_config || null,
    atlas_disabled: atlasDisabled,
    atlas_disabled_reason: opts.disableAtlasReason || opts.disable_atlas_reason || sanitizedPayload.disableAtlasReason || sanitizedPayload.disable_atlas_reason || contextHints.disableAtlasReason || contextHints.disable_atlas_reason || null,
    _raw_payload: sanitizedPayload, // for smart preload task_spec matching

    // ── Prompt (filled by remote compiler) ──
    prompt: null,
    context_render_max_chars: _maxContextChars(),

    // ── Step 0: silent historical context ──
    step0_context: _buildStep0Context(resolvedRole, sanitizedPayload),

    // ── Kaizen: cross-run insights ──
    run_insights: _loadRelevantInsights(resolvedRole, sanitizedPayload),
    memory_surface: { symbols: [], files: [] },
    traversal_completion_check: null,

    // ── Passthrough for worker ──
    context_hints: contextHints,
    prior_artifacts: {},
  };
}

/**
 * Load relevant insights from past runs for injection into agent context.
 * Researcher and dev roles get file-scoped insights; planner gets recent insights.
 */
function _loadRelevantInsights(role, payload) {
  return loadRelevantInsightsFromModule(role, payload);
}

async function _loadRelevantInsightsAsync(role, payload, opts = {}) {
  return loadRelevantInsightsAsyncFromModule(role, payload, opts);
}

async function _loadMemorySurfaceAsync(role, payload, opts = {}) {
  return loadMemorySurfaceAsyncFromModule(role, payload, opts);
}

/**
 * Build Step 0 context: silent pre-flight history compilation.
 * Returns a string (or null) summarizing what recently happened to the files
 * this agent is about to work on. Injected into the prompt so the agent starts
 * informed without having to ask.
 */
function _buildStep0Context(role, payload) {
  return buildStep0ContextFromModule(role, payload);
}

function _applyMemoryPrefetchNotice(packet) {
  const notice = buildMemoryPrefetchNoticeFromModule(packet?.memory_surface || []);
  packet.memory_prefetch_context = notice || null;
  if (!notice) return;
  packet.step0_context = [packet.step0_context, notice].filter(Boolean).join("\n");
}

function _logSurfacedInsights(packet, role, telemetry = null) {
  const insights = Array.isArray(packet?.run_insights) ? packet.run_insights : [];
  const memorySurface = packet?.memory_surface || {};
  const memoryAnchorCount = (Array.isArray(memorySurface.symbols) ? memorySurface.symbols.length : 0)
    + (Array.isArray(memorySurface.files) ? memorySurface.files.length : 0);
  const staleDropped = Number(telemetry?.stale_dropped || 0);
  if (insights.length === 0 && staleDropped === 0 && memoryAnchorCount === 0) return;
  try {
    logEvent({
      work_item_id: packet.work_item_id || null,
      job_id: packet.job_id || null,
      event_type: EVENT_TYPES.KAIZEN_INSIGHTS_SURFACED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Surfaced ${memoryAnchorCount} memory-bearing anchor(s) and ${insights.length} insight item(s) for ${role}${staleDropped > 0 ? ` (${staleDropped} stale dropped)` : ""}`,
      event_json: JSON.stringify({
        role,
        review_visible: true,
        telemetry: telemetry || null,
        memory_surface: memorySurface,
        insights: insights.map((item) => ({
          id: item.id || null,
          memory_id: item.memory_id || item.promoted_memory_id || null,
          type: item.insight_type || null,
          kind: item.insight_kind || null,
          confidence: item.confidence || null,
          source: item.source || null,
          summary: item.summary || null,
          action: item.action || null,
          why_surface: item.why_surface || null,
          stale: !!item.stale,
        })).slice(0, 12),
      }),
    });
  } catch {
    // Insight observability should never make handoff fail.
  }
}

function _normalizePlannerScore(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function _skillRoleForPacket(packet) {
  const role = String(packet?.recipient || "").trim().toLowerCase();
  if (role === "fix" || packet?.job_type === "fix") return "dev";
  return role;
}

function _skillBudgetChars() {
  return _maxContextChars();
}

function _logSkillEvent(packet, eventType, message, eventJson = {}) {
  try {
    logEvent({
      work_item_id: packet.work_item_id || null,
      job_id: packet.job_id || null,
      event_type: eventType,
      actor_type: EVENT_ACTORS.SYSTEM,
      message,
      event_json: JSON.stringify(eventJson),
    });
  } catch {
    // Skill observability must not make handoff fail.
  }
}

function _take(array, limit = 25) {
  return Array.isArray(array) ? array.slice(0, limit) : [];
}

function _logHandoffWarning(packet, eventType, message, eventJson = {}) {
  const ctx = getObservationContext() || {};
  const detail = {
    severity: "warn",
    role: packet?.recipient || null,
    job_type: packet?.job_type || null,
    max_file_bytes: _maxFileSize(),
    max_related_files_total_bytes: _maxRelatedFilesTotal(),
    ...eventJson,
  };
  try {
    logEvent({
      work_item_id: packet?.work_item_id || null,
      job_id: packet?.job_id || null,
      attempt_id: ctx.attempt_id ?? null,
      event_type: eventType,
      actor_type: EVENT_ACTORS.SYSTEM,
      message,
      event_json: JSON.stringify(detail),
    });
  } catch {
    // Handoff observability must not make prompt assembly fail.
  }
  try {
    log.warn("handoff", message, {
      wiId: packet?.work_item_id || null,
      jobId: packet?.job_id || null,
      ...detail,
    });
  } catch {
    // File logging is best effort only.
  }
}

function _emitHandoffDropTelemetry(packet) {
  if (!packet || packet._handoff_drop_telemetry_logged) return;
  const editableDropped = _take(packet.dropped_files);
  const relatedDropped = _take(packet.related_files_dropped);
  const atlasFallbackDropped = _take(packet.atlas_fallback_context?.dropped);
  const totalDropped = (packet.dropped_files || []).length
    + (packet.related_files_dropped || []).length
    + (packet.atlas_fallback_context?.dropped || []).length;
  if (totalDropped <= 0) return;
  packet._handoff_drop_telemetry_logged = true;
  _logHandoffWarning(
    packet,
    EVENT_TYPES.PACKET_FILES_DROPPED,
    `WARN handoff dropped ${totalDropped} file attachment(s) before prompt render`,
    {
      total_dropped: totalDropped,
      editable_dropped: editableDropped,
      related_dropped: relatedDropped,
      atlas_fallback_dropped: atlasFallbackDropped,
      related_files_total_bytes: packet.related_files_total_bytes || 0,
      related_files_attach_order: _take(packet.related_files_attach_order),
    },
  );
}

function _renderSkillStableSection(skill) {
  return [
    `=== SKILL: ${skill.id}${skill.name ? ` (${skill.name})` : ""} ===`,
    skill.body || "",
  ].join("\n").trim();
}

function _attachSkills(packet) {
  if (packet._skills_processed) return;
  packet._skills_processed = true;
  const requested = parseSkillIds(packet.skills || packet.requested_skills || packet._raw_payload?.skills);
  packet.requested_skills = requested;
  packet.skills = requested;
  packet.skill_sections = [];
  packet.skills_attached = [];
  packet.skills_skipped = { invalid: [], disabled: [], truncated: [] };
  if (requested.length === 0) return;

  const role = _skillRoleForPacket(packet);
  const validation = validateSkillIds(requested, role);
  for (const id of validation.invalid) {
    packet.skills_skipped.invalid.push(id);
    _logSkillEvent(packet, EVENT_TYPES.SKILL_SKIPPED_UNKNOWN, `Skipped unknown skill ${id}`, { skill_id: id, role });
  }
  for (const id of validation.disabled) {
    packet.skills_skipped.disabled.push(id);
    _logSkillEvent(packet, EVENT_TYPES.SKILL_SKIPPED_DISABLED, `Skipped disabled skill ${id}`, { skill_id: id, role });
  }
  if (!isSkillsEnabled()) return;

  const budget = _skillBudgetChars();
  let used = 0;
  for (let idx = 0; idx < validation.valid.length; idx++) {
    const id = validation.valid[idx];
    const manifest = getSkillById(id);
    if (!manifest) continue;
    const rendered = _renderSkillStableSection(manifest);
    const nextChars = used + (used > 0 ? 2 : 0) + rendered.length;
    if (budget > 0 && nextChars > budget) {
      const dropped = validation.valid.slice(idx);
      packet.skills_skipped.truncated.push(...dropped);
      _logSkillEvent(packet, EVENT_TYPES.SKILL_TRUNCATED, `Dropped ${dropped.length} skill(s) over handoff context budget`, {
        role,
        budget_chars: budget,
        used_chars: used,
        dropped,
      });
      break;
    }
    packet.skill_sections.push({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      when_to_use: manifest.when_to_use,
      body: manifest.body,
    });
    packet.skills_attached.push(manifest.id);
    used = nextChars;
    _logSkillEvent(packet, EVENT_TYPES.SKILL_ATTACHED, `Attached skill ${manifest.id}`, {
      skill_id: manifest.id,
      role,
      chars: rendered.length,
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// handoff — enrich a routing packet with filesystem context
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Enrich a routing packet (or raw data) with deterministic filesystem context.
 * Accepts either a packet from buildRoutingPacket or a raw { recipient, data } call.
 *
 * @param {object} input — either a routing packet (has .recipient) or { recipient, data }
 * @returns {object} The same packet, enriched in-place
 */
export async function handoff(input) {
  // Accept both styles: handoff(packet) or handoff({ recipient, data })
  let packet;
  if (input.recipient && input.job_type) {
    // Already a routing packet
    packet = input;
    packet.files_to_modify = Array.isArray(packet.files_to_modify) ? packet.files_to_modify : [];
    packet.files_to_create = Array.isArray(packet.files_to_create) ? packet.files_to_create : [];
    packet.files_to_delete = Array.isArray(packet.files_to_delete) ? packet.files_to_delete : [];
    packet.create_roots = Array.isArray(packet.create_roots) ? packet.create_roots : [];
    packet.related_files = Array.isArray(packet.related_files) ? packet.related_files : [];
    packet.success_criteria = Array.isArray(packet.success_criteria) ? packet.success_criteria : packet.success_criteria ? [packet.success_criteria] : [];
    packet.skills = parseSkillIds(packet.skills || packet.requested_skills || packet._raw_payload?.skills);
    packet.requested_skills = parseSkillIds(packet.requested_skills || packet.skills);
    packet.skill_sections = Array.isArray(packet.skill_sections) ? packet.skill_sections : [];
    packet.skills_attached = Array.isArray(packet.skills_attached) ? packet.skills_attached : [];
    packet.editable_files = packet.editable_files || {};
    packet.creatable_files = packet.creatable_files || {};
    packet.deleted_files_applied = Array.isArray(packet.deleted_files_applied) ? packet.deleted_files_applied : [];
    packet.deleted_files_absent = Array.isArray(packet.deleted_files_absent) ? packet.deleted_files_absent : [];
    packet.delete_failures = Array.isArray(packet.delete_failures) ? packet.delete_failures : [];
    packet.related_files_content = packet.related_files_content || {};
    packet.source_files = packet.source_files || {};
    packet.dropped_files = Array.isArray(packet.dropped_files) ? packet.dropped_files : [];
    packet.atlas = packet.atlas || null;
    packet.atlas_db_context = packet.atlas_db_context || null;
    packet.atlas_research_context = packet.atlas_research_context || null;
    packet.atlas_slice_context = packet.atlas_slice_context || null;
    packet.atlas_slice_candidates = packet.atlas_slice_candidates || null;
    packet.atlas_fallback_context = packet.atlas_fallback_context || null;
    packet.context_hints = packet.context_hints || {};
    packet.atlas_disabled = !!(
      packet.atlas_disabled ||
      packet.disableAtlas ||
      packet.disable_atlas ||
      packet.context_hints.disableAtlas ||
      packet.context_hints.disable_atlas ||
      packet._raw_payload?.disableAtlas ||
      packet._raw_payload?.disable_atlas
    );
    packet.atlas_disabled_reason = packet.atlas_disabled_reason || packet.disableAtlasReason || packet.disable_atlas_reason || packet.context_hints.disableAtlasReason || packet.context_hints.disable_atlas_reason || packet._raw_payload?.disableAtlasReason || packet._raw_payload?.disable_atlas_reason || null;
    packet.prior_artifacts = packet.prior_artifacts || {};
    packet.run_insights = Array.isArray(packet.run_insights) ? packet.run_insights : [];
    packet.pending_merge = packet.pending_merge || null;
    packet.traversal_completion_check = packet.traversal_completion_check || null;
    packet.dev_brief = packet.dev_brief || packet._raw_payload?.dev_brief || null;
    packet.hash_ref_packet = packet.hash_ref_packet || packet._raw_payload?.hash_ref_packet || packet.dev_brief?.hash_ref_packet || null;
  } else if (input.recipient && input.data) {
    // Legacy style: { recipient, data }
    packet = {
      recipient: input.recipient,
      job_type: input.data.job_type || input.recipient,
      work_item_id: input.data.work_item_id || null,
      job_id: input.data.job_id || null,
      title: input.data.title || "",
      mode: input.data.mode || "build",
      model_tier: input.data.model_tier || "standard",
      reasoning_effort: input.data.reasoning_effort || "medium",
      planner_complexity_score: _normalizePlannerScore(input.data.planner_complexity_score ?? input.data.complexity),
      planner_risk_score: _normalizePlannerScore(input.data.planner_risk_score ?? input.data.risk),
      attempt: input.data.attempt || { count: 1, max: 3, last_error: null, escalated: false },
      cwd: input.data.cwd || process.cwd(),
      files_to_modify: input.data.files_to_modify || [],
      files_to_create: input.data.files_to_create || [],
      files_to_delete: input.data.files_to_delete || [],
      create_roots: input.data.create_roots || [],
      related_files: input.data.related_files || [],
      success_criteria: Array.isArray(input.data.success_criteria) ? input.data.success_criteria : input.data.success_criteria ? [input.data.success_criteria] : [],
      test_command: input.data.test_command || null,
      skills: parseSkillIds(input.data.skills || input.data.requested_skills),
      requested_skills: parseSkillIds(input.data.skills || input.data.requested_skills),
      dev_brief: input.data.dev_brief && typeof input.data.dev_brief === "object"
        ? input.data.dev_brief
        : null,
      hash_ref_packet: input.data.hash_ref_packet && typeof input.data.hash_ref_packet === "object"
        ? input.data.hash_ref_packet
        : input.data.dev_brief?.hash_ref_packet && typeof input.data.dev_brief.hash_ref_packet === "object"
          ? input.data.dev_brief.hash_ref_packet
          : null,
      risk: { mutating: false, assessable: false },
      tool_policy: null,
      budgets: null,
      editable_files: {},
      creatable_files: {},
      deleted_files_applied: [],
      deleted_files_absent: [],
      delete_failures: [],
      related_files_content: {},
      directory_tree: null,
      source_files: {},
      dropped_files: [],
      atlas: null,
      atlas_config: input.data.atlasConfig || input.data.atlas_config || null,
      atlas_db_context: null,
      atlas_research_context: null,
      atlas_slice_context: null,
      atlas_slice_candidates: null,
      atlas_fallback_context: null,
      atlas_disabled: !!(
        input.data.disableAtlas ||
        input.data.disable_atlas ||
        input.data.context_hints?.disableAtlas ||
        input.data.context_hints?.disable_atlas
      ),
      atlas_disabled_reason: input.data.disableAtlasReason || input.data.disable_atlas_reason || input.data.context_hints?.disableAtlasReason || input.data.context_hints?.disable_atlas_reason || null,
      governance_tier: input.data.governance_tier || "mvp",
      step0_context: null,
      run_insights: [],
      traversal_completion_check: null,
      project_context: input.data.project_context || "",
      prompt: null,
      context_hints: input.data.context_hints || {},
      prior_artifacts: input.data.prior_artifacts || {},
      execution_provider: input.data.execution_provider || input.data.job_provider || null,
      _raw_payload: input.data,
    };
  } else {
    throw new Error("handoff: expected a routing packet or { recipient, data }");
  }

  const recipient = packet.recipient;

  // Fix jobs often originate from assessor instructions that name the actual
  // file to repair. Make that named file writable before the zero-scope
  // preflight and before editable-file context is attached.
  await timeHandoffStep(packet, "fix.scope_guard", () => applyFixScopeHandoffGuard(packet));

  // Step 0.5: Detect pending merge (rebase-on-lease left conflicts for the dev).
  // Expand files_to_modify with conflicted paths so the full merge is editable,
  // and surface the state in a dedicated packet field. Cap only body preloading
  // so large merges stay scoped without trying to inline every conflict marker.
  //
  // Run this BEFORE the zero-scope preflight so a task that appears to have
  // no writable scope but is actually meant to complete a pending merge is
  // not spuriously rejected.
  const CONFLICT_EXPANSION_CAP = 50;
  if (packet.cwd && recipient === "dev") {
    const pending = await detectPendingMergeAsync(packet.cwd);
    if (pending) {
      const { safe: conflicts, invalid: invalidConflicts } = sanitizePendingMergeConflicts(packet.cwd, pending.conflicts);
      packet.pending_merge = {
        ...pending,
        conflicts,
        invalid_conflicts: invalidConflicts,
        invalid_conflict_count: invalidConflicts.length,
      };
      const existingFiles = Array.isArray(packet.files_to_modify) ? packet.files_to_modify : [];
      const existing = new Set(existingFiles.map((p) => String(p).replace(/\\/g, "/")));
      const preloadAllowlist = new Set(existingFiles.map((p) => String(p).replace(/\\/g, "/")));
      const preloadedConflicts = [];
      const unpreloadedConflicts = [];
      let added = 0;
      for (const conflict of conflicts) {
        if (!existing.has(conflict)) {
          packet.files_to_modify.push(conflict);
          existing.add(conflict);
          added++;
        }
        if (preloadedConflicts.length < CONFLICT_EXPANSION_CAP) {
          preloadedConflicts.push(conflict);
          preloadAllowlist.add(conflict);
        } else {
          unpreloadedConflicts.push(conflict);
        }
      }
      packet.pending_merge.total_conflict_count = conflicts.length;
      packet.pending_merge.expanded_count = added;
      packet.pending_merge.preloaded_conflicts = preloadedConflicts;
      packet.pending_merge.preloaded_conflict_count = preloadedConflicts.length;
      packet.pending_merge.unpreloaded_conflicts = unpreloadedConflicts;
      packet.pending_merge.unpreloaded_conflict_count = unpreloadedConflicts.length;
      if (unpreloadedConflicts.length > 0) {
        packet.pending_merge.truncated = true;
        packet.editable_file_preload_allowlist = [...preloadAllowlist];
      }
    }
  }

  await timeHandoffStep(packet, "scope.preflight", () => assertHandoffScopePreflight(packet));

  // Step 1: ATLAS attachment + required-mode fail-closed checks. Resolve this
  // before local preloads so ATLAS prefetch and smart/editable prefetch stay
  // mutually exclusive. Pending merge handoffs are the exception because ATLAS
  // cannot see uncommitted conflict markers; those force local context.
  packet.atlas = await timeHandoffStep(packet, "atlas.resolve", () => _resolveAtlasHandoffState(recipient, packet));
  if (packet.atlas?.failClosed) {
    const reason = packet.atlas.requiredFailureReason || "unavailable";
    const err = new Error(`ATLAS required mode blocked handoff for ${recipient} (${reason}).`);
    err.code = "ATLAS_REQUIRED_BLOCKED";
    err.atlas = packet.atlas;
    throw err;
  }
  const atlasPrefetchActive = !!packet.atlas?.active;

  // Step 2: Editable file contents (existing files to modify)
  if (packet.files_to_modify.length > 0 && packet.cwd) {
    await timeHandoffStep(packet, "files.editable", () => _attachEditableFiles(packet));
  }

  // Step 2b: Creatable file metadata (new files to create)
  if (packet.files_to_create.length > 0 && packet.cwd) {
    await timeHandoffStep(packet, "files.creatable", () => _attachCreatableFiles(packet));
  }

  // Step 3: Related file contents. ATLAS-active handoffs keep related files as
  // route/slice hints only; exact local content is attached only if ATLAS falls
  // back, so agents see one prefetch signal rather than two competing ones.
  if (packet.related_files.length > 0 && packet.cwd && !atlasPrefetchActive) {
    await timeHandoffStep(packet, "files.related", () => _attachRelatedFiles(packet));
  }

  // Plan 4: Wrap prefetch in an observation context so tool.atlas.prefetch rows
  // carry the work_item_id/job_id of the call they precede. Without this the
  // prefetch observations get whatever parent scope was active, often null,
  // making it impossible to join them back to the agent_call they support.
  // If a parent context already exists (worker.js wraps most handoff calls),
  // inherit its attempt_id but override ids with the packet's for accuracy.
  const parentCtx = getObservationContext() || {};
  const prefetchCtx = {
    work_item_id: packet.work_item_id ?? parentCtx.work_item_id ?? null,
    job_id: packet.job_id ?? parentCtx.job_id ?? null,
    attempt_id: parentCtx.attempt_id ?? null,
    role: packet.recipient ?? parentCtx.role ?? null,
  };
  let atlasPrefetchStepError = null;
  const atlasPrefetchPacket = { ...packet };
  await timeHandoffStep(packet, "atlas.prefetch", () => runWithObservationContext(prefetchCtx, async () => {
    await Promise.all([
      _attachAtlasPlannerSlice(atlasPrefetchPacket),
      _attachAtlasAssessorPrefetch(atlasPrefetchPacket),
      _attachAtlasResearcherPrefetch(atlasPrefetchPacket),
      _attachAtlasDbPrefetch(atlasPrefetchPacket),
    ]);
  }), {
    timeoutMs: atlasHandoffPrefetchTimeoutMs(),
    timeoutGraceMs: HANDOFF_TIMEOUT_GRACE_MS,
  }).catch((err) => {
    atlasPrefetchStepError = err;
  });

  if (!atlasPrefetchStepError) {
    copyAtlasPrefetchFields(packet, atlasPrefetchPacket);
  } else if (packet.atlas?.active) {
    copyAtlasPrefetchFields(packet, {});
    const timeoutDetail = formatHandoffStepFailure(atlasPrefetchStepError);
    if ((recipient === "planner" || recipient === "dev" || recipient === "researcher") && !packet.atlas_slice_context) {
      packet.atlas_slice_context = { ok: false, error: timeoutDetail };
    }
    if (recipient === "researcher" && !packet.atlas_research_context) {
      packet.atlas_research_context = { ok: false, error: timeoutDetail };
    }
    if (recipient === "assessor" && !packet.atlas_assessment_baseline) {
      packet.atlas_assessment_baseline = { ok: false, error: timeoutDetail };
    }
  }

  // If ATLAS was advertised as active but its prefetch failed, and the mode is a
  // fallback-eligible one (anything but "required"), fall back to preload/tree
  // so the agent still has context. Without this, researcher/planner prompts
  // end up with neither ATLAS data nor preload — the worst of both worlds.
  const sliceError = packet.atlas_slice_context?.ok === false ? packet.atlas_slice_context.error : null;
  const baselineError = packet.atlas_assessment_baseline?.ok === false ? packet.atlas_assessment_baseline.error : null;
  const researchError = packet.atlas_research_context?.ok === false ? packet.atlas_research_context.error : null;
  const atlasPrefetchFailed = !!(sliceError || baselineError || researchError);

  // Required mode: prefetch failure = hard fail. Otherwise the agent gets a
  // failure notice with no fallback context, which is strictly worse than the
  // upfront capability check that already throws above.
  if (atlasPrefetchFailed && packet.atlas?.active && packet.atlas?.fallback === "fail") {
    const parts = [];
    if (baselineError) parts.push(`assessment: ${baselineError}`);
    if (researchError) parts.push(`research: ${researchError}`);
    if (sliceError) parts.push(`slice: ${sliceError}`);
    const err = new Error(`ATLAS required mode: prefetch failed (${parts.join("; ") || "unknown"}).`);
    err.code = "ATLAS_REQUIRED_BLOCKED";
    err.atlas = packet.atlas;
    err.prefetch = { assessment: baselineError, slice: sliceError };
    throw err;
  }

  const fallbackDetail = atlasPrefetchFailed
    ? _firstAtlasPrefetchErrorLine(sliceError, baselineError, researchError)
    : null;
  const fallbackReason = atlasPrefetchFailed ? classifyAtlasFailure(fallbackDetail) : null;
  const atlasFallbackActive = !!packet.atlas?.active
    && atlasPrefetchFailed
    && packet.atlas?.fallback !== "fail"
    && shouldAtlasPrefetchUseDeterministicFallback(fallbackReason);
  if (atlasPrefetchFailed && packet.atlas?.active && packet.atlas?.fallback !== "fail") {
    packet.atlas.prefetchFailureReason = fallbackReason;
    packet.atlas.prefetchFailureDetail = fallbackDetail;
  }
  if (atlasFallbackActive) {
    packet.atlas.prefetchFailed = true;
    // Editable files were attached earlier with ATLAS treated as active, which
    // suppresses their smart preload in favor of ATLAS retrieval. Now that the
    // prefetch has failed and we are falling back to deterministic tools, re-run
    // the editable attach so files_to_modify honor the configured preload mode
    // (smart_preloads for indexable bodies, "not preloaded" markers when off).
    if (packet.files_to_modify.length > 0 && packet.cwd) {
      _attachEditableFiles(packet);
    }
    // Replace the failed prefetch blocks with a single notice so the rendered
    // prompt doesn't carry both ATLAS "active" framing AND failure text AND
    // preload context — the agent should see one clear fallback signal.
    packet.atlas.fallbackNotice = `ATLAS prefetch failed (${fallbackReason}). Do not call ATLAS tools for this handoff; continue with the normal deterministic file/search/edit tools and any preload context.`;
    try {
      recordObservation({
        work_item_id: packet.work_item_id ?? null,
        job_id: packet.job_id ?? null,
        attempt_id: parentCtx.attempt_id ?? null,
        observation_type: "tool.atlas.prefetch",
        summary: `ATLAS prefetch fallback: ${fallbackReason} -> deterministic tools`,
        detail: {
          kind: "atlas",
          origin: "prefetch",
          ok: false,
          fallback: "deterministic_tools",
          failure_classification: fallbackReason,
          error: fallbackDetail,
        },
      });
    } catch {
      // Handoff fallback must not be blocked by optional telemetry writes.
    }
    _attachAtlasFallbackSmartContext(packet);
    packet.atlas_research_context = null;
    packet.atlas_assessment_baseline = null;
    packet.atlas_db_context = null;
    packet.atlas_slice_context = null;
  } else if (atlasPrefetchFailed && packet.atlas?.active && packet.atlas?.fallback !== "fail") {
    try {
      recordObservation({
        work_item_id: packet.work_item_id ?? null,
        job_id: packet.job_id ?? null,
        attempt_id: parentCtx.attempt_id ?? null,
        observation_type: "tool.atlas.prefetch",
        summary: `ATLAS prefetch warning: ${fallbackReason}; ATLAS tools remain enabled`,
        detail: {
          kind: "atlas",
          origin: "prefetch",
          ok: false,
          fallback: null,
          failure_classification: fallbackReason,
          error: fallbackDetail,
        },
      });
    } catch {
      // Optional telemetry only.
    }
  }
  const atlasContextUsable = !!packet.atlas?.active && !atlasFallbackActive;

  // Plan 2: Compute a single prefetch-status label for telemetry. We derive it
  // from the pre-nulled blocks above by remembering whether prefetch was even
  // attempted (packet.atlas.active) and whether all/some/none succeeded.
  if (packet.atlas) {
    const sliceAttempted = (recipient === "planner" || recipient === "dev" || recipient === "researcher") && packet.atlas.active
      && (packet.atlas_slice_prefetch_attempted === true || !!packet.atlas_slice_context);
    const researchAttempted = recipient === "researcher" && packet.atlas.active
      && !!packet.atlas_research_context;
    const baselineAttempted = recipient === "assessor" && packet.atlas.active
      && !!packet.atlas_assessment_baseline;
    const anyAttempted = sliceAttempted || baselineAttempted || researchAttempted;
    let status;
    if (!anyAttempted) {
      status = "skipped";
    } else if (!atlasPrefetchFailed) {
      status = classifyAtlasPrefetchRelevanceFromModule(packet, recipient)
        ? "ok_relevant"
        : "ok_unhelpful";
    } else if (researchAttempted) {
      status = researchError
        ? "failed"
        : (sliceError ? "partial" : (classifyAtlasPrefetchRelevanceFromModule(packet, recipient) ? "ok_relevant" : "ok_unhelpful"));
    } else if (sliceAttempted && baselineAttempted && sliceError && baselineError) {
      status = "failed";
    } else if (sliceAttempted && !baselineAttempted) {
      status = sliceError
        ? "failed"
        : (classifyAtlasPrefetchRelevanceFromModule(packet, recipient) ? "ok_relevant" : "ok_unhelpful");
    } else if (baselineAttempted && !sliceAttempted) {
      status = baselineError
        ? "failed"
        : (classifyAtlasPrefetchRelevanceFromModule(packet, recipient) ? "ok_relevant" : "ok_unhelpful");
    } else {
      // One of two prefetches failed; classify as partial.
      status = "partial";
    }
    packet.atlas.prefetchStatus = status;
  }

  // Step 4: Directory tree
  // When ATLAS is active for researcher/planner, tree discovery is redundant.
  const wantsTree = packet.context_hints?.include_tree === true
    || ((recipient === "researcher" || recipient === "planner") && !atlasContextUsable);
  if (wantsTree && packet.cwd) {
    await timeHandoffStep(packet, "files.tree", () => _attachDirectoryTree(packet));
  }

  // Step 5: Bulk source preload only for roles without runtime read tools.
  // Researcher/planner now have deterministic read fallback, so prefer tree +
  // targeted ATLAS/smart context and let tools pull exact missing files.
  const recipientPolicy = TOOL_POLICIES[recipient] || TOOL_POLICIES.dev;
  if ((recipient === "researcher" || recipient === "planner") && packet.cwd && !atlasContextUsable && !recipientPolicy.allow_read) {
    await timeHandoffStep(packet, "files.source_preload", () => _attachSourcePreload(packet));
  }

  // Step 6: Probe ATLAS memory presence after ATLAS/preload adds file context.
  // Memory bodies are not prefetched; agents can call memory.get for exact
  // anchors they are about to rely on.
  const kaizenTelemetry = {};
  packet.run_insights = await timeHandoffStep(packet, "insights.load", () => _loadRelevantInsightsAsync(recipient, packet, { cwd: packet.cwd || process.cwd(), telemetry: kaizenTelemetry }));
  packet.memory_surface = await timeHandoffStep(packet, "memory.surface", () => _loadMemorySurfaceAsync(recipient, packet, { cwd: packet.cwd || process.cwd(), telemetry: kaizenTelemetry }));
  await timeHandoffStep(packet, "insights.memory_prefetch_notice", () => _applyMemoryPrefetchNotice(packet));
  await timeHandoffStep(packet, "insights.log", () => _logSurfacedInsights(packet, recipient, kaizenTelemetry));

  // Step 7: Tool policy + budgets
  await timeHandoffStep(packet, "skills.attach", () => _attachSkills(packet));
  await timeHandoffStep(packet, "traversal_completion.resolve", () => _applyTraversalCompletionCheck(packet));
  await timeHandoffStep(packet, "atlas_shadow_guardrails.resolve", () => _applyAtlasShadowGuardrails(packet));
  await timeHandoffStep(packet, "hash_refs.proof_expand", () => _expandHashRefProofs(packet));
  await timeHandoffStep(packet, "tool_policy.apply", () => _applyToolPolicy(recipient, packet));
  await timeHandoffStep(packet, "drop_telemetry.emit", () => _emitHandoffDropTelemetry(packet));

  return packet;
}

function _expandHashRefProofs(packet) {
  if (!packet || !(packet.recipient === "dev" || packet.job_type === "fix")) return null;
  const sourcePacket = packet.hash_ref_packet || packet.dev_brief?.hash_ref_packet || null;
  if (!sourcePacket) return null;
  const result = expandHashRefHandoffPacketProofsFromModule(sourcePacket, {
    context: {
      work_item_id: packet.work_item_id || null,
      job_id: packet.job_id || null,
    },
  });
  if (result.packet) {
    packet.hash_ref_packet = result.packet;
    if (packet.dev_brief && typeof packet.dev_brief === "object") {
      packet.dev_brief.hash_ref_packet = result.packet;
    }
  }
  if (result.dropped?.length > 0) {
    packet.hash_ref_packet_dropped = result.dropped;
  }
  return result;
}

function _applyTraversalCompletionCheck(packet) {
  const mode = getSetting(SETTING_KEYS.RESEARCH_TRAVERSAL_COMPLETION_CHECK) || "off";
  const maxChars = getIntSetting(
    SETTING_KEYS.RESEARCH_TRAVERSAL_COMPLETION_MAX_CHARS,
    DEFAULT_TRAVERSAL_COMPLETION_MAX_CHARS,
  );
  const check = buildTraversalCompletionCheckFromModule(packet, { mode, maxChars });
  packet.traversal_completion_check = check;

  if (check.mode === "off") return check;

  try {
    const ctx = getObservationContext() || {};
    const status = check.attach ? "attached" : (check.shadow ? "shadowed" : "skipped");
    const terms = check.matched_terms.length > 0 ? check.matched_terms.join(",") : "none";
    recordObservation({
      work_item_id: packet.work_item_id ?? ctx.work_item_id ?? null,
      job_id: packet.job_id ?? ctx.job_id ?? null,
      attempt_id: ctx.attempt_id ?? null,
      observation_type: "handoff.traversal_completion_check",
      summary: `Traversal completion check ${status} (${check.mode}; terms=${terms})`,
      detail: {
        kind: "handoff_traversal_completion_check",
        mode: check.mode,
        status,
        triggered: check.triggered,
        matched_terms: check.matched_terms,
        rendered_chars: check.rendered_chars,
        max_chars: check.max_chars,
        task_text_chars: check.task_text_chars,
        recipient: packet.recipient || null,
        job_type: packet.job_type || null,
        provider: packet.execution_provider || null,
        atlas_prefetch_status: packet.atlas?.prefetchStatus || null,
      },
    });
  } catch {
    // Optional telemetry only; handoff rendering must not fail on observation IO.
  }

  return check;
}

function _applyAtlasShadowGuardrails(packet) {
  const mode = getSetting(SETTING_KEYS.ATLAS_SHADOW_GUARDRAILS) || "shadow";
  const guardrails = buildAtlasShadowGuardrailsFromModule(packet, { mode });
  packet.atlas_shadow_guardrails = guardrails;

  if (guardrails.mode === "off" || !guardrails.triggered) return guardrails;

  try {
    const ctx = getObservationContext() || {};
    const lanes = guardrails.lanes.map((lane) => lane.id).join(",") || "none";
    recordObservation({
      work_item_id: packet.work_item_id ?? ctx.work_item_id ?? null,
      job_id: packet.job_id ?? ctx.job_id ?? null,
      attempt_id: ctx.attempt_id ?? null,
      observation_type: "handoff.atlas_shadow_guardrails",
      summary: `ATLAS shadow guardrails matched ${lanes}`,
      detail: {
        kind: "atlas_shadow_guardrails",
        mode: guardrails.mode,
        status: "shadowed",
        lanes: guardrails.lanes,
        matched_terms: guardrails.matched_terms,
        recommendations: guardrails.recommendations,
        task_text_chars: guardrails.task_text_chars,
        recipient: packet.recipient || null,
        job_type: packet.job_type || null,
        provider: packet.execution_provider || null,
        atlas_prefetch_status: packet.atlas?.prefetchStatus || null,
      },
    });
  } catch {
    // Shadow telemetry must never affect handoff assembly.
  }

  return guardrails;
}

export function attachAssessmentDiffContext(assessmentContext = null, cwd = null) {
  if (!assessmentContext || typeof assessmentContext !== "object" || !cwd) return assessmentContext;
  const branchNetDiff = String(assessmentContext.branch_net_diff || "").trim();
  if (branchNetDiff) {
    assessmentContext.scoped_git_diff = branchNetDiff.length > 50000
      ? `${branchNetDiff.slice(0, 50000)}\n...[diff truncated]`
      : branchNetDiff;
    assessmentContext.scoped_diff_narrative = [
      `BRANCH NET DIFF: zero-commit attempt found existing committed WI branch changes vs ${assessmentContext.branch_net_diff_target || "target"}.`,
      Array.isArray(assessmentContext.branch_net_diff_files) && assessmentContext.branch_net_diff_files.length > 0
        ? `Files: ${assessmentContext.branch_net_diff_files.slice(0, 40).join(", ")}`
        : null,
    ].filter(Boolean).join("\n");
    return assessmentContext;
  }
  const commitHash = String(assessmentContext.commit_hash || "").trim();
  const scopedPaths = [...new Set([
    ...(Array.isArray(assessmentContext.files_committed) ? assessmentContext.files_committed : []),
    ...(Array.isArray(assessmentContext.files_reverted) ? assessmentContext.files_reverted : []),
  ].filter(Boolean).map((value) => String(value).replace(/\\/g, "/")))].slice(0, 20);
  if (!commitHash || scopedPaths.length === 0) return assessmentContext;
  try {
    const diff = gitExec([
      "diff",
      "--unified=6",
      `${commitHash}^!`,
      "--",
      ...scopedPaths,
    ], cwd, {
      timeoutMs: 15000,
      maxBuffer: 1024 * 1024 * 2,
    });
    const trimmed = String(diff || "").trim();
    if (trimmed) {
      assessmentContext.scoped_git_diff = trimmed.length > 50000
        ? `${trimmed.slice(0, 50000)}\n...[diff truncated]`
        : trimmed;
    }
  } catch {
    // best effort only
  }
  attachDiffNarrative(assessmentContext, cwd);
  return assessmentContext;
}

export async function attachAssessmentDiffContextAsync(assessmentContext = null, cwd = null) {
  if (!assessmentContext || typeof assessmentContext !== "object" || !cwd) return assessmentContext;
  const branchNetDiff = String(assessmentContext.branch_net_diff || "").trim();
  if (branchNetDiff) {
    assessmentContext.scoped_git_diff = branchNetDiff.length > 50000
      ? `${branchNetDiff.slice(0, 50000)}\n...[diff truncated]`
      : branchNetDiff;
    assessmentContext.scoped_diff_narrative = [
      `BRANCH NET DIFF: zero-commit attempt found existing committed WI branch changes vs ${assessmentContext.branch_net_diff_target || "target"}.`,
      Array.isArray(assessmentContext.branch_net_diff_files) && assessmentContext.branch_net_diff_files.length > 0
        ? `Files: ${assessmentContext.branch_net_diff_files.slice(0, 40).join(", ")}`
        : null,
    ].filter(Boolean).join("\n");
    return assessmentContext;
  }
  const commitHash = String(assessmentContext.commit_hash || "").trim();
  const scopedPaths = [...new Set([
    ...(Array.isArray(assessmentContext.files_committed) ? assessmentContext.files_committed : []),
    ...(Array.isArray(assessmentContext.files_reverted) ? assessmentContext.files_reverted : []),
  ].filter(Boolean).map((value) => String(value).replace(/\\/g, "/")))].slice(0, 20);
  if (!commitHash || scopedPaths.length === 0) return assessmentContext;
  try {
    const stdout = await gitExecAsync([
      "diff",
      "--unified=6",
      `${commitHash}^!`,
      "--",
      ...scopedPaths,
    ], cwd, {
      timeoutMs: 15000,
      maxBuffer: 1024 * 1024 * 2,
    });
    const trimmed = String(stdout || "").trim();
    if (trimmed) {
      assessmentContext.scoped_git_diff = trimmed.length > 50000
        ? `${trimmed.slice(0, 50000)}\n...[diff truncated]`
        : trimmed;
    }
  } catch {
    // best effort only
  }
  await attachDiffNarrativeAsync(assessmentContext, cwd);
  return assessmentContext;
}

// ═════════════════════════════════════════════════════════════════════════════
// packetToContextString — format the file context as a prompt section
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Build a prompt-ready context string from packet fields.
 * The packet is the source of truth — this just formats it for the model.
 */
export function renderAtlasHandoffSections(packet) {
  const meta = renderAtlasHandoffSectionsWithMetaFromModule(packet);
  if (packet && typeof packet === "object") {
    // Stashed for the prompt-section accounting observation (operator-facing
    // telemetry only; never rendered into the agent prompt).
    packet.atlas_render_meta = {
      char_count: meta.charCount,
      original_length: meta.originalLength,
      trim_level: meta.trimLevel,
      truncated: meta.truncated,
      cap: meta.cap,
    };
  }
  return meta.text;
}

export function collectAtlasCoveredFiles(packet) {
  return collectAtlasCoveredFilesFromModule(packet);
}

export function packetToContextString(packet) {
  return packetToContextStringFromModule(packet);
}

export function packetToDynamicContextString(packet) {
  return packetToDynamicContextStringFromModule(packet);
}

export async function buildPromptAsync(packet, instructions, opts = {}) {
  return await composePromptRemoteAware(packet, instructions, opts);
}

export async function composePromptRemoteAware(packet, instructions, opts = {}) {
  const mode = getPosseRemoteMode();
  if (!packet) {
    const err = new Error("Remote prompt composition requires a routing packet");
    err.code = "POSSE_REMOTE_REQUIRED";
    throw err;
  }

  const composer = await timeHandoffStep(packet, "prompt.remote_composer_init", () => opts.composer || getDefaultRemoteComposer());
  const remoteOpts = {
    providerName: opts.providerName || packet?.execution_provider || null,
    maxPromptChars: _maxPromptChars(),
    maxContextChars: _maxContextChars(),
  };

  try {
    const remote = await timeHandoffStep(packet, "prompt.remote_compile", () => composer.composePrompt(packet, instructions, remoteOpts), {
      timeoutMs: remoteCompileHandoffTimeoutMs(),
    });
    packet.prompt = remote.userPrompt || remote.prompt;
    packet.remote_full_prompt = remote.prompt || null;
    packet.remote_prompt_composed = true;
    packet.remote_prompt_metadata = remote.metadata || null;
    packet.remote_prompt_response = remote.response || null;
    packet.remote_system_prompt = remote.systemPrompt || null;
    packet.remote_stable_context = remote.stableContext || remote.response?.stable_context || null;
    packet.remote_issuance = remote.issuance || remote.response?.issuance || packet.remote_issuance || null;
    packet.remote_tool_surface = Array.isArray(packet.remote_issuance?.tool_surface)
      ? packet.remote_issuance.tool_surface.slice()
      : (Array.isArray(remote.response?.issuance?.tool_surface) ? remote.response.issuance.tool_surface.slice() : packet.remote_tool_surface || []);
    packet.stable_context = remote.stableContext || null;
    packet.posse_remote = {
      mode,
      source: "remote",
      ok: true,
      latency_ms: remote.latencyMs,
      metadata: remote.metadata || null,
    };
    return remote.userPrompt || remote.prompt;
  } catch (err) {
    packet.posse_remote = {
      mode,
      source: "remote_required",
      ok: false,
      error: err?.message || String(err),
    };
    const requiredErr = new Error(`Posse remote prompt compiler required but unavailable: ${err?.message || String(err)}`);
    requiredErr.code = "POSSE_REMOTE_REQUIRED";
    requiredErr.cause = err;
    throw requiredErr;
  }
}

export function buildResumeHandoff({
  packet = null,
  instructions = "",
  priorSession = null,
  role = null,
} = {}) {
  const dynamicContext = packet?.prompt_dynamic_context || (packet ? packetToDynamicContextString(packet) : "");
  const parts = [
    "SESSION RESUME DELTA",
    [
      `Resuming provider session${priorSession?.id ? ` #${priorSession.id}` : ""}`,
      priorSession?.hop_count != null ? `at hop ${priorSession.hop_count}.` : ".",
      "The base role prompt, contracts, skill guidance, and prior turn context remain in session memory.",
    ].join(" "),
    "Continue obeying all original role, file-scope, tool, status, and output-format requirements.",
    role ? `ROLE: ${role}` : null,
    packet?.job_id ? `JOB: #${packet.job_id}` : null,
    priorSession?.parent_job_id ? `PRIOR JOB: #${priorSession.parent_job_id}` : null,
    "",
    "NEW TURN INSTRUCTIONS:",
    String(instructions || "").trim() || "(none)",
    dynamicContext ? `\nNEW OR CHANGED CONTEXT:\n${dynamicContext}` : null,
  ].filter((part) => part != null && String(part) !== "");

  const resumePrompt = parts.join("\n\n");
  if (packet) {
    packet.resumed_from = {
      session_id: priorSession?.id ?? null,
      hop_count: priorSession?.hop_count ?? null,
    };
    packet.resume_prompt = resumePrompt;
  }
  return resumePrompt;
}

// ═════════════════════════════════════════════════════════════════════════════
// Post-call helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Parse a MISSING_CONTEXT response from dev output.
 * Returns array of file paths or null.
 */
export function parseMissingContext(output, { maxFiles = 5 } = {}) {
  const match = output.match(/MISSING_CONTEXT[:\s]*\n?([\s\S]*?)(?:---|$)/i);
  if (!match) return null;

  const neededFiles = [];
  const addCandidate = (raw) => {
    const token = String(raw || "")
      .trim()
      .replace(/^["'`]+|["'`,.;:]+$/g, "");
    if (token && looksLikeConcreteRequestedFile(token)) neededFiles.push(token);
  };
  // Lines can list several paths ("src/a.js, src/b.js"); keep every token that
  // passes the path validation rather than only the first.
  const addLineCandidates = (raw) => {
    const text = String(raw || "").trim();
    const quoted = text.match(/^(?:"([^"]+)"|`([^`]+)`)$/);
    if (quoted) {
      addCandidate(quoted[1] || quoted[2]);
      return;
    }
    for (const token of text.split(/[\s,]+/)) addCandidate(token);
  };

  for (const line of match[1].split(/\r?\n/)) {
    const bullet = line.match(/^\s*(?:[-*]|\u2022)\s+(.+)$/);
    if (bullet) addLineCandidates(bullet[1]);
  }

  const compact = match[1].trim();
  if (compact && !compact.includes("\n") && !/^(?:[-*]|•)\s/.test(compact)) {
    addLineCandidates(compact);
  }
  try {
    const parsed = JSON.parse(match[1]);
    if (Array.isArray(parsed.needed_files)) {
      for (const filePath of parsed.needed_files) addCandidate(filePath);
    }
  } catch { /* not JSON */ }

  const cap = Math.max(1, Number.parseInt(String(maxFiles || 5), 10) || 5);
  return neededFiles.length > 0 ? [...new Set(neededFiles)].slice(0, cap) : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// File-request parsing + risk classification

export function classifyFileRisk(filePath) {
  return classifyFileRiskFromModule(filePath);
}

export function isHighRiskPath(filePath) {
  return isHighRiskPathFromModule(filePath);
}

export function parseFileRequest(output) {
  return parseFileRequestFromModule(output);
}

export function splitFileRequestsByRisk(requests) {
  return splitFileRequestsByRiskFromModule(requests);
}

export function parseResearcherStructuredOutput(output) {
  return parseResearcherStructuredOutputFromModule(output);
}

export function researcherOutputNeedsHuman(output) {
  return researcherOutputNeedsHumanFromModule(output);
}

export function extractResearcherFiles(artifacts) {
  return extractResearcherFilesFromModule(artifacts);
}

export function normalizeResearcherKeySymbols(parsed, maxItems = 24) {
  return normalizeResearcherKeySymbolsFromModule(parsed, maxItems);
}

export function normalizeResearcherFilePriorities(parsed) {
  return normalizeResearcherFilePrioritiesFromModule(parsed);
}

export function normalizeResearcherCitationTriage(parsed, opts = {}) {
  return normalizeResearcherCitationTriageFromModule(parsed, opts);
}

export {
  expandHashRefHandoffPacketProofs,
  normalizeHashRefHandoffPacket,
  reissueHashRefHandoffPacket,
  renderHashRefHandoffPacket,
} from "./helpers/hash-ref-packet.js";

// ─── Test-only exports ──────────────────────────────────────────────────────
export { _parseFunctions, _buildSmartPreload };
