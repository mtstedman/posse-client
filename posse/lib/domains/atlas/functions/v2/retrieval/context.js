// @ts-check
//
// context and agent.feedback handlers.

import { sliceBuild } from "./slice.js";
import { okEnvelope, errorEnvelope } from "./envelope.js";
import { buildSymbolCard, symbolHit, symbolIdOf } from "./cards.js";
import { rankSymbols } from "./rank.js";
import { sha256Hex } from "../hash.js";
import { getRetrievalCache } from "../../../classes/v2/RetrievalCache.js";

/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/api.js").Ledger} Ledger */
/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../contracts/tool-params.js").ContextParams} ContextParams */
/** @typedef {import("../contracts/tool-params.js").ContextSummaryParams} ContextSummaryParams */
/** @typedef {import("../contracts/tool-params.js").AgentFeedbackParams} AgentFeedbackParams */
/** @typedef {import("../contracts/tool-params.js").AgentFeedbackQueryParams} AgentFeedbackQueryParams */
/** @typedef {import("../contracts/tool-results.js").ContextData} ContextData */
/** @typedef {import("../contracts/tool-results.js").ContextSummaryData} ContextSummaryData */
/** @typedef {import("../contracts/tool-results.js").AgentFeedbackData} AgentFeedbackData */
/** @typedef {import("../contracts/tool-results.js").AgentFeedbackQueryData} AgentFeedbackQueryData */
/** @typedef {import("../contracts/tool-results.js").SymbolCard} SymbolCard */
/** @typedef {import("./orchestrator/query-planner-types.js").QueryPlan} QueryPlan */

/**
 * Build a context envelope. Internally calls slice.build with the
 * task params, then formats the result as a provider-ready prompt
 * fragment.
 *
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: ContextParams,
 *   ledger?: Ledger,
 *   repoRoot?: string,
 *   repoId?: string | null,
 *   embeddingIndex?: import("../contracts/embeddings.js").EmbeddingIndex,
 *   encoder?: import("../contracts/embeddings.js").EmbeddingEncoder,
 *   planner?: (input: string) => QueryPlan | Promise<QueryPlan>,
 * }} args
 * @returns {ReturnType<typeof okEnvelope<ContextData>> | ReturnType<typeof errorEnvelope> | Promise<ReturnType<typeof okEnvelope<ContextData>> | ReturnType<typeof errorEnvelope>>}
 */
export function contextBuild({ view, versionId, params, ledger, repoRoot, repoId, embeddingIndex, encoder, planner }) {
  const maxTokens = params.maxTokens || 6000;
  const sliceEnv = /** @type {any} */ (sliceBuild({
    view,
    versionId,
    ledger,
    repoRoot,
    repoId,
    embeddingIndex,
    encoder,
    planner,
    taskType: params.taskType,
    params: {
      taskText: params.taskText,
      entrySymbols: params.focusSymbols,
      editedFiles: params.focusPaths,
      cardDetail: "compact",
      budget: { maxEstimatedTokens: maxTokens },
    },
  }));
  if (sliceEnv && typeof sliceEnv.then === "function") {
    return sliceEnv.then((resolved) => finishContextBuild({
      sliceEnv: resolved,
      versionId,
      params,
      maxTokens,
    }));
  }
  return finishContextBuild({
    sliceEnv,
    versionId,
    params,
    maxTokens,
  });
}

/**
 * @param {{
 *   sliceEnv: any,
 *   versionId: string,
 *   params: ContextParams,
 *   maxTokens: number,
 * }}
 */
function finishContextBuild({ sliceEnv, versionId, params, maxTokens }) {
  if (!sliceEnv.ok) {
    return /** @type {any} */ ({ ...sliceEnv, action: "context" });
  }
  const sourceCards = Array.isArray(sliceEnv.data?.cards) ? sliceEnv.data.cards : [];
  const sourceMemories = Array.isArray(/** @type {any} */ (sliceEnv.data)?.memories)
    ? /** @type {any} */ (sliceEnv.data).memories
    : [];
  const capped = capContextPayload({
    taskType: params.taskType,
    taskText: params.taskText,
    cards: sourceCards,
    memories: sourceMemories,
    maxTokens,
  });
  return okEnvelope({ action: "context", versionId, data: capped });
}

