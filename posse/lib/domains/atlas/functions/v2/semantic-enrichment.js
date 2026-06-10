// @ts-check
//
// Semantic enrichment observability. Atlas already stores edge provenance and
// SCIP external bindings in the view DB; this module turns those exact signals
// into a status surface clients can reason about.

/**
 * @param {{
 *   view?: import("./contracts/api.js").View,
 *   edges?: { total?: number, resolved?: number, unresolved?: number, callTotal?: number, callResolved?: number, callResolutionRate?: number },
 * }} args
 */
export function readSemanticEnrichmentStatus({ view, edges = {} } = {}) {
  const db = typeof /** @type {any} */ (view)?._unsafeDb === "function"
    ? /** @type {any} */ (view)._unsafeDb()
    : null;
  if (!db) {
    return {
      enabled: false,
      status: "unavailable",
      reason: "view_db_unavailable",
      providers: providerRows({ edgeSources: {}, externalEdges: 0, scipEdges: 0 }),
      edgeSources: {},
      exactEdgeCount: 0,
      externalEdges: 0,
      resolvedEdges: Number(edges.resolved || 0),
      unresolvedEdges: Number(edges.unresolved || 0),
      callResolutionRate: Number(edges.callResolutionRate || 0),
      symbolResolution: { qualifiedNames: 0, signatures: 0 },
    };
  }

  const edgeSources = countEdgesBySource(db);
  const externalEdges = countSql(db, "SELECT COUNT(*) AS cnt FROM edges WHERE to_external_id IS NOT NULL");
  const scipEdges = countSql(db, "SELECT COUNT(*) AS cnt FROM edges WHERE source = 'scip' OR to_external_id IS NOT NULL");
  const exactEdgeCount = countSql(
    db,
    "SELECT COUNT(*) AS cnt FROM edges WHERE source != 'treesitter' OR to_external_id IS NOT NULL",
  );
  const symbolResolution = {
    qualifiedNames: countSql(db, "SELECT COUNT(*) AS cnt FROM symbols WHERE qualified_name IS NOT NULL AND qualified_name != ''"),
    signatures: countSql(db, "SELECT COUNT(*) AS cnt FROM symbols WHERE signature_hash IS NOT NULL AND signature_hash != ''"),
  };
  return {
    enabled: true,
    status: "available",
    reason: null,
    providers: providerRows({ edgeSources, externalEdges, scipEdges }),
    edgeSources,
    exactEdgeCount,
    externalEdges,
    resolvedEdges: Number(edges.resolved || 0),
    unresolvedEdges: Number(edges.unresolved || 0),
    callResolutionRate: Number(edges.callResolutionRate || 0),
    symbolResolution,
  };
}

/**
 * @param {{ edgeSources: Record<string, number>, externalEdges: number, scipEdges?: number }} args
 */
function providerRows({ edgeSources, externalEdges, scipEdges }) {
  const providerScipEdges = Number(scipEdges ?? (Number(edgeSources.scip || 0) + Number(externalEdges || 0)));
  return [
    {
      id: "tree-sitter",
      enabled: true,
      active: Number(edgeSources.treesitter || 0) > 0,
      status: "available",
      edgeCount: Number(edgeSources.treesitter || 0),
    },
    {
      id: "scip",
      enabled: true,
      active: providerScipEdges > 0,
      status: providerScipEdges > 0 ? "active" : "available",
      edgeCount: providerScipEdges,
    },
    {
      id: "typescript-compiler-api",
      enabled: false,
      active: false,
      status: "planned",
      edgeCount: Number(edgeSources.typescript || 0),
    },
    {
      id: "lsp",
      enabled: false,
      active: false,
      status: "planned",
      edgeCount: Number(edgeSources.lsp || 0),
    },
  ];
}

/**
 * @param {any} db
 */
function countEdgesBySource(db) {
  try {
    const rows = db.prepare("SELECT COALESCE(source, 'treesitter') AS source, COUNT(*) AS cnt FROM edges GROUP BY COALESCE(source, 'treesitter')").all();
    /** @type {Record<string, number>} */
    const out = {};
    for (const row of rows) out[String(row.source || "treesitter")] = Number(row.cnt || 0);
    return out;
  } catch {
    return {};
  }
}

/**
 * @param {any} db
 * @param {string} sql
 */
function countSql(db, sql) {
  try {
    const row = db.prepare(sql).get();
    return Number(row?.cnt || 0);
  } catch {
    return 0;
  }
}
