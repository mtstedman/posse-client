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



  _applyBlockingOverlay(buf) {
    if (!this._blockingOverlay) return buf;
    if (this._blockingOverlay.kind === "wrapup") {
      return this._applyWrapUpOverlay(buf);
    }
    const title = this._blockingOverlay.title;
    const subtitle = this._blockingOverlay.subtitle || "";
    const visibleTitle = stripAnsi(title);
    const visibleSubtitle = stripAnsi(subtitle);
    const innerW = Math.min(
      Math.max(visibleTitle.length, visibleSubtitle.length, 18) + 8,
      Math.max(18, this.cols - 8),
    );
    const boxW = innerW + 2;
    const col = Math.max(1, Math.floor((this.cols - boxW) / 2) + 1);
    const row = Math.max(2, Math.floor((this.rows - 7) / 2) + 1);
    const titleLine = fit(`${C.yellow}${C.bold}! ${title}${C.reset}`, innerW);
    const subtitleLine = subtitle ? fit(`${C.dim}${subtitle}${C.reset}`, innerW) : " ".repeat(innerW);
    const pad = " ".repeat(innerW);
    return buf
      + `\x1b[${row};${col}H${C.yellow}${C.bold}\u250c${"\u2500".repeat(innerW)}\u2510${C.reset}`
      + `\x1b[${row + 1};${col}H${C.yellow}${C.bold}\u2502${C.reset}${pad}${C.yellow}${C.bold}\u2502${C.reset}`
      + `\x1b[${row + 2};${col}H${C.yellow}${C.bold}\u2502${C.reset}${titleLine}${C.yellow}${C.bold}\u2502${C.reset}`
      + `\x1b[${row + 3};${col}H${C.yellow}${C.bold}\u2502${C.reset}${subtitleLine}${C.yellow}${C.bold}\u2502${C.reset}`
      + `\x1b[${row + 4};${col}H${C.yellow}${C.bold}\u2502${C.reset}${pad}${C.yellow}${C.bold}\u2502${C.reset}`
      + `\x1b[${row + 5};${col}H${C.yellow}${C.bold}\u2514${"\u2500".repeat(innerW)}\u2518${C.reset}`;
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
