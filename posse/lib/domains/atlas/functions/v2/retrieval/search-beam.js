// @ts-check

// Query-conditioned scope beam attached to thin symbol.search results. Search
// addresses always remain first and unchanged; this module ranks only the
// candidates eligible for unused result slots.

export const SCOPE_BEAM_RRF_K = 65;
export const SCOPE_BEAM_SYMBOL_WEIGHT = 0.65;
export const SCOPE_BEAM_FILE_WEIGHT = 0.35;
export const SCOPE_BEAM_STRUCTURE_FILE_LIMIT = 128;

export function symbolSearchLimit(value, fallback = 20) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}

export function scopeBeamMaxFiles(limit) {
  return Math.min(500, Math.max(24, symbolSearchLimit(limit) * 3));
}

/**
 * Beam scope calls must not participate in counterfactual routing experiments.
 * They are delivery enrichment, not the handoff-prefetch population that owns
 * identifier-routing shadow measurement.
 *
 * @param {Record<string, unknown> | null | undefined} config
 */
export function scopeBeamConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  const copy = { ...config };
  delete copy.identifierRoutingShadowCapture;
  return copy;
}

export function symbolSearchHasUnusedSlots(envelope, limit) {
  const items = Array.isArray(envelope?.data?.items) ? envelope.data.items : [];
  return envelope?.ok !== false && items.length < symbolSearchLimit(limit);
}

/**
 * @param {any} envelope
 * @param {string} [reason]
 */
export function markScopeBeamDegraded(envelope, reason = "tree_unavailable") {
  if (!envelope || envelope.ok === false) return envelope;
  const meta = envelope.meta && typeof envelope.meta === "object" ? envelope.meta : {};
  const degraded = Array.isArray(meta.degraded) ? [...meta.degraded] : [];
  if (!degraded.includes(reason)) degraded.push(reason);
  envelope.meta = {
    ...meta,
    degraded,
    scopeBeam: { attempted: true, backfilled: 0 },
  };
  return envelope;
}

/**
 * Add scope-ranked candidates without mutating or reordering genuine search
 * hits. Structural symbols are query-ranked, diversified to two per file, and
 * fused with scope file rank via weighted RRF. A file candidate is retained
 * when structural symbol resolution is unavailable.
 *
 * @param {any} envelope
 * @param {{ query?: string, limit?: number, scopeEnvelope?: any, structureEnvelope?: any }} opts
 */
export function attachScopeBeam(envelope, {
  query = "",
  limit = 20,
  scopeEnvelope = null,
  structureEnvelope = null,
} = {}) {
  if (!symbolSearchHasUnusedSlots(envelope, limit)) return envelope;
  const data = scopeEnvelope?.data;
  if (scopeEnvelope?.ok === false || !data || data.available === false) {
    return markScopeBeamDegraded(envelope);
  }

  const searchItems = Array.isArray(envelope?.data?.items) ? envelope.data.items : [];
  const slots = Math.max(0, symbolSearchLimit(limit) - searchItems.length);
  const surfacedPaths = new Set(searchItems
    .map((item) => normalizedPath(item?.location?.repo_rel_path || item?.path))
    .filter(Boolean));
  const surfacedSymbols = new Set(searchItems.map((item) => String(item?.symbolId || "")).filter(Boolean));
  const scopeFiles = (Array.isArray(data.candidateFiles) ? data.candidateFiles : [])
    .filter((file) => normalizedPath(file?.path) && !file?.generated);
  const structureFiles = new Map(
    (Array.isArray(structureEnvelope?.data?.files) ? structureEnvelope.data.files : [])
      .map((file) => [normalizedPath(file?.path), file])
      .filter(([path]) => path),
  );
  const terms = queryTerms(data.queryTerms, query);
  const ranked = [];

  for (const [fileIndex, scopeFile] of scopeFiles.entries()) {
    const path = normalizedPath(scopeFile.path);
    if (!path || surfacedPaths.has(path)) continue;
    const structureFile = structureFiles.get(path);
    const symbols = rankedFileSymbols(structureFile?.symbols, terms)
      .filter((symbol) => !surfacedSymbols.has(String(symbol?.symbolId || "")))
      .slice(0, 2);
    if (symbols.length === 0) {
      ranked.push({
        fileRank: fileIndex + 1,
        symbolRankBasis: 0,
        order: ranked.length,
        candidate: fileBeamCandidate(path, terms),
      });
      continue;
    }
    for (const symbol of symbols) {
      ranked.push({
        fileRank: fileIndex + 1,
        symbolRankBasis: symbol._beamRankBasis,
        order: ranked.length,
        candidate: symbolBeamCandidate(path, symbol, terms),
      });
    }
  }

  const symbolRanked = ranked
    .filter((entry) => "symbolId" in entry.candidate && entry.candidate.symbolId)
    .sort((a, b) => b.symbolRankBasis - a.symbolRankBasis || a.order - b.order);
  const symbolRank = new Map(symbolRanked.map((entry, index) => [entry, index + 1]));
  ranked.sort((a, b) => {
    const score = (entry) => (
      (symbolRank.has(entry)
        ? SCOPE_BEAM_SYMBOL_WEIGHT / (SCOPE_BEAM_RRF_K + symbolRank.get(entry))
        : 0)
      + SCOPE_BEAM_FILE_WEIGHT / (SCOPE_BEAM_RRF_K + entry.fileRank)
    );
    return score(b) - score(a) || a.order - b.order;
  });

  const beam = ranked.slice(0, slots).map((entry) => entry.candidate);
  const meta = envelope.meta && typeof envelope.meta === "object" ? envelope.meta : {};
  envelope.meta = {
    ...meta,
    scopeBeam: {
      attempted: true,
      backfilled: beam.length,
      candidates: ranked.length,
      symbolWeight: SCOPE_BEAM_SYMBOL_WEIGHT,
      fileWeight: SCOPE_BEAM_FILE_WEIGHT,
      symbolResolution: structureEnvelope?.ok === true ? "available" : "unavailable",
    },
  };
  if (beam.length > 0) envelope.data.beam = beam;
  return envelope;
}

