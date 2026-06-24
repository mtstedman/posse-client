// Review, approval, and wrap-up orchestration for CLI sessions.

import { parseJobPayload } from "../../queue/functions/payload.js";
import { withMergeLock } from "../../queue/functions/locks.js";
import { jobIsWriteStep } from "../../ui/functions/display/helpers/job-status.js";
import { finalAssessmentFor } from "./review-report.js";
import { applyMemoryReviewAction } from "./memory-feedback.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { FAILED_JOB_STATUSES } from "../../../catalog/job.js";

export function createTuiWrapUpTracker(display, {
  title = "Review closeout",
  subtitle = "",
  steps = [],
  layout = "overlay",
  allowEarlyExit = false,
  exitHint = "",
  onExitEarly = null,
} = {}) {
  const hasOverlay = !!display && typeof display.setWrapUpOverlay === "function";
  const normalizedSteps = (Array.isArray(steps) ? steps : [])
    .map((step, idx) => ({
      id: step.id || `step-${idx}`,
      label: step.label || `Step ${idx + 1}`,
      status: step.status || "pending",
      detail: step.detail || "",
    }));
  if (hasOverlay) {
    display.setWrapUpOverlay({
      title,
      subtitle,
      steps: normalizedSteps,
      layout,
      allowEarlyExit,
      exitHint,
    });
  }
  if (hasOverlay && typeof onExitEarly === "function") {
    display.onWrapUpEarlyExit = onExitEarly;
  }

  const update = (id, status, detail = "") => {
    if (!hasOverlay || !id) return;
    display.updateWrapUpOverlayStep?.(id, { status, detail });
  };
  const start = (id, detail = "") => update(id, "running", detail);
  const done = (id, detail = "") => update(id, "done", detail);
  const skip = (id, detail = "") => update(id, "skipped", detail);
  const fail = (id, detail = "") => update(id, "failed", detail);

  return {
    start,
    done,
    skip,
    fail,
    async run(id, fn, { doneDetail = "" } = {}) {
      start(id);
      try {
        const result = await Promise.resolve().then(fn);
        done(id, typeof doneDetail === "function" ? doneDetail(result) : doneDetail);
        return result;
      } catch (err) {
        fail(id, String(err?.message || err || "failed").slice(0, 80));
        throw err;
      }
    },
    clear() {
      if (hasOverlay) {
        if (display.onWrapUpEarlyExit === onExitEarly) display.onWrapUpEarlyExit = null;
        display.clearWrapUpOverlay?.();
      }
    },
  };
}

export async function askSingleKeyChoice(prompt, choices = [], {
  stdin = process.stdin,
  stdout = process.stdout,
  fallbackAsk = null,
} = {}) {
  const allowed = new Set((Array.isArray(choices) ? choices : [])
    .map((choice) => String(choice || "").trim().toLowerCase())
    .filter(Boolean)
    .map((choice) => choice[0]));
  if (!stdin?.isTTY) {
    if (typeof fallbackAsk === "function") return fallbackAsk(prompt);
    stdout.write(prompt);
    return "";
  }

  return new Promise((resolve) => {
    let settled = false;
    const wasRaw = Boolean(stdin.isRaw);
    const wasPaused = typeof stdin.isPaused === "function" ? stdin.isPaused() : false;

    const cleanup = () => {
      try { stdin.off("data", onData); } catch { /* best effort */ }
      try { stdin.setRawMode(wasRaw); } catch { /* best effort */ }
      if (wasPaused) {
        try { stdin.pause(); } catch { /* best effort */ }
      }
    };

    const settle = (answer) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.write(`${answer || ""}\n`);
      resolve(answer);
    };

    const onData = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      if (!text) return;
      for (const ch of text) {
        const key = ch.toLowerCase();
        if (allowed.has(key)) return settle(key);
        if (key === "\r" || key === "\n" || key === "\u001b" || key === "\u0003") return settle("");
        if (key >= " " && key <= "~") return settle(key);
      }
    };

    try { stdin.setRawMode(true); } catch { /* best effort */ }
    stdin.on("data", onData);
    try { stdin.resume(); } catch { /* best effort */ }
    stdout.write(prompt);
  });
}
