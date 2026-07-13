import { SETTING_KEYS } from "../../../catalog/settings.js";
import { WORK_ITEM_GOVERNANCE_TIERS } from "../../../catalog/work-item.js";
import { C } from "../../../shared/format/functions/colors.js";
import {
  defaultOutputModeForMode,
  normalizeRequestKindChoice,
} from "../../intake/functions/choices.js";
import { mergeSuspectedDirsWithInputContexts } from "../../intake/functions/input-contexts.js";
import { normalizeIntakeHints } from "../../intake/functions/hints.js";
import { getSetting } from "../../queue/functions/index.js";
import { getCatalogRuntimeFallbackInt } from "../../settings/functions/catalog.js";
import { isValidWiMode } from "../../artifacts/functions/index.js";
import {
  maxResearchBudget,
  normalizeResearchBudget,
  researchBudgetFromDeepthink,
} from "../../../shared/policies/functions/role-utils.js";

export function settingEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

export function parseAutoMerge() {
  if (process.argv.includes("--auto-merge")) return { enabled: true, source: "flag" };
  if (process.argv.includes("--no-auto-merge")) return { enabled: false, source: "flag-off" };
  try {
    if (settingEnabled(getSetting(SETTING_KEYS.AUTO_MERGE_COMPLETED))) return { enabled: true, source: "setting" };
  } catch { /* DB not ready */ }
  return { enabled: false, source: "off" };
}


function parsePositiveInteger(raw) {
  const text = String(raw ?? "").trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Generic positive-integer flag parser. Handles both --flag=value and
 * --flag value forms, rejects non-positive-integer values, treats a
 * following arg that starts with "-" as missing. Throws errorFactory()
 * on malformed input.
 */
export function parsePositiveIntegerFlag(argv, flagName, errorFactory) {
  const eqPrefix = `${flagName}=`;
  const eqArg = argv.find((arg) => String(arg || "").startsWith(eqPrefix));
  if (eqArg) {
    const parsed = parsePositiveInteger(String(eqArg).slice(eqPrefix.length));
    if (parsed == null) throw errorFactory();
    return parsed;
  }
  const idx = argv.indexOf(flagName);
  if (idx !== -1) {
    const value = argv[idx + 1];
    if (value == null || String(value || "").startsWith("-")) throw errorFactory();
    const parsed = parsePositiveInteger(value);
    if (parsed == null) throw errorFactory();
    return parsed;
  }
  return null;
}

function concurrencyFlagError() {
  return new Error("--concurrency requires a positive integer");
}

export function parseConcurrency(argv = process.argv) {
  const fromFlag = parsePositiveIntegerFlag(argv, "--concurrency", concurrencyFlagError);
  if (fromFlag != null) return fromFlag;

  try {
    const db = getSetting(SETTING_KEYS.SCHEDULER_CONCURRENCY);
    if (db) {
      const v = parsePositiveInteger(db);
      if (v != null) return v;
    }
  } catch { /* DB not ready */ }
  return getCatalogRuntimeFallbackInt("scheduler_concurrency", 3);
}

function stallTimeoutFlagError() {
  return new Error("--stall-timeout requires a positive integer number of seconds");
}

export function parseStallTimeout(argv = process.argv) {
  const fromFlag = parsePositiveIntegerFlag(argv, "--stall-timeout", stallTimeoutFlagError);
  if (fromFlag != null) return fromFlag;

  try {
    const db = getSetting(SETTING_KEYS.STALL_TIMEOUT);
    if (db) {
      const v = parsePositiveInteger(db);
      if (v != null) return v;
    }
  } catch { /* DB not ready */ }
  return null; // null = provider helper uses catalog-backed stall_timeout fallback
}

/** Parse --mode flag from argv. */
export function parseModeFlagFromArgv() {
  const idx = process.argv.indexOf("--mode");
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const val = process.argv[idx + 1].toLowerCase();
    return isValidWiMode(val) ? val : null;
  }
  return null;
}

const VALID_TIERS = new Set(WORK_ITEM_GOVERNANCE_TIERS);

export function parseTierFlagFromArgv() {
  const idx = process.argv.indexOf("--tier");
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const val = process.argv[idx + 1].toLowerCase();
    return VALID_TIERS.has(val) ? val : null;
  }
  return null;
}