/**
 * Return a compact, model-facing summary of the same task-shaped context
 * without exposing the full generated prompt fragment. This mirrors the
 * native v2 philosophy: reuse the slice/context path, then project the
 * result into evidence, answer, quality, and next-action fields.
 *
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: ContextSummaryParams,
 *   ledger?: Ledger,
 *   repoRoot?: string,
 *   repoId?: string | null,
 *   embeddingIndex?: import("../contracts/embeddings.js").EmbeddingIndex,
 *   encoder?: import("../contracts/embeddings.js").EmbeddingEncoder,
 *   planner?: (input: string) => QueryPlan | Promise<QueryPlan>,
 * }} args
 * @returns {ReturnType<typeof okEnvelope<ContextSummaryData>> | ReturnType<typeof errorEnvelope> | Promise<ReturnType<typeof okEnvelope<ContextSummaryData>> | ReturnType<typeof errorEnvelope>>}
 */
export function contextSummary({ view, versionId, params, ledger, repoRoot, repoId, embeddingIndex, encoder, planner }) {
  const contextEnv = contextBuild({ view, versionId, params, ledger, repoRoot, repoId, embeddingIndex, encoder, planner });
  if (contextEnv && typeof /** @type {any} */ (contextEnv).then === "function") {
    return /** @type {Promise<any>} */ (contextEnv).then((resolved) => finishContextSummary({
      contextEnv: resolved,
      versionId,
      params,
    }));
  }
  return finishContextSummary({
    contextEnv,
    versionId,
    params,
  });
}

/**
 * @param {{
 *   contextEnv: any,
 *   versionId: string,
 *   params: ContextSummaryParams,
 * }}
 */
function finishContextSummary({ contextEnv, versionId, params }) {
  if (!contextEnv.ok) {
    return errorEnvelope({
      action: "context.summary",
      versionId,
      code: contextEnv.error?.code || "context_failed",
      message: contextEnv.error?.message || "context.summary could not build context",
      details: contextEnv.error?.details,
      meta: contextEnv.meta,
    });
  }

  const cards = Array.isArray(contextEnv.data?.cards) ? contextEnv.data.cards : [];
  const memories = Array.isArray(/** @type {any} */ (contextEnv.data)?.memories)
    ? /** @type {any[]} */ (/** @type {any} */ (contextEnv.data).memories)
    : [];
  const maxEvidence = clampInt(params.maxEvidence, 1, 50, params.contextMode === "precise" ? 5 : 10);
  const evidence = [
    ...cards.slice(0, maxEvidence).map((card) => evidenceFromCard(card)),
    ...memories.slice(0, Math.max(0, maxEvidence - Math.min(cards.length, maxEvidence))).map((memory) => evidenceFromMemory(memory)),
  ];
  const summary = renderSummaryText({ params, cards, memories, evidence });
  const answer = renderAnswerText({ params, evidence });
  const data = /** @type {ContextSummaryData} */ ({
    taskId: `ctx_${sha256Hex(`${versionId}|${params.taskType || ""}|${params.taskText || ""}`).slice(0, 16)}`,
    taskType: params.taskType,
    success: cards.length > 0 || memories.length > 0,
    summary,
    answer,
    finalEvidence: evidence,
    estimatedTokens: Math.ceil(JSON.stringify({ summary, answer, evidence }).length / 4),
    actionsConsumed: contextEnv.data.actionsConsumed || 1,
    contextQuality: qualityFor({ cards, memories, maxEvidence }),
    retrievalEvidence: {
      sources: evidence.map((item) => item.reference),
      symbolCount: cards.length,
      memoryCount: memories.length,
      mode: params.contextMode || "broad",
    },
    nextBestAction: nextBestActionFor({ params, cards, memories }),
  });
  if (params.includeCards === true) {
    /** @type {any} */ (data).cards = cards.slice(0, maxEvidence);
  }
  return okEnvelope({ action: "context.summary", versionId, data });
}

