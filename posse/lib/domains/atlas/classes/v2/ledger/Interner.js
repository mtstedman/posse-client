// @ts-check
//
// ATLAS v2 Ledger — string/path interner. The `interned_strings` and
// `interned_paths` tables keep blob_symbols/blob_edges narrow by storing
// repeated kinds/names/qualified-names/paths once and referencing them by id.
// No in-memory cache — SQLite is the source of truth — but it owns its own
// prepared statements over the shared connection. Shared by the Ledger
// wireframe and the domain stores (BlobStore, ScipIndexStore) that write
// interned references.

export class Interner {
  /** @type {Record<string, import("better-sqlite3").Statement>} */
  #stmt;

  /** @param {import("better-sqlite3").Database} db */
  constructor(db) {
    this.#stmt = {
      internStringSelect: db.prepare("SELECT id FROM interned_strings WHERE value = ?"),
      internStringInsert: db.prepare(
        "INSERT INTO interned_strings(value) VALUES(?) ON CONFLICT(value) DO UPDATE SET value = value RETURNING id",
      ),
      internPathSelect: db.prepare("SELECT id FROM interned_paths WHERE path = ?"),
      internPathInsert: db.prepare(
        "INSERT INTO interned_paths(path) VALUES(?) ON CONFLICT(path) DO UPDATE SET path = path RETURNING id",
      ),
    };
  }

  /**
   * @param {string} value
   * @returns {number}
   */
  internString(value) {
    const found = /** @type {{ id: number } | undefined} */ (
      this.#stmt.internStringSelect.get(value)
    );
    if (found) return found.id;
    const ins = /** @type {{ id: number }} */ (this.#stmt.internStringInsert.get(value));
    return ins.id;
  }

  /**
   * @param {string} repo_rel_path
   * @returns {number}
   */
  internPath(repo_rel_path) {
    const found = /** @type {{ id: number } | undefined} */ (
      this.#stmt.internPathSelect.get(repo_rel_path)
    );
    if (found) return found.id;
    const ins = /** @type {{ id: number }} */ (this.#stmt.internPathInsert.get(repo_rel_path));
    return ins.id;
  }

  /**
   * @param {string} repo_rel_path
   * @returns {number | null}
   */
  pathId(repo_rel_path) {
    const found = /** @type {{ id: number } | undefined} */ (
      this.#stmt.internPathSelect.get(repo_rel_path)
    );
    return found ? found.id : null;
  }
}
