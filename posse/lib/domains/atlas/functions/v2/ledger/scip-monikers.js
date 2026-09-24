// @ts-check
//
// View-build binding of external SCIP references by moniker.
//
// SCIP is staged and converted per batch, so a reference into a definition
// another batch indexed converts to an external moniker. The SCIP layer of
// each blob records the moniker of every structural definition it emitted,
// together with the repository path it was indexed at (layer metadata
// `scip_definitions`). The view build indexes those definitions over the
// CURRENT snapshot and resolves by moniker each external reference, and each
// reference intake bound to another blob's definition (the moniker that
// definition's layer recorded):
//
//   * defined at exactly one snapshot path and possibly nowhere else: the edge
//     binds that definition at that path (`bound`);
//   * otherwise, when its package is a repository package: the edge stays
//     external, or loses its intake binding, and claims no tree-sitter call
//     (`unbound`);
//   * otherwise the reference is genuinely external and keeps today's edge;
//     an intake binding into a layer that recorded no monikers (written before
//     rows spec v7) is kept as well.
//
// "Possibly nowhere else" is fail-closed. A definition registers only at the
// path its layer was indexed at, and only when the blob materializes from its
// layers. A moniker names a package-relative definition, so it may have twins
// the index cannot see:
//
//   * a duplicate blob at another path carries the definitions under that
//     path's own, unknown package identity: every moniker sharing a
//     descriptor the copy's path can carry (it ends with the descriptor's
//     package-relative file path) stays unbound (`shadowed`);
//   * two definition paths of one moniker mean two package roots share a
//     package identity (sample apps with one `package.json` name): no moniker
//     of that package binds (colliding).
//
// Copies cut the other way too: an intake binding names a blob's content, not
// which copy, so one into a blob several snapshot paths hold does not bind;
// and a caller copy at a path its layer was not indexed at referenced its
// targets from the indexed path, so none of its repository monikers binds
// (`foreignCopies`).
//
// The moniker is the `external_symbols` identity (scheme, manager, package
// name, package version, descriptor). Posse-bin's native view build
// (`view_write/scip_monikers.rs`) implements the same rules.

import { languageForPath } from "../parse/language-buckets.js";

/**
 * @typedef {{ status: "bound", repo_rel_path: string, content_hash: string, local_id: number }
 *   | { status: "unbound" }} ScipMonikerTarget
 */

/**
 * @typedef {{ repo_rel_path: string, content_hash: string, local_id: number }} DefinitionSite
 * @typedef {{
 *   definitions: Map<string, DefinitionSite[]>,
 *   shadowed: Set<string>,
 *   hashPaths: Map<string, number>,
 *   foreignCopies: Set<string>,
 * }} ScipMonikerIndex
 * @typedef {{ atPath: boolean, definitions: Array<{ localId: number, key: string, descriptor: string }> }} RecordedDefinitions
 */

const LAYER_SOURCES = new Set(["treesitter", "scip"]);

/**
 * @param {unknown[]} fields scheme, manager, package name, package version, descriptor
 * @returns {string}
 */
function monikerKey(fields) {
  return JSON.stringify(fields.map((field) => String(field)));
}

/**
 * @param {string} key
 * @returns {string}
 */
function packageKey(key) {
  return JSON.stringify(/** @type {string[]} */ (JSON.parse(key)).slice(0, 4));
}

/**
 * @param {string} key
 * @returns {string}
 */
function descriptorOf(key) {
  return /** @type {string[]} */ (JSON.parse(key))[4];
}

/**
 * Distinct sources of each blob's legacy flat projection. A blob whose active
 * layers do not cover them materializes from the flat rows instead.
 *
 * @param {import("better-sqlite3").Database} ledgerDb
 * @returns {Map<string, Set<string>>}
 */
export function readLegacySourcesByHash(ledgerDb) {
  /** @type {Map<string, Set<string>>} */
  const bySource = new Map();
  try {
    for (const row of /** @type {Array<{ content_hash: string, source: string | null }>} */ (
      ledgerDb.prepare("SELECT DISTINCT content_hash, source FROM blob_symbols").all()
    )) {
      let set = bySource.get(row.content_hash);
      if (!set) { set = new Set(); bySource.set(row.content_hash, set); }
      set.add(String(row.source || "treesitter"));
    }
  } catch { /* no legacy rows / no source column — fall back only on empty layers */ }
  return bySource;
}

