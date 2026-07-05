// lib/domains/providers/functions/copilot/index.js
//
// GitHub Copilot CLI provider for the posse orchestrator.
//
// PHASE 1 (this file): SKELETON ONLY.
//   - Registers the provider in the catalog/registry surface.
//   - Implements credentials/readiness checks so `posse status` / settings
//     surfaces show the right state ("binary missing", "no token", etc.).
//   - callProvider() throws "not_implemented" until Phase 2 lands.
//
// PHASE 2 (next): implement the spawn/JSONL pipeline modeled on
//   `lib/domains/providers/functions/codex/index.js`. The shape mirrors `codex exec` —
//   spawn `copilot -p <prompt> --output-format json --model <tier>` and
//   consume the JSONL stream line-by-line.
//
// PHASE 3: ATLAS v2 MCP attachment via `--additional-mcp-config <path>`.
//
// Auth model: dual — OAuth state managed by the copilot CLI itself, or
// a fine-grained PAT in the environment. Resolution order:
//   1. OAuth — `~/.copilot/config.json` lists at least one logged-in
//      user. The CLI handles token refresh and request signing on its
//      own; posse just spawns and lets it talk to GitHub.
//   2. PAT — `GH_TOKEN`, then `GITHUB_TOKEN`. Used as a fallback for CI
//      environments where the operator can't run `copilot login`
//      interactively. Token needs the "Copilot Requests" fine-grained
//      permission.
// Interactive `copilot login` should be done OUT of band, not by Posse.
// We never invoke the device-flow ourselves.
//
// Pricing model: subscription quota (premium requests × per-model
// multiplier), NOT per-token. Cost-tier routing is documented as a
// Phase 5 follow-up; until then, expect the rate-limiter to trip when
// the daily/monthly quota is exhausted and the delegator to fall
// through to the next provider in the provider_<role> account setting.

import { spawn } from "child_process";
import { buildRuntimeEnv } from "../../../runtime/functions/paths.js";
import { appendBoundedText } from "../../../../shared/format/functions/bounded-text.js";
import { providerRuntimeState } from "../../classes/runtime-state-singleton.js";
import { selectExecutionModel } from "../shared/model-selection.js";
import { getMaxOutputTokensForProvider } from "../shared/turns.js";
import { normalizeMaxOutputTokens } from "../shared/output-limits.js";
import { MODEL_TIERS, escalateTier, getModelOverride, getModelTierConfig } from "./model-config.js";
import { getCopilotInfo } from "./cli-discovery.js";
import { getAuthMethod, hasCredentials, resolveCopilotAuth } from "./auth-state.js";
import { buildCopilotArgs, buildCopilotChildEnv, buildCopilotSpawn } from "./launch.js";
import { classifyCopilotFailure, parseCopilotErrorBackoff } from "./failure-classification.js";
import { buildCopilotCloseStats, resolveCopilotStallTimeoutMs } from "./close-stats.js";
import { terminateSpawnedProcess, trackSpawnedProcess } from "../shared/windows-spawn.js";
import {
  consumeCopilotLine,
  createAccumulator,
  finalOutput as copilotFinalOutput,
} from "./events.js";

export const capabilities = Object.freeze({ images: false, sessionResume: false, toolAttachment: "mcp" });

const LINE_BUF_MAX = 16 * 1024 * 1024;

export { MODEL_TIERS, escalateTier, getAuthMethod, getCopilotInfo, getModelTierConfig, hasCredentials };

export function isReady() {
  const info = getCopilotInfo();
  if (!info.cmd) return { ready: false, reason: info.error || "Copilot CLI not found on PATH" };
  const auth = resolveCopilotAuth();
  if (!auth) {
    return {
      ready: false,
      reason: "Copilot CLI is installed but no credential is set. Run `copilot login` interactively (preferred), or export GH_TOKEN/GITHUB_TOKEN with the \"Copilot Requests\" fine-grained permission.",
    };
  }
  return { ready: true, reason: null };
}
export function getRateLimitState() {
  return providerRuntimeState.getRateLimitState("copilot");
}

export function tripRateLimit(backoffSec = 60, reason = "") {
  providerRuntimeState.tripRateLimit("copilot", backoffSec, reason || "Copilot rate limited");
}

export function parseErrorBackoff(err) {
  return parseCopilotErrorBackoff(err);
}

