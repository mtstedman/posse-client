export class RunIdleAutoMergeController {
  constructor({
    getDisplay = () => null,
    useTui = false,
    C,
    autoMergePendingReviewBlockers = false,
    autoMergeCompletedWorkItems = null,
    isIterativeWorkItemActive = () => false,
  } = {}) {
    this.getDisplay = getDisplay;
    this.useTui = useTui;
    this.C = C;
    this.autoMergePendingReviewBlockers = autoMergePendingReviewBlockers;
    this.autoMergeCompletedWorkItems = autoMergeCompletedWorkItems;
    this.isIterativeWorkItemActive = isIterativeWorkItemActive;
    this.promise = null;
  }

  /**
   * Whether this run merges `workItem`, once complete, before the run loop
   * ends: only this controller merges mid-run, and only with automatic merge
   * on (`start` refuses otherwise); its candidates then skip an iterative
   * work item that is still looping. A finalized iterative work item that
   * auto-approves merges only at wrap-up when automatic merge is off, which
   * is after the loop, so a work item waiting on it mid-run would wait
   * forever (run 1250b red team 2, finding 7). The scheduler's work-item
   * order uses this as its merge policy: a completed work item it returns
   * false for is parked.
   */
  mergesDuringRun(workItem) {
    if (!this.autoMergePendingReviewBlockers || typeof this.autoMergeCompletedWorkItems !== "function") return false;
    return !this.isIterativeWorkItemActive(workItem);
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

  whenIdle(callback) {
    const pending = this.promise;
    const invoke = () => {
      try { callback?.(); } catch { /* scheduler re-drive hints are best-effort */ }
    };
    if (!pending) {
      queueMicrotask(invoke);
      return;
    }
    void pending.then(invoke, invoke);
  }
}
