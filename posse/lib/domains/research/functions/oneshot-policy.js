// lib/domains/research/functions/oneshot-policy.js
//
// Shared deterministic eligibility policy for one-shot dev routing. Every
// surface that can originate a one-shot (explicit --oneshot/#oneshot intake,
// heuristic and low-blast classification, fuzzy tracked-file resolution,
// preflight scope resolution, and createOneshotDevJob as the final defense)
// consults this module so the rules cannot drift between origins.
//
// A one-shot is only eligible when:
//   - the work item mode is build (report/image WIs keep their planner path),
//   - the requested output resolves to repository output (explicit artifact or
//     question-only outputs keep their normal path),
//   - the request text carries no risk signals (security, auth, concurrency,
//     migration, data loss, ambiguity, broad scope, rename, formatting sweep),
//   - exactly one safe, tracked, non-configuration target file is in scope.

import path from "path";

import { isHighRiskPath } from "../../handoff/functions/helpers/file-request.js";

// ── request risk signals ────────────────────────────────────────────────────
// COMPLEX/AMBIGUOUS/BROAD send the request back to research; RENAME/FORMAT are
// trivial-but-unsafe sweeps that return to planning instead.
export const ONESHOT_COMPLEX_SIGNAL_RE = /\b(?:race|concurren\w*|security|auth|authorization|authentication|lock|locking|deadlock|transaction|migration|corruption|data\s+loss|permission|credential|secret|encryption|oauth|session)\b/i;
export const ONESHOT_AMBIGUOUS_SIGNAL_RE = /\b(?:investigate|figure\s+out\s+why|diagnose|debug\s+why|root\s+cause|trace\s+why|why\s+(?:is|does|did)|flaky|intermittent)\b/i;
export const ONESHOT_BROAD_SCOPE_SIGNAL_RE = /\b(?:all|every|each|across|whole|entire)\b/i;
export const ONESHOT_LOW_BLAST_SCOPE_RE = /\b(?:keep|limit(?:ed)?|scop(?:e|ed)|single[-\s]?file|one[-\s]?file|only|do\s+not\s+change|don't\s+change|without\s+changing|no\s+(?:runtime\s+)?behaviou?r|smallest\s+change)\b/i;
export const ONESHOT_RENAME_SIGNAL_RE = /\b(?:rename|renaming)\b/i;
export const ONESHOT_FORMAT_SWEEP_SIGNAL_RE = /\bformatting\b/i;
export const ONESHOT_EXTERNAL_VERIFICATION_SIGNAL_RE = /(?:\b(?:run|execute|verify|check|pass)\b[\s\S]{0,80}\b(?:browser|playwright|cypress|selenium|puppeteer|visual\s+regression|end[-\s]?to[-\s]?end|e2e|lint(?:er|ing)?|eslint)\b|\b(?:browser|playwright|cypress|selenium|puppeteer|visual\s+regression|end[-\s]?to[-\s]?end|e2e|lint(?:er|ing)?|eslint)\b[\s\S]{0,80}\b(?:test|suite|check|verify|pass|run)\b)/i;

const REPO_OUTPUT_MODES = new Set(["", "auto", "repo"]);
const NON_CODE_INTENTS = new Set(["image", "report", "question", "analysis"]);

// ── one-shot-specific risky target paths ────────────────────────────────────
// isHighRiskPath() covers lockfiles, package manifests, docker/CI basics.
// One-shots additionally refuse language manifests, build configuration,
// CI configuration, dependency files, and tool config (`*.config.*`), because
// a machine-derived single-file edit to any of these has outsized blast radius.
const ONESHOT_CONFIG_RISK_BASENAMES = new Set([
  "build.gradle",
  "build.gradle.kts",
  "build.sbt",
  "build.xml",
  "cargo.toml",
  "cmakelists.txt",
  "codemagic.yaml",
  "composer.json",
  "constraints.txt",
  "go.mod",
  "go.sum",
  "gnumakefile",
  "justfile",
  "makefile",
  "meson.build",
  "mix.exs",
  "netlify.toml",
  "package.swift",
  "pom.xml",
  "project.clj",
  "pyproject.toml",
  "rakefile",
  "requirements.txt",
  "rust-toolchain.toml",
  "sconstruct",
  "setup.cfg",
  "setup.py",
  "settings.gradle",
  "settings.gradle.kts",
  ".babelrc",
  ".drone.yml",
  ".tool-versions",
  ".travis.yml",
]);

const ONESHOT_CONFIG_RISK_DIR_PREFIXES = ["ci/", ".buildkite/", ".husky/"];

const ONESHOT_CONFIG_RISK_BASENAME_RES = [
  /^requirements[-.][a-z0-9_.-]*\.txt$/i, // requirements-dev.txt, requirements.prod.txt
  /^[^/]+\.config\.[a-z0-9]+$/i,          // vite.config.ts, jest.config.cjs, next.config.mjs
  /^\.env(?:\.[a-z0-9_.-]+)?$/i,          // .env, .env.production
  /^\.(?:eslintrc|prettierrc|stylelintrc|babelrc)(?:\.[a-z0-9]+)?$/i,
  /^[^/]+\.(?:csproj|sln|vcxproj|gemspec|tf|tfvars|nuspec)$/i,
];

// Directory segments that are too generic to count as evidence that a request
// is really about a specific candidate file.
const GENERIC_PATH_EVIDENCE_TOKENS = new Set([
  "app",
  "apps",
  "asset",
  "assets",
  "class",
  "classes",
  "common",
  "component",
  "components",
  "core",
  "doc",
  "docs",
  "file",
  "files",
  "function",
  "functions",
  "helper",
  "helpers",
  "index",
  "internal",
  "lib",
  "libs",
  "main",
  "module",
  "modules",
  "package",
  "packages",
  "pkg",
  "public",
  "script",
  "scripts",
  "shared",
  "source",
  "sources",
  "spec",
  "specs",
  "src",
  "test",
  "tests",
  "tool",
  "tools",
  "util",
  "utils",
]);

const PATH_MATCH_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "without",
  "from",
  "into",
  "onto",
  "this",
  "that",
  "these",
  "those",
  "fix",
  "fixed",
  "update",
  "updated",
  "change",
  "changed",
  "make",
  "set",
  "remove",
  "delete",
  "add",
  "bump",
  "correct",
  "adjust",
  "polish",
  "copy",
  "edit",
  "copyedit",
  "typo",
  "spelling",
  "comment",
  "comments",
  "doc",
  "docs",
  "documentation",
  "whitespace",
  "only",
  "single",
  "file",
  "one",
  "keep",
]);

