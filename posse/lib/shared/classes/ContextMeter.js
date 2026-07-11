import {
  CONTEXT_CHARS_PER_TOKEN_ESTIMATE,
  CONTEXT_PRESSURE_THRESHOLDS,
} from "../../catalog/context.js";

const MAX_RETAINED_METERS = 512;

function positiveNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function estimateTokensFromChars(chars) {
  return Math.ceil(positiveNumber(chars, 0) / CONTEXT_CHARS_PER_TOKEN_ESTIMATE);
}

function meterKeyFromContext(context = {}) {
  const agentCallId = context.agent_call_id ?? context.agentCallId;
  if (agentCallId != null) return `agent_call:${agentCallId}`;
  const attemptId = context.attempt_id ?? context.attemptId;
  if (attemptId != null) return `attempt:${attemptId}`;
  const jobId = context.job_id ?? context.jobId;
  if (jobId != null) return `job:${jobId}`;
  const workItemId = context.work_item_id ?? context.workItemId;
  if (workItemId != null) return `work_item:${workItemId}`;
  return null;
}

export class ContextMeter {
  static #meters = new Map();

  static forContext(context = {}, opts = {}) {
    const key = opts.key || meterKeyFromContext(context);
    if (!key) return null;
    let meter = this.#meters.get(key);
    if (!meter) {
      while (this.#meters.size >= MAX_RETAINED_METERS) {
        const oldestKey = this.#meters.keys().next().value;
        if (oldestKey == null) break;
        this.#meters.delete(oldestKey);
      }
      meter = new ContextMeter({ key, ...opts });
      this.#meters.set(key, meter);
    } else if (opts.promptChars != null) {
      meter.setPromptChars(opts.promptChars);
    }
    return meter;
  }

  static resetForTests() {
    this.#meters.clear();
  }

  static release(contextOrKey = {}) {
    const key = typeof contextOrKey === "string"
      ? contextOrKey
      : meterKeyFromContext(contextOrKey);
    if (!key) return false;
    return this.#meters.delete(key);
  }

  constructor({
    key = null,
    promptChars = 0,
    avgOutputTokensPerTurn = CONTEXT_PRESSURE_THRESHOLDS.avgOutputTokensPerTurn,
    thresholds = CONTEXT_PRESSURE_THRESHOLDS,
  } = {}) {
    this.key = key;
    this.promptChars = positiveNumber(promptChars, 0);
    this.avgOutputTokensPerTurn = positiveNumber(
      avgOutputTokensPerTurn,
      CONTEXT_PRESSURE_THRESHOLDS.avgOutputTokensPerTurn,
    );
    this.thresholds = thresholds || CONTEXT_PRESSURE_THRESHOLDS;
    this.emittedChars = 0;
    this.fullToolResultChars = 0;
    this.trimmedBeforeIngressChars = 0;
    this.toolResults = 0;
    this.lastPressureBand = "normal";
    this.lastReportedTurn = 0;
  }

  setPromptChars(chars) {
    this.promptChars = positiveNumber(chars, this.promptChars);
  }

  recordToolResult({
    fullSizeChars = 0,
    emittedSizeChars = null,
    bounded = false,
  } = {}) {
    const full = positiveNumber(fullSizeChars, 0);
    const emitted = emittedSizeChars == null ? full : positiveNumber(emittedSizeChars, 0);
    this.toolResults += 1;
    this.fullToolResultChars += full;
    this.emittedChars += emitted;
    if (bounded) {
      this.trimmedBeforeIngressChars += Math.max(0, full - emitted);
    }
    return this.snapshot();
  }

  snapshot() {
    const emittedTokens = estimateTokensFromChars(this.emittedChars);
    const promptTokens = estimateTokensFromChars(this.promptChars);
    const estimateTokens = promptTokens + emittedTokens + (this.toolResults * this.avgOutputTokensPerTurn);
    const band = estimateTokens >= this.thresholds.resetTokens
      ? "reset"
      : estimateTokens >= this.thresholds.hardTokens
        ? "hard"
        : estimateTokens >= this.thresholds.softTokens
          ? "soft"
          : "normal";
    return {
      key: this.key,
      prompt_chars: this.promptChars,
      prompt_tokens_est: promptTokens,
      emitted_chars: this.emittedChars,
      emitted_tokens_est: emittedTokens,
      full_tool_result_chars: this.fullToolResultChars,
      trimmed_before_ingress_chars: this.trimmedBeforeIngressChars,
      tool_results: this.toolResults,
      turns: this.toolResults,
      avg_output_tokens_per_turn: this.avgOutputTokensPerTurn,
      estimate_tokens: estimateTokens,
      pressure_band: band,
    };
  }

  shouldReport(snapshot = this.snapshot()) {
    if (snapshot.pressure_band !== this.lastPressureBand) {
      this.lastPressureBand = snapshot.pressure_band;
      this.lastReportedTurn = snapshot.tool_results;
      return snapshot.pressure_band !== "normal";
    }
    if (snapshot.tool_results - this.lastReportedTurn >= 25) {
      this.lastReportedTurn = snapshot.tool_results;
      return true;
    }
    return false;
  }
}

export const __testContextMeterInternals = Object.freeze({
  MAX_RETAINED_METERS,
  estimateTokensFromChars,
  meterKeyFromContext,
});
