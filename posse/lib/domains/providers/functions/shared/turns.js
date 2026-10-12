import { TIER_ORDER, OUTPUT_TOKEN_CONFIGS, ROLE_ALIASES, TURN_CONFIGS } from "../../../../catalog/provider-turns.js";
import { getSetting } from "../../../queue/functions/index.js";
import { UP_FRONT_TURN_BUDGET_PROVIDERS } from "../../../../catalog/provider.js";





function readConfiguredMaxTurns(role, { requirePositive = true } = {}) {
  try {
    const dbVal = getSetting(`max_turns_${role}`);
    if (!dbVal) return null;
    const value = Number.parseInt(dbVal, 10);
    if (!Number.isNaN(value) && (!requirePositive || value > 0)) return value;
  } catch {
    // DB may not be ready yet.
  }
  return null;
}

function normalizeRole(role) {
  const key = String(role || "").trim().toLowerCase();
  return ROLE_ALIASES[key] || key;
}

function readConfiguredMaxOutputTokens(role) {
  try {
    const dbVal = getSetting(`max_output_tokens_${role}`);
    if (!dbVal) return null;
    const value = Number.parseInt(dbVal, 10);
    if (!Number.isNaN(value) && value > 0) return value;
  } catch {
    // DB may not be ready yet.
  }
  return null;
}

function boundedComplexity(value) {
  return Math.max(1, Math.min(5, value || 3));
}

function fileScopeBonus(role, filesToModifyCount, cap) {
  if (role !== "dev") return 0;
  const fileCount = Number.parseInt(filesToModifyCount, 10);
  return Number.isFinite(fileCount) && fileCount > 0
    ? Math.min(cap, Math.floor(fileCount / 4))
    : 0;
}

function devTurns(config, role, {
  modelTier = "standard",
  complexity = null,
  filesToModifyCount = null,
  deepthink = false,
  configuredBase = null,
} = {}) {
  const c = boundedComplexity(complexity);
  const base = Number.isFinite(configuredBase)
    ? configuredBase
    : config.defaultBase[role];
  const perLevel = config.perLevel[role];
  const tierBonus = modelTier === "strong" ? config.strongBonus : 0;
  const deepthinkBonus = deepthink ? config.deepthinkBonus : 0;
  const scopeBonus = fileScopeBonus(role, filesToModifyCount, config.fileScopeBonusCap);
  const variableTurns = config.formula === "centered"
    ? (c - 3) * perLevel
    : c * perLevel;
  return Math.max(1, base + variableTurns + tierBonus + deepthinkBonus + scopeBonus);
}

export function getMaxTurnsForProvider(providerName, {
  role,
  modelTier = "standard",
  complexity = null,
  filesToModifyCount = null,
  deepthink = false,
} = {}) {
  const config = TURN_CONFIGS[providerName] || TURN_CONFIGS.openai;
  const configured = readConfiguredMaxTurns(role, {
    requirePositive: config.requirePositiveConfigured,
  });
  if (config.configured === "override" && Number.isFinite(configured)) return configured;

  if (role === "dev" || role === "artificer") {
    return devTurns(config.dev, role, {
      modelTier,
      complexity,
      filesToModifyCount,
      deepthink,
      configuredBase: config.configured === "base" ? configured : null,
    });
  }

  const base = Number.isFinite(configured)
    ? configured
    : (config.defaults[role] || config.fallback);
  if (providerName === "claude") {
    if (role === "researcher") return Math.max(1, base + (modelTier === "strong" ? 6 : 0) + (deepthink ? 10 : 0));
    if (role === "planner") return Math.max(1, base + (modelTier === "strong" ? 4 : 0) + (deepthink ? 8 : 0));
    if (role === "assessor") return Math.max(1, base + (modelTier === "cheap" ? -4 : 0));
  }
  if ((providerName === "anthropic" || providerName === "openai" || providerName === "grok") && role === "assessor") {
    return modelTier === "cheap" ? 4 : 6;
  }
  return Math.max(1, base);
}

/**
 * The turn budget an adapter will apply when it builds its call, resolved
 * from the same inputs and defaults the adapters use, or null for providers
 * without an up-front turn budget.
 */
export function resolveUpFrontMaxTurns(providerName, {
  role = "planner",
  modelTier = "standard",
  complexity = null,
  filesToModifyCount = null,
  deepthink = false,
} = {}) {
  if (!UP_FRONT_TURN_BUDGET_PROVIDERS.includes(providerName)) return null;
  return getMaxTurnsForProvider(providerName, { role, modelTier, complexity, filesToModifyCount, deepthink });
}

export function getMaxOutputTokensForProvider(providerName, {
  role,
} = {}) {
  const config = OUTPUT_TOKEN_CONFIGS[providerName] || OUTPUT_TOKEN_CONFIGS.openai;
  const normalizedRole = normalizeRole(role);
  const configured = readConfiguredMaxOutputTokens(normalizedRole);
  if (Number.isFinite(configured)) return configured;
  const base = config.defaults[normalizedRole] || config.fallback;
  return Math.max(1, base);
}

export function escalateModelTier(currentTier, attemptCount, { resolveModel } = {}) {
  if (attemptCount <= 1) return currentTier;
  const index = TIER_ORDER.indexOf(currentTier);
  if (index === -1) return currentTier;
  const standardIndex = TIER_ORDER.indexOf("standard");
  // Preserve a deliberately planned strong tier, but never promote a cheaper
  // job past standard merely because it is retrying.
  if (index >= standardIndex) return currentTier;
  const baseTarget = attemptCount === 2
    ? Math.min(index + 1, standardIndex)
    : standardIndex;
  if (typeof resolveModel !== "function") return TIER_ORDER[baseTarget];

  // Model-aware: when consecutive tiers resolve to the same concrete model
  // (e.g. codex_model_cheap == codex_model_standard in user settings),
  // a name-based escalation is a no-op that the same-error dead-letter guard
  // misreads as "escalation won't help." Walk forward from the name-based
  // target until we find a tier whose resolved model actually differs from
  // currentTier's, falling back to the top tier when none differ.
  let currentModel;
  try {
    currentModel = resolveModel(currentTier);
  } catch {
    return TIER_ORDER[baseTarget];
  }
  const currentKey = currentModel ?? "";
  for (let i = baseTarget; i <= standardIndex; i++) {
    let candidateModel;
    try {
      candidateModel = resolveModel(TIER_ORDER[i]);
    } catch {
      continue;
    }
    const candidateKey = candidateModel ?? "";
    if (candidateKey !== currentKey) return TIER_ORDER[i];
  }
  return "standard";
}
