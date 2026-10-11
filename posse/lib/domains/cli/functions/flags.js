import { FLAG_DESCRIPTORS } from "../../../catalog/cli-flags.js";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { SCOPE_APPROVAL_MODES, SCOPE_APPROVAL_MODE_VALUES } from "../../../catalog/human-input.js";
import { WORK_ITEM_GOVERNANCE_TIERS } from "../../../catalog/work-item.js";
import { C } from "../../../shared/format/functions/colors.js";
import {
  defaultOutputModeForMode,
  normalizeRequestKindChoice,
} from "../../intake/functions/choices.js";
import {
  assertInputContextSelection,
  mergeSuspectedDirsWithInputContexts,
} from "../../intake/functions/input-contexts.js";
import { normalizeIntakeHints } from "../../intake/functions/hints.js";
import { getSetting } from "../../queue/functions/index.js";
import { getCatalogRuntimeFallbackInt } from "../../settings/functions/catalog.js";
import { isValidWiMode } from "../../artifacts/functions/index.js";
import {
  maxResearchBudget,
  normalizeResearchBudget,
  researchBudgetFromDeepthink,
} from "../../../shared/policies/functions/role-utils.js";

export { FLAG_DESCRIPTORS };

export function settingEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

export function parseScopeMode(argv = process.argv) {
  let mode = SCOPE_APPROVAL_MODES.DEFAULT;
  let supplied = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "");
    if (arg === "--") break;
    if (arg !== "--scope-mode" && !arg.startsWith("--scope-mode=")) continue;
    const raw = arg === "--scope-mode" ? argv[++index] : arg.slice("--scope-mode=".length);
    const value = String(raw || "").trim().toLowerCase();
    if (!SCOPE_APPROVAL_MODE_VALUES.includes(value)) {
      throw new Error(`--scope-mode requires ${SCOPE_APPROVAL_MODE_VALUES.join(" or ")}`);
    }
    if (supplied && mode !== value) throw new Error("--scope-mode received conflicting values");
    mode = value;
    supplied = true;
  }
  return mode;
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
    if (raw === "--") break;
    if (raw === "--work-item" || raw === "--wi") {
      const value = argv[i + 1];
      if (value == null || String(value).startsWith("-")) {
        throw new Error(`${raw} requires a positive work-item ID or comma-separated IDs`);
      }
      values.push(value);
      i += 1;
      continue;
    }
    if (raw.startsWith("--work-item=")) values.push(raw.slice("--work-item=".length));
    if (raw.startsWith("--wi=")) values.push(raw.slice("--wi=".length));
  }
  return [...new Set(values
    .flatMap((value) => String(value || "").split(","))
    .map((value) => {
      const token = String(value).trim();
      const id = Number(token.replace(/^wi#?/i, ""));
      if (!/^(?:wi#?)?\d+$/i.test(token) || !Number.isSafeInteger(id) || id <= 0) {
        throw new Error(`--work-item/--wi requires positive work-item IDs; invalid ID: ${JSON.stringify(token)}`);
      }
      return id;
    }))];
}

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
  assertInputContextSelection(mergedDirs, inputSelection);
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
