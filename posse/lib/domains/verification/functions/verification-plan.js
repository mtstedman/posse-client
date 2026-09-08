// Versioned repository verification plans. The repository, not the planner,
// owns executable commands; planner input may only select optional check IDs.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { adminGitExec } from "../../git/functions/admin-git-exec.js";

export const VERIFICATION_PLAN_SCHEMA_VERSION = 1;
export const VERIFICATION_PLAN_CONFIG = "posse.verification.json";

const STAGES = Object.freeze(["fast", "required", "canonical"]);
const INTENTS = new Set(["test", "lint", "typecheck", "contract"]);
const CHECK_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/;

function stableJson(value) {
  if (value === null) return "null";
  if (["string", "number", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return "null";
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function safeRelativeDirectory(value) {
  const raw = String(value || ".").trim().replace(/\\/g, "/");
  if (raw === ".") return ".";
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.includes("\0")) return null;
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._@+-]+$/.test(part))) return null;
  return parts.join("/");
}

function isCommitted(projectDir, relativePath) {
  try {
    // Plan resolution is synchronous and may happen before the native pulse
    // cache is warm. Use the repository's bounded bootstrap Git adapter for
    // this read-only trust check; executable verification remains on the
    // normal native-backed worker path.
    const result = adminGitExec(["ls-files", "--error-unmatch", "--", relativePath], projectDir, {
      timeoutMs: 5_000,
    });
    return String(result || "").trim().replace(/\\/g, "/") === relativePath;
  } catch {
    return false;
  }
}

function packageManager(projectDir) {
  if (fs.existsSync(path.join(projectDir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(projectDir, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(projectDir, "bun.lock")) || fs.existsSync(path.join(projectDir, "bun.lockb"))) return "bun";
  return "npm";
}

function packageScriptCommand(manager, script) {
  if (manager === "yarn" || manager === "bun") return `${manager} ${script}`;
  return `${manager} run ${script}`;
}

function scriptIntent(script) {
  if (/typecheck|types/.test(script)) return "typecheck";
  if (/lint/.test(script)) return "lint";
  if (/check|verify/.test(script) && !/test/.test(script)) return "contract";
  return "test";
}

function scriptStage(script) {
  if (/(?:^|:)(?:fast|quick|unit|changed)$/.test(script)) return "fast";
  if (/^(?:lint|typecheck|check)(?::|$)/.test(script)) return "required";
  return "canonical";
}

function manifestChecks(projectDir) {
  const manifestPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(manifestPath)) return [];
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { return []; }
  const scripts = manifest?.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
  const candidates = Object.keys(scripts).filter((name) => (
    /^(?:test|verify)(?::(?:fast|quick|unit|changed|all))?$/.test(name)
    || /^(?:lint|typecheck|check)(?::changed)?$/.test(name)
  ));
  const manager = packageManager(projectDir);
  return candidates.map((script) => ({
    id: `package:${script}`,
    command: packageScriptCommand(manager, script),
    cwd: ".",
    intent: scriptIntent(script),
    stage: scriptStage(script),
    required: scriptStage(script) !== "fast",
    depends_on: [],
    timeout_policy: "repository",
    evidence: { commit_bound: true, clean_tree_required: true, output_required: true },
  }));
}

function configuredChecks(projectDir) {
  const configPath = path.join(projectDir, VERIFICATION_PLAN_CONFIG);
  if (!fs.existsSync(configPath)) return null;
  if (!isCommitted(projectDir, VERIFICATION_PLAN_CONFIG)) {
    return { error: "verification_plan_config_not_committed", checks: [] };
  }
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {
    return { error: "verification_plan_config_invalid_json", checks: [] };
  }
  if (config?.schema_version !== VERIFICATION_PLAN_SCHEMA_VERSION || !Array.isArray(config?.checks)) {
    return { error: "verification_plan_config_schema_invalid", checks: [] };
  }
  return { error: null, checks: config.checks };
}

function normalizeCheck(raw, index, validateCommand) {
  const id = String(raw?.id || "").trim().toLowerCase();
  const command = String(raw?.command || "").trim();
  const cwd = safeRelativeDirectory(raw?.cwd);
  const intent = String(raw?.intent || "test").trim().toLowerCase();
  const stage = String(raw?.stage || "required").trim().toLowerCase();
  const dependencies = Array.isArray(raw?.depends_on)
    ? [...new Set(raw.depends_on.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))]
    : [];
  if (!CHECK_ID_RE.test(id)) return { error: `verification_check_id_invalid:${index}` };
  if (!command) return { error: `verification_check_command_missing:${id}` };
  if (!cwd) return { error: `verification_check_cwd_invalid:${id}` };
  if (!INTENTS.has(intent)) return { error: `verification_check_intent_invalid:${id}` };
  if (!STAGES.includes(stage)) return { error: `verification_check_stage_invalid:${id}` };
  const displayCommand = cwd === "." ? command : `cd ${cwd} && ${command}`;
  const validation = validateCommand(displayCommand);
  if (!validation?.ok) return { error: `${validation?.reason || "verification_check_command_invalid"}:${id}` };
  return {
    check: {
      id,
      command: displayCommand,
      execution_command: validation.execution_command || command,
      cwd_relative: validation.cwd_relative || (cwd === "." ? null : cwd),
      intent,
      stage,
      required: raw?.required !== false && stage !== "fast",
      depends_on: dependencies,
      timeout_policy: String(raw?.timeout_policy || "repository"),
      evidence: {
        commit_bound: raw?.evidence?.commit_bound !== false,
        clean_tree_required: raw?.evidence?.clean_tree_required !== false,
        output_required: raw?.evidence?.output_required !== false,
      },
    },
  };
}

