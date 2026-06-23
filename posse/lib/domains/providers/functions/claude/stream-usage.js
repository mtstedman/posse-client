import { stripAnsi } from "../../../../shared/format/functions/ansi.js";
import { resolvePricing } from "../../../billing/functions/pricing.js";
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
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
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

export function _extractClaudeToolUsesFromStreamMessage(msg) {
  if (!msg || typeof msg !== "object") return [];
  return [
    _normalizeClaudeToolUseBlock(msg),
    ..._extractClaudeToolUsesFromContent(msg.content),
    ..._extractClaudeToolUsesFromContent(msg.message?.content),
  ].filter(Boolean);
}

export function __testExtractClaudeToolUsesFromStreamMessage(msg) {
  assertTestContext("__testExtractClaudeToolUsesFromStreamMessage");
  return _extractClaudeToolUsesFromStreamMessage(msg);
}

export function _estimateClaudeApiEquivalentCostUsd({ modelName, modelTier, usage = {}, stderrTokens = {} } = {}) {
  const rates = resolvePricing({ provider: "claude", modelName, modelTier });
  if (!rates || rates.source === "none") return null;
  const regularInput = Math.max(0, _usageNumberOrNull(usage.input_tokens) ?? stderrTokens.input ?? 0);
  const cacheCreationInput = Math.max(0, _usageNumberOrNull(usage.cache_creation_input_tokens) ?? 0);
  const cacheReadInput = Math.max(0, _usageNumberOrNull(usage.cache_read_input_tokens) ?? 0);
  const output = Math.max(0, _usageNumberOrNull(usage.output_tokens) ?? stderrTokens.output ?? 0);
  const billableInputUnits = regularInput + (cacheCreationInput * 1.25) + (cacheReadInput * 0.10);
  const cost = ((billableInputUnits * rates.inputPerM) + (output * rates.outputPerM)) / 1_000_000;
  return Number.isFinite(cost) ? cost : null;
}
