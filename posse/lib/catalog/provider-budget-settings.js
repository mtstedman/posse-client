// @ts-check
import { SETTING_KEYS } from "./setting-keys.js";

export const PROVIDER_USAGE_BUDGET_DEFS = Object.freeze([
  Object.freeze({ provider: "claude", kind: "run", settingKey: SETTING_KEYS.CLAUDE_RUN_BUDGET_PCT_SESSION, unit: "percent_of_session" }),
  Object.freeze({ provider: "codex", kind: "run", settingKey: SETTING_KEYS.CODEX_RUN_BUDGET_PCT_SESSION, unit: "percent_of_session" }),
  Object.freeze({ provider: "openai", kind: "run", settingKey: SETTING_KEYS.OPENAI_RUN_BUDGET_USD, unit: "usd" }),
  Object.freeze({ provider: "openai", kind: "daily", settingKey: SETTING_KEYS.OPENAI_DAILY_BUDGET_USD, unit: "usd" }),
  Object.freeze({ provider: "openai", kind: "image", settingKey: SETTING_KEYS.OPENAI_IMAGE_BUDGET_USD, unit: "usd" }),
  Object.freeze({ provider: "grok", kind: "run", settingKey: SETTING_KEYS.GROK_RUN_BUDGET_USD, unit: "usd" }),
  Object.freeze({ provider: "grok", kind: "daily", settingKey: SETTING_KEYS.GROK_DAILY_BUDGET_USD, unit: "usd" }),
  Object.freeze({ provider: "grok", kind: "image", settingKey: SETTING_KEYS.GROK_IMAGE_BUDGET_USD, unit: "usd" }),
]);
