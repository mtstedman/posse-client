// @ts-check
import { MODEL_TIERS } from "./model.js";
// Provider turn defaults. Runtime settings and budget calculations remain provider-owned.


export const TIER_ORDER = MODEL_TIERS;

export const OUTPUT_TOKEN_CONFIGS = Object.freeze({
  claude: Object.freeze({
    defaults: Object.freeze({
      researcher: 6000,
      planner: 4000,
      dev: 8000,
      artificer: 8000,
      assessor: 2500,
      preflight: 1500,
    }),
    fallback: 4000,
  }),
  anthropic: Object.freeze({
    defaults: Object.freeze({
      researcher: 6000,
      planner: 4000,
      dev: 8000,
      artificer: 8000,
      assessor: 2500,
      preflight: 1500,
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
    }),
    fallback: 3500,
  }),
});

export const ROLE_ALIASES = Object.freeze({
  research: "researcher",
  plan: "planner",
  developer: "dev",
  fix: "dev",
  promote: "dev",
});

export const TURN_CONFIGS = Object.freeze({
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
      researcher: 10,
      planner: 4,
      preflight: 2,
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
  anthropic: Object.freeze({
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
      assessor: 6,
    }),
    fallback: 12,
  }),
});
