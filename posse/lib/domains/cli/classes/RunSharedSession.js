// What a shared run (`posse go` inside a live session) does instead of ending.
//
// A run outside a session finishes when its queue empties: it tears the
// display down, merges, reviews, offers to push, and exits. A shared run stays
// on the session screen, so the parts of that closeout that matter while it is
// still running happen here, at each quiet point, without leaving the screen:
//
//   - iterative work items get their next pass (the closeout would rerun);
//   - completed work is auto-merged when automatic merge is on;
//   - the deploy offer is refreshed from the current Git state;
//   - work items waiting for review are announced, with the key that opens
//     the in-screen review.
//
// Review prompts on the plain terminal, the end-of-run summary and the exit
// code belong to the real exit (Ctrl+C, or the session ending), which goes
// through the ordinary shutdown and wrap-up paths unchanged.

import { RUN_DISPLAY_GLOBAL_KEYS } from "../../../catalog/shared-run.js";
import { describeSharedRunEnd } from "../../pairing/functions/shared-run.js";

export class RunSharedSession {
  constructor({
    enabled = false,
    getDisplay = () => null,
    getIdleAutoMerge = () => null,
    C,
    processIterativeWrapUp = null,
    mergeIterativePassToTarget = null,
    autoMergeCompletedWorkItems = null,
    hasAutoMergeableCompletedWorkItems = null,
    refreshPushOfferGate = null,
    countReviewableWorkItems = () => 0,
    seedQueuedWorkItems = () => ({ seeded: 0, unsettled: 0 }),
    getRole = () => "member",
  } = {}) {
    this.enabled = enabled === true;
    this.getDisplay = getDisplay;
    this.getIdleAutoMerge = getIdleAutoMerge;
    this.C = C;
    this.processIterativeWrapUp = processIterativeWrapUp;
    this.mergeIterativePassToTarget = mergeIterativePassToTarget;
    this.autoMergeCompletedWorkItems = autoMergeCompletedWorkItems;
    this.hasAutoMergeableCompletedWorkItems = hasAutoMergeableCompletedWorkItems;
    this.refreshPushOfferGate = refreshPushOfferGate;
    this.countReviewableWorkItems = countReviewableWorkItems;
    this.seedQueuedWorkItems = seedQueuedWorkItems;
    this.getRole = getRole;
    this.quietWork = null;
    this.lastSeedGeneration = null;
    this.lastReviewableAnnounced = 0;
  }

  say(text, color = this.C.cyan) {
    const display = this.getDisplay();
    if (display) display.addEvent(`${color}${text}${this.C.reset}`);
    else console.log(`\n  ${color}${text}${this.C.reset}`);
  }

  /**
   * A shared run that starts with nothing to run still opens the session
   * screen. What `go` does before saying "nothing to do" still happens first:
   * the next iterative pass, the start-of-run merge, the deploy offer.
   *
   * @returns {Promise<{ rerun: boolean }>} rerun: an iterative pass was
   *   spawned, so the run should select its jobs again.
   */
  async prelude() {
    if (typeof this.processIterativeWrapUp === "function") {
      const iterate = await this.processIterativeWrapUp({
        reason: "run start",
        mergeIterativePassToTarget: this.mergeIterativePassToTarget,
      });
      if (iterate?.rerun) return { rerun: true };
    }
    let merged = 0;
    try {
      if (typeof this.autoMergeCompletedWorkItems === "function") {
        merged = Number(await this.autoMergeCompletedWorkItems({ reason: "run start" })) || 0;
      }
    } catch (error) {
      console.log(`\n  ${this.C.yellow}Start-of-run merge failed: ${error?.message || error}${this.C.reset}`);
    }
    try {
      await this.refreshPushOfferGate?.(merged, { createdBy: "run_wrapup" });
    } catch { /* the deploy offer is best-effort */ }
    console.log(`\n  ${this.C.cyan}Nothing is queued here yet.${this.C.reset} This is a session run: the session screen stays open and picks up work as it is added.`);
    return { rerun: false };
  }

