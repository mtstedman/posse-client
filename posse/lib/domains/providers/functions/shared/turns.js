import { getSetting } from "../../../queue/functions/index.js";

const TIER_ORDER = Object.freeze(["cheap", "standard", "strong"]);

const OUTPUT_TOKEN_CONFIGS = Object.freeze({
  claude: Object.freeze({
    defaults: Object.freeze({
      researcher: 6000,
      planner: 4000,
      dev: 8000,
      artificer: 8000,
      assessor: 2500,
      preflight: 1500,
      delegator: 1500,
    }),
    fallback: 4000,
  }),
  codex: Object.freeze({
    defaults: Object.freeze({
      researcher: 6000,
      planner: 4000,
      dev: 8000,
      artificer: 8000,
      assessor: 2500,
      preflight: 1500,
      delegator: 1500,
    }),
    fallback: 4000,
  }),
  copilot: Object.freeze({
    defaults: Object.freeze({
      researcher: 6000,
      planner: 4000,
      dev: 8000,
      artificer: 8000,
      assessor: 2500,
      preflight: 1500,
      delegator: 1500,
    }),
    fallback: 4000,
  }),
  openai: Object.freeze({
    defaults: Object.freeze({
      researcher: 5000,
      planner: 3500,
      dev: 7000,
      artificer: 7000,
      assessor: 2200,
      preflight: 1200,
      delegator: 1200,
    }),
    fallback: 3500,
  }),
  grok: Object.freeze({
    defaults: Object.freeze({
      researcher: 5000,
      planner: 3500,
      dev: 7000,
      artificer: 7000,
      assessor: 2200,
      preflight: 1200,
      delegator: 1200,
    }),
    fallback: 3500,
  }),
});

const ROLE_ALIASES = Object.freeze({
  research: "researcher",
  plan: "planner",
  developer: "dev",
  fix: "dev",
  promote: "dev",
});

const TURN_CONFIGS = Object.freeze({
  claude: Object.freeze({
    configured: "base",
    requirePositiveConfigured: true,
    dev: Object.freeze({
      defaultBase: { dev: 29, artificer: 29 },
      perLevel: { dev: 5, artificer: 4 },
      strongBonus: 10,
      deepthinkBonus: 8,
      fileScopeBonusCap: 10,
      formula: "centered",
    }),
    defaults: Object.freeze({
      researcher: 30,
      planner: 10,
      preflight: 4,
      delegator: 3,
      assessor: 12,
    }),
    fallback: 20,
  }),
  codex: Object.freeze({
    configured: "override",
    requirePositiveConfigured: true,
    dev: Object.freeze({
      defaultBase: { dev: 10, artificer: 8 },
      perLevel: { dev: 3, artificer: 2 },
      strongBonus: 4,
      deepthinkBonus: 4,
      fileScopeBonusCap: 6,
      formula: "linear",
    }),
    defaults: Object.freeze({
      researcher: 8,
      planner: 2,
      preflight: 2,
      delegator: 2,
      assessor: 6,
    }),
    fallback: 12,
  }),
  openai: Object.freeze({
    configured: "override",
    requirePositiveConfigured: false,
    dev: Object.freeze({
      defaultBase: { dev: 4, artificer: 4 },
      perLevel: { dev: 2, artificer: 2 },
      strongBonus: 5,
      deepthinkBonus: 3,
      fileScopeBonusCap: 4,
      formula: "linear",
    }),
    defaults: Object.freeze({
      researcher: 1,
      planner: 1,
      preflight: 1,
    }),
    fallback: 20,
  }),
  grok: Object.freeze({
    configured: "override",
    requirePositiveConfigured: false,
    dev: Object.freeze({
      defaultBase: { dev: 4, artificer: 4 },
      perLevel: { dev: 2, artificer: 2 },
      strongBonus: 5,
      deepthinkBonus: 3,
      fileScopeBonusCap: 4,
      formula: "linear",
    }),
    defaults: Object.freeze({
      researcher: 1,
      planner: 1,
      preflight: 1,
    }),
    fallback: 20,
  }),
  // Copilot CLI uses the same agent core as the Copilot cloud agent —
  // tool-heavy, autonomous loops similar in shape to codex. Mirror
  // codex's turn budgets until we have empirical data from Phase 0/2
  // to calibrate against.
  copilot: Object.freeze({
    configured: "override",
    requirePositiveConfigured: true,
    dev: Object.freeze({
      defaultBase: { dev: 10, artificer: 8 },
      perLevel: { dev: 3, artificer: 2 },
      strongBonus: 4,
      deepthinkBonus: 4,
      fileScopeBonusCap: 6,
      formula: "linear",
    }),
    defaults: Object.freeze({
      researcher: 8,
      planner: 2,
      preflight: 2,
      delegator: 2,
      assessor: 6,
    }),
    fallback: 12,
  }),
});

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
  if ((providerName === "openai" || providerName === "grok") && role === "assessor") {
    return modelTier === "cheap" ? 4 : 6;
  }
  return Math.max(1, base);
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
  const baseTarget = attemptCount === 2
    ? Math.min(index + 1, TIER_ORDER.length - 1)
    : TIER_ORDER.length - 1;
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
  for (let i = baseTarget; i < TIER_ORDER.length; i++) {
    let candidateModel;
    try {
      candidateModel = resolveModel(TIER_ORDER[i]);
    } catch {
      continue;
    }
    const candidateKey = candidateModel ?? "";
    if (candidateKey !== currentKey) return TIER_ORDER[i];
  }
  return TIER_ORDER[TIER_ORDER.length - 1];
}
