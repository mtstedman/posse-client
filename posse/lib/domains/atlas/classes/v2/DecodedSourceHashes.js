// @ts-check
//
// Indexed content hashes are SHA-256 of the raw file bytes, but retrieval
// reads hand handlers decoded text. When that text does not re-encode to the
// same bytes (BOM-marked, UTF-16 or invalid UTF-8 source), this remembers which
// raw-byte hashes decode to it. Each entry is a fact about the decoder, not
// about any one file, so it never goes stale; the bound only limits memory.

const DEFAULT_CAPACITY = 4096;

export class DecodedSourceHashes {
  /**
   * @param {{ capacity?: number }} [opts]
   */
  constructor({ capacity = DEFAULT_CAPACITY } = {}) {
    this.capacity = Math.max(1, capacity);
    /** @type {Set<string>} */
    this.pairs = new Set();
  }

  /**
   * @param {string} textHash  SHA-256 of the decoded text as UTF-8.
   * @param {string} bytesHash SHA-256 of the raw bytes it was decoded from.
   */
  record(textHash, bytesHash) {
    const key = `${textHash}:${bytesHash}`;
    this.pairs.delete(key);
    this.pairs.add(key);
    while (this.pairs.size > this.capacity) {
      const oldest = this.pairs.values().next().value;
      if (oldest === undefined) break;
      this.pairs.delete(oldest);
    }
  }

  /**
   * @param {string} textHash
   * @param {string} bytesHash
   */
  has(textHash, bytesHash) {
    return this.pairs.has(`${textHash}:${bytesHash}`);
  }
}

const DECODED_SOURCE_HASHES = new DecodedSourceHashes();

export function getDecodedSourceHashes() {
  return DECODED_SOURCE_HASHES;
}
