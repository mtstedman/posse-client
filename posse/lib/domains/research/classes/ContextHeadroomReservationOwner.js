export class ContextHeadroomReservationOwner {
  constructor() {
    this._pendingByScope = new Map();
  }

  reservedTokens(key) {
    return Math.max(0, Number(this._pendingByScope.get(key) || 0));
  }

  reserve(key, tokens) {
    const next = this.reservedTokens(key) + Math.max(0, Number(tokens) || 0);
    if (next > 0) this._pendingByScope.set(key, next);
    return next;
  }

  release(key, tokens) {
    const remaining = Math.max(0, this.reservedTokens(key) - Math.max(0, Number(tokens) || 0));
    if (remaining > 0) this._pendingByScope.set(key, remaining);
    else this._pendingByScope.delete(key);
    return remaining;
  }
}

export const contextHeadroomReservationOwner = new ContextHeadroomReservationOwner();
