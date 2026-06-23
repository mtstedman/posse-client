// lib/pricing.js
//
// Pricing lookup for cost attribution. Resolution order:
//   1. Exact match in the provider_pricing table on (provider, model_name) —
//      operator overrides; never written by remote data.
//   2. Remote model catalog cache (fetched from posse-remote, exact then
//      family match) so new-model rates land without a client patch.
//   3. Builtin DEFAULT_PRICING (exact then family match).
//   4. Tier default table keyed by (provider, tier).
//   5. Last-resort "unknown" return that renders as $0 but is flagged.
//
// The module never throws; unknown models return an explicit { source: "none" }
// so callers can warn rather than surface NaN.

import { getDb } from "../../../shared/storage/functions/index.js";
import { getRemotePricingMap } from "../../providers/functions/model-catalog-store.js";

// Defaults as of May 2026. Rates in USD per million input/output tokens.
// Operators can override any row via the provider_pricing table (admin CLI).
// These are best-effort — keep them conservative so we don't under-report.
const DEFAULT_PRICING = Object.freeze({
  // Anthropic (claude)
  "claude:fable":             { tier: "strong",   input: 10.00, output: 50.00, cachedInput: 1.00 },
  "claude:claude-fable-5":    { tier: "strong",   input: 10.00, output: 50.00, cachedInput: 1.00 },
  "claude:haiku":             { tier: "cheap",    input: 1.00,  output: 5.00,  cachedInput: 0.10 },
  "claude:sonnet":            { tier: "standard", input: 3.00,  output: 15.00, cachedInput: 0.30 },
  "claude:opus":              { tier: "strong",   input: 5.00,  output: 25.00, cachedInput: 0.50 },
  "claude:claude-opus-4-8":   { tier: "strong",   input: 5.00,  output: 25.00, cachedInput: 0.50 },
  "claude:claude-opus-4-7":   { tier: "strong",   input: 5.00,  output: 25.00, cachedInput: 0.50 },
  "claude:claude-opus-4-6":   { tier: "strong",   input: 5.00,  output: 25.00, cachedInput: 0.50 },
  "claude:claude-opus-4-5":   { tier: "strong",   input: 5.00,  output: 25.00, cachedInput: 0.50 },
  "claude:claude-opus-4-1":   { tier: "strong",   input: 15.00, output: 75.00, cachedInput: 1.50 },
  "claude:claude-opus-4":     { tier: "strong",   input: 15.00, output: 75.00, cachedInput: 1.50 },

  // OpenAI
  "openai:gpt-4.1-mini": { tier: "cheap",    input: 0.40, output: 1.60, cachedInput: 0.10 },
  "openai:gpt-4.1":      { tier: "standard", input: 2.00, output: 8.00, cachedInput: 0.50 },
  "openai:gpt-5-mini":   { tier: "cheap",    input: 0.25, output: 2.00, cachedInput: 0.025 },
  "openai:gpt-5":        { tier: "strong",   input: 1.25, output: 10.00, cachedInput: 0.125 },
  "openai:gpt-5-codex":  { tier: "standard", input: 1.25, output: 10.00, cachedInput: 0.125 },
  "openai:gpt-5.3-codex": { tier: "standard", input: 1.75, output: 14.00, cachedInput: 0.175 },
  "openai:gpt-5.4":      { tier: "strong",   input: 2.50, output: 15.00, cachedInput: 0.25 },
  "openai:gpt-5.4-mini": { tier: "cheap",    input: 0.75, output: 4.50, cachedInput: 0.075 },
  "openai:gpt-5.4-pro":  { tier: "strong",   input: 30.00, output: 180.00 },
  "openai:gpt-5.5":      { tier: "strong",   input: 5.00, output: 30.00, cachedInput: 0.50 },
  "openai:gpt-5.5-pro":  { tier: "strong",   input: 30.00, output: 180.00 },

  // Codex CLI (OpenAI-backed)
  "codex:gpt-5.3-codex": { tier: "standard", input: 1.75, output: 14.00, cachedInput: 0.175 },
  "codex:gpt-5.4":       { tier: "strong",   input: 2.50, output: 15.00, cachedInput: 0.25 },
  "codex:gpt-5.4-mini":  { tier: "cheap",    input: 0.75, output: 4.50, cachedInput: 0.075 },
  "codex:gpt-5.5":       { tier: "strong",   input: 5.00, output: 30.00, cachedInput: 0.50 },

  // xAI Grok (approximate; adjust via admin when verified)
  "grok:grok-3-mini":                   { tier: "cheap",    input: 0.30, output: 0.50 },
  "grok:grok-code-fast-1":              { tier: "standard", input: 0.20, output: 1.50 },
  "grok:grok-4":                        { tier: "strong",   input: 1.25, output: 2.50 },
  "grok:grok-4.3":                      { tier: "strong",   input: 1.25, output: 2.50 },
  "grok:grok-4.20-multi-agent-0309":    { tier: "strong",   input: 1.25, output: 2.50 },
  "grok:grok-4.20-0309-reasoning":      { tier: "strong",   input: 1.25, output: 2.50 },
  "grok:grok-4.20-0309-non-reasoning":  { tier: "strong",   input: 1.25, output: 2.50 },
  "grok:grok-4-1-fast-reasoning":       { tier: "cheap",    input: 0.20, output: 0.50 },
  "grok:grok-4-1-fast-non-reasoning":   { tier: "cheap",    input: 0.20, output: 0.50 },

  // GitHub Copilot CLI models, mirrored to their underlying model-family rates.
  "copilot:sonnet":              { tier: "cheap",    input: 3.00, output: 15.00, cachedInput: 0.30 },
  "copilot:claude-sonnet-4-5":   { tier: "cheap",    input: 3.00, output: 15.00, cachedInput: 0.30 },
  "copilot:claude-sonnet-4.5":   { tier: "cheap",    input: 3.00, output: 15.00, cachedInput: 0.30 },
  "copilot:gpt-5.4":             { tier: "standard", input: 2.50, output: 15.00, cachedInput: 0.25 },
});

