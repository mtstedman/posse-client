import { firstLine } from "./run-session.js";

export function createBootWarmup({ log, updateBootStep }) {
  return function bootWarmup(label, task, {
    fatal = false,
    start = "warming up",
    done = () => "warm",
    isOk = () => true,
    softTimeoutMs = null,
    softTimeoutDetail = "continuing in background",
    onSoftTimeout = null,
    // Chip status at soft-timeout. "ok" (default) suits steps whose tail is
    // genuinely fire-and-forget. Steps that still GATE boot after the
    // soft-timeout (the ATLAS warm — the pre-TUI gate keeps waiting on the
    // real task) must pass "running" so the hero gauge can't read 100%/ready
    // while boot is in fact still blocked on them.
    softTimeoutStatus = "ok",
  } = {}) {
    const startedAt = Date.now();
    // Step-start diagnostic — pairs with "Boot readiness step complete" /
    // "soft-timeout" entries so a frozen boot can be fingerprinted from the
    // log: whichever start has no completion is the wedge.
    log?.info?.("run", "Boot readiness step start", { label, fatal, softTimeoutMs });
    updateBootStep(label, {
      status: "running",
      detail: `${start}...`,
      startedAt,
    });
    const runTask = new Promise((resolve) => setImmediate(resolve)).then(task);
    const requestedSoftTimeoutMs = Math.max(0, Number(softTimeoutMs) || 0);
    const effectiveSoftTimeoutMs = fatal ? 0 : requestedSoftTimeoutMs;
    const work = effectiveSoftTimeoutMs > 0
      ? (() => {
          let softTimeoutTimer = null;
          return Promise.race([
            runTask.then(
              (result) => ({ kind: "result", result }),
              (error) => ({ kind: "error", error }),
            ),
            new Promise((resolve) => {
              softTimeoutTimer = setTimeout(() => resolve({ kind: "soft-timeout" }), effectiveSoftTimeoutMs);
            }),
          ]).then((outcome) => {
            if (softTimeoutTimer) clearTimeout(softTimeoutTimer);
            if (outcome.kind === "soft-timeout") {
              runTask.catch(() => {});
              return {
                __bootSoftTimeout: true,
                detail: typeof softTimeoutDetail === "function" ? softTimeoutDetail() : softTimeoutDetail,
              };
            }
            if (outcome.kind === "error") throw outcome.error;
            return outcome.result;
          });
        })()
      : runTask;
    return work
      .then((result) => {
        const durationMs = Date.now() - startedAt;
        if (result?.__bootSoftTimeout) {
          try {
            onSoftTimeout?.(result);
          } catch (err) {
            log?.warn?.("run", "Boot warmup soft-timeout hook failed", {
              label,
              error: firstLine(err?.message || err),
            });
          }
          updateBootStep(label, {
            status: softTimeoutStatus,
            detail: result.detail || "continuing in background",
          });
          if (softTimeoutStatus === "running") {
            // The step stays in-flight on the panel, so flip it to its true
            // terminal state when the real task settles — otherwise the chip
            // spins forever and the gauge never reaches an honest 100%.
            // (An Enter-to-background can mark the step "deferred" first;
            // this late settle then upgrades it to the real outcome.)
            runTask.then(
              (taskResult) => {
                const ok = isOk(taskResult);
                const detail = done(taskResult, ok);
                updateBootStep(label, { status: ok ? "ok" : "failed", detail, force: true });
                log?.info?.("run", "Boot readiness step complete", {
                  label,
                  ok,
                  duration_ms: Date.now() - startedAt,
                  detail,
                  after_soft_timeout: true,
                });
              },
              (error) => {
                updateBootStep(label, {
                  status: "failed",
                  detail: `failed (${firstLine(error?.message || error)})`,
                  force: true,
                });
                log?.warn?.("run", "Boot warmup failed after soft-timeout", {
                  label,
                  error: String(error?.message || error || "unknown"),
                });
              },
            );
          }
          log?.info?.("run", "Boot readiness step soft-timeout", {
            label,
            duration_ms: durationMs,
            detail: result.detail || "continuing in background",
          });
          return { label, ok: true, fatal, result, softTimedOut: true };
        }
        const ok = isOk(result);
        const detail = done(result, ok);
        updateBootStep(label, {
          status: ok ? "ok" : "failed",
          detail,
        });
        log?.info?.("run", "Boot readiness step complete", {
          label,
          ok,
          duration_ms: durationMs,
          detail,
        });
        return { label, ok, fatal, result };
      })
      .catch((error) => {
        const durationMs = Date.now() - startedAt;
        const errorId = `boot-warmup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        log?.warn?.("run", "Boot warmup failed", {
          errorId,
          label,
          fatal,
          duration_ms: durationMs,
          error: String(error?.message || error || "unknown"),
          stack: error?.stack || null,
        });
        const detail = `failed (${firstLine(error?.message || error)}; errorId=${errorId})`;
        updateBootStep(label, {
          status: "failed",
          detail,
        });
        return { label, ok: false, fatal, error };
      });
  };
}