export function parseDeepthinkFlagFromArgv() {
  return process.argv.includes("--deepthink");
}

export function parseFlagValue(flag) {
  const eqPrefix = `${flag}=`;
  const eqArg = process.argv.find((arg) => String(arg || "").startsWith(eqPrefix));
  if (eqArg) return eqArg.slice(eqPrefix.length);
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const value = process.argv[idx + 1];
    return String(value || "").startsWith("--") ? null : value;
  }
  return null;
}

export function hasArgFlag(flag) {
  const eqPrefix = `${flag}=`;
  return process.argv.some((arg) => arg === flag || String(arg || "").startsWith(eqPrefix));
}

export function parseSessionRecycleFlagFromArgv() {
  if (hasArgFlag("--no-session-recycle")) return "off";
  const eqArg = process.argv.find((arg) => String(arg || "").startsWith("--session-recycle="));
  if (eqArg) {
    const value = eqArg.slice("--session-recycle=".length).trim().toLowerCase();
    if (["1", "true", "yes", "on", "dev-fix"].includes(value)) return "on";
    if (["0", "false", "no", "off"].includes(value)) return "off";
    return null;
  }
  return process.argv.includes("--session-recycle") ? "on" : null;
}

export function parseWorkItemIdsFlagFromArgv(argv = process.argv) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i] || "");
    if (raw === "--work-item" || raw === "--wi") {
      const value = argv[i + 1];
      if (value != null && !String(value).startsWith("-")) {
        values.push(value);
        i += 1;
      }
      continue;
    }
    if (raw.startsWith("--work-item=")) values.push(raw.slice("--work-item=".length));
    if (raw.startsWith("--wi=")) values.push(raw.slice("--wi=".length));
  }
  return [...new Set(values
    .flatMap((value) => String(value || "").split(","))
    .map((value) => Number.parseInt(String(value).trim().replace(/^wi#?/i, ""), 10))
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
}

// Single source of truth for every CLI flag the orchestrator accepts.
// Each descriptor has:
//   name        — the flag literal (with leading dashes; short aliases included)
//   takesValue  — true if the flag consumes the next argv item (or accepts =VALUE)
//   category    — "value"        : a value flag that affects positional parsing
//                                  (skipped when collecting positional args)
//                 "filter-value" : a value flag scoped to query/report subcommands
//                                  (counted as value-taking by unknown-flag detection
//                                  but NOT skipped during positional-arg collection,
//                                  since those subcommands don't use positionals)
//                 "boolean"      : no value (presence implies true)
//
// The three legacy Sets (VALUE_FLAGS, FLAG_VALUE_FLAGS, KNOWN_FLAGS) are now
// derived from this table so adding or renaming a flag requires updating one
// row. A drift test in test-cli-flags.test.js asserts the derivation matches.
export const FLAG_DESCRIPTORS = Object.freeze([
  // Global value flags (affect work-item creation, mode, scope).
  { name: "--mode", takesValue: true, category: "value" },
  { name: "--tier", takesValue: true, category: "value" },
  { name: "--deepthink-budget", takesValue: true, category: "value" },
  { name: "--research-budget", takesValue: true, category: "value" },
  { name: "--intent", takesValue: true, category: "value" },
  { name: "--deliverable", takesValue: true, category: "value" },
  { name: "--output", takesValue: true, category: "value" },
  { name: "--files", takesValue: true, category: "value" },
  { name: "--dirs", takesValue: true, category: "value" },
  { name: "--input-contexts", takesValue: true, category: "value" },
  { name: "--contexts", takesValue: true, category: "value" },
  { name: "--subtasks", takesValue: true, category: "value" },
  { name: "--constraints", takesValue: true, category: "value" },
  { name: "--concurrency", takesValue: true, category: "value" },
  { name: "--stall-timeout", takesValue: true, category: "value" },
  { name: "--work-item", takesValue: true, category: "value" },
  { name: "--wi", takesValue: true, category: "value" },

  // Filter/query value flags (used by reports, audit, status, etc.).
  { name: "--by", takesValue: true, category: "filter-value" },
  { name: "--since", takesValue: true, category: "filter-value" },
  { name: "--limit", takesValue: true, category: "filter-value" },
  { name: "--min-runs", takesValue: true, category: "filter-value" },
  { name: "--max-review-rate", takesValue: true, category: "filter-value" },
  { name: "--first-plan-min", takesValue: true, category: "filter-value" },
  { name: "--feedback", takesValue: true, category: "filter-value" },
  { name: "--job", takesValue: true, category: "filter-value" },
  { name: "-j", takesValue: true, category: "filter-value" },
  { name: "--role", takesValue: true, category: "filter-value" },
  { name: "--branch", takesValue: true, category: "filter-value" },
  { name: "--lang", takesValue: true, category: "filter-value" },
  { name: "-r", takesValue: true, category: "filter-value" },
  { name: "-n", takesValue: true, category: "filter-value" },
  { name: "--around", takesValue: true, category: "filter-value" },
  { name: "--minutes", takesValue: true, category: "filter-value" },
  { name: "--window-minutes", takesValue: true, category: "filter-value" },
  { name: "--confirmation-code", takesValue: true, category: "filter-value" },
  { name: "--pair-code", takesValue: true, category: "filter-value" },

  // Boolean flags.
  { name: "--all", takesValue: false, category: "boolean" },
  { name: "--auto-approve", takesValue: false, category: "boolean" },
  { name: "--auto-approve-plan", takesValue: false, category: "boolean" },
  { name: "--approve-plan", takesValue: false, category: "boolean" },
  { name: "--active", takesValue: false, category: "boolean" },
  { name: "--adopt-node-install", takesValue: false, category: "boolean" },
  { name: "--auto-merge", takesValue: false, category: "boolean" },
  { name: "--cold-index", takesValue: false, category: "boolean" },
  { name: "--deepthink", takesValue: false, category: "boolean" },
  { name: "--dry-run", takesValue: false, category: "boolean" },
  { name: "--exact-prompt", takesValue: false, category: "boolean" },
  { name: "--full", takesValue: false, category: "boolean" },
  { name: "--force", takesValue: false, category: "boolean" },
  { name: "--guided", takesValue: false, category: "boolean" },
  { name: "--help", takesValue: false, category: "boolean" },
  { name: "-h", takesValue: false, category: "boolean" },
  { name: "--iterate", takesValue: false, category: "boolean" },
  { name: "--iterate-red-team", takesValue: false, category: "boolean" },
  { name: "--red-team-iterate", takesValue: false, category: "boolean" },
  { name: "--redteam-iterate", takesValue: false, category: "boolean" },
  { name: "--json", takesValue: false, category: "boolean" },
  { name: "--non-interactive", takesValue: false, category: "boolean" },
  { name: "--no-tui", takesValue: false, category: "boolean" },
  { name: "--no-auto-merge", takesValue: false, category: "boolean" },
  { name: "--pricing", takesValue: false, category: "boolean" },
  { name: "--provider-clis-only", takesValue: false, category: "boolean" },
  { name: "--force-refresh", takesValue: false, category: "boolean" },
  { name: "--recycling", takesValue: false, category: "boolean" },
  { name: "--red-team-plan", takesValue: false, category: "boolean" },
  { name: "--refresh", takesValue: false, category: "boolean" },
  { name: "--replan", takesValue: false, category: "boolean" },
  { name: "--savings", takesValue: false, category: "boolean" },
  { name: "--session", takesValue: false, category: "boolean" },
  { name: "--session-recycle", takesValue: false, category: "boolean" },
  { name: "--show-token", takesValue: false, category: "boolean" },
  { name: "--show-lan-token", takesValue: false, category: "boolean" },
  { name: "--no-session-recycle", takesValue: false, category: "boolean" },
  { name: "--oneshot", takesValue: false, category: "boolean" },
  { name: "--pair", takesValue: false, category: "boolean" },
  { name: "--verbose", takesValue: false, category: "boolean" },
  { name: "-v", takesValue: false, category: "boolean" },
  { name: "--auto", takesValue: false, category: "boolean" },
  { name: "--yes", takesValue: false, category: "boolean" },
  { name: "-y", takesValue: false, category: "boolean" },
]);

const VALUE_FLAGS = new Set(
  FLAG_DESCRIPTORS.filter((d) => d.category === "value").map((d) => d.name),
);
const FLAG_VALUE_FLAGS = new Set(
  FLAG_DESCRIPTORS.filter((d) => d.takesValue).map((d) => d.name),
);
const KNOWN_FLAGS = new Set(FLAG_DESCRIPTORS.map((d) => d.name));

export function unknownArgFlags(argv = process.argv.slice(2)) {
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i] || "");
    if (raw === "--") break;
    if (!raw.startsWith("-") || raw === "-") continue;

    const flag = raw.includes("=") ? raw.slice(0, raw.indexOf("=")) : raw;
    if (!KNOWN_FLAGS.has(flag)) unknown.push(raw);
    if (!raw.includes("=") && FLAG_VALUE_FLAGS.has(flag)) i++;
  }
  return unknown;
}

export function rejectUnknownFlags() {
  const unknown = unknownArgFlags();
  if (unknown.length === 0) return false;
  const label = unknown.length === 1 ? "flag" : "flags";
  console.error(`\n  ${C.red}Unknown ${label}: ${unknown.join(", ")}${C.reset}`);
  console.error(`  ${C.dim}Run with --help for valid flags. Use -- before literal text that starts with a dash.${C.reset}\n`);
  process.exitCode = 1;
  return true;
}

export function getCommandPositionalArgs(argv = process.argv.slice(3)) {
  const args = [];
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || "");
    if (literal) {
      args.push(argv[i]);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    if (!arg) continue;
    args.push(argv[i]);
  }
  return args;
}