function requestCopilotChildTermination(proc, { platform = process.platform, scheduleForceKill = null } = {}) {
  terminateSpawnedProcess(proc, { force: false, platform });
  if (typeof scheduleForceKill === "function") scheduleForceKill();
}

// ---------------------------------------------------------------------------
// callProvider
// ---------------------------------------------------------------------------
//
// Spawn the Copilot CLI in non-interactive mode, stream JSONL events
// through the adapter, and resolve with `{ output, stats }` mirroring
// the codex contract.
//
// PHASE 2 SCOPE: spawn + JSONL pipeline + error classification. NOT
// included yet:
//   - ATLAS v2 MCP attachment (Phase 3)
//   - Scope/policy enforcement on tool surfaces (Phase 4)
//   - Quota-aware cost routing — beyond tripping the rate limit when
//     we see a quota error (Phase 5)
//
// We intentionally accept (and silently ignore) the full Codex opts
// surface so the worker call site doesn't need provider-specific
// branching. Options that have no Copilot equivalent stay no-ops.

/**
 * @param {string} promptText
 * @param {Record<string, any>} [opts]
 * @returns {Promise<{ output: string, stats: ReturnType<typeof buildCopilotCloseStats> }>}
 */
export function callProvider(promptText, opts = {}) {
  const readiness = isReady();
  if (!readiness.ready) {
    return Promise.reject(buildNotReadyError(readiness.reason));
  }

  const {
    role = "planner",
    modelTier = "standard",
    modelName = null,
    reasoningEffort = "medium",
    silent = false,
    onLine = null,
    cwd = null,
    projectDir = null,
    abortSignal = null,
    stallTimeout = null,
    maxOutputTokens = null,
  } = opts || {};

  return new Promise((resolve, reject) => {
    const workingDir = String(cwd || projectDir || process.cwd());
    const tierConfig = getModelTierConfig(modelTier);
    const resolvedModel = selectExecutionModel({
      jobModelName: modelName,
      globalModelOverride: getModelOverride(),
      tierModel: tierConfig.model,
    });
    const outputTokenLimit = normalizeMaxOutputTokens(maxOutputTokens)
      || getMaxOutputTokensForProvider("copilot", { role });

    const argv = buildCopilotArgs({
      prompt: promptText,
      model: resolvedModel,
      reasoningEffort,
      workingDir,
    });

    const env = buildCopilotChildEnv(
      buildRuntimeEnv(projectDir || workingDir, workingDir, process.env),
      resolveCopilotAuth(),
    );
    // COPILOT_ALLOW_ALL is also accepted in lieu of --allow-all-tools;
    // belt-and-braces in case future versions tighten the flag set.
    env.COPILOT_ALLOW_ALL = env.COPILOT_ALLOW_ALL || "1";

    /** @type {ReturnType<typeof spawn> | null} */
    let child;
    try {
      const launch = buildCopilotSpawn(getCopilotInfo().cmd, argv);
      child = spawn(launch.command, launch.args, {
        cwd: workingDir,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
      trackSpawnedProcess(child, launch.command, {
        label: `copilot:${role || "provider"}`,
        cwd: workingDir,
      });
    } catch (spawnErr) {
      const err = new Error(`Failed to spawn copilot: ${spawnErr?.message || spawnErr}`);
      err.code = "COPILOT_SPAWN_FAILED";
      reject(err);
      return;
    }

    if (!child || !child.stdout || !child.stderr) {
      requestCopilotChildTermination(child, {
        scheduleForceKill: () => terminateSpawnedProcess(child, { force: true }),
      });
      reject(new Error("Copilot child process did not start cleanly (no stdio handles)"));
      return;
    }

    const acc = createAccumulator();
    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let killedByStall = false;
    let killedByAbort = false;
    /** @type {NodeJS.Timeout | null} */
    let stallTimer = null;
    const forceKillTimers = new Set();
    const stallTimeoutMs = resolveCopilotStallTimeoutMs(stallTimeout);
    const scheduleForceKill = () => {
      const timer = setTimeout(() => {
        forceKillTimers.delete(timer);
        terminateSpawnedProcess(child, { force: true });
      }, 3000);
      timer.unref?.();
      forceKillTimers.add(timer);
    };
    const clearForceKillTimers = () => {
      for (const timer of forceKillTimers) clearTimeout(timer);
      forceKillTimers.clear();
    };

    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      if (stallTimeoutMs > 0) {
        stallTimer = setTimeout(() => {
          killedByStall = true;
          requestCopilotChildTermination(child, { scheduleForceKill });
        }, stallTimeoutMs);
      }
    };
    resetStallTimer();

    const onAbort = () => {
      killedByAbort = true;
      requestCopilotChildTermination(child, { scheduleForceKill });
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const handleStdoutLine = (rawLine) => {
      resetStallTimer();
      const consumed = consumeCopilotLine(rawLine, acc);
      if (!silent && typeof onLine === "function") {
        try { onLine(rawLine); } catch { /* listener should not break the stream */ }
      }
      return consumed;
    };

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout = appendBoundedText(stdout, chunk);
      stdoutLineBuffer += chunk;
      if (stdoutLineBuffer.length > LINE_BUF_MAX) {
        stdoutLineBuffer = "";
        resetStallTimer();
        return;
      }
      let idx;
      while ((idx = stdoutLineBuffer.indexOf("\n")) >= 0) {
        const line = stdoutLineBuffer.slice(0, idx).replace(/\r$/, "");
        stdoutLineBuffer = stdoutLineBuffer.slice(idx + 1);
        if (line) handleStdoutLine(line);
      }
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => { stderr = appendBoundedText(stderr, chunk); });

    child.on("error", (err) => {
      if (stallTimer) clearTimeout(stallTimer);
      clearForceKillTimers();
      const wrapped = new Error(`Copilot child process error: ${err?.message || err}`);
      wrapped.code = "COPILOT_CHILD_ERROR";
      wrapped.stdout = stdout;
      wrapped.stderr = stderr;
      reject(wrapped);
    });

    child.on("close", (code) => {
      if (stallTimer) clearTimeout(stallTimer);
      clearForceKillTimers();
      if (abortSignal) {
        try { abortSignal.removeEventListener("abort", onAbort); } catch { /* ignore */ }
      }
      // Flush any line left in the buffer.
      if (stdoutLineBuffer.trim()) {
        handleStdoutLine(stdoutLineBuffer.trim());
        stdoutLineBuffer = "";
      }
      const durationMs = Date.now() - startTime;
      const finalText = copilotFinalOutput(acc);
      const stats = buildCopilotCloseStats({
        role,
        modelTier,
        reasoningEffort,
        modelName: resolvedModel,
        acc,
        durationMs,
        finalOutputText: finalText,
        stdout,
        code,
        sessionHandle: acc.sessionId,
        priorSessionHandle: null,
        maxOutputTokens: outputTokenLimit,
        outputTruncated: false,
        outputLimitReason: null,
      });

      if (code === 0 && !killedByStall && !killedByAbort) {
        resolve({ output: finalText || stdout.trim(), stats });
        return;
      }

      if (killedByStall) {
        const err = new Error(`Copilot CLI stalled after ${(durationMs / 1000).toFixed(1)}s and was killed`);
        err.code = "COPILOT_STALLED";
        // The main attempt path keys on `err.stallKill` to route to the
        // penalty-free stall path + stall cap (claude/codex/openai/grok all set
        // it). Without this flag, dev/planner/researcher stalls take a full
        // attempt penalty instead. (B15)
        err.stallKill = true;
        err.stats = stats;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      if (killedByAbort) {
        const err = new Error("Copilot CLI run was aborted by the caller");
        err.code = "COPILOT_ABORTED";
        err.stats = stats;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }

      const classified = classifyCopilotFailure({ stdout, stderr, exit: code, acc });
      if (classified.tripRateLimit) {
        tripRateLimit(classified.tripRateLimit.backoffSec, classified.tripRateLimit.reason);
      }
      const err = new Error(classified.message);
      err.code = classified.code;
      err.exitCode = code;
      err.stats = stats;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

function buildNotReadyError(reason) {
  const err = new Error(`Copilot provider is not ready: ${reason}`);
  err.code = "COPILOT_NOT_READY";
  return err;
}

// Exposed for tests.
export const __testClassifyCopilotFailure = classifyCopilotFailure;
export const __testBuildCopilotArgs = buildCopilotArgs;
export const __testBuildCopilotCloseStats = buildCopilotCloseStats;
export const __testBuildCopilotChildEnv = buildCopilotChildEnv;
export const __testBuildCopilotSpawn = buildCopilotSpawn;
export const __testResolveCopilotStallTimeoutMs = resolveCopilotStallTimeoutMs;
export const __testRequestCopilotChildTermination = requestCopilotChildTermination;
