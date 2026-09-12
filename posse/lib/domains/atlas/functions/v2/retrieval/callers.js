// @ts-check
import { parseSymbolId, symbolIdOf } from "./cards.js";
import { okEnvelope, errorEnvelope } from "./envelope.js";
import { projectCompactSymbolRelationships } from "./compact-presentation.js";
import { selectIncomingRelationshipEntries } from "./relationship-selection.js";

/**
 * @param {{view: import("../contracts/api.js").View, versionId: string, params: import("../contracts/tool-params.js").SymbolCallersParams}} request
 */
export async function symbolCallers({ view, versionId, params }) {
  const action = "symbol.callers";
  const parsed = parseSymbolId(params.symbolId);
  if (!parsed) return errorEnvelope({ action, versionId, code: "invalid_symbol_id", message: "symbol.callers requires a valid symbolId" });
  if (params.projection === "compact-v1"
    && params.indexVersion
    && params.indexVersion !== versionId) {
    return errorEnvelope({
      action,
      versionId,
      code: "index_version_changed",
      message: "The Atlas index changed before this relationship page could continue",
    });
  }
  const target = await view.query.getByContentLocal(parsed.content_hash, parsed.local_id);
  if (!target) return errorEnvelope({ action, versionId, code: "symbol_not_found", message: `No symbol found for ${params.symbolId}` });
  const confidence = Number(params.minConfidence || 0);
  const minimum = Math.ceil(Math.max(0, Math.min(100, confidence)));
  if (params.projection === "compact-v1") {
    const mode = params.mode || "caller";
    const kinds = /** @type {("calls" | "references")[]} */ (mode === "all"
      ? ["calls", "references"]
      : mode === "reference" ? ["references"] : ["calls"]);
    try {
      const selected = await view.query.symbolRelationships(target.global_id, kinds, minimum);
      const page = selectIncomingRelationshipEntries(selected.relationships, {
        relationships: mode === "all" ? ["caller", "reference"] : [mode],
        offset: params.offset,
        limit: params.limit,
        indexVersion: versionId,
        indexIncomplete: selected.truncated,
      });
      const projected = projectCompactSymbolRelationships(page, {
        mode,
        limit: params.limit,
        offset: params.offset,
        indexVersion: versionId,
        indexIncomplete: selected.truncated,
      });
      return okEnvelope({
        action,
        versionId,
        data: projected.data,
        meta: /** @type {any} */ (projected.meta),
      });
    } catch (error) {
      return errorEnvelope({
        action,
        versionId,
        code: String(error?.code || "symbol_relationships_failed"),
        message: String(error?.message || "Could not select compact symbol relationships"),
      });
    }
  }
  const neighborhood = await view.query.symbolCallers(target.global_id, minimum);
  const groups = new Map();
  let missingCallerSymbols = 0;
  for (const { edge, symbol: from } of neighborhood.callers) {
    if (edge.kind !== "calls") continue;
    if (!from) { missingCallerSymbols += 1; continue; }
    const key = JSON.stringify([from.repo_rel_path, from.range_start_line, symbolIdOf(from)]);
    const group = groups.get(key) || { from, sites: new Map() };
    const siteKey = JSON.stringify([edge.repo_rel_path, edge.range_start, edge.range_end]);
    const previous = group.sites.get(siteKey);
    if (!previous || previous.confidence < edge.confidence) group.sites.set(siteKey, {
      repoRelPath: edge.repo_rel_path, startLine: edge.range_start_line, endLine: edge.range_end_line,
      startByte: edge.range_start, endByte: edge.range_end, confidence: edge.confidence,
    });
    groups.set(key, group);
  }
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const ordered = [...groups.values()].sort((a, b) => compare(a.from.repo_rel_path, b.from.repo_rel_path)
    || a.from.range_start_line - b.from.range_start_line || compare(symbolIdOf(a.from), symbolIdOf(b.from)));
  const limit = Math.max(1, Math.min(100, params.limit ?? 20));
  const offset = Math.max(0, params.offset ?? 0);
  const callers = ordered.slice(offset, offset + limit).map(({ from, sites }) => ({
    symbolId: symbolIdOf(from), name: from.name, qualifiedName: from.qualified_name ?? null, kind: from.kind,
    repoRelPath: from.repo_rel_path, startLine: from.range_start_line, endLine: from.range_end_line,
    callSiteCount: sites.size,
    callSites: [...sites.values()].sort((a, b) => compare(a.repoRelPath, b.repoRelPath) || a.startByte - b.startByte || a.endByte - b.endByte).slice(0, 5),
    callSitesTruncated: sites.size > 5,
  }));
  const hasMore = offset + callers.length < ordered.length;
  return okEnvelope({ action, versionId, data: {
    symbolId: symbolIdOf(target), name: target.name, qualifiedName: target.qualified_name ?? null, repoRelPath: target.repo_rel_path,
    callers, observedCallerCount: ordered.length, observedCallSiteCount: ordered.reduce((sum, group) => sum + group.sites.size, 0),
    offset, limit, hasMore, nextOffset: hasMore ? offset + limit : null,
    indexTruncated: neighborhood.truncated, missingCallerSymbols,
    truncated: hasMore || neighborhood.truncated || missingCallerSymbols > 0 || callers.some(row => row.callSitesTruncated),
    coverage: "Indexed resolved call edges only; dynamic or unresolved callers may be absent. Counts describe the observed index subset. Call sites are samples when callSitesTruncated is true; read the caller body by symbolId for context.",
  } });
}