export function parseResearchBudgetFromArgv() {
  const explicit = parseFlagValue("--deepthink-budget") || parseFlagValue("--research-budget");
  const deepthinkFlag = parseDeepthinkFlagFromArgv();
  if (explicit != null) {
    const budget = normalizeResearchBudget(explicit);
    if (deepthinkFlag && maxResearchBudget(budget, "high") !== budget) {
      console.warn(`${C.yellow}Warning:${C.reset} --deepthink raises --deepthink-budget=${budget} to high. Use --deepthink-budget=xhigh for the largest budget.`);
    }
    return { budget: deepthinkFlag ? maxResearchBudget(budget, "high") : budget, explicit: true };
  }
  // Compatibility: the legacy boolean --deepthink flag maps to high. Use
  // --deepthink-budget=xhigh when the extra-high turn budget is desired.
  if (deepthinkFlag) {
    return { budget: "high", explicit: true };
  }
  return { budget: "normal", explicit: false };
}

export function resolveResearchBudgetForDeepthink(deepthink, parsed = parseResearchBudgetFromArgv()) {
  if (parsed.explicit) {
    return deepthink ? maxResearchBudget(parsed.budget, "high") : parsed.budget;
  }
  return researchBudgetFromDeepthink(deepthink);
}

export function parseIntakeHintsFromArgv(description, fallbackMode = "build") {
  const inputSelection = parseFlagValue("--input-contexts") || parseFlagValue("--contexts");
  const outputFlag = parseFlagValue("--output");
  const deliverableFlag = parseFlagValue("--deliverable");
  const oneshotFlag = hasArgFlag("--oneshot");
  const rawIntentFlag = parseFlagValue("--intent");
  const intentFlag = oneshotFlag
    ? "oneshot"
    : (
      hasArgFlag("--intent")
        ? (normalizeRequestKindChoice(rawIntentFlag, "") || rawIntentFlag)
        : ""
    );
  const mergedDirs = mergeSuspectedDirsWithInputContexts(
    parseFlagValue("--dirs"),
    inputSelection,
    process.cwd(),
  );
  return normalizeIntakeHints({
    intent_type: intentFlag,
    intent_type_source: (oneshotFlag || hasArgFlag("--intent")) ? "explicit" : "inferred",
    deliverable_type: deliverableFlag,
    deliverable_type_source: hasArgFlag("--deliverable") ? "explicit" : "inferred",
    output_mode: outputFlag || defaultOutputModeForMode(fallbackMode),
    output_mode_source: hasArgFlag("--output") ? "explicit" : "inferred",
    desired_outputs_source: hasArgFlag("--output") ? "explicit" : "inferred",
    suspected_files: parseFlagValue("--files"),
    suspected_dirs: mergedDirs.merged,
    subtasks: parseFlagValue("--subtasks"),
    constraints: parseFlagValue("--constraints"),
  }, { requestText: description, fallbackMode });
}

export function hasIntakeHintFlags() {
  return ["--intent", "--oneshot", "--deliverable", "--output", "--files", "--dirs", "--input-contexts", "--contexts", "--subtasks", "--constraints"]
    .some((flag) => hasArgFlag(flag));
}

