// @ts-check
//
// Fidelity-preserving A+B layer merge.
//
// Reads the tree-sitter (A) and SCIP (B) layers for one blob and produces
// flat-shaped symbol/edge rows — the SAME shape ViewBuilder's legacy
// `blob_symbols`/`blob_edges` read returns — so `buildFrom`'s global_id
// mapping / parent backfill / cross-blob resolver run unchanged on the output.
//
// Merge contract ("A first, B enriches"), order-independent:
//   * Base source (tree-sitter if present, else scip when it lands alone)
//     keeps EVERY symbol by its own id — no intra-source collapse. This is the
//     fidelity guarantee the merge-key-keyed `materializeLayeredPath` loses.
//   * Overlay source (scip, when both are present) ENRICHES the base symbol it
//     matches by (kind, qualified||name); non-matching overlay symbols are
//     ADDED with fresh ids.
//   * parent_local_id is threaded through the id remap so nesting survives.
//
// The output is identity-stable regardless of which layer was written first:
// the merge always reads base-then-overlay and emits the canonical A+B shape.

import { callSiteOffset, treesitterCallsAtScipSites } from "./call-site-dedupe.js";

const SOURCE_ORDER = ["treesitter", "scip"];

function parseJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function mergeKey(kind, qualifiedOrName) {
  return `${String(kind || "")}\0${String(qualifiedOrName || "")}`;
}

function locationMergeKey(name, rangeStart, rangeStartLine) {
  // Tree-sitter usually spans the whole declaration while SCIP spans only
  // its identifier, and the two parsers can disagree on broad kinds (for
  // example enum/class or let/const). A unique same-name declaration on the
  // same source line is the stable cross-parser identity. Fall back to the
  // exact offset only for producers that omit line numbers.
  const location = Number.isInteger(rangeStartLine)
    ? `line:${rangeStartLine}`
    : `offset:${rangeStart ?? ""}`;
  return [String(name || ""), location].join("\0");
}

function declarationRangesOverlap(left, right) {
  const leftStart = num(left?.range_start, 0);
  const leftEnd = num(left?.range_end, leftStart);
  const rightStart = num(right?.range_start, 0);
  const rightEnd = num(right?.range_end, rightStart);
  if (leftEnd <= leftStart || rightEnd <= rightStart) return leftStart === rightStart;
  return leftStart < rightEnd && rightStart < leftEnd;
}