// Per-tier fallback when model_name isn't recognized at all. Uses the
// standard-tier rate of each provider family as a conservative midpoint.
const TIER_DEFAULTS = Object.freeze({
  "claude:cheap":     { input: 1.00,  output: 5.00,  cachedInput: 0.10 },
  "claude:standard":  { input: 3.00,  output: 15.00, cachedInput: 0.30 },
  "claude:strong":    { input: 5.00,  output: 25.00, cachedInput: 0.50 },
  "openai:cheap":     { input: 0.40,  output: 1.60, cachedInput: 0.10 },
  "openai:standard":  { input: 2.00,  output: 8.00, cachedInput: 0.50 },
  "openai:strong":    { input: 2.50,  output: 15.00, cachedInput: 0.25 },
  "codex:cheap":      { input: 1.75,  output: 14.00, cachedInput: 0.175 },
  "codex:standard":   { input: 2.50,  output: 15.00, cachedInput: 0.25 },
  "codex:strong":     { input: 2.50,  output: 15.00, cachedInput: 0.25 },
  "grok:cheap":       { input: 0.30,  output: 0.50 },
  "grok:standard":    { input: 0.20,  output: 1.50 },
  "grok:strong":      { input: 1.25,  output: 2.50 },
  "copilot:cheap":    { input: 3.00,  output: 15.00, cachedInput: 0.30 },
  "copilot:standard": { input: 2.50,  output: 15.00, cachedInput: 0.25 },
  "copilot:strong":   { input: 2.50,  output: 15.00, cachedInput: 0.25 },
});

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase() || null;
}

function normalizeModel(value) {
  return String(value || "").trim().toLowerCase() || null;
}

