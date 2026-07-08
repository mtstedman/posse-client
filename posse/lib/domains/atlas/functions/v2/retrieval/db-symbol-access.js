// @ts-check
//
// Narrow in-process cache for DB access facts discovered by code.db. Symbol
// cards can consult this after prefetch so database read/write context follows
// the symbol without rescanning files or routing through MCP.

const MAX_SYMBOL_ACCESS_ENTRIES = 4096;
const MAX_SITES_PER_SYMBOL = 24;

/** @type {Map<string, any>} */
const dbAccessBySymbolId = new Map();

/**
 * @param {unknown} queries
 */
export function cacheDbAccessForQueries(queries) {
  if (!Array.isArray(queries)) return;
  for (const query of queries) {
    const symbols = Array.isArray(query?.symbols) ? query.symbols : [];
    for (const symbol of symbols) {
      const symbolId = String(symbol?.symbolId || "").trim();
      if (!symbolId) continue;
      mergeSymbolAccess(symbolId, query, symbol);
    }
  }
}

/**
 * @param {any} card
 * @returns {any}
 */
export function applyDbAccessToCard(card) {
  if (!card || typeof card !== "object") return card;
  const dbAccess = dbAccessForSymbolId(card.symbolId);
  if (dbAccess) card.dbAccess = dbAccess;
  else if ("dbAccess" in card) delete card.dbAccess;
  return card;
}

/**
 * @param {unknown} symbolId
 */
export function dbAccessForSymbolId(symbolId) {
  const key = String(symbolId || "").trim();
  if (!key) return null;
  const entry = dbAccessBySymbolId.get(key);
  return entry ? cloneDbAccess(entry) : null;
}

/**
 * @param {unknown} dbAccess
 * @param {number} [maxSites]
 */
export function compactDbAccess(dbAccess, maxSites = 8) {
  if (!dbAccess || typeof dbAccess !== "object") return null;
  const cap = clampInt(maxSites, 8, 0, MAX_SITES_PER_SYMBOL);
  const compact = {
    access: normalizeStringArray(dbAccess.access),
    operations: normalizeStringArray(dbAccess.operations),
    targets: normalizeStringArray(dbAccess.targets),
    readCount: Number(dbAccess.readCount || 0),
    writeCount: Number(dbAccess.writeCount || 0),
    schemaCount: Number(dbAccess.schemaCount || 0),
    telemetryCount: Number(dbAccess.telemetryCount || 0),
    ambiguousLineCount: Number(dbAccess.ambiguousLineCount || 0),
  };
  const reads = compactSites(dbAccess.reads, cap);
  const writes = compactSites(dbAccess.writes, cap);
  const schema = compactSites(dbAccess.schema, cap);
  if (reads.length > 0) compact.reads = reads;
  if (writes.length > 0) compact.writes = writes;
  if (schema.length > 0) compact.schema = schema;
  return compact;
}

export function __resetDbSymbolAccessForTests() {
  dbAccessBySymbolId.clear();
}

/**
 * @param {string} symbolId
 * @param {any} query
 * @param {any} symbol
 */
