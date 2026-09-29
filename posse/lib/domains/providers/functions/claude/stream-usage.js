import { stripAnsi } from "../../../../shared/format/functions/ansi.js";
import { estimateCallCost } from "../../../billing/functions/pricing.js";
import { assertTestContext } from "../../../runtime/functions/test-context.js";

// ─── Token Usage Parsing ─────────────────────────────────────────────────────

/**
 * Parse token usage from Claude CLI stderr output.
 * Claude Code prints usage stats to stderr in various formats.
 * Returns { input: number|null, output: number|null }.
 */
export function parseTokenUsage(stderr) {
  const result = { input: null, output: null };
  if (!stderr) return result;

  // Strip ANSI codes for reliable matching
  const clean = stripAnsi(stderr);

  // Pattern: "Input tokens: 12,345" or "input: 12345"
  const inputMatch = clean.match(/input\s*(?:tokens)?[:\s]+([0-9,]+)/i);
  if (inputMatch) result.input = parseInt(inputMatch[1].replace(/,/g, ""), 10);

  // Pattern: "Output tokens: 4,567" or "output: 4567"
  const outputMatch = clean.match(/output\s*(?:tokens)?[:\s]+([0-9,]+)/i);
  if (outputMatch) result.output = parseInt(outputMatch[1].replace(/,/g, ""), 10);

  // Pattern: "Total tokens: 16,912" with "Input: 12,345 / Output: 4,567"
  if (!result.input || !result.output) {
    const slashMatch = clean.match(/input[:\s]+([0-9,]+)\s*[/|]\s*output[:\s]+([0-9,]+)/i);
    if (slashMatch) {
      if (!result.input) result.input = parseInt(slashMatch[1].replace(/,/g, ""), 10);
      if (!result.output) result.output = parseInt(slashMatch[2].replace(/,/g, ""), 10);
    }
  }

  return result;
}

export function _usageNumberOrNull(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

export function _extractStreamUsage(resultData) {
  const candidates = [
    resultData?.usage,
    resultData?.result?.usage,
    resultData?.message?.usage,
    resultData?.final?.usage,
  ];
  for (const usage of candidates) {
    if (!usage || typeof usage !== "object") continue;
    if (
      usage.input_tokens != null
      || usage.output_tokens != null
      || usage.cache_creation_input_tokens != null
      || usage.cache_read_input_tokens != null
    ) {
      return usage;
    }
  }
  return {};
}

export function estimateTokensFromText(text) {
  const length = String(text || "").length;
  if (length <= 0) return null;
  return Math.max(1, Math.ceil(length / 4));
}

const CLAUDE_TOOL_USE_BLOCK_TYPES = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

function _pickFirstString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

export function _normalizeClaudeToolUseBlock(block) {
  if (!block || typeof block !== "object") return null;
  if (!CLAUDE_TOOL_USE_BLOCK_TYPES.has(String(block.type || ""))) return null;
  const toolName = _pickFirstString(
    block.name,
    block.tool_name,
    block.toolName,
    block.mcp_tool_name,
    block.mcpToolName,
  );
  if (!toolName) return null;
  return {
    id: _pickFirstString(block.id, block.tool_use_id, block.toolUseId),
    tool: toolName,
    input: block.input && typeof block.input === "object" ? block.input : null,
  };
}

function _extractClaudeToolUsesFromContent(content) {
  if (!Array.isArray(content)) return [];
  const toolUses = [];
  for (const block of content) {
    const toolUse = _normalizeClaudeToolUseBlock(block);
    if (toolUse) toolUses.push(toolUse);
  }
  return toolUses;
}

export function _extractClaudeToolUsesFromStreamMessage(msg, { providerTurnIndex = null } = {}) {
  if (!msg || typeof msg !== "object") return [];
  const toolUses = [
    _normalizeClaudeToolUseBlock(msg),
    ..._extractClaudeToolUsesFromContent(msg.content),
    ..._extractClaudeToolUsesFromContent(msg.message?.content),
  ].filter(Boolean);
  if (toolUses.length === 0) return [];
  const providerTurnId = _pickFirstString(
    msg.message?.id,
    msg.message_id,
    msg.messageId,
    msg.type === "assistant" ? msg.id : null,
  );
  const normalizedTurnIndex = Number.isFinite(Number(providerTurnIndex))
    && Number(providerTurnIndex) > 0
    ? Math.floor(Number(providerTurnIndex))
    : null;
  return toolUses.map((toolUse, providerBatchIndex) => ({
    ...toolUse,
    ...(providerTurnId ? { providerTurnId } : {}),
    ...(normalizedTurnIndex != null ? { providerTurnIndex: normalizedTurnIndex } : {}),
    providerBatchIndex,
    providerBatchSize: toolUses.length,
  }));
}

export function __testExtractClaudeToolUsesFromStreamMessage(msg) {
  assertTestContext("__testExtractClaudeToolUsesFromStreamMessage");
  return _extractClaudeToolUsesFromStreamMessage(msg);
}

// Sums the raw cache-write TTL split (usage.cache_creation.ephemeral_{5m,1h}
// _input_tokens). Returns null when no usage carries it, so pricing applies its
// Claude default rather than reading a missing split as zero.
function claudeCacheCreationSplit(usages = []) {
  let split = null;
  for (const usage of usages) {
    const creation = usage?.cache_creation;
    if (!creation || typeof creation !== "object") continue;
    const writes5m = _usageNumberOrNull(creation.ephemeral_5m_input_tokens);
    const writes1h = _usageNumberOrNull(creation.ephemeral_1h_input_tokens);
    if (writes5m == null && writes1h == null) continue;
    split ??= { cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 };
    split.cacheCreation5mTokens += writes5m ?? 0;
    split.cacheCreation1hTokens += writes1h ?? 0;
  }
  return split;
}

export function _estimateClaudeApiEquivalentCostUsd({ modelName, modelTier, usage = {}, stderrTokens = {}, segments = [] } = {}) {
  const regularInput = Math.max(0, _usageNumberOrNull(usage.input_tokens) ?? stderrTokens.input ?? 0);
  const cacheCreationInput = Math.max(0, _usageNumberOrNull(usage.cache_creation_input_tokens) ?? 0);
  const cacheReadInput = Math.max(0, _usageNumberOrNull(usage.cache_read_input_tokens) ?? 0);
  const output = Math.max(0, _usageNumberOrNull(usage.output_tokens) ?? stderrTokens.output ?? 0);
  // Per-message segments keep the TTL split; the aggregate usage is the fallback.
  const split = claudeCacheCreationSplit((Array.isArray(segments) ? segments : []).map((segment) => segment?.usage))
    ?? claudeCacheCreationSplit([usage]);
  const priced = estimateCallCost({
    provider: "claude",
    modelName,
    modelTier,
    inputTokens: regularInput + cacheCreationInput + cacheReadInput,
    cachedInputTokens: cacheReadInput,
    cacheCreationInputTokens: cacheCreationInput,
    ...split,
    outputTokens: output,
  });
  if (priced.source === "none") return null;
  return Number.isFinite(priced.costUsd) ? priced.costUsd : null;
}
