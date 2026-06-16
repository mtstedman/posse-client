import { Lease } from "./Lease.js";

function defaultNoop() {
  return null;
}

export class LeaseManager {
  constructor({
    defaultDurationSec = 900,
    acquireLease = defaultNoop,
    acquireLeaseWithWriteLocks = defaultNoop,
    acquireLeaseWithWriteLocksAsync = null,
    renewLease = () => false,
    releaseLease = () => false,
    releaseLeaseWithoutAttemptPenalty = () => false,
    requeueExpiredLeases = () => 0,
    isLeaseValid = () => false,
    now = () => new Date().toISOString(),
  } = {}) {
    this.defaultDurationSec = Number.isFinite(Number(defaultDurationSec))
      ? Math.max(1, Number(defaultDurationSec))
      : 900;
    this.deps = {
      acquireLease,
      acquireLeaseWithWriteLocks,
      acquireLeaseWithWriteLocksAsync,
      renewLease,
      releaseLease,
      releaseLeaseWithoutAttemptPenalty,
      requeueExpiredLeases,
      isLeaseValid,
      now,
    };
  }

  _buildLease({ jobId, token, ownerId = null, durationSec = this.defaultDurationSec } = {}) {
    const durationMs = Math.max(1, Number(durationSec || this.defaultDurationSec)) * 1000;
    return new Lease({
      jobId,
      token,
      ownerId,
      expiresAt: new Date(Date.now() + durationMs).toISOString(),
    });
  }

  acquire(jobId, ownerId, durationSec = this.defaultDurationSec) {
    const acquired = this.deps.acquireLease(jobId, ownerId, durationSec);
    if (!acquired?.leaseToken) return null;
    return this._buildLease({
      jobId,
      token: acquired.leaseToken,
      ownerId,
      durationSec,
    });
  }

  acquireWithLocks(job, ownerId, scope = null, durationSec = this.defaultDurationSec, opts = {}) {
    const acquired = this.deps.acquireLeaseWithWriteLocks(job, ownerId, scope, durationSec, opts);
    if (!acquired?.leaseToken) return null;
    return this._buildLease({
      jobId: job?.id ?? null,
      token: acquired.leaseToken,
      ownerId,
      durationSec,
    });
  }

  async acquireWithLocksAsync(job, ownerId, scope = null, durationSec = this.defaultDurationSec, opts = {}) {
    const acquire = this.deps.acquireLeaseWithWriteLocksAsync || this.deps.acquireLeaseWithWriteLocks;
    const acquired = await acquire(job, ownerId, scope, durationSec, opts);
    if (!acquired?.leaseToken) return null;
    return this._buildLease({
      jobId: job?.id ?? null,
      token: acquired.leaseToken,
      ownerId,
      durationSec,
    });
  }

  renew(lease, durationSec = this.defaultDurationSec) {
    if (!lease?.jobId || !lease?.token) return false;
    return this.deps.renewLease(lease.jobId, lease.token, durationSec);
  }

  release(lease, finalStatus, opts = {}) {
    if (!lease?.jobId || !lease?.token) return false;
    return this.deps.releaseLease(lease.jobId, lease.token, finalStatus, opts);
  }

  releaseWithoutAttemptPenalty(lease, finalStatus, opts = {}) {
    if (!lease?.jobId || !lease?.token) return false;
    return this.deps.releaseLeaseWithoutAttemptPenalty(lease.jobId, lease.token, finalStatus, opts);
  }

  requeueExpired() {
    return this.deps.requeueExpiredLeases();
  }

  isValid(lease) {
    if (!lease?.jobId || !lease?.token) return false;
    return this.deps.isLeaseValid(lease.jobId, lease.token);
  }

  static fromQueueFns(queueFns = {}, options = {}) {
    return new LeaseManager({
      ...options,
      acquireLease: queueFns.acquireLease,
      acquireLeaseWithWriteLocks: (job, ownerId, scope, durationSec, opts) => (
        queueFns.acquireLeaseWithWriteLocks
          ? queueFns.acquireLeaseWithWriteLocks(job, ownerId, scope, durationSec, opts)
          : null
      ),
      acquireLeaseWithWriteLocksAsync: queueFns.acquireLeaseWithWriteLocksAsync
        ? (job, ownerId, scope, durationSec, opts) => queueFns.acquireLeaseWithWriteLocksAsync(job, ownerId, scope, durationSec, opts)
        : null,
      renewLease: queueFns.renewLease,
      releaseLease: queueFns.releaseLease,
      releaseLeaseWithoutAttemptPenalty: queueFns.releaseLeaseWithoutAttemptPenalty,
      requeueExpiredLeases: queueFns.requeueExpiredLeases,
      isLeaseValid: queueFns.isLeaseValid,
    });
  }
}
