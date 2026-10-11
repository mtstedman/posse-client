import { CONTEXT_BOUNDING_POLICIES, CONTEXT_CODE_STRUCTURE_DIGEST_FILE_LIMIT } from "../../../catalog/context.js";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getSetting } from "../../../domains/queue/functions/settings.js";

export function normalizeObjectType(value) {
  return String(value || "")
    .trim()
    .replace(/[^0-9A-Za-z_.:-]+/g, "_")
    .slice(0, 80);
}

// symbol.search bounding is a transport invariant (atlas_search_result_paging,
// default on — an explicit "off" is an operator escape hatch, not a baseline):
// unbounded search results were a primary retained-input regression while the
// flag defaulted off. search_files/list_files keep their long-standing
// unconditional policies.
const SEARCH_PAGING_POLICY_KEYS = new Set(["symbol.search", "atlas.symbol.search"]);

function searchResultPagingEnabled() {
  try {
    const stored = getSetting(SETTING_KEYS.ATLAS_SEARCH_RESULT_PAGING);
    if (stored == null) return true;
    const normalized = String(stored).trim().toLowerCase();
    return !(normalized === "off" || normalized === "false" || normalized === "0" || normalized === "no");
  } catch {
    return true;
  }
}

export function boundingPolicyFor(toolName, objectType, { searchPaging = null } = {}) {
  const candidates = [
    normalizeObjectType(objectType),
    normalizeObjectType(toolName),
  ].filter(Boolean);
  for (const candidate of candidates) {
    for (const key of [candidate, candidate.toLowerCase()]) {
      const policy = CONTEXT_BOUNDING_POLICIES[key];
      if (!policy) continue;
      if (SEARCH_PAGING_POLICY_KEYS.has(key) && !(searchPaging ?? searchResultPagingEnabled())) continue;
      return policy;
    }
  }
  return null;
}

function parseSearchRows(text) {
  const files = new Map();
  const firstMatches = [];
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    if (!line || line === "--") continue;
    const match = /^(.*?):(\d+)(?::|-|\+)(.*)$/.exec(line);
    if (!match) continue;
    const file = match[1] || "(unknown)";
    const row = files.get(file) || { file, count: 0, first_line: Number(match[2]) || null };
    row.count += 1;
    if (row.first_line == null) row.first_line = Number(match[2]) || null;
    files.set(file, row);
    if (firstMatches.length < 12 && line.includes(":")) firstMatches.push(line.slice(0, 240));
  }
  return {
    file_count: files.size,
    match_like_row_count: [...files.values()].reduce((sum, entry) => sum + entry.count, 0),
    files: [...files.values()]
      .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
      .slice(0, 30),
    first_matches: firstMatches,
  };
}

function listDigest(text) {
  const paths = String(text || "").replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const roots = new Map();
  const extensions = new Map();
  for (const p of paths) {
    const normalized = p.replace(/\\/g, "/");
    const root = normalized.includes("/") ? normalized.split("/")[0] : ".";
    roots.set(root, (roots.get(root) || 0) + 1);
    const leaf = normalized.split("/").pop() || "";
    const extMatch = /(\.[^.\/]+)$/.exec(leaf);
    const ext = extMatch ? extMatch[1].toLowerCase() : "(none)";
    extensions.set(ext, (extensions.get(ext) || 0) + 1);
  }
  return {
    path_count: paths.length,
    first_paths: paths.slice(0, 25),
    roots: [...roots.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20)
      .map(([root, count]) => ({ root, count })),
    extensions: [...extensions.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20)
      .map(([extension, count]) => ({ extension, count })),
  };
}

function genericDigest(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const nonEmpty = lines.filter((line) => line.trim()).length;
  return {
    line_count: lines.length,
    non_empty_line_count: nonEmpty,
    char_count: normalized.length,
    first_lines: lines.filter((line) => line.trim()).slice(0, 12).map((line) => line.slice(0, 220)),
  };
}

function symbolCardDigest(text) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    return genericDigest(text);
  }
  const data = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  const cards = Array.isArray(data?.cards)
    ? data.cards
    : (data?.symbolId ? [data] : []);
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  return {
    char_count: String(text || "").length,
    card_count: cards.length,
    error_count: errors.length,
    cards: cards.slice(0, 100).map((card) => ({
      symbolId: card?.symbolId || null,
      name: card?.name || null,
      qualifiedName: card?.qualifiedName || null,
      kind: card?.kind || null,
      file: card?.location?.repo_rel_path || card?.repo_rel_path || null,
      line: Number(card?.location?.startLine ?? card?.startLine) || null,
      signature: typeof card?.signature === "string" ? card.signature.slice(0, 300) : null,
    })),
    errors: errors.slice(0, 100).map((error) => ({
      index: error?.index ?? null,
      symbolId: error?.symbolId || null,
      symbolRef: error?.symbolRef || null,
      message: String(error?.message || error?.error || "").slice(0, 300),
    })),
  };
}