function normalizeTier(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "cheap" || raw === "standard" || raw === "strong" ? raw : null;
}

function normalizeRequiredRate(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

let _cachedDbRows = null;
let _cachedDbSig = null;

function dbRows() {
  try {
    const db = getDb();
    // Invalidate if the table was edited since last read.
    const sig = db.prepare(`SELECT MAX(updated_at) AS mx, COUNT(*) AS cnt FROM provider_pricing`).get();
    const sigKey = `${sig?.mx || ""}|${sig?.cnt || 0}`;
    if (_cachedDbRows && _cachedDbSig === sigKey) return _cachedDbRows;
    const rows = db.prepare(`SELECT provider, model_name, model_tier, input_per_million_usd, cached_input_per_million_usd, output_per_million_usd FROM provider_pricing`).all();
    _cachedDbRows = rows.map((row) => {
      const inputPerM = normalizeRequiredRate(row.input_per_million_usd);
      const outputPerM = normalizeRequiredRate(row.output_per_million_usd);
      if (inputPerM == null || outputPerM == null) return null;
      // NULL cached rate means the operator didn't specify one; fall back to
      // the uncached input rate (conservative — never under-reports).
      const cachedInputPerM = normalizeRequiredRate(row.cached_input_per_million_usd) ?? inputPerM;
      return {
        provider: normalizeProvider(row.provider),
        modelName: normalizeModel(row.model_name),
        modelTier: normalizeTier(row.model_tier),
        inputPerM,
        cachedInputPerM,
        outputPerM,
      };
    }).filter(Boolean);
    _cachedDbSig = sigKey;
    return _cachedDbRows;
  } catch {
    return [];
  }
}

/**
 * Reset the in-memory cache. Call after bulk DB edits in the same process
 * so subsequent lookups see fresh rows. Tests also use this.
 */
export function invalidatePricingCache() {
  _cachedDbRows = null;
  _cachedDbSig = null;
}

/**
 * Build a canonical short form of a model name so "claude-sonnet-4-5-20250929",
 * "sonnet", and "sonnet-4-5" all map to the same family bucket.
 */
function familyCandidates(modelName) {
  const m = normalizeModel(modelName);
  if (!m) return [];
  const candidates = new Set([m]);
  const annotated = m.replace(/\[[^\]]+\]$/, "");
  if (annotated !== m) candidates.add(annotated);
  // Strip trailing date suffix: -20250929 etc.
  const noDate = annotated.replace(/-\d{8}$/, "");
  if (noDate !== annotated) candidates.add(noDate);
  // Progressive prefix trims on hyphens: try "claude-sonnet-4-5", "claude-sonnet-4", ...
  const parts = noDate.split("-");
  while (parts.length > 1) {
    parts.pop();
    candidates.add(parts.join("-"));
  }
  // Also try just the last bare tier-word (sonnet/haiku/opus/mini).
  const lastTierWord = m.match(/(?:^|-)(haiku|sonnet|opus|mini)(?:-|$)/);
  if (lastTierWord) candidates.add(lastTierWord[1]);
  return [...candidates];
}

function findInRows(rows, provider, modelName) {
  const prov = normalizeProvider(provider);
  const model = normalizeModel(modelName);
  if (!prov || !model) return null;
  for (const row of rows) {
    if (row.provider === prov && row.modelName === model) return row;
  }
  // Family fallback against DB rows: cover cases where the operator added a
  // generic entry ("sonnet") for a family of versioned model names.
  for (const cand of familyCandidates(model)) {
    for (const row of rows) {
      if (row.provider === prov && row.modelName === cand) return row;
    }
  }
  return null;
}

