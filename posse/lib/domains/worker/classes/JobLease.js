import { SETTING_KEYS } from "../../../catalog/settings.js";
import { renewLease as renewLeaseFromQueue, getSetting } from "../../queue/functions/index.js";
import { C } from "../../../shared/format/functions/colors.js";

const DEFAULT_LEASE_SEC = 900;
const DEFAULT_MAX_TRANSIENT_LEASE_RENEW_ERRORS = 2;

export class JobLease {
  constructor({
    worker = null,
    job = null,
    leaseToken = null,
    leaseSec = DEFAULT_LEASE_SEC,
    abortController = null,
    renewLeaseFn = renewLeaseFromQueue,
    maxTransientErrors = readMaxTransientLeaseRenewErrors(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    this.worker = worker;
    this.job = job;
    this.leaseToken = leaseToken;
    this.leaseSec = leaseSec;
    this.abortController = abortController;
    this.renewLeaseFn = renewLeaseFn;
    this.maxTransientErrors = Math.max(0, Math.floor(Number(maxTransientErrors) || 0));
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.renewMs = JobLease.renewalIntervalMs(leaseSec);
    this.transientRetryMs = Math.max(500, Math.min(5000, Math.floor(this.renewMs / 4)));
    this.transientErrors = 0;
    this.timer = null;
    this.stopped = false;
  }

  static renewalIntervalMs(leaseSec) {
    const leaseMs = Math.max(1000, Math.floor((Number(leaseSec) || DEFAULT_LEASE_SEC) * 1000));
    if (leaseMs <= 5000) return Math.max(250, Math.floor(leaseMs / 2));
    return Math.max(5000, Math.floor(leaseMs / 3));
  }

  start() {
    if (this.timer || this.stopped) return this;
    this.#schedule(this.renewMs);
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    return this;
  }

  renewNow() {
    if (this.abortController?.signal?.aborted) {
      this.stop();
      return "aborted";
    }

    try {
      const renewed = this.renewLeaseFn(this.job.id, this.leaseToken, this.leaseSec);
      if (renewed) {
        this.transientErrors = 0;
        return "renewed";
      }
      this.stop();
      this.#emit(`${C.red}[lease] WI#${this.job.work_item_id} job #${this.job.id} - renewal failed, aborting to prevent double-execution${C.reset}`);
      this.worker?.killJob?.(this.job.id, "lease_expired");
      return "failed";
    } catch (err) {
      if (isTransientLeaseRenewalError(err)) {
        const nextErrors = this.transientErrors + 1;
        this.transientErrors = nextErrors;
        if (nextErrors <= this.maxTransientErrors) {
          const message = err?.message || String(err || "unknown error");
          this.#emit(`${C.yellow}[lease] WI#${this.job.work_item_id} job #${this.job.id} - transient renewal error (${nextErrors}/${this.maxTransientErrors}): ${message}; retrying${C.reset}`);
          return "retrying";
        }
      }
      this.stop();
      const message = err?.message || String(err || "unknown error");
      this.#emit(`${C.red}[lease] WI#${this.job.work_item_id} job #${this.job.id} - renewal threw: ${message}; aborting job${C.reset}`);
      this.worker?.killJob?.(this.job.id, "lease_renew_failed");
      return "error";
    }
  }

  #schedule(delayMs = this.renewMs) {
    if (this.stopped || this.timer) return;
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      const result = this.renewNow();
      if (result === "retrying" && !this.stopped) {
        this.#schedule(this.transientRetryMs);
      } else if (result === "renewed" && !this.stopped) {
        this.#schedule(this.renewMs);
      }
    }, Math.max(0, delayMs || 0));
    this.timer?.unref?.();
  }

  #emit(message) {
    if (this.job?.id == null) return;
    this.worker?.emit?.(this.job.id, message);
  }
}

function readMaxTransientLeaseRenewErrors() {
  try {
    const raw = getSetting(SETTING_KEYS.WORKER_LEASE_RENEW_MAX_TRANSIENT_ERRORS);
    const parsed = Number.parseInt(String(raw || ""), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_TRANSIENT_LEASE_RENEW_ERRORS;
    return parsed;
  } catch {
    return DEFAULT_MAX_TRANSIENT_LEASE_RENEW_ERRORS;
  }
}

function isTransientLeaseRenewalError(err) {
  const code = String(err?.code || err?.errno || "").toUpperCase();
  const message = String(err?.message || err || "").toLowerCase();
  return code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || /database is (?:busy|locked)/i.test(message)
    || /sqlite_(?:busy|locked)/i.test(message);
}
