import {
  progressStepIcon,
  renderActionOverlay,
  renderWrapUpOverlay,
} from "../../functions/display/helpers/progress-overlay.js";

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
    if (this._blockingOverlay.kind === "wrapup") return this._applyWrapUpOverlay(buf);
    return renderActionOverlay(buf, this._blockingOverlay, this.cols, this.rows);
  }

  _wrapUpStepIcon(status, tick = 0) {
    return progressStepIcon(status, tick);
  }

  _applyWrapUpOverlay(buf) {
    return renderWrapUpOverlay(buf, this._blockingOverlay || {}, this.cols, this.rows);
  }

  _applyWrapUpScreen(buf) {
    return this._applyWrapUpOverlay(buf);
  }
}
