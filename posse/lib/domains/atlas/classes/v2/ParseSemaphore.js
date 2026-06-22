// @ts-check

export class ParseSemaphore {
  #max;
  #active = 0;
  /** @type {Array<() => void>} */
  #queue = [];

  /**
   * @param {number} max
   */
  constructor(max = 1) {
    this.#max = Math.max(1, Math.floor(Number(max) || 1));
  }

  get active() {
    return this.#active;
  }

  get pending() {
    return this.#queue.length;
  }

  /**
   * @template T
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(fn) {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  #acquire() {
    if (this.#active < this.#max) {
      this.#active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#queue.push(() => {
        this.#active++;
        resolve(undefined);
      });
    });
  }

  #release() {
    this.#active = Math.max(0, this.#active - 1);
    const next = this.#queue.shift();
    if (next) next();
  }
}
