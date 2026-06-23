import { log } from "../../../../shared/telemetry/functions/logging/logger.js";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import {
  claimInsightPromotion,
  getInsightById,
  getSetting,
  isCannedInsightAction,
  updateInsightPromotion,
} from "../../../queue/functions/index.js";
import { extractJson } from "../../../../shared/format/functions/json.js";
import { executeEmbeddedAtlasTool } from "../../../integrations/functions/atlas-embedded.js";
import { callAtlasMemoryAction, getAtlasMemoryClient } from "../../../integrations/functions/atlas-memory.js";
import {
  atlasResultData,
  atlasResultField,
  atlasSymbolCardField,
} from "../../../atlas/functions/v2/contracts/tool-results.js";

const GENERIC_REJECT_PATTERNS = [
  /\bbe careful\b/i,
  /\bvalidate against the current task\b/i,
  /\bscope-sensitive area\b/i,
  /\brespect the current file scope contract\b/i,
  /\bprior failure\/success path\b/i,
];

const DURABLE_HUMAN_HINT = /\b(always|never|prefer|avoid|must|should|use|do not|don't|convention|architecture|workflow|when touching|for .+ use)\b/i;
const CONCRETE_ASSESSOR_HINT = /\b(expected|actual|missing|regression|violat|because|must|should|test|assert|contract|API|schema|migration|deterministic|dirty|scope)\b/i;
const PATH_SIGNAL = /\b(?:[\w@.-]+[\\/])+[\w@.-]+\.[A-Za-z0-9][\w.-]*\b/;
const SYMBOL_SIGNAL = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|::[A-Za-z_$][\w$]*|#[A-Za-z_$][\w$]*)\b/;
const ERROR_SIGNAL = /\b(?:[A-Z][A-Za-z0-9_]*(?:Error|Exception)|ENOENT|EACCES|EPERM|MODULE_NOT_FOUND)\b/;
const COMMAND_SIGNAL = /\b(?:npm|pnpm|yarn|jest|vitest|pytest|python|node|go test|cargo test|mvn|gradle|tsc|eslint)\b/i;
// camelCase like processInput, parseJSON — distinctive shape, unlikely to match prose.
const CAMEL_IDENT_SIGNAL = /\b[a-z][a-zA-Z0-9_$]*[A-Z][a-zA-Z0-9_$]*\b/;
// Identifier in backticks, e.g. `validate` — Markdown convention for naming code.
const BACKTICK_IDENT_SIGNAL = /`[A-Za-z_$][\w$]*`/;
// Identifier in call syntax of length 5+ characters, e.g. validate(input). 5+ avoids matching keywords like if/for/do.
const CALL_IDENT_SIGNAL = /\b[a-zA-Z_$][\w$]{4,}\s*\(/;
const PROMOTION_TERMINAL_STATUSES = new Set(["promoted", "duplicate", "shadow", "rejected", "failed"]);
const KAIZEN_TO_ATLAS_PROMOTION_ENABLED = false;

function safeParseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  const parsed = safeParseJson(value);
  if (Array.isArray(parsed)) return parsed;
  return [value];
}

function cleanLine(value, max = 260) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizedUnique(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = cleanLine(value, 500).replace(/\\/g, "/");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export function collectInsightAnchors({ insight = {}, payload = {} } = {}) {
  const files = [
    ...parseArray(insight.file_paths),
    ...parseArray(payload.files_to_modify),
    ...parseArray(payload.files_to_create),
    ...parseArray(payload.files_to_delete),
    ...Object.keys(payload.source_files || {}),
    ...parseArray(payload.atlas_slice_candidates?.filePaths),
    ...parseArray(payload.atlas_slice_context?.filePaths),
    ...parseArray(payload.atlas_fallback_context?.candidateFiles),
  ];
  const cards = [
    ...parseArray(payload.atlas_slice_candidates?.cards),
    ...parseArray(payload.atlas_slice_context?.cards),
  ];
  for (const card of cards) {
    if (card?.file) files.push(card.file);
  }
  const symbolIds = normalizedUnique(cards.map((card) => card?.symbolId || card?.symbol_id));
  return {
    fileRelPaths: normalizedUnique(files).slice(0, 100),
    symbolIds: symbolIds.slice(0, 100),
  };
}

function hasAnchor({ anchors, allowProjectLevel = false, text = "" } = {}) {
  if ((anchors?.fileRelPaths || []).length > 0) return true;
  if ((anchors?.symbolIds || []).length > 0) return true;
  return !!allowProjectLevel && DURABLE_HUMAN_HINT.test(text);
}

function textLooksGeneric(value) {
  const text = String(value || "");
  if (!text.trim()) return true;
  return GENERIC_REJECT_PATTERNS.some((regex) => regex.test(text));
}

function concreteActionLooksGood(value, { allowProjectLevel = false } = {}) {
  const text = String(value || "").trim();
  if (!text || textLooksGeneric(text) || isCannedInsightAction(text)) return false;
  if (allowProjectLevel && DURABLE_HUMAN_HINT.test(text)) return true;
  return PATH_SIGNAL.test(text)
    || SYMBOL_SIGNAL.test(text)
    || ERROR_SIGNAL.test(text)
    || COMMAND_SIGNAL.test(text)
    || BACKTICK_IDENT_SIGNAL.test(text)
    || CAMEL_IDENT_SIGNAL.test(text)
    || CALL_IDENT_SIGNAL.test(text);
}

function confidenceNumber(value, fallback = 0.6) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  const text = String(value || "").toLowerCase();
  if (text === "high") return 0.85;
  if (text === "medium") return 0.7;
  if (text === "low") return 0.55;
  return fallback;
}

function classifyMemoryType({ insight = {}, job = {}, attempts = [] } = {}) {
  const detail = `${insight.summary || ""} ${insight.detail || ""} ${insight.action || ""}`;
  if (insight.insight_type === "scope_issue") return "enforcement";
  if (insight.insight_kind === "success_pattern") return "pattern";
  if (insight.insight_type === "human_override" && /\b(always|never|must|do not|don't|preserve|enforce|require)\b/i.test(detail)) {
    return "enforcement";
  }
  const failed = attempts.filter((attempt) => attempt?.status === "failed");
  const succeeded = attempts.find((attempt) => attempt?.status === "succeeded");
  const lastFail = failed[failed.length - 1];
  if (succeeded && lastFail && succeeded.model_name && lastFail.model_name && succeeded.model_name !== lastFail.model_name) {
    return "lesson";
  }
  if (job?.status === "dead_letter" || insight.insight_type === "failure") return "lesson";
  return "pattern";
}

function atlasTypeForMemoryType(memoryType) {
  if (memoryType === "enforcement") return "decision";
  if (memoryType === "lesson") return "bugfix";
  return "task_context";
}

function futureActionFor({ insight = {}, memoryType, job = {} } = {}) {
  if (insight.insight_type === "human_override" || insight.insight_type === "information_request") {
    const answer = String(insight.detail || "")
      .split("\n")
      .find((line) => /^A:\s*/i.test(line));
    const guidance = cleanLine((answer || insight.detail || insight.summary).replace(/^A:\s*/i, ""), 500);
    if (guidance) return guidance;
  }
  const action = cleanLine(insight.action, 500);
  if (action && !textLooksGeneric(action) && !isCannedInsightAction(action)) return action;
  const title = cleanLine(job.title || insight.summary, 180);
  if (memoryType === "enforcement") return `When working in this scope, verify the concrete condition that previously caused assessment feedback: ${cleanLine(insight.detail || insight.summary, 220)}`;
  if (memoryType === "lesson") return `Avoid repeating the failed path from ${title}; check the recorded blocker before retrying.`;
  return `Reuse the successful approach recorded for ${title} when the same files or symbols are involved.`;
}

function evidenceFor({ insight = {}, attempts = [], verdicts = [] } = {}) {
  const evidence = parseArray(insight.evidence).map((line) => cleanLine(line, 260)).filter(Boolean);
  if (evidence.length > 0) return evidence.slice(0, 4);
  const failReasons = verdicts
    .filter((verdict) => verdict?.verdict === "fail")
    .flatMap((verdict) => verdict?.reasons || [])
    .map((reason) => cleanLine(reason, 260))
    .filter(Boolean);
  if (failReasons.length > 0) return failReasons.slice(0, 4);
  return attempts
    .filter((attempt) => attempt?.status === "failed" && attempt.error_text)
    .map((attempt) => `attempt ${attempt.attempt_number}: ${cleanLine(String(attempt.error_text).split("\n")[0], 220)}`)
    .slice(-4);
}

function buildContent({ insight, memoryType, futureAction, evidence, anchors, workItemId, job } = {}) {
  const scope = anchors.fileRelPaths.length > 0
    ? anchors.fileRelPaths.slice(0, 12).join(", ")
    : anchors.symbolIds.slice(0, 8).join(", ") || "project-level";
  const kind = memoryType === "enforcement" ? "Enforcement" : memoryType === "lesson" ? "Lesson" : "Pattern";
  return [
    `${kind}: ${futureAction}`,
    "",
    `Scope: ${scope}`,
    `Evidence: ${evidence.length > 0 ? evidence.join(" | ") : cleanLine(insight.detail || insight.summary, 500)}`,
    `Source: Posse kaizen WI#${workItemId || insight.work_item_id || "?"}${job?.id || insight.job_id ? ` job#${job?.id || insight.job_id}` : ""}`,
    "",
    cleanLine(insight.detail || insight.summary, 1000),
  ].filter(Boolean).join("\n");
}

function titleFor({ insight, memoryType, futureAction } = {}) {
  const prefix = memoryType === "enforcement" ? "Enforce" : memoryType === "lesson" ? "Remember" : "Reuse";
  const base = cleanLine(futureAction || insight.summary, 96);
  return `${prefix}: ${base}`.slice(0, 120);
}

export function evaluateInsightPromotion({
  insight,
  job = {},
  payload = {},
  attempts = [],
  verdicts = [],
  workItemStatus = null,
} = {}) {
  if (!insight) return { promote: false, reason: "missing_insight" };
  const anchors = collectInsightAnchors({ insight, payload });
  const text = `${insight.summary || ""}\n${insight.detail || ""}\n${insight.action || ""}`;

  if (isCannedInsightAction(insight.action)) {
    return { promote: false, reason: "canned_action", anchors };
  }
  if (textLooksGeneric(insight.action) && insight.insight_type !== "human_override") {
    return { promote: false, reason: "generic_action", anchors };
  }

  const isHuman = insight.insight_type === "human_override" || insight.insight_type === "information_request";
  const allowProjectLevel = isHuman;
  if (!hasAnchor({ anchors, allowProjectLevel, text })) {
    return { promote: false, reason: "unanchored", anchors };
  }

  let gate = null;
  let confidence = confidenceNumber(insight.confidence);

  if (isHuman && workItemStatus !== "failed") {
    gate = "human_anchored_guidance";
    confidence = Math.max(confidence, 0.85);
  } else if (insight.insight_kind === "success_pattern" || insight.source === "clean_success") {
    gate = "successful_pattern";
    confidence = Math.max(confidence, 0.72);
  } else if (insight.insight_type === "scope_issue" && CONCRETE_ASSESSOR_HINT.test(text) && !textLooksGeneric(text)) {
    gate = "assessor_enforcement";
    confidence = Math.max(confidence, 0.76);
  } else if (insight.insight_type === "failure" && /same error|structural|repeated/i.test(text)) {
    gate = "resolved_structural_blocker";
    confidence = Math.max(confidence, 0.8);
  } else if (insight.insight_type === "pattern" && /resolved by escalating|failed \d+x before succeeding/i.test(text)) {
    gate = "resolved_by_escalation";
    confidence = Math.max(confidence, 0.7);
  }

  if (!gate) return { promote: false, reason: "no_promotion_gate", anchors };

  const memoryType = classifyMemoryType({ insight, job, attempts });
  const futureAction = futureActionFor({ insight, memoryType, job });
  const evidence = evidenceFor({ insight, attempts, verdicts });
  if (!futureAction || textLooksGeneric(futureAction)) {
    return { promote: false, reason: "missing_future_action", anchors, gate };
  }
  if (!concreteActionLooksGood(futureAction, { allowProjectLevel: isHuman })) {
    return { promote: false, reason: "generic_future_action", anchors, gate };
  }
  if (evidence.length === 0 && !cleanLine(insight.detail || insight.summary)) {
    return { promote: false, reason: "missing_evidence", anchors, gate };
  }
  confidence = Math.min(confidence, 0.85);

  return {
    promote: true,
    gate,
    memoryType,
    atlasType: atlasTypeForMemoryType(memoryType),
    confidence,
    anchors,
    futureAction,
    evidence,
    title: titleFor({ insight, memoryType, futureAction }),
    content: buildContent({ insight, memoryType, futureAction, evidence, anchors, workItemId: insight.work_item_id, job }),
  };
}

function settingValue(settingReader, key) {
  try {
    return typeof settingReader === "function" ? settingReader(key) : null;
  } catch {
    return null;
  }
}

function promotionMode({ settingReader = getSetting } = {}) {
  if (!KAIZEN_TO_ATLAS_PROMOTION_ENABLED) return "off";
  const configured = settingValue(settingReader, SETTING_KEYS.KAIZEN_TO_ATLAS) ?? "shadow";
  const raw = String(configured).trim().toLowerCase();
  if (["1", "true", "on", "write"].includes(raw)) return "write";
  if (["shadow", "dry-run", "dryrun"].includes(raw)) return "shadow";
  return "off";
}

const SLICE_FAILURE_LOG_WINDOW_MS = 5 * 60 * 1000;
const SLICE_FAILURE_LAST_LOGGED = new Map();

function logSliceEnrichmentFailure(reason, { logger = log } = {}) {
  const key = String(reason || "unknown").slice(0, 120);
  const now = Date.now();
  const last = SLICE_FAILURE_LAST_LOGGED.get(key);
  if (last && (now - last) < SLICE_FAILURE_LOG_WINDOW_MS) return false;
  if (SLICE_FAILURE_LAST_LOGGED.size >= 64) SLICE_FAILURE_LAST_LOGGED.clear();
  SLICE_FAILURE_LAST_LOGGED.set(key, now);
  try { logger?.warn?.(`[kaizen] ATLAS slice.build did not return symbols; falling back to file-only anchors: ${key}`); } catch { /* ignore */ }
  return true;
}

function parseAtlasJsonPayload(raw, { logger = log } = {}) {
  if (!raw) return null;
  if (typeof raw === "object") {
    if (raw.ok === false || (raw.error && typeof raw.error === "string")) {
      logSliceEnrichmentFailure(raw.error || "ok=false", { logger });
      return null;
    }
    return raw;
  }
  const text = String(raw || "").trim();
  if (!text) return null;
  if (text.startsWith("Error:")) {
    logSliceEnrichmentFailure(text.slice(0, 120), { logger });
    return null;
  }
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.ok === false || (parsed.error && typeof parsed.error === "string")) {
    logSliceEnrichmentFailure(parsed.error || "ok=false", { logger });
    return null;
  }
  return parsed;
}

function cardsFromSlicePayload(parsed) {
  if (!parsed || typeof parsed !== "object") return [];
  const data = atlasResultData("slice.build", parsed) || {};
  const catalogCards = atlasResultField("slice.build", parsed, "cards");
  const candidates = [
    catalogCards,
    data.cards,
    parsed.cards,
    parsed.slice?.cards,
    parsed.slice?.c,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function symbolsFromSlicePayload(parsed) {
  const cards = cardsFromSlicePayload(parsed);
  return normalizedUnique(cards.map((card) => {
    if (!card || typeof card !== "object") return null;
    return card.symbolId || card.symbol_id || atlasSymbolCardField(card, "symbolId");
  })).slice(0, 100);
}

function normalizeFileSetKey(fileRelPaths = []) {
  return fileRelPaths
    .map((p) => String(p || "").replace(/\\/g, "/").trim())
    .filter(Boolean)
    .sort()
    .join("\n");
}

export function createEnrichmentCache() {
  return new Map();
}

async function fetchSliceSymbols({
  cwd,
  payload,
  futureAction,
  title,
  fileRelPaths,
  atlasToolRunner,
}) {
  try {
    const taskText = cleanLine(
      payload?.task_spec
        || payload?.instructions
        || payload?.title
        || futureAction
        || title,
      500,
    );
    const raw = await atlasToolRunner("slice.build", {
      taskText,
      editedFiles: fileRelPaths.slice(0, 100),
      maxCards: 12,
      maxTokens: 1800,
    }, {
      cwd,
      origin: "kaizen-promotion",
    });
    const parsed = parseAtlasJsonPayload(raw);
    return symbolsFromSlicePayload(parsed);
  } catch {
    return [];
  }
}

export async function enrichDecisionAnchorsWithAtlas2Slice(decision, {
  cwd = process.cwd(),
  payload = {},
  atlasToolRunner = executeEmbeddedAtlasTool,
  enrichmentCache = null,
} = {}) {
  if (!decision?.promote) return decision;
  const anchors = decision.anchors || {};
  const fileRelPaths = Array.isArray(anchors.fileRelPaths) ? anchors.fileRelPaths : [];
  const symbolIds = Array.isArray(anchors.symbolIds) ? anchors.symbolIds : [];
  if (symbolIds.length > 0 || fileRelPaths.length === 0 || typeof atlasToolRunner !== "function") return decision;

  const cacheKey = normalizeFileSetKey(fileRelPaths);
  const usingCache = enrichmentCache instanceof Map && cacheKey.length > 0;
  let symbolsPromise;
  if (usingCache && enrichmentCache.has(cacheKey)) {
    symbolsPromise = enrichmentCache.get(cacheKey);
  } else {
    symbolsPromise = fetchSliceSymbols({
      cwd,
      payload,
      futureAction: decision.futureAction,
      title: decision.title,
      fileRelPaths,
      atlasToolRunner,
    });
    if (usingCache) enrichmentCache.set(cacheKey, symbolsPromise);
  }

  let discovered;
  try {
    discovered = await symbolsPromise;
  } catch {
    return decision;
  }
  if (!Array.isArray(discovered) || discovered.length === 0) return decision;
  return {
    ...decision,
    anchors: {
      ...anchors,
      symbolIds: normalizedUnique([...symbolIds, ...discovered]).slice(0, 100),
    },
  };
}

function shouldSkipExistingPromotion(insight = {}) {
  const status = String(insight?.promotion_status || "").trim().toLowerCase();
  if (PROMOTION_TERMINAL_STATUSES.has(status)) return true;
  if (status !== "pending") return false;
  return !!(
    insight.promotion_reason
    || insight.memory_type
    || insight.promoted_memory_id
    || insight.rejection_reason
  );
}

async function defaultAtlasMemoryClient({ cwd = process.cwd() } = {}) {
  return getAtlasMemoryClient({ cwd });
}

async function storeAtlasMemory(decision, {
  cwd = process.cwd(),
  memoryClient = null,
  payload = {},
  atlasToolRunner = executeEmbeddedAtlasTool,
  enrichmentCache = null,
} = {}) {
  const client = memoryClient || await defaultAtlasMemoryClient({ cwd });
  if (!client?.ok || typeof client.call !== "function") {
    return { ok: false, skipped: client?.skipped || "memory_client_unavailable" };
  }
  decision = await enrichDecisionAnchorsWithAtlas2Slice(decision, { cwd, payload, atlasToolRunner, enrichmentCache });
  const stored = await callAtlasMemoryAction("memory.store", {
    title: decision.title,
    content: decision.content,
    symbolIds: decision.anchors.symbolIds,
    fileRelPaths: decision.anchors.fileRelPaths,
  }, { memoryClient: client });
  const storedJson = stored?.json;
  const memoryId = storedJson?.memoryId || storedJson?.memory_id || null;
  if (storedJson?.deduplicated === true) return { ok: true, duplicate: true, memoryId, raw: storedJson };
  return { ok: !!memoryId || storedJson?.ok === true, memoryId, raw: storedJson };
}

export function triggerInsightPromotion({
  insight,
  job = {},
  payload = {},
  attempts = [],
  verdicts = [],
  workItemStatus = null,
  cwd = process.cwd(),
  memoryClient = null,
  atlasToolRunner = executeEmbeddedAtlasTool,
  settingReader = getSetting,
  insightFetcher = getInsightById,
  enrichmentCache = null,
} = {}) {
  const decision = evaluateInsightPromotion({ insight, job, payload, attempts, verdicts, workItemStatus });
  if (!insight?.id) return decision;
  // Re-fetch from DB so the idempotency guard reflects committed promotion state, not the
  // in-memory row passed by the extractor (which never carries promotion_status set).
  const freshRow = (typeof insightFetcher === "function" && insightFetcher(insight.id)) || insight;
  if (shouldSkipExistingPromotion(freshRow)) return { ...decision, skipped: "already_processed" };

  if (!decision.promote) {
    updateInsightPromotion(insight.id, {
      promotion_status: "rejected",
      rejection_reason: decision.reason,
    });
    return decision;
  }

  const mode = promotionMode({ settingReader });
  if (mode === "off") {
    updateInsightPromotion(insight.id, {
      promotion_status: "rejected",
      rejection_reason: "promotion_disabled",
    });
    return { ...decision, mode };
  }
  if (mode === "shadow") {
    updateInsightPromotion(insight.id, {
      promotion_status: "shadow",
      promotion_reason: decision.gate,
      memory_type: decision.memoryType,
    });
    return { ...decision, mode };
  }

  const claimed = claimInsightPromotion(insight.id, {
    promotion_reason: decision.gate,
    memory_type: decision.memoryType,
  });
  if (!claimed) return { ...decision, mode, skipped: "already_processed" };

  void storeAtlasMemory(decision, { cwd, memoryClient, payload, atlasToolRunner, enrichmentCache })
    .then((result) => {
      updateInsightPromotion(insight.id, {
        promotion_status: result.duplicate ? "duplicate" : result.ok ? "promoted" : "failed",
        promotion_reason: result.skipped || decision.gate,
        promoted_memory_id: result.memoryId || null,
        memory_type: decision.memoryType,
        rejection_reason: result.ok ? null : (result.error || result.skipped || "memory_store_failed"),
      });
    })
    .catch((err) => {
      updateInsightPromotion(insight.id, {
        promotion_status: "failed",
        promotion_reason: decision.gate,
        memory_type: decision.memoryType,
        rejection_reason: String(err?.message || err || "memory_store_failed"),
      });
      log.warn(`[kaizen] ATLAS memory promotion failed for insight #${insight.id}: ${err?.message || err}`);
    });
  return { ...decision, mode };
}

function resetSliceFailureLogCache() {
  SLICE_FAILURE_LAST_LOGGED.clear();
}

export const __test = {
  concreteActionLooksGood,
  confidenceNumber,
  parseAtlasJsonPayload,
  futureActionFor,
  normalizeFileSetKey,
  promotionMode,
  kaizenToAtlasPromotionEnabled: () => KAIZEN_TO_ATLAS_PROMOTION_ENABLED,
  resetSliceFailureLogCache,
  shouldSkipExistingPromotion,
  atlasTypeForMemoryType,
  symbolsFromSlicePayload,
};