function mergeSymbolAccess(symbolId, query, symbol) {
  const access = normalizeAccess(query?.access);
  if (!access) return;
  const operation = normalizeOperation(query?.operation);
  const target = normalizeTarget(query?.target);
  const site = {
    access,
    operation,
    target,
    path: String(query?.path || ""),
    line: Number.isFinite(Number(query?.line)) ? Number(query.line) : null,
    classification: String(query?.classification || "unknown"),
    confidence: String(query?.confidence || ""),
    symbolRelation: String(symbol?.relation || query?.symbolSurface || ""),
    symbolSurface: String(query?.symbolSurface || ""),
    site: oneLine(query?.site, 160),
  };
  const evidence = oneLine(query?.evidence, 220);
  if (evidence) site.evidence = evidence;

  const current = dbAccessBySymbolId.get(symbolId) || emptyAccess();
  const bucketName = access === "read" ? "reads" : access === "write" ? "writes" : "schema";
  const bucket = current[bucketName];
  const key = accessSiteKey(site);
  if (!bucket.some((entry) => accessSiteKey(entry) === key)) {
    bucket.push(site);
    if (bucket.length > MAX_SITES_PER_SYMBOL) bucket.length = MAX_SITES_PER_SYMBOL;
  }

  current.access = addSorted(current.access, access);
  current.operations = addSorted(current.operations, operation);
  if (target) current.targets = addSorted(current.targets, target);
  current.readCount = current.reads.length;
  current.writeCount = current.writes.length;
  current.schemaCount = current.schema.length;
  current.telemetryCount = countClassified(current, "telemetry");
  current.ambiguousLineCount = countAmbiguous(current);

  dbAccessBySymbolId.set(symbolId, current);
  if (dbAccessBySymbolId.size > MAX_SYMBOL_ACCESS_ENTRIES) {
    const first = dbAccessBySymbolId.keys().next().value;
    if (first) dbAccessBySymbolId.delete(first);
  }
}

function emptyAccess() {
  return {
    access: [],
    operations: [],
    targets: [],
    reads: [],
    writes: [],
    schema: [],
    readCount: 0,
    writeCount: 0,
    schemaCount: 0,
    telemetryCount: 0,
    ambiguousLineCount: 0,
  };
}

/**
 * @param {any} current
 * @param {string} classification
 */
function countClassified(current, classification) {
  return [...current.reads, ...current.writes, ...current.schema]
    .filter((site) => site.classification === classification).length;
}

/**
 * @param {any} current
 */
function countAmbiguous(current) {
  return [...current.reads, ...current.writes, ...current.schema]
    .filter((site) => site.symbolRelation === "same_line" || site.symbolSurface === "same_line").length;
}

/**
 * @param {any} site
 */
function accessSiteKey(site) {
  return [
    site.access,
    site.operation,
    site.target,
    site.path,
    site.line,
    site.classification,
    site.symbolRelation,
  ].join("\0");
}

/**
 * @param {string[]} values
 * @param {string} value
 */
function addSorted(values, value) {
  const normalized = String(value || "").trim();
  if (!normalized || values.includes(normalized)) return values;
  return values.concat(normalized).sort();
}

/**
 * @param {any} access
 */
function cloneDbAccess(access) {
  return {
    access: [...access.access],
    operations: [...access.operations],
    targets: [...access.targets],
    reads: access.reads.map((site) => ({ ...site })),
    writes: access.writes.map((site) => ({ ...site })),
    schema: access.schema.map((site) => ({ ...site })),
    readCount: access.readCount,
    writeCount: access.writeCount,
    schemaCount: access.schemaCount,
    telemetryCount: access.telemetryCount,
    ambiguousLineCount: access.ambiguousLineCount,
  };
}

/**
 * @param {unknown} sites
 * @param {number} cap
 */
function compactSites(sites, cap) {
  if (!Array.isArray(sites) || cap <= 0) return [];
  return sites.slice(0, cap).map((site) => ({
    access: site.access,
    operation: site.operation,
    target: site.target,
    path: site.path,
    line: site.line,
    classification: site.classification,
    confidence: site.confidence,
    symbolRelation: site.symbolRelation,
    symbolSurface: site.symbolSurface,
  }));
}

/**
 * @param {unknown} values
 */
function normalizeStringArray(values) {
  return Array.isArray(values) ? values.map((value) => String(value || "").trim()).filter(Boolean) : [];
}

/**
 * @param {unknown} value
 */
function normalizeAccess(value) {
  const key = String(value || "").trim().toLowerCase();
  return key === "read" || key === "write" || key === "schema" ? key : "";
}

/**
 * @param {unknown} value
 */
function normalizeOperation(value) {
  return String(value || "unknown").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

/**
 * @param {unknown} value
 */
function normalizeTarget(value) {
  return String(value || "").trim();
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function oneLine(value, max) {
  if (value == null) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
