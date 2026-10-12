// @ts-check
// Process-local notification ownership, with explicit subscription disposal.
// One failing cache invalidator must not prevent the others from running.
export class SettingsChangeNotifier {
  #listeners = new Set();

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("settings listener must be a function");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  notify() {
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* cache invalidation is best effort */ }
    }
  }
}

export const settingsChangeNotifier = new SettingsChangeNotifier();
