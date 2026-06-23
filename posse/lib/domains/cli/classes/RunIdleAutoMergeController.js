export class RunIdleAutoMergeController {
  constructor({
    getDisplay = () => null,
    useTui = false,
    C,
    autoMergePendingReviewBlockers = false,
    autoMergeCompletedWorkItems = null,
  } = {}) {
    this.getDisplay = getDisplay;
    this.useTui = useTui;
    this.C = C;
    this.autoMergePendingReviewBlockers = autoMergePendingReviewBlockers;
    this.autoMergeCompletedWorkItems = autoMergeCompletedWorkItems;
    this.promise = null;
  }

  start({
    reason = "scheduler idle",
    runGc = false,
    beforeStart = null,
    afterMerged = null,
    afterNoMerge = null,
    onError = null,
  } = {}) {
    if (!this.autoMergePendingReviewBlockers || typeof this.autoMergeCompletedWorkItems !== "function") return false;
    if (this.promise) return false;
    try { beforeStart?.(); } catch { /* display/log callback only */ }
    this.promise = Promise.resolve()
      .then(() => this.autoMergeCompletedWorkItems({ display: this.getDisplay(), reason, runGc }))
      .then((mergedCount) => {
        if (mergedCount > 0) afterMerged?.(mergedCount);
        else afterNoMerge?.();
      })
      .catch((err) => {
        if (typeof onError === "function") onError(err);
        else {
          const display = this.getDisplay();
          const errMsg = `Auto-merge during scheduler idle failed: ${err?.message || err}`;
          if (display) display.addEvent(`${this.C.red}${errMsg}${this.C.reset}`);
          else console.log(`\n  ${this.C.red}${errMsg}${this.C.reset}`);
        }
      })
      .finally(() => {
        this.promise = null;
      });
    return true;
  }

  async wait() {
    const pending = this.promise;
    if (!pending) return;
    const display = this.getDisplay();
    if (display && typeof display.setRunPhase === "function") {
      display.setRunPhase("Finishing pending auto-merge");
    } else if (!display && !this.useTui) {
      console.log(`\n  ${this.C.cyan}Finishing pending auto-merge before wrap-up...${this.C.reset}`);
    }
    await pending;
  }

  isRunning() {
    return !!this.promise;
  }
}