// code.structure arrives as one JSON line, so a line excerpt would cut the
// first object mid-way. Summarize the parsed inventory (native or compact
// projection) instead; text that does not parse reports only its size.
function codeStructureDigest(text) {
  const source = String(text || "");
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { char_count: source.length, parsed: false };
  }
  const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);
  const count = (value) => (value != null && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null);
  const data = record(parsed?.data) || record(parsed) || {};
  if (!Array.isArray(data.files)) {
    return { char_count: source.length, parsed: true, top_level_keys: Object.keys(data).slice(0, 20).map((key) => key.slice(0, 80)) };
  }
  const files = data.files.map(record).filter(Boolean);
  const metrics = record(data.metrics) || {};
  const compactEdges = record(data.edges);
  const compactRows = Array.isArray(compactEdges?.rows) ? compactEdges.rows : null;
  const declarations = (file) => (Array.isArray(file.symbols)
    ? file.symbols.length
    : Object.keys(record(file.symbols) || {}).length);
  const edgeCount = (scope) => count(metrics[`${scope}EdgeCount`])
    ?? count(compactEdges?.counts?.[scope])
    ?? (Array.isArray(data[`${scope}Edges`]) ? data[`${scope}Edges`].length : null)
    ?? (compactRows ? compactRows.filter((row) => row?.scope === scope).length : null);
  const listed = files.slice(0, CONTEXT_CODE_STRUCTURE_DIGEST_FILE_LIMIT);
  return {
    char_count: source.length,
    parsed: true,
    file_count: count(metrics.fileCount) ?? count(data.summary?.fileCount) ?? files.length,
    listed_file_count: files.length,
    declaration_count: files.reduce((sum, file) => sum + declarations(file), 0),
    files: listed.map((file) => ({ path: String(file.path || "").slice(0, 200), declarations: declarations(file) })),
    files_truncated: files.length > listed.length,
    edge_counts: { internal: edgeCount("internal"), inbound: edgeCount("inbound"), outbound: edgeCount("outbound") },
    truncated: data.truncated === true || Boolean(record(data.incomplete)),
    omitted_file_count: count(data.omittedFileCount) ?? count(data.incomplete?.omittedFiles) ?? count(data.pagination?.omittedFiles),
  };
}

export function overflowDigest(text, policy, toolName, args = {}) {
  const digestKind = policy?.digest || "generic";
  const base = {
    tool: toolName || null,
    digest: digestKind,
    omitted_chars: Math.max(0, String(text || "").length - (policy?.headChars || 0) - (policy?.tailChars || 0)),
  };
  if (args && typeof args === "object") {
    if (args.path || args.directory) base.path = args.path || args.directory;
    if (args.pattern) base.pattern = args.pattern;
    if (args.output_mode) base.output_mode = args.output_mode;
  }
  if (digestKind === "search_files") return { ...base, ...parseSearchRows(text) };
  if (digestKind === "list_files") return { ...base, ...listDigest(text) };
  if (digestKind === "symbol_card") return { ...base, ...symbolCardDigest(text) };
  if (digestKind === "code_structure") return { ...base, ...codeStructureDigest(text) };
  return { ...base, ...genericDigest(text) };
}

export function boundedResultSlices(text, policy, sizeChars = String(text || "").length) {
  const headChars = Math.max(0, Math.min(policy.headChars || policy.capChars || 0, sizeChars));
  const tailChars = Math.max(0, Math.min(policy.tailChars || 0, Math.max(0, sizeChars - headChars)));
  const tailStart = sizeChars - tailChars;
  return {
    head: text.slice(0, headChars),
    tail: tailChars > 0 ? text.slice(tailStart) : "",
    omitted: text.slice(headChars, tailStart),
    omittedStart: headChars,
    omittedEnd: tailStart,
  };
}

export function renderBoundedResult(text, {
  policy,
  toolName,
  objectType,
  args,
  sizeChars,
  slices = boundedResultSlices(text, policy, sizeChars),
}) {
  const { head, tail } = slices;
  const omitted = slices.omitted.length;
  const objectLabel = normalizeObjectType(objectType) || normalizeObjectType(toolName) || "tool_result";
  const digest = overflowDigest(text, policy, toolName, args);
  const digestText = JSON.stringify(digest);
  const lines = [
    `[bounded_result ${objectLabel}: full payload ${sizeChars} chars; showing ${head.length}${tail ? `+${tail.length}` : ""} chars; omitted ${omitted} chars]`,
    "[overflow_digest]",
    digestText,
    "[/overflow_digest]",
    "",
    head,
  ];
  if (tail) {
    lines.push("", `[... ${omitted} chars omitted from bounded view ...]`, "", tail);
  } else if (omitted > 0) {
    lines.push("", `[... ${omitted} chars omitted from bounded view ...]`);
  }
  return lines.join("\n");
}
