// Pending source-result token reservations, keyed by `<attemptId>:<providerSessionId>`.
//
// RH-1: a leaked reservation permanently inflates the predicted next request
// and recreates the unrecoverable near-tier block this owner exists to avoid,
// so every scope carries a TTL and expired scopes are swept away. Reservations
// are short-lived by construction: one reservation covers a single source-read
// execution, and the owner releases it on the success, stale-binding, throw,
// and `finally` paths alike.
const DEFAULT_RESERVATION_TTL_MS = 10 * 60 * 1000;

export class ContextHeadroomReservationOwner {
  constructor({ ttlMs = DEFAULT_RESERVATION_TTL_MS, now = () => Date.now() } = {}) {
    this._pendingByScope = new Map();
    this._ttlMs = Math.max(1, Number(ttlMs) || DEFAULT_RESERVATION_TTL_MS);
    this._now = now;
  }

  _entry(key) {
    const entry = this._pendingByScope.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this._now()) {
      this._pendingByScope.delete(key);
      return null;
    }
    return entry;
  }

  // Expiry sweeps toward admitting evidence: a scope whose owner never released
  // must not block source reads forever.
  sweepExpired() {
    const now = this._now();
    let swept = 0;
    for (const [key, entry] of [...this._pendingByScope.entries()]) {
      if (entry.expiresAt <= now) {
        this._pendingByScope.delete(key);
        swept += 1;
      }
    }
    return swept;
  }

  reservedTokens(key) {
    return Math.max(0, Number(this._entry(key)?.tokens || 0));
  }

  reserve(key, tokens) {
    this.sweepExpired();
    const next = this.reservedTokens(key) + Math.max(0, Number(tokens) || 0);
    if (next > 0) {
      this._pendingByScope.set(key, { tokens: next, expiresAt: this._now() + this._ttlMs });
    }
    return next;
  }

  release(key, tokens) {
    const remaining = Math.max(0, this.reservedTokens(key) - Math.max(0, Number(tokens) || 0));
    if (remaining > 0) {
      const expiresAt = this._pendingByScope.get(key)?.expiresAt ?? (this._now() + this._ttlMs);
      this._pendingByScope.set(key, { tokens: remaining, expiresAt });
    } else {
      this._pendingByScope.delete(key);
    }
    return remaining;
  }

  // Scope eviction for a finished attempt or provider session.
  releaseScope(key) {
    return this._pendingByScope.delete(key);
  }

  scopeCount() {
    this.sweepExpired();
    return this._pendingByScope.size;
  }
}

export const contextHeadroomReservationOwner = new ContextHeadroomReservationOwner();
