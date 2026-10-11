import { getSetting } from "../../../queue/functions/index.js";
import { getModelTierConfig } from "./index.js";
import { buildNativeDispatchRequest, runNativeDispatch } from "../shared/native-dispatch.js";
import { getMergedTextModels } from "../model-catalog.js";

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
    // Merged catalog (builtin + remote, deprecated excluded) so newly
    // published codex models become probe candidates without a client patch.
    ...(includeKnown ? getMergedTextModels("codex") : []),
  ];
  return uniqueModels(candidates);
}

async function defaultProbe({
  model,
  cwd = process.cwd(),
  prompt = "Reply with exactly OK",
  timeoutMs = 120000,
  authMode = "oauth",
} = {}) {
  const startedAt = Date.now();
  const deadlineMs = Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Codex model validation timed out")), deadlineMs);
  timer.unref?.();
  try {
    const request = buildNativeDispatchRequest("codex", prompt, {
      role: "preflight",
      modelTier: "cheap",
      modelName: model,
      authMode: authMode === "auto" ? null : authMode,
      cwd,
      issuedToolIds: [],
      maxTurns: 1,
      maxOutputTokens: 32,
      stallTimeoutMs: deadlineMs,
      wallTimeoutMs: deadlineMs,
    });
    const result = await runNativeDispatch(request, {
      abortSignal: controller.signal,
      projectDir: cwd,
      silent: true,
    });
    return { ok: true, exitCode: 0, durationMs: Date.now() - startedAt, summary: String(result.output || "").trim() };
  } catch (error) {
    return { ok: false, exitCode: 1, durationMs: Date.now() - startedAt, summary: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function validateCodexModels({
  models = null,
  cwd = process.cwd(),
  prompt = "Reply with exactly OK",
  timeoutMs = 120000,
  authMode = "oauth",
  probe = defaultProbe,
} = {}) {
  const targetModels = uniqueModels(Array.isArray(models) ? models : getCurrentCodexModels({ includeKnown: true }));
  const results = [];
  for (const model of targetModels) {
    const probeResult = await probe({
      model,
      cwd,
      prompt,
      timeoutMs,
      authMode,
    }) || {};
    results.push({
      model,
      ok: probeResult.ok === true,
      exitCode: Number.isInteger(probeResult.exitCode) ? probeResult.exitCode : -1,
      durationMs: Number.isFinite(probeResult.durationMs) ? probeResult.durationMs : null,
      summary: String(probeResult.summary || "").trim(),
    });
  }
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