  /** The scheduler reached a point where a run outside a session would end. */
  onQuiet({ parked = false } = {}) {
    if (!this.enabled) return;
    // Two short lines: the activity pane cuts a long one off.
    this.say(parked
      ? "Nothing can run right now: the remaining work waits on a person. The session stays open."
      : "All queued work is done. The session stays open.", `${this.C.green}${this.C.bold}`);
    this.say(`${this.getDisplay()?.onInject ? `[${RUN_DISPLAY_GLOBAL_KEYS.INJECT}] adds a task · ` : ""}Ctrl+C returns to the session console`, this.C.dim);
    if (this.quietWork) return;
    this.quietWork = this.#closeoutWithoutLeaving()
      .catch((error) => this.say(`Session idle closeout failed: ${error?.message || error}`, this.C.yellow))
      .finally(() => { this.quietWork = null; });
  }

  async #closeoutWithoutLeaving() {
    const display = this.getDisplay();
    if (typeof this.processIterativeWrapUp === "function") {
      const iterate = await this.processIterativeWrapUp({
        display,
        reason: "session idle",
        mergeIterativePassToTarget: this.mergeIterativePassToTarget,
      });
      // The next pass is queued work: the run is busy again.
      if (iterate?.spawned > 0) return;
    }
    let merged = 0;
    const idleAutoMerge = this.getIdleAutoMerge();
    let mergeable = false;
    try { mergeable = this.hasAutoMergeableCompletedWorkItems?.() === true; } catch { /* nothing to merge */ }
    if (idleAutoMerge && mergeable) {
      idleAutoMerge.start({
        reason: "session idle",
        runGc: false,
        afterMerged: (count) => {
          merged = count;
          this.say(`Auto-merged ${count} completed work item${count === 1 ? "" : "s"}.`, this.C.green);
        },
      });
      // Also covers a merge another trigger started first.
      await new Promise((resolve) => idleAutoMerge.whenIdle(resolve));
    }
    try {
      await this.refreshPushOfferGate?.(merged, { createdBy: "run_wrapup" });
    } catch { /* the deploy offer is best-effort */ }
    let reviewable = 0;
    try { reviewable = Number(this.countReviewableWorkItems()) || 0; } catch { /* advisory */ }
    if (reviewable > 0 && reviewable !== this.lastReviewableAnnounced) {
      this.say(this.getDisplay()?.onReviewPending
        ? `${reviewable} work item${reviewable === 1 ? " is" : "s are"} ready for review: press [${RUN_DISPLAY_GLOBAL_KEYS.REVIEW}] to review and merge without leaving this screen.`
        : `${reviewable} work item${reviewable === 1 ? " is" : "s are"} ready for review: stop this run (Ctrl+C) and run \`posse review\`.`,
      this.C.yellow);
    }
    this.lastReviewableAnnounced = reviewable;
  }

  /**
   * Work queued from another terminal (`posse add`) has no jobs until a run
   * plans it, and this run never restarts: plan it when the queue changes.
   */
  onQueueGeneration(generation) {
    if (!this.enabled || generation === this.lastSeedGeneration) return;
    this.lastSeedGeneration = generation;
    let seeded = 0;
    try {
      const result = this.seedQueuedWorkItems() || {};
      seeded = Number(result.seeded) || 0;
      // A work item too new to plan safely is looked at again on the next lap.
      if (Number(result.unsettled) > 0) this.lastSeedGeneration = null;
    } catch (error) {
      this.say(`Could not plan newly queued work: ${error?.message || error}`, this.C.yellow);
      return;
    }
    if (seeded > 0) this.say(`Picked up ${seeded} newly queued work item${seeded === 1 ? "" : "s"}.`, this.C.cyan);
  }

  /** One line for the terminal when the session ended the run; else null. */
  endMessage(sessionEnd) {
    if (!this.enabled) return null;
    return describeSharedRunEnd(sessionEnd, { role: this.getRole() });
  }
}