export function compactScopeBeamCandidate(value) {
  const lines = Array.isArray(value?.lines)
    && Number.isFinite(Number(value.lines[0]))
    && Number.isFinite(Number(value.lines[1]))
    ? [Math.max(1, Math.floor(Number(value.lines[0]))), Math.max(1, Math.floor(Number(value.lines[1])))]
    : null;
  return {
    path: compactText(value?.path, 320),
    ...(value?.symbolId ? { symbolId: compactText(value.symbolId, 96) } : {}),
    kind: compactText(value?.kind || "file", 40),
    ...(lines ? { lines } : {}),
    ...(value?.signature ? { signature: compactText(value.signature, 160) } : {}),
    why: compactText(value?.why || "task-ranked area", 240),
  };
}

export function syncScopeBeamMetadata(envelope) {
  const beam = Array.isArray(envelope?.data?.beam) ? envelope.data.beam : [];
  if (envelope?.meta?.scopeBeam) envelope.meta.scopeBeam.backfilled = beam.length;
  if (beam.length === 0 && envelope?.data) delete envelope.data.beam;
  return envelope;
}

function rankedFileSymbols(value, terms) {
  return (Array.isArray(value) ? value : [])
    .map((symbol, index) => ({
      ...symbol,
      _beamRankBasis: queryMatchScore(symbolText(symbol), terms),
      _beamOriginalIndex: index,
    }))
    .filter((symbol) => String(symbol.symbolId || "").trim())
    .sort((a, b) => b._beamRankBasis - a._beamRankBasis || a._beamOriginalIndex - b._beamOriginalIndex);
}

function symbolBeamCandidate(path, symbol, terms) {
  const line = Number(symbol?.line ?? symbol?.startLine);
  const signature = compactText(symbol?.signature, 160);
  return {
    path,
    symbolId: String(symbol.symbolId),
    kind: String(symbol.kind || "symbol"),
    ...(Number.isFinite(line) && line > 0 ? { lines: [Math.floor(line), Math.floor(line)] } : {}),
    ...(signature ? { signature } : {}),
    why: deterministicWhy(`${path} ${symbolText(symbol)}`, terms),
  };
}

function fileBeamCandidate(path, terms) {
  return {
    path,
    kind: "file",
    why: deterministicWhy(path, terms),
  };
}

function deterministicWhy(text, terms) {
  const lower = String(text || "").toLowerCase();
  const matches = terms.filter((term) => lower.includes(term)).slice(0, 4);
  return matches.length > 0
    ? `task-ranked area; query term match: ${matches.join(", ")}`
    : "task-ranked area";
}

function queryTerms(scopeTerms, query) {
  const raw = [
    ...(Array.isArray(scopeTerms) ? scopeTerms : []),
    ...(String(query || "").toLowerCase().match(/[a-z][a-z0-9_-]{1,}/gu) || []),
  ];
  const out = [];
  const seen = new Set();
  for (const value of raw) {
    const term = String(value || "").trim().toLowerCase();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

function queryMatchScore(text, terms) {
  const lower = String(text || "").toLowerCase();
  return terms.reduce((score, term, index) => (
    score + (lower.includes(term) ? Math.max(1, 16 - index) : 0)
  ), 0);
}

function symbolText(symbol) {
  return [symbol?.name, symbol?.qualifiedName, symbol?.signature].filter(Boolean).join(" ");
}

function normalizedPath(value) {
  return String(value || "").trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function compactText(value, maxChars) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