function orderedChecks(checks) {
  const byId = new Map(checks.map((check) => [check.id, check]));
  for (const check of checks) {
    if (check.depends_on.some((dependency) => !byId.has(dependency))) {
      return { error: `verification_check_dependency_missing:${check.id}` };
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  const visit = (check) => {
    if (visited.has(check.id)) return true;
    if (visiting.has(check.id)) return false;
    visiting.add(check.id);
    for (const dependency of check.depends_on) {
      if (!visit(byId.get(dependency))) return false;
    }
    visiting.delete(check.id);
    visited.add(check.id);
    ordered.push(check);
    return true;
  };
  const staged = [...checks].sort((left, right) => STAGES.indexOf(left.stage) - STAGES.indexOf(right.stage));
  for (const check of staged) {
    if (!visit(check)) return { error: "verification_check_dependency_cycle" };
  }
  return { checks: ordered };
}

export function resolveRepositoryVerificationPlan({
  projectDir,
  selectedCheckIds = [],
  validateCommand,
} = {}) {
  if (!projectDir || typeof validateCommand !== "function") return null;
  const root = path.resolve(projectDir);
  const configured = configuredChecks(root);
  const source = configured ? "repository_config" : "package_manifest";
  if (configured?.error) return {
    schema_version: VERIFICATION_PLAN_SCHEMA_VERSION,
    source,
    status: "invalid_plan",
    reason: configured.error,
    checks: [],
    plan_id: sha256(`${source}\0${configured.error}`),
  };
  const rawChecks = configured?.checks || manifestChecks(root);
  if (rawChecks.length === 0) return null;
  const normalized = [];
  for (const [index, raw] of rawChecks.entries()) {
    const result = normalizeCheck(raw, index, validateCommand);
    if (result.error) return {
      schema_version: VERIFICATION_PLAN_SCHEMA_VERSION,
      source,
      status: "invalid_plan",
      reason: result.error,
      checks: [],
      plan_id: sha256(`${source}\0${result.error}`),
    };
    normalized.push(result.check);
  }
  if (new Set(normalized.map((check) => check.id)).size !== normalized.length) {
    return {
      schema_version: VERIFICATION_PLAN_SCHEMA_VERSION,
      source,
      status: "invalid_plan",
      reason: "verification_check_id_duplicate",
      checks: [],
      plan_id: sha256(`${source}\0verification_check_id_duplicate`),
    };
  }
  const selected = new Set((Array.isArray(selectedCheckIds) ? selectedCheckIds : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean));
  const selectedIds = new Set(normalized
    .filter((check) => check.required || selected.size === 0 || selected.has(check.id))
    .map((check) => check.id));
  const byId = new Map(normalized.map((check) => [check.id, check]));
  const addDependencies = (checkId) => {
    const check = byId.get(checkId);
    if (!check) return;
    for (const dependency of check.depends_on) {
      if (!selectedIds.has(dependency)) {
        selectedIds.add(dependency);
        addDependencies(dependency);
      }
    }
  };
  for (const checkId of [...selectedIds]) addDependencies(checkId);
  const selectedChecks = normalized.filter((check) => selectedIds.has(check.id));
  const ordered = orderedChecks(selectedChecks);
  if (ordered.error) return {
    schema_version: VERIFICATION_PLAN_SCHEMA_VERSION,
    source,
    status: "invalid_plan",
    reason: ordered.error,
    checks: [],
    plan_id: sha256(`${source}\0${ordered.error}`),
  };
  const identity = {
    schema_version: VERIFICATION_PLAN_SCHEMA_VERSION,
    source,
    checks: ordered.checks,
  };
  return {
    ...identity,
    status: "ready",
    plan_id: sha256(stableJson(identity)),
  };
}