/**
 * The layer language the view merge reads for a path: its path language, else
 * the blob's first layer language.
 *
 * @param {import("better-sqlite3").Database} ledgerDb
 * @param {string} repoRelPath
 * @param {string} contentHash
 * @returns {string | null}
 */
function layerLangForPath(ledgerDb, repoRelPath, contentHash) {
  const lang = languageForPath(repoRelPath);
  if (lang && lang !== "unknown") return lang;
  const row = /** @type {{ lang?: string } | undefined} */ (
    ledgerDb.prepare(
      "SELECT lang FROM blob_layers WHERE content_hash = ? ORDER BY id ASC LIMIT 1",
    ).get(contentHash)
  );
  return row?.lang || null;
}

/**
 * Parse a SCIP layer's `metadata_json` into the path its definitions were
 * recorded for and the definitions; `null` when it recorded none.
 *
 * @param {number} layerId
 * @param {string | null} metadataJson
 * @returns {{ repoRelPath: string | null, definitions: RecordedDefinitions["definitions"] } | null}
 */
function parseRecorded(layerId, metadataJson) {
  if (!metadataJson) return null;
  let metadata;
  try {
    metadata = JSON.parse(metadataJson);
  } catch (err) {
    throw new Error(`blob_layers.metadata_json of SCIP layer ${layerId} is malformed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const recorded = metadata?.scip_definitions;
  if (!recorded) return null;
  const monikers = recorded.monikers ?? [];
  if (!Array.isArray(monikers)) {
    throw new Error(`SCIP layer ${layerId} scip_definitions.monikers is not an array`);
  }
  return {
    repoRelPath: typeof recorded.repo_rel_path === "string" ? recorded.repo_rel_path : null,
    definitions: monikers.map((definition) => {
      if (!Array.isArray(definition) || definition.length !== 6 || !Number.isInteger(definition[0])
        || definition.slice(1).some((field) => typeof field !== "string")) {
        throw new Error(`SCIP layer ${layerId} has a malformed scip_definitions moniker`);
      }
      return { localId: definition[0], key: monikerKey(definition.slice(1)), descriptor: definition[5] };
    }),
  };
}

/**
 * The structural SCIP definitions the newest SCIP layer of the blob at
 * `repoRelPath` recorded, when the blob materializes from its layers, and
 * whether they were recorded for this very path.
 *
 * @param {import("better-sqlite3").Database} ledgerDb
 * @param {string} repoRelPath
 * @param {string} contentHash
 * @param {Map<string, Set<string>>} legacySourcesByHash
 * @returns {RecordedDefinitions | null}
 */
function recordedDefinitions(ledgerDb, repoRelPath, contentHash, legacySourcesByHash) {
  const lang = layerLangForPath(ledgerDb, repoRelPath, contentHash);
  if (!lang) return null;
  const layers = /** @type {Array<{ id: number, source: string, metadata_json: string | null }>} */ (
    ledgerDb.prepare(
      `SELECT id, source, metadata_json FROM blob_layers
       WHERE content_hash = ? AND lang = ? AND status = 'indexed'
       ORDER BY indexed_at DESC, id DESC`,
    ).all(contentHash, lang)
  );
  const scip = layers.find((layer) => layer.source === "scip");
  if (!scip) return null;
  const layerSources = new Set(layers.map((layer) => layer.source).filter((source) => LAYER_SOURCES.has(source)));
  const legacySources = legacySourcesByHash.get(contentHash);
  if (legacySources && ![...legacySources].every((source) => layerSources.has(source))) return null;
  const recorded = parseRecorded(scip.id, scip.metadata_json);
  return recorded
    ? { atPath: recorded.repoRelPath === repoRelPath, definitions: recorded.definitions }
    : null;
}

/**
 * Whether a copy of a blob at `repoRelPath` may define `descriptor` under its
 * own package identity: the path, from some segment on, is the descriptor's
 * leading package-relative file path (backtick escapes removed), as for
 * `sample/b/src/app.ts` and ``src/`app.ts`/App#``.
 *
 * @param {string} repoRelPath
 * @param {string} descriptor
 * @returns {boolean}
 */
function pathMayCarry(repoRelPath, descriptor) {
  const plain = descriptor.replaceAll("`", "");
  const segments = repoRelPath.split("/");
  return segments.some((_, index) => plain.startsWith(`${segments.slice(index).join("/")}/`));
}

/**
 * Index the structural SCIP definitions of a snapshot by moniker.
 *
 * @param {import("better-sqlite3").Database} ledgerDb
 * @param {Iterable<[string, string]>} snapshot repo path -> content hash
 * @param {Map<string, Set<string>>} legacySourcesByHash
 * @returns {ScipMonikerIndex}
 */
export function buildScipMonikerIndex(ledgerDb, snapshot, legacySourcesByHash) {
  /** @type {Map<string, DefinitionSite[]>} */
  const definitions = new Map();
  /** @type {Set<string>} */
  const shadowed = new Set();
  /** @type {Map<string, number>} */
  const hashPaths = new Map();
  /** @type {Set<string>} */
  const foreignCopies = new Set();
  for (const [repoRelPath, contentHash] of snapshot) {
    increment(hashPaths, contentHash);
    const recorded = recordedDefinitions(ledgerDb, repoRelPath, contentHash, legacySourcesByHash);
    if (!recorded) continue;
    if (!recorded.atPath) foreignCopies.add(repoRelPath);
    for (const { localId, key, descriptor } of recorded.definitions) {
      if (!recorded.atPath) {
        if (pathMayCarry(repoRelPath, descriptor)) shadowed.add(descriptor);
        continue;
      }
      const sites = definitions.get(key) || [];
      sites.push({ repo_rel_path: repoRelPath, content_hash: contentHash, local_id: localId });
      definitions.set(key, sites);
    }
  }
  return { definitions, shadowed, hashPaths, foreignCopies };
}

/**
 * Repository packages of an index and whether each collides (has a moniker
 * defined at several paths), counting `extra` additional definition paths per
 * moniker.
 *
 * @param {ScipMonikerIndex} index
 * @param {Map<string, number>} [extra]
 * @returns {Map<string, boolean>}
 */
function packageStatus(index, extra = new Map()) {
  /** @type {Map<string, boolean>} */
  const status = new Map();
  const note = (/** @type {string} */ key, /** @type {number} */ sites) => {
    const pkg = packageKey(key);
    status.set(pkg, status.get(pkg) === true || sites > 1);
  };
  for (const [key, sites] of index.definitions) note(key, sites.length);
  for (const [key, count] of extra) note(key, (index.definitions.get(key)?.length ?? 0) + count);
  return status;
}

/**
 * Moniker resolution of one blob's SCIP references at one path.
 *
 * @typedef {{
 *   external: (externalId: number) => ScipMonikerTarget | null,
 *   definition: (contentHash: string, localId: number) => ScipMonikerTarget | null,
 * }} ScipTargetResolver
 */

/**
 * Moniker resolution over a snapshot: `forPath` resolves the references of
 * the blob at a path; `foreignCopy` says whether that blob's layer was
 * indexed at another path (its resolution then differs from other copies').
 *
 * @typedef {{
 *   forPath: (repoRelPath: string) => ScipTargetResolver,
 *   foreignCopy: (repoRelPath: string) => boolean,
 * }} ScipTargets
 */

/**
 * The SCIP-layer local id -> moniker key map the newest SCIP layer of a blob
 * recorded, whatever path it was recorded for; `null` when it recorded none.
 *
 * @param {import("better-sqlite3").Database} ledgerDb
 * @param {string} contentHash
 * @returns {Map<number, string> | null}
 */
function recordedMonikers(ledgerDb, contentHash) {
  const row = /** @type {{ id: number, metadata_json: string | null } | undefined} */ (
    ledgerDb.prepare(
      `SELECT id, metadata_json FROM blob_layers WHERE content_hash = ? AND source = 'scip'
       AND status = 'indexed' ORDER BY indexed_at DESC, id DESC LIMIT 1`,
    ).get(contentHash)
  );
  const recorded = row ? parseRecorded(row.id, row.metadata_json) : null;
  return recorded ? new Map(recorded.definitions.map(({ localId, key }) => [localId, key])) : null;
}

/**
 * Resolve SCIP references against a moniker index: ledger `external_symbols`
 * ids (`external`, genuinely external ids resolve to `null`) and intake
 * bindings to another blob's definition (`definition`, through the moniker
 * that blob's layer recorded; `null` keeps a binding into a layer that
 * recorded none). A blob several snapshot paths hold never binds: intake
 * named its content, not which copy, and the recorded moniker belongs to one
 * copy only. A duplicate blob's references out of its file were indexed from
 * the path its layer records; at any other copy a repository moniker may mean
 * another target, so none binds there.
 *
 * @param {import("better-sqlite3").Database} ledgerDb
 * @param {ScipMonikerIndex} index
 * @returns {ScipTargets}
 */
export function createScipTargets(ledgerDb, index) {
  const read = ledgerDb.prepare(
    `SELECT scheme, manager, package_name, package_version, descriptor
     FROM external_symbols WHERE id = ?`,
  );
  /** @type {Map<number, ScipMonikerTarget | null>} */
  const externals = new Map();
  /** @type {Map<string, Map<number, string> | null>} */
  const recorded = new Map();
  /** @type {Map<string, boolean> | null} */
  let packages = null;
  /**
   * @param {string} key
   * @returns {ScipMonikerTarget | null}
   */
  const resolve = (key) => {
    const sites = index.definitions.get(key);
    packages ??= packageStatus(index);
    const colliding = packages.get(packageKey(key));
    if (sites && sites.length === 1 && colliding === false && !index.shadowed.has(descriptorOf(key))) {
      return { status: "bound", ...sites[0] };
    }
    return colliding !== undefined ? { status: "unbound" } : null;
  };
  /** @type {ScipTargetResolver} */
  const indexed = {
    external(externalId) {
      const id = Number(externalId);
      if (!Number.isInteger(id)) return null;
      if (externals.has(id)) return /** @type {ScipMonikerTarget | null} */ (externals.get(id));
      const row = /** @type {any} */ (read.get(id));
      const target = row
        ? resolve(monikerKey([row.scheme, row.manager, row.package_name, row.package_version, row.descriptor]))
        : null;
      externals.set(id, target);
      return target;
    },
    definition(contentHash, localId) {
      if (!recorded.has(contentHash)) recorded.set(contentHash, recordedMonikers(ledgerDb, contentHash));
      const monikers = recorded.get(contentHash);
      if (!monikers) return null;
      if ((index.hashPaths.get(contentHash) ?? 0) > 1) return { status: "unbound" };
      // The definition is the repository's own: when its moniker does not
      // bind, the intake binding is dropped, never kept.
      const key = monikers.get(Number(localId));
      return (key ? resolve(key) : null) ?? { status: "unbound" };
    },
  };
  /** @type {ScipTargetResolver} */
  const foreign = {
    external(externalId) {
      const target = indexed.external(externalId);
      return target?.status === "bound" ? { status: "unbound" } : target;
    },
    definition(contentHash, localId) {
      return indexed.definition(contentHash, localId) && { status: "unbound" };
    },
  };
  return {
    forPath: (repoRelPath) => (index.foreignCopies.has(repoRelPath) ? foreign : indexed),
    foreignCopy: (repoRelPath) => index.foreignCopies.has(repoRelPath),
  };
}

/**
 * @param {Map<string, number>} counts
 * @param {string} key
 */
function increment(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Paths outside the changed ones whose SCIP edges may bind differently once
 * the entries apply, so the incremental apply rebuilds their edges exactly as
 * a full build would: every path with a SCIP edge that binds nothing, every
 * path with a SCIP edge bound into a changed path, into another copy of a
 * blob a changed path holds (before or after), or into a path defining a
 * moniker whose resolution the entries can change, and every path with an
 * external edge naming such a moniker. The entries can change the resolution
 * of every moniker sharing a descriptor a changed path records (before or
 * after), and of every moniker of a package that appears, disappears, or
 * starts or stops colliding. Must run before the entries replace the changed
 * paths' symbols, while inbound edges are still bound.
 *
 * @param {{
 *   viewDb: import("better-sqlite3").Database,
 *   ledgerDb: import("better-sqlite3").Database,
 *   current: Map<string, string>,
 *   after: Map<string, string | null>,
 *   legacySourcesByHash: Map<string, Set<string>>,
 *   layerMerge: boolean,
 * }} args
 * @returns {Set<string>}
 */
export function scipRebindCallers({ viewDb, ledgerDb, current, after, legacySourcesByHash, layerMerge }) {
  const definers = new Set(after.keys());
  // Other copies of a blob a changed path held or will hold: the copy count
  // decides whether intake bindings into them stand.
  const changedHashes = new Set([
    ...[...after.keys()].map((repoRelPath) => current.get(repoRelPath)),
    ...after.values(),
  ].filter(Boolean));
  for (const [repoRelPath, hash] of current) {
    if (changedHashes.has(hash)) definers.add(repoRelPath);
  }
  /** @type {Set<string>} */
  const descriptors = new Set();
  /** @type {Set<string>} */
  const changedPackages = new Set();
  // Monikers bind only merged layers; a flat view rebinds hash targets only.
  if (layerMerge) {
    const unchanged = [...current].filter(([repoRelPath]) => !after.has(repoRelPath));
    const index = buildScipMonikerIndex(ledgerDb, unchanged, legacySourcesByHash);
    // Definition paths per moniker the changed paths register before and
    // after the entries.
    /** @type {Map<string, number>} */
    const beforeKeys = new Map();
    /** @type {Map<string, number>} */
    const afterKeys = new Map();
    for (const [repoRelPath, nextHash] of after) {
      for (const [hash, counts] of /** @type {Array<[string | null | undefined, Map<string, number>]>} */ ([
        [current.get(repoRelPath), beforeKeys],
        [nextHash, afterKeys],
      ])) {
        if (!hash) continue;
        const recorded = recordedDefinitions(ledgerDb, repoRelPath, hash, legacySourcesByHash);
        if (!recorded) continue;
        for (const { key, descriptor } of recorded.definitions) {
          descriptors.add(descriptor);
          if (recorded.atPath) increment(counts, key);
        }
      }
    }
    const beforePackages = packageStatus(index, beforeKeys);
    const afterPackages = packageStatus(index, afterKeys);
    for (const pkg of [...beforePackages.keys(), ...afterPackages.keys()]) {
      if (beforePackages.get(pkg) !== afterPackages.get(pkg)) changedPackages.add(pkg);
    }
    for (const [key, sites] of index.definitions) {
      if (!descriptors.has(descriptorOf(key)) && !changedPackages.has(packageKey(key))) continue;
      for (const site of sites) definers.add(site.repo_rel_path);
    }
  }
  // A SCIP edge that binds nothing names a target blob or definition missing
  // from the snapshot; any entry may supply it.
  const callers = new Set(/** @type {Array<{ repo_rel_path: string }>} */ (viewDb.prepare(
    `SELECT DISTINCT repo_rel_path FROM edges
     WHERE source = 'scip' AND to_global_id IS NULL AND to_external_id IS NULL`,
  ).all()).map((row) => row.repo_rel_path));
  const inbound = viewDb.prepare(
    `SELECT DISTINCT e.repo_rel_path FROM edges e
     JOIN symbols s ON s.global_id = e.to_global_id
     WHERE s.repo_rel_path = ? AND e.source = 'scip' AND e.repo_rel_path <> ?`,
  );
  for (const definer of definers) {
    for (const row of /** @type {Array<{ repo_rel_path: string }>} */ (inbound.all(definer, definer))) {
      callers.add(row.repo_rel_path);
    }
  }
  if (descriptors.size > 0 || changedPackages.size > 0) {
    const external = viewDb.prepare("SELECT DISTINCT repo_rel_path FROM edges WHERE to_external_id = ?");
    for (const row of /** @type {Array<{ id: number, scheme: string, manager: string, package_name: string, package_version: string, descriptor: string }>} */ (
      ledgerDb.prepare(
        "SELECT id, scheme, manager, package_name, package_version, descriptor FROM external_symbols",
      ).all()
    )) {
      const key = monikerKey([row.scheme, row.manager, row.package_name, row.package_version, row.descriptor]);
      if (!descriptors.has(row.descriptor) && !changedPackages.has(packageKey(key))) continue;
      for (const caller of /** @type {Array<{ repo_rel_path: string }>} */ (external.all(row.id))) {
        callers.add(caller.repo_rel_path);
      }
    }
  }
  for (const repoRelPath of after.keys()) callers.delete(repoRelPath);
  return callers;
}
