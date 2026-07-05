import { C } from "../../../../shared/format/functions/colors.js";
import { displayColumnWidth, stripAnsi, fit } from "../../functions/display/helpers/formatters.js";



function formatOverlayElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export class DisplayOverlayRenderer {


  _resetBlockingOverlayBaseFrame() {
    this._blockingOverlayBaseFrame = "";
    this._blockingOverlayBaseKey = "";
    this._lastFrameBase = "";
  }



  _baseFrameForBlockingOverlay(buf) {
    if (!this._blockingOverlay) {
      this._resetBlockingOverlayBaseFrame();
      return buf;
    }
    const key = `${this._mode}:${this.cols}x${this.rows}`;
    if (!this._blockingOverlayBaseFrame || this._blockingOverlayBaseKey !== key) {
      this._blockingOverlayBaseFrame = this._blockingOverlay.kind === "wrapup"
        && this._blockingOverlay.layout === "screen"
        ? "\x1b[1;1H\x1b[2J"
        : buf;
      this._blockingOverlayBaseKey = key;
    }
    return this._blockingOverlayBaseFrame;
  }



  // Small in-flight action modal (approve/merge/stash/discard in review).
  // Layout rules mirror the wrap-up overlay's flicker guards: the box
  // geometry is derived from STATIC content only (title, context lines) and
  // the row shape is constant, so ticks only swap the spinner glyph and the
  // elapsed digits in place \u2014 never resize or recenter the box.
  _applyBlockingOverlay(buf) {
    if (!this._blockingOverlay) return buf;
    if (this._blockingOverlay.kind === "wrapup") {
      return this._applyWrapUpOverlay(buf);
    }
    const overlay = this._blockingOverlay;
    const meta = overlay.meta && typeof overlay.meta === "object" ? overlay.meta : {};
    const tone = meta.tone === "warn" ? C.yellow : C.cyan;
    const nowMs = Date.now();
    const startedAtMs = Number(overlay.startedAt || nowMs);
    const elapsedMs = Math.max(0, nowMs - startedAtMs);
    const spinFrames = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
    const spin = spinFrames[Math.floor(elapsedMs / 250) % spinFrames.length];
    const title = stripAnsi(overlay.title).replace(/[.\u2026]+$/, "");
    // The elapsed row already carries the "please wait" hint; drop a
    // redundant trailing one from legacy subtitles used as fallback context.
    const subtitle = stripAnsi(overlay.subtitle || "").replace(/\s*[-–—·]?\s*please wait$/i, "");
    const flowText = meta.branch
      ? `${C.cyan}${stripAnsi(String(meta.branch))}${C.reset} ${C.dim}\u2192${C.reset} ${stripAnsi(String(meta.target || "main"))}`
      : (subtitle ? `${C.dim}${subtitle}${C.reset}` : "");
    const itemText = meta.item ? `${C.dim}${stripAnsi(String(meta.item))}${C.reset}` : "";
    // Constant row shape: blank rows stand in for absent context lines so a
    // phase change never alters the box height mid-operation.
    const content = [
      "",
      `  ${tone}${spin}${C.reset} ${C.bold}${title}${C.reset}`,
      flowText ? `    ${flowText}` : "",
      "",
      itemText ? `  ${itemText}` : "",
      `  ${C.dim}${formatOverlayElapsed(elapsedMs)} \u00b7 please wait${C.reset}`,
      "",
    ];
    const widthBasis = [
      `  + ${title}`,
      flowText ? `    ${flowText}` : "",
      itemText ? `  ${itemText}` : "",
      "  0:00 \u00b7 please wait",
    ];
    const rawWidth = Math.max(34, ...widthBasis.map((line) => displayColumnWidth(line)));
    const innerW = Math.min(rawWidth + 3, Math.max(24, this.cols - 8));
    const boxW = innerW + 2;
    const boxH = content.length + 2;
    const col = Math.max(1, Math.floor((this.cols - boxW) / 2) + 1);
    const row = Math.max(2, Math.floor((this.rows - boxH) / 2) + 1);
    let out = buf + `\x1b[${row};${col}H${tone}\u256d${"\u2500".repeat(innerW)}\u256e${C.reset}`;
    for (let i = 0; i < content.length; i++) {
      out += `\x1b[${row + 1 + i};${col}H${tone}\u2502${C.reset}${fit(content[i], innerW)}${tone}\u2502${C.reset}`;
    }
    out += `\x1b[${row + boxH - 1};${col}H${tone}\u2570${"\u2500".repeat(innerW)}\u256f${C.reset}`;
    return out;
  }



  _wrapUpStepIcon(status, tick = 0) {
    const clean = String(status || "pending");
    if (clean === "done") return `${C.green}\u2713${C.reset}`;
    if (clean === "failed") return `${C.red}\u2717${C.reset}`;
    if (clean === "skipped") return `${C.dim}-${C.reset}`;
    if (clean === "running") {
      const frames = ["|", "/", "-", "\\"];
      return `${C.cyan}${frames[Math.abs(Number(tick) || 0) % frames.length]}${C.reset}`;
    }
    return `${C.dim}\u00b7${C.reset}`;
  }



  _applyWrapUpOverlay(buf) {
    const overlay = this._blockingOverlay || {};
    if (overlay.layout === "screen") return this._applyWrapUpScreen(buf);
    const title = overlay.title || "Wrapping up";
    const subtitle = overlay.subtitle || "Finishing closeout work. Please wait.";
    const steps = Array.isArray(overlay.steps) ? overlay.steps : [];
    const nowMs = Date.now();
    const startedAt = Number(overlay.startedAt || nowMs);
    const elapsedMs = Math.max(0, nowMs - startedAt);
    const elapsed = formatOverlayElapsed(elapsedMs);
    const progressTick = Math.floor(elapsedMs / 250);
    const runningStep = steps.find((step) => step.status === "running");
    const maxStepLines = Math.max(1, Math.min(steps.length, this.rows - 10));
    const visibleSteps = steps.slice(0, maxStepLines);
    const hiddenCount = Math.max(0, steps.length - visibleSteps.length);
    const stepLines = visibleSteps.map((step) => {
      const detail = step.detail ? `${C.dim} - ${step.detail}${C.reset}` : "";
      return ` ${this._wrapUpStepIcon(step.status, progressTick)} ${step.label}${detail}`;
    });
    if (hiddenCount > 0) {
      stepLines.push(` ${C.dim}\u00b7 ${hiddenCount} more step${hiddenCount === 1 ? "" : "s"}${C.reset}`);
    }

    const earlyExitHint = overlay.exitHint || "leave remaining ATLAS/ONNX work queued; Ctrl+C interrupts.";
    const exitLine = overlay.allowEarlyExit
      ? (overlay.earlyExitRequested
        ? `${C.yellow}Exit requested${C.reset}${C.dim} - remaining ATLAS work will stay queued for next run.${C.reset}`
        : `${C.yellow}[Enter] exit early${C.reset}${C.dim} - ${earlyExitHint}${C.reset}`)
      : `${C.dim}Progress only - no choice needed here; Ctrl+C interrupts.${C.reset}`;
    const content = [
      "",
      `${C.yellow}${C.bold}! ${title}${C.reset}`,
      subtitle ? `${C.dim}${subtitle}${C.reset}` : "",
      `${C.cyan}heartbeat${C.reset} ${elapsed}${runningStep ? `${C.dim} - ${runningStep.label}${C.reset}` : ""}`,
      exitLine,
      "",
      ...stepLines,
      "",
    ];
    // Box width is derived from the STATIC content only (title, subtitle, the
    // fixed instruction, and step labels) — NOT the live heartbeat elapsed or the
    // streaming step details, which change width every tick. Letting those resize
    // and recenter the box on the frozen base frame each tick was the flicker.
    // The dynamic lines fit() to innerW below (truncating any overflow).
    const widthBasis = [
      `${C.yellow}${C.bold}! ${title}${C.reset}`,
      subtitle ? `${C.dim}${subtitle}${C.reset}` : "",
      overlay.allowEarlyExit
        ? `${C.yellow}[Enter] exit early${C.reset}${C.dim} - ${earlyExitHint}${C.reset}`
        : `${C.dim}Progress only - no choice needed here; Ctrl+C interrupts.${C.reset}`,
      ...visibleSteps.map((step) => ` ${this._wrapUpStepIcon(step.status, 0)} ${step.label}`),
    ];
    const rawWidth = Math.max(34, ...widthBasis.map((line) => displayColumnWidth(line)));
    const innerW = Math.min(rawWidth + 4, Math.max(18, this.cols - 8));
    const boxW = innerW + 2;
    const boxH = content.length + 2;
    const col = Math.max(1, Math.floor((this.cols - boxW) / 2) + 1);
    const row = Math.max(2, Math.floor((this.rows - boxH) / 2) + 1);
    const pad = " ".repeat(innerW);
    let out = buf + `\x1b[${row};${col}H${C.yellow}${C.bold}\u250c${"\u2500".repeat(innerW)}\u2510${C.reset}`;
    for (let i = 0; i < content.length; i++) {
      out += `\x1b[${row + i + 1};${col}H${C.yellow}${C.bold}\u2502${C.reset}${fit(content[i], innerW)}${C.yellow}${C.bold}\u2502${C.reset}`;
    }
    out += `\x1b[${row + boxH - 1};${col}H${C.yellow}${C.bold}\u2514${"\u2500".repeat(innerW)}\u2518${C.reset}`;
    return out;
  }

  _applyWrapUpScreen(buf) {
    const overlay = this._blockingOverlay || {};
    const title = overlay.title || "Run wrap-up";
    const subtitle = overlay.subtitle || "Finishing closeout work.";
    const steps = Array.isArray(overlay.steps) ? overlay.steps : [];
    const nowMs = Date.now();
    const startedAt = Number(overlay.startedAt || nowMs);
    const elapsedMs = Math.max(0, nowMs - startedAt);
    const elapsed = formatOverlayElapsed(elapsedMs);
    const progressTick = Math.floor(elapsedMs / 250);
    const runningStep = steps.find((step) => step.status === "running");
    const innerW = Math.max(30, this.cols - 8);
    const col = 5;
    let row = Math.max(2, Math.floor(this.rows * 0.12));
    const rule = "\u2500".repeat(innerW);
    const earlyExitHint = overlay.exitHint || "leave remaining ATLAS/ONNX work queued; Ctrl+C interrupts.";
    const exitLine = overlay.allowEarlyExit
      ? (overlay.earlyExitRequested
        ? `${C.yellow}Exit requested${C.reset}${C.dim} - leaving queued ATLAS/ONNX work for next run.${C.reset}`
        : `${C.yellow}[Enter] exit early${C.reset}${C.dim} - ${earlyExitHint}${C.reset}`)
      : `${C.dim}Progress only - no choice needed here; Ctrl+C interrupts.${C.reset}`;
    const header = [
      `${C.cyan}${C.bold}POSSE WRAP-UP${C.reset}`,
      `${C.bold}${title}${C.reset}`,
      subtitle ? `${C.dim}${subtitle}${C.reset}` : "",
      `${C.cyan}heartbeat${C.reset} ${elapsed}${runningStep ? `${C.dim} - ${runningStep.label}${C.reset}` : ""}`,
      exitLine,
    ].filter((line) => line !== "");
    let out = buf;
    for (const line of header) {
      out += `\x1b[${row};${col}H${fit(line, innerW)}\x1b[K`;
      row++;
    }
    row++;
    out += `\x1b[${row};${col}H${C.dim}${rule}${C.reset}\x1b[K`;
    row += 2;
    const maxStepLines = Math.max(1, this.rows - row - 2);
    const visibleSteps = steps.slice(0, maxStepLines);
    for (const step of visibleSteps) {
      const detail = step.detail ? `${C.dim} - ${step.detail}${C.reset}` : "";
      const line = ` ${this._wrapUpStepIcon(step.status, progressTick)} ${step.label}${detail}`;
      out += `\x1b[${row};${col}H${fit(line, innerW)}\x1b[K`;
      row++;
    }
    const hiddenCount = Math.max(0, steps.length - visibleSteps.length);
    if (hiddenCount > 0 && row <= this.rows - 1) {
      out += `\x1b[${row};${col}H${C.dim}\u00b7 ${hiddenCount} more step${hiddenCount === 1 ? "" : "s"}${C.reset}\x1b[K`;
    }
    return out;
  }
}
