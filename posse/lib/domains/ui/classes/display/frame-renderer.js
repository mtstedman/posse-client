import { C } from "../../../../shared/format/functions/colors.js";
import { fit } from "../../functions/display/helpers/formatters.js";

export class DisplayFrameRenderer {


  // ── Render ──────────────────────────────────────────────────────────────

  render({ advanceAnimation = false } = {}) {
    if (!this._started && !this._renderOnce) return;
    if (this._stdoutBackedUp) return;
    this._renderOnce = false;
    this._lastRenderAt = Date.now();
    this._refreshViewport();

    if (advanceAnimation && !this._blockingOverlay) {
      this._spinIdx++;
    }

    if (this._mode === "approval") {
      this._renderApproval();
      return;
    }

    // ── Panel sizing ──
    // fullW = usable width inside the outer border (cols - 2 border chars)
    const fullW = Math.max(0, this.cols - 2);
    const maxLeftW = Math.max(0, this.cols - 3);
    const leftW = Math.max(0, Math.min(Math.max(Math.floor(this.cols * 0.31), 28), 44, fullW, maxLeftW));
    const rightW = Math.max(0, this.cols - leftW - 3); // 3 = │ + │ + │

    // Build fixed sections
    const progressLines = this._buildProgressBar(fullW);
    // Context-health is now shown by the dedicated ATLAS/ONNX readiness bars in
    // the left panel, so the old bottom status bar is retired (no placeholder row).
    const contextBarLines = [];
    const inputLines = this._buildBottomInput(fullW);

    // Layout rows:  top border(1) + progress + divider(1) + middle + divider(1)
    //               + context bar + input + bottom border(1)
    const overhead = 2 + progressLines.length + 1 + 1 + contextBarLines.length + inputLines.length;
    const middleRows = Math.max(this.rows - overhead, 5);

    let left = this._buildLeft(leftW, middleRows);
    let right = this._buildRight(rightW, middleRows);

    if (left.length > middleRows) left.length = middleRows;
    if (right.length > middleRows) right.length = middleRows;
    while (left.length < middleRows) left.push("");
    while (right.length < middleRows) right.push("");

    // ── Compose frame with absolute cursor positioning ──
    let buf = "";
    let row = 1;

    // Top border
    buf += `\x1b[${row};1H${C.dim}\u250c${"\u2500".repeat(fullW)}\u2510${C.reset}\x1b[K`;
    row++;

    // Progress bar section (full width)
    for (const line of progressLines) {
      buf += `\x1b[${row};1H${C.dim}\u2502${C.reset}${fit(line, fullW)}${C.dim}\u2502${C.reset}\x1b[K`;
      row++;
    }

    // Divider: progress → split panels
    buf += `\x1b[${row};1H${C.dim}\u251c${"\u2500".repeat(leftW)}\u252c${"\u2500".repeat(rightW)}\u2524${C.reset}\x1b[K`;
    row++;

    // Middle: split panels
    for (let i = 0; i < middleRows; i++) {
      buf += `\x1b[${row};1H${C.dim}\u2502${C.reset}${fit(left[i], leftW)}${C.dim}\u2502${C.reset}${fit(right[i], rightW)}${C.dim}\u2502${C.reset}\x1b[K`;
      row++;
    }

    // Divider: split panels → bottom input
    buf += `\x1b[${row};1H${C.dim}\u251c${"\u2500".repeat(leftW)}\u2534${"\u2500".repeat(rightW)}\u2524${C.reset}\x1b[K`;
    row++;

    // Context status bar (thin, full width) \u2014 a vim/tmux-style status line
    // between the split panels and the input. Part of the cacheable base frame
    // since it tracks context-health state, not keystrokes.
    for (const line of contextBarLines) {
      buf += `\x1b[${row};1H${C.dim}\u2502${C.reset}${fit(line, fullW)}${C.dim}\u2502${C.reset}\x1b[K`;
      row++;
    }

    // Bottom input section \u2014 built separately so the overlay base-frame
    // cache never freezes keystroke feedback. Keys still get processed while
    // the overlay is up; this lets the user actually SEE the result.
    let inputBuf = "";
    for (const line of inputLines) {
      inputBuf += `\x1b[${row};1H${C.dim}\u2502${C.reset}${fit(line, fullW)}${C.dim}\u2502${C.reset}\x1b[K`;
      row++;
    }

    // Bottom border + clear-below (part of the cacheable base frame)
    buf += `\x1b[${row};1H${C.dim}\u2514${"\u2500".repeat(fullW)}\u2518${C.reset}\x1b[K`;
    row++;
    buf += `\x1b[${row};1H\x1b[J`;

    const baseFrame = this._baseFrameForBlockingOverlay(buf);
    // Build the overlay portion separately so we can write only its delta
    // when just the wrap-up heartbeat ticks. Repainting the whole base frame
    // every second was the visible flicker source.
    const overlayPart = this._blockingOverlay ? this._applyBlockingOverlay("") : "";
    const full = baseFrame + inputBuf + overlayPart;

    if (full === this._lastFrame) return;

    const overlayActive = !!this._blockingOverlay;
    const haveLast = this._lastFrame !== "";
    const baseSame = overlayActive && haveLast && this._lastFrameBase === baseFrame;
    const inputSame = baseSame && this._lastFrameInput === inputBuf;
    let payload;
    if (inputSame) {
      payload = overlayPart;
    } else if (baseSame) {
      payload = inputBuf + overlayPart;
    } else {
      payload = full;
    }
    // Wrap the frame write in DEC 2026 synchronized-output markers (BSU/ESU) so
    // terminals that support it (Windows Terminal, modern xterm/kitty) buffer the
    // whole repaint and present it atomically instead of tearing mid-frame. When
    // busy we rewrite the entire frame on every change — token counters and the
    // provider gauges (the [S]/[W] rows) tick constantly — and an un-synchronized
    // full repaint at render cadence is what makes those rows flicker. Terminals
    // that don't implement 2026 ignore the unknown private mode harmlessly.
    const ok = process.stdout.write(`\x1b[?2026h${payload}\x1b[?2026l`);
    if (!ok) {
      this._stdoutBackedUp = true;
      process.stdout.once("drain", () => {
        this._stdoutBackedUp = false;
        this._lastFrame = "";
        this._lastFrameBase = "";
        this._lastFrameInput = "";
        this.requestRender({ force: true });
      });
    } else {
      this._lastFrame = full;
      this._lastFrameBase = baseFrame;
      this._lastFrameInput = inputBuf;
    }
  }
}
