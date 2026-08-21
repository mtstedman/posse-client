// Pending source-result token reservations, keyed by `<attemptId>:<providerSessionId>`.
//
// RH-1: a leaked reservation permanently inflates the predicted next request
// and recreates the unrecoverable near-tier block this owner exists to avoid,
// so every scope carries a TTL and expired scopes are swept away. Reservations
// are short-lived by construction: one reservation covers a single source-read
// execution. A result that never reached the model is released immediately on
// the stale-binding, throw, and `finally` paths; a delivered one stays pending
// until `supersede()` sees the checkpoint that carried it (see F1 below).
//
// F4: the entry is one aggregated total per scope, not a record per
// reservation, so a release carries no identity of its own. When a scope
// expires or is evicted between a reservation and its late release, the tokens
// the release names were never counted by the entry now standing, and
// subtracting them deflates a sibling that is still in flight. Each entry
// therefore carries a generation: an entry created from nothing starts a new
// one, and a release stamped with an older generation is ignored.
const DEFAULT_RESERVATION_TTL_MS = 10 * 60 * 1000;

export class ContextHeadroomReservationOwner {
  constructor({ ttlMs = DEFAULT_RESERVATION_TTL_MS, now = () => Date.now() } = {}) {
    this._pendingByScope = new Map();
    this._ttlMs = Math.max(1, Number(ttlMs) || DEFAULT_RESERVATION_TTL_MS);
    this._now = now;
    this._lastGeneration = 0;
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

  // F1: a reservation covers a result that will sit in the *next* provider
  // request, so it stays pending until that request has been made. The
  // checkpoint sequence is how the scope learns that happened: once a newer
  // checkpoint exists, its `request_context_input_tokens` already contains
  // every result reserved against the older sequence, and keeping those
  // reservations would double-count them.
  supersede(key, sequenceId) {
    const entry = this._entry(key);
    if (!entry || sequenceId == null) return false;
    const sequence = Number(sequenceId);
    if (!Number.isFinite(sequence)) return false;
    if (entry.sequenceId == null || sequence <= entry.sequenceId) return false;
    this._pendingByScope.delete(key);
    return true;
  }

  reserve(key, tokens, { sequenceId = null } = {}) {
    this.sweepExpired();
    const entry = this._entry(key);
    const next = Math.max(0, Number(entry?.tokens || 0)) + Math.max(0, Number(tokens) || 0);
    if (next <= 0) return { tokens: 0, generation: 0 };
    // Joining a live entry keeps its generation; starting one from nothing —
    // after expiry, eviction, or a first reservation — begins a new one.
    const generation = entry ? entry.generation : (this._lastGeneration += 1);
    // `Number(null)` is 0, so an absent sequence must be rejected explicitly:
    // stamping 0 would make the next checkpoint supersede an entry that was
    // never tied to a checkpoint at all.
    const sequence = sequenceId != null && Number.isFinite(Number(sequenceId))
      ? Number(sequenceId)
      : (entry?.sequenceId ?? null);
    this._pendingByScope.set(key, {
      tokens: next,
      generation,
      sequenceId: sequence,
      expiresAt: this._now() + this._ttlMs,
    });
    return { tokens: next, generation };
  }

  release(key, tokens, generation = null) {
    const entry = this._entry(key);
    if (!entry) return 0;
    // A release from a generation this entry never counted is not this entry's
    // to give back: honouring it would deflate a sibling still in flight and
    // over-admit the next request.
    if (generation != null && Number(generation) !== entry.generation) return entry.tokens;
    const remaining = Math.max(0, entry.tokens - Math.max(0, Number(tokens) || 0));
    if (remaining > 0) {
      this._pendingByScope.set(key, { ...entry, tokens: remaining });
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
