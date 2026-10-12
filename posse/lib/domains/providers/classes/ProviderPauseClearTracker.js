// @ts-check
// Applies each persisted operator clear once per provider. A later routing
// pause must survive repeated reads of the same clear record.
export class ProviderPauseClearTracker {
  #applied = new Map();

  apply(provider, clearedAtMs, clear) {
    if (!Number.isFinite(clearedAtMs) || this.#applied.get(provider) === clearedAtMs) return;
    this.#applied.set(provider, clearedAtMs);
    clear();
  }
}

export const providerPauseClearTracker = new ProviderPauseClearTracker();
