export class Lease {
  constructor({
    jobId,
    token,
    expiresAt = null,
    ownerId = null,
  } = {}) {
    this.jobId = jobId == null ? null : Number(jobId);
    this.token = token || null;
    this.expiresAt = expiresAt || null;
    this.ownerId = ownerId || null;
    Object.freeze(this);
  }

  isExpired({ nowMs = Date.now() } = {}) {
    if (!this.expiresAt) return false;
    const expiryMs = Date.parse(this.expiresAt);
    if (!Number.isFinite(expiryMs)) return false;
    return expiryMs <= nowMs;
  }

  get leaseToken() {
    return this.token;
  }

  msUntilExpiry({ nowMs = Date.now() } = {}) {
    if (!this.expiresAt) return null;
    const expiryMs = Date.parse(this.expiresAt);
    if (!Number.isFinite(expiryMs)) return null;
    return Math.max(0, expiryMs - nowMs);
  }

  toString() {
    return `Lease(jobId=${this.jobId ?? "?"}, token=${this.token ? "set" : "null"}, expiresAt=${this.expiresAt || "null"}, ownerId=${this.ownerId || "null"})`;
  }

  toJSON() {
    return {
      jobId: this.jobId,
      token: this.token,
      expiresAt: this.expiresAt,
      ownerId: this.ownerId,
    };
  }
}