export function normalizeCandidatePath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function singularizeToken(token) {
  const value = String(token || "").toLowerCase();
  if (value.length > 4 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 4 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

export function tokenizeForPathMatch(value, { keepStopwords = false } = {}) {
  const expanded = String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  const tokens = expanded
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => keepStopwords || !PATH_MATCH_STOPWORDS.has(token));
  const out = new Set();
  for (const token of tokens) {
    out.add(token);
    out.add(singularizeToken(token));
  }
  return out;
}

export function basenameStem(filePath) {
  const base = path.posix.basename(normalizeCandidatePath(filePath));
  if (!base) return "";
  if (base.startsWith(".") && base.indexOf(".", 1) === -1) return base.slice(1);
  return base.replace(/\.[^.]+$/, "");
}

export function pathTokenSets(filePath) {
  const normalized = normalizeCandidatePath(filePath);
  const stem = basenameStem(normalized);
  const basenameTokens = tokenizeForPathMatch(stem || path.posix.basename(normalized), { keepStopwords: true });
  const fullPathTokens = tokenizeForPathMatch(normalized, { keepStopwords: true });
  return { basenameTokens, fullPathTokens };
}

function intersection(left, right) {
  const out = [];
  for (const value of left) {
    if (right.has(value)) out.push(value);
  }
  return out;
}

function normalizedHintSource(value) {
  return String(value || "").trim().toLowerCase();
}

function oneshotSignalMatches(text) {
  const value = String(text || "");
  const signals = [];
  if (ONESHOT_COMPLEX_SIGNAL_RE.test(value)) signals.push("complex_signal");
  if (ONESHOT_AMBIGUOUS_SIGNAL_RE.test(value)) signals.push("ambiguity_signal");
  if (ONESHOT_BROAD_SCOPE_SIGNAL_RE.test(value) && !ONESHOT_LOW_BLAST_SCOPE_RE.test(value)) {
    signals.push("broad_scope_signal");
  }
  if (ONESHOT_RENAME_SIGNAL_RE.test(value)) signals.push("rename_requested");
  if (ONESHOT_FORMAT_SWEEP_SIGNAL_RE.test(value)) signals.push("formatting_requested");
  if (ONESHOT_EXTERNAL_VERIFICATION_SIGNAL_RE.test(value)) signals.push("external_verification_signal");
  return signals;
}

/**
 * Deterministic request-level eligibility for one-shot routing.
 *
 * Returns { ok } when eligible, otherwise { ok: false, reason, reclassify }
 * where reclassify is "research" for complexity/ambiguity/broad-scope signals
 * (the request deserves the ordinary research path) and "plan" for trivial-
 * but-unsafe requests (wrong mode, non-repo output, rename/formatting sweeps)
 * which should return to planning instead of skipping research entirely.
 */
export function evaluateOneshotRequestEligibility({ text = "", mode = null, intakeHints = null } = {}) {
  const lowerMode = String(mode || "").trim().toLowerCase();
  if (lowerMode && lowerMode !== "build") {
    return { ok: false, reason: `mode_${lowerMode}`, reclassify: "plan" };
  }

  const hints = intakeHints && typeof intakeHints === "object" ? intakeHints : {};
  const outputMode = String(hints.output_mode || "").trim().toLowerCase();
  const outputModeExplicit = normalizedHintSource(hints.output_mode_source) === "explicit"
    || normalizedHintSource(hints.desired_outputs_source) === "explicit";
  if (outputModeExplicit && outputMode && !REPO_OUTPUT_MODES.has(outputMode)) {
    return { ok: false, reason: `output_${outputMode}`, reclassify: "plan" };
  }
  const desiredOutputs = Array.isArray(hints.desired_outputs)
    ? hints.desired_outputs.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
    : [];
  if (outputModeExplicit && desiredOutputs.length > 0 && !desiredOutputs.includes("repo")) {
    return { ok: false, reason: "output_not_repo", reclassify: "plan" };
  }
  const intent = String(hints.intent_type || "").trim().toLowerCase();
  if (normalizedHintSource(hints.intent_type_source) === "explicit" && NON_CODE_INTENTS.has(intent)) {
    return { ok: false, reason: `intent_${intent}`, reclassify: "plan" };
  }

  const signals = oneshotSignalMatches(text);
  if (signals.length > 0) {
    const reclassify = signals.some((signal) => signal.endsWith("_signal")) ? "research" : "plan";
    return { ok: false, reason: signals[0], reclassify, signals };
  }

  return { ok: true, reason: "eligible", reclassify: null };
}

/**
 * Target-path risk for one-shot edits. Returns null when the path is safe,
 * "high_risk_path" for the shared file-request policy, and
 * "oneshot_config_risk_path" for the stricter one-shot-only configuration
 * surface (language manifests, build files, CI config, `*.config.*`, env
 * files, infra definitions).
 */
export function oneshotTargetRisk(filePath) {
  const normalized = normalizeCandidatePath(filePath).toLowerCase();
  if (!normalized) return "high_risk_path";
  if (isHighRiskPath(normalized)) return "high_risk_path";
  const basename = path.posix.basename(normalized);
  if (ONESHOT_CONFIG_RISK_BASENAMES.has(basename)) return "oneshot_config_risk_path";
  if (ONESHOT_CONFIG_RISK_BASENAME_RES.some((re) => re.test(basename))) return "oneshot_config_risk_path";
  if (ONESHOT_CONFIG_RISK_DIR_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "oneshot_config_risk_path";
  }
  return null;
}

export function isOneshotRiskyTargetPath(filePath) {
  return oneshotTargetRisk(filePath) != null;
}

/**
 * Corroboration between a request text and a candidate file. Passes only on
 * an exact (normalized) path mention or on meaningful basename/stem token
 * evidence; directory-only matches such as src, lib, docs, or test never
 * count.
 */
export function oneshotPathCorroboration(requestText, candidatePath) {
  const normalizedPath = normalizeCandidatePath(candidatePath).toLowerCase();
  const normalizedText = String(requestText || "").replace(/\\/g, "/").toLowerCase();
  if (normalizedPath && normalizedText.includes(normalizedPath)) {
    return { ok: true, matched_via: "exact_path", matched_tokens: [normalizedPath] };
  }
  const basename = path.posix.basename(normalizedPath);
  if (basename && normalizedText.includes(basename)) {
    return { ok: true, matched_via: "basename_mention", matched_tokens: [basename] };
  }

  const requestTokens = tokenizeForPathMatch(requestText);
  const { basenameTokens } = pathTokenSets(candidatePath);
  const matched = intersection(requestTokens, basenameTokens)
    .filter((token) => !GENERIC_PATH_EVIDENCE_TOKENS.has(token));
  return {
    ok: matched.length > 0,
    matched_via: matched.length > 0 ? "basename_tokens" : null,
    matched_tokens: matched,
    request_token_count: requestTokens.size,
  };
}
