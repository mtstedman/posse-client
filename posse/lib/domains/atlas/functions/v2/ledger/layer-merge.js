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

const SOURCE_ORDER = ["treesitter", "scip"];

function parseJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function mergeKey(kind, qualifiedOrName) {
  return `${String(kind || "")}\0${String(qualifiedOrName || "")}`;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nullableInt(value) {
  return Number.isInteger(value) ? value : null;
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

function readLayerEdges(ledgerDb, layerId) {
  return /** @type {any[]} */ (
    ledgerDb.prepare(
      `SELECT edge_id, kind, from_local_id, to_local_id, to_symbol, range_json, detail_json
       FROM blob_layer_edges WHERE layer_id = ? ORDER BY edge_id ASC`,
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
 * @param {import("better-sqlite3").Database} ledgerDb
 * @param {string} contentHash
 * @param {string | null} [lang] - derived from the layers when omitted
 * @returns {{ symbols: any[], edges: any[], sources: string[] }}
 */
export function mergeLayerRows(ledgerDb, contentHash, lang = null) {
  const resolvedLang = lang || layerLangFor(ledgerDb, contentHash);
  if (!resolvedLang) return { symbols: [], edges: [], sources: [] };
  const layers = latestLayers(ledgerDb, contentHash, resolvedLang);
  if (layers.length === 0) return { symbols: [], edges: [], sources: [] };

  const baseLayer = layers[0];
  const overlayLayer = layers[1] || null;

  const symbols = [];
  /** mergeKey -> merged local_id (for overlay enrichment matching) */
  const keyToMerged = new Map();
  /** "layerId:srcLocalId" -> merged local_id (parent + edge remap) */
  const remap = new Map();
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
    const key = mergeKey(sym.kind, sym.qualified_name || sym.name);
    if (!keyToMerged.has(key)) keyToMerged.set(key, mergedId);
  }

  // Overlay: enrich matching base symbol, else add as new.
  if (overlayLayer) {
    for (const row of readLayerSymbols(ledgerDb, overlayLayer.id)) {
      const detail = parseJson(row.detail_json) || {};
      const qualified = row.container ?? detail.qualified_name ?? null;
      const key = mergeKey(row.kind, qualified || row.name);
      const matchId = keyToMerged.get(key);
      if (matchId != null) {
        const base = byMerged.get(matchId);
        base.name = row.name || base.name;
        base.qualified_name = qualified ?? base.qualified_name;
        base.signature_hash = detail.signature_hash ?? base.signature_hash;
        base.signature_text = detail.signature_text ?? row.signature ?? base.signature_text;
        base.visibility = detail.visibility ?? base.visibility;
        base.doc = row.doc ?? base.doc;
        remap.set(`${overlayLayer.id}:${row.local_id}`, matchId);
      } else {
        const mergedId = nextLocalId++;
        const sym = symbolRowFrom(contentHash, resolvedLang, mergedId, overlayLayer.id, row);
        sym.source = detail.source || "scip";
        symbols.push(sym);
        byMerged.set(mergedId, sym);
        remap.set(`${overlayLayer.id}:${row.local_id}`, mergedId);
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
  // resolver. Dedup identical A/B edges.
  const edges = [];
  const seen = new Set();
  for (const layer of layers) {
    for (const row of readLayerEdges(ledgerDb, layer.id)) {
      const detail = parseJson(row.detail_json) || {};
      const range = parseJson(row.range_json) || {};
      const fromLocal = remap.get(`${layer.id}:${row.from_local_id}`);
      if (fromLocal == null) continue; // from-symbol didn't materialize
      const sameBlob = detail.to_content_hash === contentHash && detail.to_local_id != null;
      const toLocal = sameBlob
        ? (remap.get(`${layer.id}:${detail.to_local_id}`) ?? null)
        : (detail.to_local_id ?? null);
      const toName = detail.to_name ?? null;
      const source = detail.source || layer.source;
      const key = [
        fromLocal,
        sameBlob ? `L${toLocal}` : (detail.to_content_hash || ""),
        sameBlob ? "" : (detail.to_local_id ?? ""),
        detail.to_external_id ?? "",
        toName ?? "",
        row.kind,
        num(range.range_start, 0),
        source,
      ].join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from_content_hash: contentHash,
        from_local_id: fromLocal,
        to_content_hash: sameBlob ? contentHash : (detail.to_content_hash ?? null),
        to_local_id: toLocal,
        to_external_id: detail.to_external_id ?? null,
        to_name: toName,
        to_module: detail.to_module ?? null,
        kind: row.kind,
        range_start: num(range.range_start, 0),
        range_end: num(range.range_end, 0),
        range_start_line: nullableInt(range.range_start_line),
        range_end_line: nullableInt(range.range_end_line),
        confidence: detail.confidence ?? null,
        source,
      });
    }
  }

  return { symbols, edges, sources: layers.map((l) => l.source) };
}
