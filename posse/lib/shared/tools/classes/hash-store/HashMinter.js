import crypto from "crypto";
import {
  HASH_REF_ALIAS_PATTERN,
  normalizeHashRefAlias,
} from "../../../../catalog/hash-store.js";

const DEFAULT_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const DEFAULT_WIDTH = 4;
const DEFAULT_MAX_WIDTH = 12;
const DEFAULT_OCCUPANCY_GROWTH_RATIO = 0.65;
const DEFAULT_COLLISION_GROWTH_THRESHOLD = 8;
const DEFAULT_MAX_ATTEMPTS_PER_WIDTH = 256;

function nowIso() {
  return new Date().toISOString();
}

function randomAlias(width, alphabet, randomInt) {
  let out = "#";
  for (let i = 0; i < width; i += 1) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

export class HashMinter {
  constructor({
    db,
    alphabet = DEFAULT_ALPHABET,
    minWidth = DEFAULT_WIDTH,
    maxWidth = DEFAULT_MAX_WIDTH,
    occupancyGrowthRatio = DEFAULT_OCCUPANCY_GROWTH_RATIO,
    collisionGrowthThreshold = DEFAULT_COLLISION_GROWTH_THRESHOLD,
    maxAttemptsPerWidth = DEFAULT_MAX_ATTEMPTS_PER_WIDTH,
    randomInt = crypto.randomInt,
  } = {}) {
    if (!db) throw new Error("HashMinter requires a db");
    this.db = db;
    this.alphabet = String(alphabet || DEFAULT_ALPHABET);
    this.minWidth = Math.max(1, Number(minWidth) || DEFAULT_WIDTH);
    this.maxWidth = Math.max(this.minWidth, Number(maxWidth) || DEFAULT_MAX_WIDTH);
    this.occupancyGrowthRatio = Number.isFinite(Number(occupancyGrowthRatio))
      ? Math.max(0.01, Math.min(0.95, Number(occupancyGrowthRatio)))
      : DEFAULT_OCCUPANCY_GROWTH_RATIO;
    this.collisionGrowthThreshold = Math.max(1, Number(collisionGrowthThreshold) || DEFAULT_COLLISION_GROWTH_THRESHOLD);
    this.maxAttemptsPerWidth = Math.max(1, Number(maxAttemptsPerWidth) || DEFAULT_MAX_ATTEMPTS_PER_WIDTH);
    this.randomInt = randomInt;
  }

  ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hash_ref_aliases (
        ref TEXT PRIMARY KEY,
        width INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_hash_ref_aliases_width ON hash_ref_aliases(width, created_at)`);
  }

  refExists(ref) {
    const normalized = normalizeHashRefAlias(ref);
    if (!normalized) return false;
    this.ensureSchema();
    return !!this.db.prepare(`SELECT 1 FROM hash_ref_aliases WHERE ref = ?`).get(normalized);
  }

  reserve(ref) {
    const normalized = normalizeHashRefAlias(ref);
    if (!HASH_REF_ALIAS_PATTERN.test(normalized)) {
      throw new Error(`Invalid hash ref alias: ${ref}`);
    }
    this.ensureSchema();
    const width = normalized.length - 1;
    this.db.prepare(`
      INSERT INTO hash_ref_aliases (ref, width, created_at)
      VALUES (?, ?, ?)
    `).run(normalized, width, nowIso());
    return { ref: normalized, width };
  }

  release(ref) {
    const normalized = normalizeHashRefAlias(ref);
    if (!normalized) return false;
    this.ensureSchema();
    return this.db.prepare(`DELETE FROM hash_ref_aliases WHERE ref = ?`).run(normalized).changes > 0;
  }

  chooseWidth() {
    this.ensureSchema();
    for (let width = this.minWidth; width < this.maxWidth; width += 1) {
      const capacity = this.alphabet.length ** width;
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM hash_ref_aliases WHERE width = ?`).get(width);
      const count = Number(row?.count || 0);
      if (count / capacity < this.occupancyGrowthRatio) return width;
    }
    return this.maxWidth;
  }

  mint() {
    this.ensureSchema();
    let width = this.chooseWidth();
    let collisionsAtWidth = 0;

    while (width <= this.maxWidth) {
      for (let attempt = 0; attempt < this.maxAttemptsPerWidth; attempt += 1) {
        const ref = randomAlias(width, this.alphabet, this.randomInt);
        try {
          this.db.prepare(`
            INSERT INTO hash_ref_aliases (ref, width, created_at)
            VALUES (?, ?, ?)
          `).run(ref, width, nowIso());
          return { ref, width };
        } catch (err) {
          if (!/UNIQUE|constraint/i.test(err?.message || String(err))) throw err;
          collisionsAtWidth += 1;
          if (collisionsAtWidth >= this.collisionGrowthThreshold) break;
        }
      }
      width += 1;
      collisionsAtWidth = 0;
    }

    throw new Error(`Unable to mint a unique hash ref up to width ${this.maxWidth}`);
  }
}

export const __testHashMinterInternals = Object.freeze({
  normalizeRef: normalizeHashRefAlias,
  randomAlias,
});
