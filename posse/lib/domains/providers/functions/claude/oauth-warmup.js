// OAuth priming is a tool-free Rust provider turn. Node never launches Claude.
import { getClaudeConfigDir, hasUsableClaudeOauthToken, readClaudeCredentials } from "./auth-state.js";
import { classifyClaudeCliFailure } from "./failure-classification.js";
import { buildNativeDispatchRequest, runNativeDispatch } from "../shared/native-dispatch.js";

let activeWarmup = null;

export async function warmOauthSessionAsync({ cwd = null, timeoutMs = 20_000 } = {}) {
  const credentials = readClaudeCredentials(getClaudeConfigDir());
  if (!hasUsableClaudeOauthToken(credentials)) {
    return { attempted: false, ok: false, skipped: "oauth-unconfigured" };
  }
  if (activeWarmup) return activeWarmup;
  const resolvedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Claude OAuth warmup timed out")), resolvedTimeoutMs);
  timer.unref?.();
  activeWarmup = (async () => {
    try {
      const request = buildNativeDispatchRequest("claude", "Reply with OK.", {
        role: "preflight",
        modelTier: "cheap",
        cwd: cwd || process.cwd(),
        issuedToolIds: [],
        maxTurns: 1,
        maxOutputTokens: 32,
        stallTimeoutMs: resolvedTimeoutMs,
        wallTimeoutMs: resolvedTimeoutMs,
      });
      const result = await runNativeDispatch(request, {
        abortSignal: controller.signal,
        projectDir: cwd || process.cwd(),
        silent: true,
      });
      return { attempted: true, ok: true, status: 0, signal: null, error: null, stdout: String(result.output || ""), stderr: "" };
    } catch (error) {
      const failure = classifyClaudeCliFailure(error);
      return {
        attempted: true,
        ok: false,
        status: null,
        signal: controller.signal.aborted ? "SIGTERM" : null,
        error: String(error?.message || error),
        stdout: "",
        stderr: "",
        classification: failure?.classification || null,
        retryable: failure?.retryable ?? null,
        detail: failure?.detail || null,
      };
    } finally {
      clearTimeout(timer);
      activeWarmup = null;
    }
  })();
  return activeWarmup;
}