function sourceLocalKey(source, localId) {
  return `${String(source || "treesitter")}\0${String(localId)}`;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nullableInt(value) {
  return Number.isInteger(value) ? value : null;
}

function confidenceScore(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : -1;
}

function edgeDedupKey(edge) {
  if (edge.kind === "calls") {
    return [
      "calls",
      edge.from_local_id,
      edge.to_content_hash ?? "",
      edge.to_local_id ?? "",
      edge.to_external_id ?? "",
      edge.to_name ?? "",
      edge.to_module ?? "",
      edge.range_start,
    ].join("\0");
  }
  return [
    edge.from_local_id,
    edge.to_content_hash ?? "",
    edge.to_local_id ?? "",
    edge.to_external_id ?? "",
    edge.to_name ?? "",
    edge.kind,
    edge.range_start,
    edge.source,
  ].join("\0");
}

/**
 * Latest indexed layer per source, ordered tree-sitter first.
 * @param {import("better-sqlite3").Database} ledgerDb
 * @param {string} contentHash
 * @param {string} lang
 * @returns {Array<{ id: number, source: "treesitter" | "scip" }>}
 */
function latestLayers(ledgerDb, contentHash, lang) {
  const rows = /** @type {Array<{ id: number, source: string }>} */ (
    ledgerDb.prepare(
      `SELECT id, source FROM blob_layers
       WHERE content_hash = ? AND lang = ? AND status = 'indexed'
       ORDER BY indexed_at DESC, id DESC`,
    ).all(contentHash, lang)
  );
  const bySource = new Map();
  for (const r of rows) {
    if ((r.source === "treesitter" || r.source === "scip") && !bySource.has(r.source)) {
      bySource.set(r.source, { id: Number(r.id), source: r.source });
    }
  }
  return /** @type {any} */ (SOURCE_ORDER.map((s) => bySource.get(s)).filter(Boolean));
}

function readLayerSymbols(ledgerDb, layerId) {
  return /** @type {any[]} */ (
    ledgerDb.prepare(
      `SELECT local_id, lang, kind, name, signature, container, range_json, doc, detail_json
       FROM blob_layer_symbols WHERE layer_id = ? ORDER BY local_id ASC`,
    ).all(layerId)
  );
}

// Layer edges keep only the external id; the view denormalizes the descriptor
// like the flat `blob_edges` read does.
function readLayerEdges(ledgerDb, layerId) {
  return /** @type {any[]} */ (
    ledgerDb.prepare(
      `SELECT e.edge_id, e.kind, e.from_local_id, e.to_local_id, e.to_symbol, e.range_json, e.detail_json,
              es.descriptor AS external_descriptor
       FROM blob_layer_edges e
       LEFT JOIN external_symbols es ON es.id = CASE WHEN json_valid(e.detail_json)
         THEN json_extract(e.detail_json, '$.to_external_id') END
       WHERE e.layer_id = ? ORDER BY e.edge_id ASC`,
    ).all(layerId)
  );
}

/**
 * @param {string} contentHash
 * @param {string} lang
 * @param {number} mergedLocalId
 * @param {number} srcLayerId
 * @param {any} layerRow
 */
function symbolRowFrom(contentHash, lang, mergedLocalId, srcLayerId, layerRow) {
  const detail = parseJson(layerRow.detail_json) || {};
  const range = parseJson(layerRow.range_json) || {};
  const qualified = layerRow.container ?? detail.qualified_name ?? null;
  return {
    content_hash: contentHash,
    local_id: mergedLocalId,
    kind: layerRow.kind,
    name: layerRow.name,
    qualified_name: qualified,
    parent_local_id: null, // remapped in pass 2
    range_start: num(range.range_start, 0),
    range_end: num(range.range_end, 0),
    range_start_line: nullableInt(range.range_start_line),
    range_end_line: nullableInt(range.range_end_line),
    signature_hash: detail.signature_hash ?? null,
    signature_text: detail.signature_text ?? layerRow.signature ?? null,
    body_identifiers: typeof detail.body_identifiers === "string" ? detail.body_identifiers : null,
    visibility: detail.visibility ?? null,
    doc: layerRow.doc ?? null,
    lang: layerRow.lang || lang,
    source: detail.source || (srcLayerId === -1 ? "scip" : "treesitter"),
    // transient — stripped before return
    _srcLayerId: srcLayerId,
    _srcParent: detail.parent_local_id ?? null,
  };
}

/**
 * Resolve the layer language for a content hash when the caller (e.g.
 * ViewBuilder, which only has the hash) doesn't already know it.
 * @param {import("better-sqlite3").Database} ledgerDb
 * @param {string} contentHash
 * @returns {string | null}
 */
function layerLangFor(ledgerDb, contentHash) {
  const row = /** @type {{ lang?: string } | undefined} */ (
    ledgerDb.prepare(
      "SELECT lang FROM blob_layers WHERE content_hash = ? ORDER BY id ASC LIMIT 1",
    ).get(contentHash)
  );
  return row?.lang || null;
}

/**
 * Merge the A/B layers for one content hash into flat-shaped rows.
 *
 * `scipTargets` is the view build's moniker resolution (`scip-monikers.js`)
 * of the blob's external SCIP references (`external`) and of those intake
 * bound to another blob's definition (`definition`). A `bound` target rewrites
 * the SCIP edge onto that definition (a SCIP-layer local id of
 * `content_hash`, bound at `repo_rel_path`); an `unbound` one keeps an
 * external edge external, drops an intake binding, and lets the edge claim no
 * tree-sitter call; `null` keeps the edge as intake stored it.
 *
 * @param {import("better-sqlite3").Database} ledgerDb
 * @param {string} contentHash
 * @param {string | null} [lang] - derived from the layers when omitted
 * @param {{ scipTargets?: import("./scip-monikers.js").ScipTargetResolver | null }} [opts]
 * @returns {{ symbols: any[], edges: any[], sources: string[], sourceLocalToMerged: Map<string, number> }}
 */
export function mergeLayerRows(ledgerDb, contentHash, lang = null, opts = {}) {
  const scipTargets = opts.scipTargets ?? null;
  const resolvedLang = lang || layerLangFor(ledgerDb, contentHash);
  if (!resolvedLang) return { symbols: [], edges: [], sources: [], sourceLocalToMerged: new Map() };
  const layers = latestLayers(ledgerDb, contentHash, resolvedLang);
  if (layers.length === 0) return { symbols: [], edges: [], sources: [], sourceLocalToMerged: new Map() };

  const baseLayer = layers[0];
  const overlayLayer = layers[1] || null;

  const symbols = [];
  /** mergeKey -> merged local_id (for overlay enrichment matching) */
  const keyToMerged = new Map();
  /** locationMergeKey -> candidate merged local_ids. */
  const locationToMerged = new Map();
  /** "layerId:srcLocalId" -> merged local_id (parent + edge remap) */
  const remap = new Map();
  /** "source\0srcLocalId" -> merged local_id for cross-blob target remap. */
  const sourceLocalToMerged = new Map();
  /** merged local_id -> symbol row (for enrichment) */
  const byMerged = new Map();
  let nextLocalId = 0;

  // Base: keep every symbol (no intra-source collapse).
  for (const row of readLayerSymbols(ledgerDb, baseLayer.id)) {
    const mergedId = nextLocalId++;
    const sym = symbolRowFrom(contentHash, resolvedLang, mergedId, baseLayer.id, row);
    symbols.push(sym);
    byMerged.set(mergedId, sym);
    remap.set(`${baseLayer.id}:${row.local_id}`, mergedId);
    sourceLocalToMerged.set(sourceLocalKey(baseLayer.source, row.local_id), mergedId);
    const key = mergeKey(sym.kind, sym.qualified_name || sym.name);
    if (!keyToMerged.has(key)) keyToMerged.set(key, mergedId);
    const locKey = locationMergeKey(sym.name, sym.range_start, sym.range_start_line);
    const locationCandidates = locationToMerged.get(locKey) || [];
    locationCandidates.push(mergedId);
    locationToMerged.set(locKey, locationCandidates);
  }

  // Overlay: enrich matching base symbol, else add as new.
  if (overlayLayer) {
    for (const row of readLayerSymbols(ledgerDb, overlayLayer.id)) {
      const detail = parseJson(row.detail_json) || {};
      const qualified = row.container ?? detail.qualified_name ?? null;
      const key = mergeKey(row.kind, qualified || row.name);
      const range = parseJson(row.range_json) || {};
      const overlayRange = {
        range_start: num(range.range_start, 0),
        range_end: num(range.range_end, 0),
      };
      const locKey = locationMergeKey(
        row.name,
        overlayRange.range_start,
        nullableInt(range.range_start_line),
      );
      const locationMatches = (locationToMerged.get(locKey) || [])
        .filter((candidateId) => declarationRangesOverlap(byMerged.get(candidateId), overlayRange));
      const matchId = keyToMerged.get(key)
        ?? (locationMatches.length === 1 ? locationMatches[0] : undefined);
      if (matchId != null) {
        const base = byMerged.get(matchId);
        base.name = row.name || base.name;
        base.qualified_name = qualified ?? base.qualified_name;
        // The base signature is declaration source text; SCIP's is
        // synthesized from kind + qualified name. Keep the base text/hash
        // pair and fill it from the overlay only when the base has no text.
        if (!base.signature_text) {
          base.signature_hash = detail.signature_hash ?? base.signature_hash;
          base.signature_text = detail.signature_text ?? row.signature ?? null;
        }
        base.visibility = detail.visibility ?? base.visibility;
        base.doc = row.doc ?? base.doc;
        remap.set(`${overlayLayer.id}:${row.local_id}`, matchId);
        sourceLocalToMerged.set(sourceLocalKey(overlayLayer.source, row.local_id), matchId);
      } else {
        const mergedId = nextLocalId++;
        const sym = symbolRowFrom(contentHash, resolvedLang, mergedId, overlayLayer.id, row);
        sym.source = detail.source || "scip";
        symbols.push(sym);
        byMerged.set(mergedId, sym);
        remap.set(`${overlayLayer.id}:${row.local_id}`, mergedId);
        sourceLocalToMerged.set(sourceLocalKey(overlayLayer.source, row.local_id), mergedId);
        keyToMerged.set(key, mergedId);
      }
    }
  }

  // Pass 2: remap parent_local_id through each symbol's own source remap, then
  // strip transients.
  for (const sym of symbols) {
    if (sym._srcParent != null) {
      sym.parent_local_id = remap.get(`${sym._srcLayerId}:${sym._srcParent}`) ?? null;
    }
    delete sym._srcLayerId;
    delete sym._srcParent;
  }

  // Edges: remap from/to ids; keep cross-blob targets raw for buildFrom's
  // resolver. Drop tree-sitter calls at a SCIP call site, then dedup
  // identical A/B calls by confidence.
  const candidates = [];
  for (const layer of layers) {
    for (const row of readLayerEdges(ledgerDb, layer.id)) {
      const detail = parseJson(row.detail_json) || {};
      const range = parseJson(row.range_json) || {};
      const fromLocal = remap.get(`${layer.id}:${row.from_local_id}`);
      if (fromLocal == null) continue; // from-symbol didn't materialize
      const source = detail.source || layer.source;
      let toContentHash = detail.to_content_hash ?? null;
      let toLocalId = detail.to_local_id ?? null;
      let toExternalId = detail.to_external_id ?? null;
      let toRepoRelPath = null;
      let claimsTreesitterCall = true;
      let target = null;
      if (source === "scip" && scipTargets) {
        if (toExternalId != null) {
          target = scipTargets.external(toExternalId);
        } else if (toContentHash && toContentHash !== contentHash && toLocalId != null) {
          target = scipTargets.definition(toContentHash, toLocalId);
        }
      }
      if (target?.status === "bound") {
        toContentHash = target.content_hash;
        toLocalId = target.local_id;
        toExternalId = null;
        toRepoRelPath = target.repo_rel_path;
      } else if (target?.status === "unbound") {
        claimsTreesitterCall = false;
        if (toExternalId == null) {
          toContentHash = null;
          toLocalId = null;
        }
      }
      const sameBlob = toContentHash === contentHash && toLocalId != null;
      const toLocal = sameBlob
        ? (remap.get(`${layer.id}:${toLocalId}`) ?? null)
        : toLocalId;
      const toName = detail.to_name ?? null;
      const edge = {
        from_content_hash: contentHash,
        from_local_id: fromLocal,
        to_content_hash: sameBlob ? contentHash : toContentHash,
        to_local_id: toLocal,
        to_external_id: toExternalId,
        // A moniker-bound edge is no longer external: it drops the descriptor.
        external_descriptor: toExternalId != null ? (row.external_descriptor ?? null) : null,
        to_name: toName,
        to_module: detail.to_module ?? null,
        kind: row.kind,
        range_start: num(range.range_start, 0),
        range_end: num(range.range_end, 0),
        range_start_line: nullableInt(range.range_start_line),
        range_end_line: nullableInt(range.range_end_line),
        confidence: detail.confidence ?? null,
        source,
        to_repo_rel_path: toRepoRelPath,
      };
      const site = {
        start: callSiteOffset(range.range_start ?? detail.range_start),
        end: callSiteOffset(range.range_end ?? detail.range_end),
        line: edge.range_start_line,
        name: toName,
        claims: claimsTreesitterCall,
      };
      candidates.push({ edge, site });
    }
  }
  const dropped = treesitterCallsAtScipSites(
    candidates.map(({ edge, site }) => ({ kind: edge.kind, source: edge.source, site })),
  );

  const edges = [];
  const edgeIndexByKey = new Map();
  for (const [index, { edge }] of candidates.entries()) {
    if (dropped[index]) continue;
    const key = edgeDedupKey(edge);
    const existingIndex = edgeIndexByKey.get(key);
    if (existingIndex != null) {
      if (edge.kind === "calls" && confidenceScore(edge.confidence) > confidenceScore(edges[existingIndex].confidence)) {
        edges[existingIndex] = edge;
      }
      continue;
    }
    edgeIndexByKey.set(key, edges.length);
    edges.push(edge);
  }

  return { symbols, edges, sources: layers.map((l) => l.source), sourceLocalToMerged };
}