function findInRemoteCatalog(provider, modelName) {
  let map = null;
  try {
    map = getRemotePricingMap();
  } catch {
    return null;
  }
  if (!map || map.size === 0) return null;
  const prov = normalizeProvider(provider);
  const model = normalizeModel(modelName);
  if (!prov || !model) return null;
  const exactKey = `${prov}:${model}`;
  const exact = map.get(exactKey);
  if (exact) return { ...exact, key: exactKey };
  for (const cand of familyCandidates(model)) {
    const key = `${prov}:${cand}`;
    const hit = map.get(key);
    if (hit) return { ...hit, key };
  }
  return null;
}

function findInDefaults(provider, modelName) {
  const prov = normalizeProvider(provider);
  const model = normalizeModel(modelName);
  if (!prov || !model) return null;
  const exactKey = `${prov}:${model}`;
  if (DEFAULT_PRICING[exactKey]) return { ...DEFAULT_PRICING[exactKey], key: exactKey };
  for (const cand of familyCandidates(model)) {
    const key = `${prov}:${cand}`;
    if (DEFAULT_PRICING[key]) return { ...DEFAULT_PRICING[key], key };
  }
  return null;
}

function findTierDefault(provider, tier) {
  const prov = normalizeProvider(provider);
  const t = normalizeTier(tier);
  if (!prov || !t) return null;
  const key = `${prov}:${t}`;
  return TIER_DEFAULTS[key] ? { ...TIER_DEFAULTS[key], key } : null;
}

function usesOpenAiLongContextPremium(provider, modelName, inputTokens) {
  const prov = normalizeProvider(provider);
  if (prov !== "openai" && prov !== "codex") return false;
  const model = normalizeModel(modelName)?.replace(/\[[^\]]+\]$/, "") || "";
  if (!/^gpt-5\.(4|5)(?:-|$)/.test(model)) return false;
  if (/^gpt-5\.(4|5)-(mini|nano)(?:-|$)/.test(model)) return false;
  const input = Math.max(0, Number(inputTokens) || 0);
  return input > 272_000;
}

function applyUsageRateAdjustments(rates, { provider, modelName, inputTokens } = {}) {
  if (!usesOpenAiLongContextPremium(provider, modelName, inputTokens)) return rates;
  return {
    ...rates,
    inputPerM: rates.inputPerM * 2,
    cachedInputPerM: rates.cachedInputPerM * 2,
    outputPerM: rates.outputPerM * 1.5,
    source: `${rates.source}:long_context`,
  };
}

/**
 * Resolve the per-million USD rate for a given call.
 * @returns {{inputPerM: number, outputPerM: number, source: string} |
 *           {inputPerM: 0, outputPerM: 0, source: "none"}}
 */
export function resolvePricing({ provider, modelName, modelTier } = {}) {
  const dbHit = findInRows(dbRows(), provider, modelName);
  if (dbHit) {
    return { inputPerM: dbHit.inputPerM, cachedInputPerM: dbHit.cachedInputPerM, outputPerM: dbHit.outputPerM, source: "db" };
  }
  const remoteHit = findInRemoteCatalog(provider, modelName);
  if (remoteHit) {
    return {
      inputPerM: remoteHit.input,
      // Null cached rate means the catalog didn't curate one; fall back to the
      // uncached input rate (conservative — never under-reports).
      cachedInputPerM: remoteHit.cachedInput != null && Number.isFinite(Number(remoteHit.cachedInput))
        ? Number(remoteHit.cachedInput)
        : remoteHit.input,
      outputPerM: remoteHit.output,
      source: `remote:${remoteHit.key}`,
    };
  }
  const defHit = findInDefaults(provider, modelName);
  if (defHit) {
    return { inputPerM: defHit.input, cachedInputPerM: Number.isFinite(Number(defHit.cachedInput)) ? Number(defHit.cachedInput) : defHit.input, outputPerM: defHit.output, source: `default:${defHit.key}` };
  }
  const tierHit = findTierDefault(provider, modelTier);
  if (tierHit) {
    return { inputPerM: tierHit.input, cachedInputPerM: Number.isFinite(Number(tierHit.cachedInput)) ? Number(tierHit.cachedInput) : tierHit.input, outputPerM: tierHit.output, source: `tier:${tierHit.key}` };
  }
  return { inputPerM: 0, cachedInputPerM: 0, outputPerM: 0, source: "none" };
}

