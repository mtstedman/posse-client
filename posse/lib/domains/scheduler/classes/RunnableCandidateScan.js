import { findRunnableJobsBatch } from "../../queue/functions/queue-store.js";
import { parseJobPayload } from "../../queue/functions/payload.js";

function cursor(job) {
  const payload = parseJobPayload(job);
  return { priority: ({ urgent: 0, high: 1, normal: 2 })[job.priority] ?? 3,
    kind: [true, 1, "1"].includes(payload._assess_only) ? 0 : job.job_type === "fix" ? 1 : job.job_type === "promote" ? 2 : 3,
    created_at: job.created_at, id: job.id };
}

// Each bounded pass reserves a head batch for new/urgent work and continues
// the tail from the previous pass. Incidental queue wakes cannot restart the
// tail walk. Keyset positions survive rows being completed or canceled.
export class RunnableCandidateScan {
  constructor(read = findRunnableJobsBatch) {
    this.read = read;
    this.positions = new Map();
    this.heads = new Set();
    this.passStartedAt = null;
  }

  beginPass() {
    this.heads = new Set();
    this.changedAfter = this.passStartedAt || null;
    this.passStartedAt = new Date().toISOString();
  }

  next(limit, options = {}) {
    const key = JSON.stringify([options.onlyJobTypes || [], options.onlyWorkItemIds || []]);
    const head = !this.heads.has(key);
    this.heads.add(key);
    let rows = head && this.changedAfter ? this.read(limit, { ...options, changedAfter: this.changedAfter }) : [];
    if (head) {
      const freshIds = new Set(rows.map((job) => job.id));
      rows = [...rows, ...this.read(limit, { ...options, after: null }).filter((job) => !freshIds.has(job.id))]
        .sort((a, b) => cursor(a).priority - cursor(b).priority).slice(0, limit);
    } else rows = this.read(limit, { ...options, after: this.positions.get(key) || null });
    if (!head) {
      if (rows.length < limit) this.positions.delete(key);
      else this.positions.set(key, cursor(rows[rows.length - 1]));
    } else if (!this.positions.has(key) && rows.length) this.positions.set(key, cursor(rows[rows.length - 1]));
    return rows;
  }
}
