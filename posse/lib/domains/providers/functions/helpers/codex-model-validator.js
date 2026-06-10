import { spawnSync } from "child_process";
import { getSetting } from "../../../queue/functions/index.js";
import { getClaudeInfo, getModelTierConfig } from "../codex.js";
import { CODEX_VALIDATION_KNOWN_MODELS } from "../model-catalog.js";

function normalizeModelName(value) {
  const model = String(value || "").trim();
  return model || null;
}

function uniqueModels(values = []) {
  const out = [];
  const seen = new Set();
  for (const entry of values || []) {
    const model = normalizeModelName(entry);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

function safeGetSetting(key) {
  try {
    return getSetting(key);
  } catch {
    return null;
  }
}

function getStoredCodexModelCandidates() {
  return uniqueModels([
    safeGetSetting("codex_model"),
    safeGetSetting("codex_model_cheap"),
    safeGetSetting("codex_model_standard"),
    safeGetSetting("codex_model_strong"),
  ]);
}

export function getCurrentCodexModels({ includeKnown = true } = {}) {
  const tierModels = [
    getModelTierConfig("cheap").model,
    getModelTierConfig("standard").model,
    getModelTierConfig("strong").model,
  ];
  const candidates = [
    ...getStoredCodexModelCandidates(),
    ...tierModels,
    ...(includeKnown ? CODEX_VALIDATION_KNOWN_MODELS : []),
  ];
  return uniqueModels(candidates);
}

function buildValidationEnv(authMode = "oauth", env = process.env) {
  const next = { ...env };
  const normalized = String(authMode || "oauth").trim().toLowerCase();
  if (normalized === "oauth") {
    delete next.CODEX_API_KEY;
    delete next.OPENAI_API_KEY;
  }
  return next;
}

function summarizeOutput(stdout = "", stderr = "") {
  const combined = `${String(stdout || "")}\n${String(stderr || "")}`;
  const lines = combined
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  return lines.slice(-3).join(" | ");
}

function defaultProbe({
  model,
  cwd = process.cwd(),
  prompt = "Reply with exactly OK",
  timeoutMs = 120000,
  authMode = "oauth",
} = {}) {
  const cli = getClaudeInfo();
  const cmd = cli?.cmd || "codex";
  const baseArgs = Array.isArray(cli?.args) ? cli.args : [];
  const args = [
    ...baseArgs,
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-m",
    model,
    prompt,
  ];
  const startedAt = Date.now();
  const result = spawnSync(cmd, args, {
    cwd,
    env: buildValidationEnv(authMode),
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const durationMs = Date.now() - startedAt;
  const exitCode = Number.isInteger(result.status) ? result.status : -1;
  return {
    ok: exitCode === 0,
    exitCode,
    durationMs,
    summary: summarizeOutput(result.stdout, result.stderr),
  };
}

export function validateCodexModels({
  models = null,
  cwd = process.cwd(),
  prompt = "Reply with exactly OK",
  timeoutMs = 120000,
  authMode = "oauth",
  probe = defaultProbe,
} = {}) {
  const targetModels = uniqueModels(Array.isArray(models) ? models : getCurrentCodexModels({ includeKnown: true }));
  const results = targetModels.map((model) => {
    const probeResult = probe({
      model,
      cwd,
      prompt,
      timeoutMs,
      authMode,
    }) || {};
    return {
      model,
      ok: probeResult.ok === true,
      exitCode: Number.isInteger(probeResult.exitCode) ? probeResult.exitCode : -1,
      durationMs: Number.isFinite(probeResult.durationMs) ? probeResult.durationMs : null,
      summary: String(probeResult.summary || "").trim(),
    };
  });
  const passed = results.filter((entry) => entry.ok).map((entry) => entry.model);
  const failed = results.filter((entry) => !entry.ok).map((entry) => entry.model);
  return {
    authMode: String(authMode || "oauth").trim().toLowerCase() || "oauth",
    models: targetModels,
    passed,
    failed,
    results,
  };
}

export function formatCodexModelValidationReport(report) {
  const lines = [];
  lines.push("Codex model validation");
  lines.push(`Auth mode: ${report?.authMode || "oauth"}`);
  lines.push(`Models checked: ${Array.isArray(report?.models) ? report.models.length : 0}`);
  lines.push(`Passed: ${Array.isArray(report?.passed) ? report.passed.length : 0}`);
  lines.push(`Failed: ${Array.isArray(report?.failed) ? report.failed.length : 0}`);
  lines.push("");
  for (const row of report?.results || []) {
    const status = row.ok ? "PASS" : "FAIL";
    const duration = Number.isFinite(row.durationMs) ? `${row.durationMs}ms` : "?";
    lines.push(`[${status}] ${row.model} exit=${row.exitCode} duration=${duration}${row.summary ? ` | ${row.summary}` : ""}`);
  }
  return lines.join("\n");
}

export function __testBuildValidationEnv(authMode = "oauth", env = process.env) {
  return buildValidationEnv(authMode, env);
}