/**
 * Estimate USD cost for a single call given token counts. If the call row
 * already carries cost_estimate_usd and it's non-negative, we prefer that value
 * (the provider may have reported a more authoritative figure at call time).
 */
export function estimateCallCost({ provider, modelName, modelTier, inputTokens = 0, outputTokens = 0, cachedInputTokens = 0, knownCostUsd = null, longContextInputTokens = null } = {}) {
  if (knownCostUsd != null && Number.isFinite(Number(knownCostUsd)) && Number(knownCostUsd) >= 0) {
    return { costUsd: Number(knownCostUsd), source: "known" };
  }
  const input = Math.max(0, Number(inputTokens) || 0);
  const rateInput = longContextInputTokens == null
    ? input
    : Math.max(0, Number(longContextInputTokens) || 0);
  const cachedInput = Math.min(input, Math.max(0, Number(cachedInputTokens) || 0));
  const uncachedInput = Math.max(0, input - cachedInput);
  const output = Math.max(0, Number(outputTokens) || 0);
  const rates = applyUsageRateAdjustments(
    resolvePricing({ provider, modelName, modelTier }),
    { provider, modelName, inputTokens: rateInput }
  );
  const cost = (
    (uncachedInput * rates.inputPerM)
    + (cachedInput * rates.cachedInputPerM)
    + (output * rates.outputPerM)
  ) / 1_000_000;
  return { costUsd: cost, source: rates.source };
}

/**
 * Read-only accessor for tests and admin UIs.
 */
export function listDefaultPricing() {
  return Object.entries(DEFAULT_PRICING).map(([key, entry]) => {
    const [provider, modelName] = key.split(":");
    return {
      provider,
      modelName,
      modelTier: entry.tier,
      inputPerM: entry.input,
      cachedInputPerM: Number.isFinite(Number(entry.cachedInput)) ? Number(entry.cachedInput) : entry.input,
      outputPerM: entry.output,
    };
  });
}

/**
 * Upsert a pricing row (DB overrides default). Returns the stored row.
 */
export function setPricing({ provider, modelName, modelTier = null, inputPerM, outputPerM, cachedInputPerM = null, note = null } = {}) {
  const prov = normalizeProvider(provider);
  const model = normalizeModel(modelName);
  const tier = normalizeTier(modelTier);
  if (!prov || !model) throw new Error("provider and modelName are required");
  const input = Number(inputPerM);
  const output = Number(outputPerM);
  if (!Number.isFinite(input) || input < 0) throw new Error("inputPerM must be a non-negative number");
  if (!Number.isFinite(output) || output < 0) throw new Error("outputPerM must be a non-negative number");
  let cachedInput = null;
  if (cachedInputPerM != null) {
    cachedInput = Number(cachedInputPerM);
    if (!Number.isFinite(cachedInput) || cachedInput < 0) throw new Error("cachedInputPerM must be a non-negative number");
  }
  const db = getDb();
  db.prepare(`
    INSERT INTO provider_pricing (provider, model_name, model_tier, input_per_million_usd, cached_input_per_million_usd, output_per_million_usd, note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT (provider, model_name) DO UPDATE SET
      model_tier = excluded.model_tier,
      input_per_million_usd = excluded.input_per_million_usd,
      cached_input_per_million_usd = excluded.cached_input_per_million_usd,
      output_per_million_usd = excluded.output_per_million_usd,
      note = excluded.note,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(prov, model, tier, input, cachedInput, output, note);
  invalidatePricingCache();
  return { provider: prov, modelName: model, modelTier: tier, inputPerM: input, cachedInputPerM: cachedInput, outputPerM: output, note };
}

export function listPricing() {
  return dbRows().slice();
}