/**
 * agent.feedback persists useful/missing signals into the ledger so the
 * retrieval orchestrator's feedback-boost pass can pick them up on
 * future searches. When no ledger is provided (e.g. unit tests that
 * don't wire one) the handler degrades to an in-memory acknowledgement
 * — the response shape is unchanged.
 *
 * @param {{
 *   view: View,
 *   versionId: string,
 *   params: AgentFeedbackParams,
 *   ledger?: Ledger,
 * }} args
 */
export async function agentFeedback({ view, versionId, params, ledger }) {
  const useful = params.usefulSymbols || [];
  const missing = params.missingSymbols || [];
  let recorded = true;
  /** @type {string | null} */
  let errorMessage = null;
  const ledgerApi = /** @type {any} */ (ledger);
  if (ledgerApi && (typeof ledgerApi.recordFeedbackAsync === "function" || typeof ledgerApi.recordFeedback === "function")) {
    try {
      const input = {
        sliceHandle: params.sliceHandle,
        usefulSymbolIds: useful,
        missingSymbolIds: missing,
        taskType: params.taskType,
        taskText: params.taskText,
      };
      if (typeof ledgerApi.recordFeedbackAsync === "function") {
        await ledgerApi.recordFeedbackAsync(input, { label: "agent.feedback.recordFeedback" });
      } else {
        ledgerApi.recordFeedback(input);
      }
    } catch (err) {
      // A persistence failure shouldn't break the agent's request flow —
      // surface that it wasn't recorded but keep the envelope ok=true so
      // the caller still gets the count summary.
      recorded = false;
      errorMessage = err instanceof Error ? err.message : String(err);
      console.warn(`[atlas.agent.feedback] ledger write failed: ${errorMessage}`);
    }
  }
  /** @type {AgentFeedbackData} */
  const data = {
    recorded,
    usefulCount: useful.length,
    missingCount: missing.length,
  };
  if (!recorded && errorMessage) data.errorMessage = errorMessage;
  if (recorded) getRetrievalCache().invalidateAll();
  return okEnvelope({ action: "agent.feedback", versionId, data });
}

/**
 * @param {{
 *   versionId: string,
 *   params: AgentFeedbackQueryParams,
 *   ledger?: Ledger,
 * }} args
 */
export function agentFeedbackQuery({ versionId, params, ledger }) {
  if (!ledger || typeof ledger.recentFeedback !== "function") {
    return errorEnvelope({
      action: "agent.feedback.query",
      versionId,
      code: "ledger_unavailable",
      message: "agent.feedback.query requires a ledger-backed ATLAS context",
    });
  }
  const limit = typeof params.limit === "number" && params.limit > 0
    ? Math.min(Math.floor(params.limit), 1000)
    : 100;
  const sinceTs = params.since || defaultFeedbackSince();
  const aggregates = ledger.recentFeedback({
    sinceTs,
    taskType: params.taskType,
    limit: limit + 1,
    halfLifeDays: params.halfLifeDays,
  });
  const page = aggregates.slice(0, limit);
  const feedback = page.map((row) => ({
    symbolId: symbolIdOf(row),
    usefulCount: row.useful_count,
    missingCount: row.missing_count,
    ...(row.useful_weight == null ? {} : { usefulWeight: row.useful_weight }),
    ...(row.missing_weight == null ? {} : { missingWeight: row.missing_weight }),
    lastTs: row.last_ts,
  }));
  const stats = feedbackStats({
    ledger,
    sinceTs,
    taskType: params.taskType,
    fallbackRows: aggregates,
  });
  /** @type {AgentFeedbackQueryData} */
  const data = {
    feedback,
    aggregatedStats: stats,
    hasMore: aggregates.length > limit,
  };
  return okEnvelope({ action: "agent.feedback.query", versionId, data });
}

