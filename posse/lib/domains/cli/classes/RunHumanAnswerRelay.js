import {
  listReservedHumanAnswerDeliveries,
  markHumanAnswerDelivery,
} from "../../queue/functions/interaction-contract.js";

const DEFAULT_POLL_INTERVAL_MS = 150;

/**
 * Attended-run owner for cross-process human-answer delivery. SQLite polling
 * is intentional: queue wake listeners are process-local, while reservations
 * may be written by a separate bridge/CLI process.
 */
export class RunHumanAnswerRelay {
  constructor({
    display = null,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    listDeliveries = listReservedHumanAnswerDeliveries,
    markDelivery = markHumanAnswerDelivery,
    onError = null,
  } = {}) {
    this.display = display;
    this.pollIntervalMs = Math.max(50, Math.min(2_000, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS));
    this.listDeliveries = listDeliveries;
    this.markDelivery = markDelivery;
    this.onError = onError;
    this.timer = null;
    this.running = false;
    this.polling = false;
  }

  start() {
    if (this.running || !this.display?.deliverQuestionAnswer) return this;
    this.running = true;
    this.#schedule(0);
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  pollOnce() {
    if (!this.display?.deliverQuestionAnswer || this.polling) {
      return { inspected: 0, delivered: 0 };
    }
    this.polling = true;
    let inspected = 0;
    let delivered = 0;
    try {
      const reservations = this.listDeliveries({ limit: 32 });
      for (const reservation of reservations) {
        inspected += 1;
        const result = this.display.deliverQuestionAnswer(reservation, {
          onMatched: ({ ownerLeaseToken }) => this.markDelivery({
            reservation_id: reservation.reservation_id,
            job_id: reservation.job_id,
            question_generation: reservation.question_generation,
            lease_token: ownerLeaseToken,
          }),
        });
        if (result?.delivered) delivered += 1;
      }
      return { inspected, delivered };
    } catch (err) {
      try { this.onError?.(err); } catch { /* relay errors never stop the run */ }
      return { inspected, delivered, error: err };
    } finally {
      this.polling = false;
    }
  }

  #schedule(delayMs = this.pollIntervalMs) {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pollOnce();
      this.#schedule();
    }, delayMs);
    this.timer.unref?.();
  }
}