function defaultFeedbackSince() {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * @param {{
 *   ledger: Ledger,
 *   sinceTs: string,
 *   taskType?: string,
 *   fallbackRows: import("../contracts/api.js").FeedbackAggregate[],
 * }} args
 * @returns {import("../contracts/tool-results.js").AgentFeedbackStats}
 */
function feedbackStats({ ledger, sinceTs, taskType, fallbackRows }) {
  const db = typeof /** @type {any} */ (ledger)._unsafeDb === "function" ? /** @type {any} */ (ledger)._unsafeDb() : null;
  if (!db) return feedbackStatsFromRows(fallbackRows);
  const where = taskType ? "WHERE ts >= ? AND task_type = ?" : "WHERE ts >= ?";
  const params = taskType ? [sinceTs, taskType] : [sinceTs];
  try {
    const total = db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN signal = 'useful' THEN 1 ELSE 0 END) AS useful,
         SUM(CASE WHEN signal = 'missing' THEN 1 ELSE 0 END) AS missing
       FROM feedback_signals
       ${where}`,
    ).get(...params);
    const topRows = (signal) => db.prepare(
      `SELECT content_hash, local_id, COUNT(*) AS count, MAX(ts) AS last_ts
       FROM feedback_signals
       ${where} AND signal = ?
       GROUP BY content_hash, local_id
       ORDER BY count DESC, last_ts DESC
       LIMIT 10`,
    ).all(...params, signal);
    return {
      totalFeedback: Number(total?.total || 0),
      usefulFeedback: Number(total?.useful || 0),
      missingFeedback: Number(total?.missing || 0),
      topUsefulSymbols: topRows("useful").map((row) => ({ symbolId: symbolIdOf(row), count: Number(row.count || 0) })),
      topMissingSymbols: topRows("missing").map((row) => ({ symbolId: symbolIdOf(row), count: Number(row.count || 0) })),
    };
  } catch {
    return feedbackStatsFromRows(fallbackRows);
  }
}

/**
 * @param {import("../contracts/api.js").FeedbackAggregate[]} rows
 * @returns {import("../contracts/tool-results.js").AgentFeedbackStats}
 */
function feedbackStatsFromRows(rows) {
  const mapped = rows.map((row) => ({
    symbolId: symbolIdOf(row),
    usefulCount: row.useful_count,
    missingCount: row.missing_count,
  }));
  return {
    totalFeedback: mapped.reduce((sum, row) => sum + row.usefulCount + row.missingCount, 0),
    usefulFeedback: mapped.reduce((sum, row) => sum + row.usefulCount, 0),
    missingFeedback: mapped.reduce((sum, row) => sum + row.missingCount, 0),
    topUsefulSymbols: mapped
      .filter((row) => row.usefulCount > 0)
      .sort((a, b) => b.usefulCount - a.usefulCount)
      .slice(0, 10)
      .map((row) => ({ symbolId: row.symbolId, count: row.usefulCount })),
    topMissingSymbols: mapped
      .filter((row) => row.missingCount > 0)
      .sort((a, b) => b.missingCount - a.missingCount)
      .slice(0, 10)
      .map((row) => ({ symbolId: row.symbolId, count: row.missingCount })),
  };
}

/**
 * @param {SymbolCard} card
 */
function cardToHit(card) {
  return {
    symbolId: card.symbolId,
    name: card.name,
    qualifiedName: card.qualifiedName,
    kind: card.kind,
    lang: card.lang,
    location: card.location,
  };
}

/**
 * @param {{ taskText: string, taskType?: string, cards: SymbolCard[], memories?: any[] }} args
 */
function renderContextPrompt({ taskText, taskType, cards, memories = [] }) {
  const lines = [];
  lines.push(`# Task: ${taskText}`);
  if (taskType) lines.push(`Type: ${taskType}`);
  lines.push("");
  lines.push("## Relevant symbols");
  for (const c of cards) {
    lines.push(`- \`${c.qualifiedName || c.name}\` (${c.kind}, ${c.location.repo_rel_path})`);
    if (c.signature) lines.push(`  - ${c.signature}`);
  }
  if (memories.length > 0) {
    lines.push("");
    lines.push("## Relevant memories");
    for (const memory of memories.slice(0, 5)) {
      lines.push(`- ${memory.title || memory.memoryId}: ${String(memory.content || "").split(/\r?\n/)[0].slice(0, 240)}`);
    }
  }
  return lines.join("\n");
}

export { symbolHit, rankSymbols, buildSymbolCard };

/**
 * @param {{
 *   taskType?: string,
 *   taskText: string,
 *   cards: SymbolCard[],
 *   memories: any[],
 *   maxTokens: number,
 * }} args
 * @returns {ContextData}
 */
function capContextPayload({ taskType, taskText, cards, memories, maxTokens }) {
  const budget = Math.max(500, Math.floor(Number(maxTokens || 6000)));
  const compactCards = cards.map(compactContextCard);
  const compactMemories = memories.map(compactContextMemory);
  /** @type {SymbolCard[]} */
  const selectedCards = [];
  /** @type {any[]} */
  let selectedMemories = [];

  for (const card of compactCards) {
    const candidate = selectedCards.concat(card);
    const candidateMemories = fitContextMemories({
      taskType,
      taskText,
      cards: candidate,
      memories: compactMemories,
      sourceCardCount: cards.length,
      sourceMemoryCount: memories.length,
      maxTokens: budget,
    });
    const tokens = estimateContextWireTokens(contextDataFor({
      taskType,
      taskText,
      cards: candidate,
      memories: candidateMemories,
      sourceCardCount: cards.length,
      sourceMemoryCount: memories.length,
      maxTokens: budget,
    }));
    if (tokens > budget && selectedCards.length > 0) break;
    if (tokens > budget) break;
    selectedCards.push(card);
    selectedMemories = candidateMemories;
  }

  if (selectedCards.length === 0 && compactCards.length > 0) {
    selectedCards.push(minimalContextCard(compactCards[0]));
    selectedMemories = fitContextMemories({
      taskType,
      taskText,
      cards: selectedCards,
      memories: compactMemories,
      sourceCardCount: cards.length,
      sourceMemoryCount: memories.length,
      maxTokens: budget,
    });
  }

  if (selectedCards.length === 0) {
    selectedMemories = compactMemories.slice(0, 3);
    while (selectedMemories.length > 0) {
      const tokens = estimateContextWireTokens(contextDataFor({
        taskType,
        taskText,
        cards: selectedCards,
        memories: selectedMemories,
        sourceCardCount: cards.length,
        sourceMemoryCount: memories.length,
        maxTokens: budget,
      }));
      if (tokens <= budget) break;
      selectedMemories = selectedMemories.slice(0, -1);
    }
  }

  const data = contextDataFor({
    taskType,
    taskText,
    cards: selectedCards,
    memories: selectedMemories,
    sourceCardCount: cards.length,
    sourceMemoryCount: memories.length,
    maxTokens: budget,
  });
  data.estimatedTokens = estimateContextWireTokens(data);
  return data;
}

const CONTEXT_MEMORY_FLOOR = 2;
const CONTEXT_MEMORY_MAX = 5;

/**
 * @param {{
 *   taskType?: string,
 *   taskText: string,
 *   cards: SymbolCard[],
 *   memories: any[],
 *   sourceCardCount: number,
 *   sourceMemoryCount: number,
 *   maxTokens: number,
 * }} args
 */
function fitContextMemories({ taskType, taskText, cards, memories, sourceCardCount, sourceMemoryCount, maxTokens }) {
  const preferredCount = preferredContextMemoryCount(cards.length, memories.length);
  let selected = memories.slice(0, preferredCount);
  while (selected.length > 0) {
    const tokens = estimateContextWireTokens(contextDataFor({
      taskType,
      taskText,
      cards,
      memories: selected,
      sourceCardCount,
      sourceMemoryCount,
      maxTokens,
    }));
    if (tokens <= maxTokens) return selected;
    selected = selected.slice(0, -1);
  }
  return [];
}

function preferredContextMemoryCount(cardCount, memoryCount) {
  if (memoryCount <= 0) return 0;
  const target = Math.max(CONTEXT_MEMORY_FLOOR, CONTEXT_MEMORY_MAX - Math.max(0, cardCount));
  return Math.min(memoryCount, target);
}

/**
 * @param {{
 *   taskType?: string,
 *   taskText: string,
 *   cards: SymbolCard[],
 *   memories: any[],
 *   sourceCardCount: number,
 *   sourceMemoryCount: number,
 *   maxTokens: number,
 * }} args
 * @returns {ContextData}
 */
function contextDataFor({ taskType, taskText, cards, memories, sourceCardCount, sourceMemoryCount, maxTokens }) {
  const generatedContext = renderContextPrompt({
    taskText: truncateOneLine(taskText, Math.min(2400, Math.max(240, maxTokens * 2))) || "",
    taskType,
    cards,
    memories,
  });
  const data = /** @type {ContextData} */ ({
    taskType,
    retrievedSymbols: cards.map((card) => /** @type {any} */ (compactContextHit(card))),
    cards,
    generatedContext,
    estimatedTokens: 0,
    actionsConsumed: 1,
  });
  if (memories.length > 0) data.memories = memories;
  if (cards.length < sourceCardCount || memories.length < sourceMemoryCount) {
    data.truncated = true;
    data.budgetUsage = {
      maxTokens,
      cardsReturned: cards.length,
      cardsAvailable: sourceCardCount,
      memoriesReturned: memories.length,
      memoriesAvailable: sourceMemoryCount,
    };
  }
  return data;
}

/**
 * @param {ContextData} data
 */
function estimateContextWireTokens(data) {
  return Math.ceil(JSON.stringify(data, null, 2).length / 4);
}

/**
 * @param {SymbolCard} card
 * @returns {SymbolCard}
 */
function compactContextCard(card) {
  const signature = truncateOneLine(card.signature, 320);
  const summary = truncateOneLine(card.summary, 360);
  return {
    symbolId: card.symbolId,
    name: card.name,
    qualifiedName: card.qualifiedName || null,
    kind: card.kind,
    lang: card.lang,
    location: card.location,
    signature: signature || null,
    summary: summary || null,
    ...(card.visibility ? { visibility: card.visibility } : {}),
    ...(card.etag ? { etag: card.etag } : {}),
    detailLevel: "signature",
  };
}

/**
 * @param {SymbolCard} card
 * @returns {SymbolCard}
 */
function minimalContextCard(card) {
  const signature = truncateOneLine(card.signature, 160);
  const summary = truncateOneLine(card.summary, 180);
  return {
    symbolId: card.symbolId,
    name: card.name,
    qualifiedName: card.qualifiedName || null,
    kind: card.kind,
    lang: card.lang,
    location: card.location,
    signature: signature || null,
    summary: summary || null,
    detailLevel: "minimal",
  };
}

/**
 * @param {SymbolCard} card
 */
function compactContextHit(card) {
  return {
    symbolId: card.symbolId,
    name: card.name,
    qualifiedName: card.qualifiedName,
    kind: card.kind,
    lang: card.lang,
    location: card.location,
  };
}

/**
 * @param {any} memory
 */
function compactContextMemory(memory) {
  return {
    memoryId: memory?.memoryId || memory?.memory_id || memory?.id || null,
    type: memory?.type || null,
    title: truncateOneLine(memory?.title, 160),
    content: truncateOneLine(memory?.content, 400),
    confidence: memory?.confidence,
  };
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function truncateOneLine(value, max) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

/**
 * @param {SymbolCard} card
 */
function evidenceFromCard(card) {
  const label = card.qualifiedName || card.name;
  const location = /** @type {any} */ (card.location || {});
  return {
    type: "symbol",
    reference: `${location.repo_rel_path || "<unknown>"}:${location.startLine || 1}`,
    summary: `${label} (${card.kind})${card.summary ? `: ${card.summary}` : card.signature ? `: ${card.signature}` : ""}`,
    symbolId: card.symbolId,
    location,
  };
}

/**
 * @param {any} memory
 */
function evidenceFromMemory(memory) {
  const title = String(memory?.title || memory?.memoryId || memory?.memory_id || "memory");
  const content = String(memory?.content || "").split(/\r?\n/)[0].slice(0, 240);
  return {
    type: "memory",
    reference: String(memory?.memoryId || memory?.memory_id || title),
    summary: content ? `${title}: ${content}` : title,
  };
}

/**
 * @param {{ params: ContextSummaryParams, cards: SymbolCard[], memories: any[], evidence: Array<Record<string, unknown>> }} args
 */
function renderSummaryText({ params, cards, memories, evidence }) {
  const parts = [];
  const task = String(params.taskText || "").trim();
  parts.push(task ? `Task: ${task}` : "Task context summary");
  const symbols = cards.map((card) => card.qualifiedName || card.name).filter(Boolean);
  if (symbols.length > 0) {
    parts.push(`Primary symbols: ${symbols.slice(0, 8).join(", ")}${symbols.length > 8 ? `, +${symbols.length - 8} more` : ""}.`);
  } else {
    parts.push("No indexed symbols matched strongly enough for this task.");
  }
  const files = [...new Set(cards.map((card) => card.location?.repo_rel_path).filter(Boolean))];
  if (files.length > 0) {
    parts.push(`Files: ${files.slice(0, 6).join(", ")}${files.length > 6 ? `, +${files.length - 6} more` : ""}.`);
  }
  if (memories.length > 0) parts.push(`Relevant memories: ${memories.length}.`);
  parts.push(`Evidence items returned: ${evidence.length}.`);
  return parts.join(" ");
}

/**
 * @param {{ params: ContextSummaryParams, evidence: Array<Record<string, unknown>> }} args
 */
function renderAnswerText({ params, evidence }) {
  if (evidence.length === 0) {
    return "ATLAS did not find enough indexed evidence for this task. Start with symbol.search or broaden the context query, then retry context.summary.";
  }
  const taskType = params.taskType ? `${params.taskType} ` : "";
  const lead = evidence.slice(0, 5).map((item) => String(item.summary || "")).filter(Boolean);
  return `Use the ${taskType}context around ${lead.join("; ")}.`;
}

/**
 * @param {{ cards: SymbolCard[], memories: any[], maxEvidence: number }} args
 */
function qualityFor({ cards, memories, maxEvidence }) {
  const evidenceItems = cards.length + memories.length;
  const confidence = evidenceItems >= Math.min(3, maxEvidence)
    ? "high"
    : evidenceItems > 0
      ? "medium"
      : "low";
  const limitations = [];
  if (cards.length === 0) limitations.push("No symbol cards matched the task.");
  if (evidenceItems > maxEvidence) limitations.push("Evidence was capped by maxEvidence.");
  return {
    confidence,
    evidenceItems,
    selectedContextItems: Math.min(evidenceItems, maxEvidence),
    limitations,
    guidance: guidanceFor({ cards }),
  };
}

/**
 * @param {{ cards: SymbolCard[] }} args
 */
function guidanceFor({ cards }) {
  if (cards.length === 0) {
    return ["Try symbol.search with a concrete identifier, context.summary with focusPaths, or slice.build with editedFiles."];
  }
  return [
    "Use symbol.card for dependency/card details.",
    "Use code.skeleton or code.lens before requesting raw windows.",
  ];
}

/**
 * @param {{ params: ContextSummaryParams, cards: SymbolCard[], memories: any[] }} args
 */
function nextBestActionFor({ params, cards, memories }) {
  if (cards.length === 0 && memories.length === 0) {
    return "symbol.search";
  }
  if (params.taskType === "review") return "review.risk";
  if (cards.length > 0) return "code.skeleton";
  return "memory.query";
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
