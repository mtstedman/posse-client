// Model presentation only. The original result is retained by the caller for
// telemetry; unfamiliar metadata and all actionable warnings fail open.
export function compactResearchSearchResult(result) {
  if (result?.isError || !Array.isArray(result?.content)) return result;
  const first = result.content[0];
  if (first?.type !== "text" || typeof first.text !== "string") return result;
  let payload;
  try { payload = JSON.parse(first.text); } catch { return result; }
  if (payload?.ok === false || payload?.error) return result;
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  if (!Array.isArray(data?.items) || !data._meta || typeof data._meta !== "object" || Array.isArray(data._meta)) return result;
  const diagnostics = data._meta;
  const meta = { ...diagnostics };
  for (const key of ["retrievalPolicy", "candidateDepth", "scopeBeam", "prefetch"]) delete meta[key];
  if (meta.separation && typeof meta.separation === "object") {
    const separation = { ...meta.separation };
    delete separation.top;
    delete separation.backendPoolSizes;
    meta.separation = separation;
  }
  const health = meta.backendHealth;
  if (health?.fullyDegraded === false && Array.isArray(health.unavailable) && health.unavailable.length === 0
    && Object.keys(health).every((key) => ["fullyDegraded", "unavailable", "active", "backends"].includes(key))
    && Object.values(health.backends || {}).every((backend) => backend?.ok === true && Object.keys(backend).length === 1)) {
    delete meta.backendHealth;
  }
  data._meta = meta;
  const text = JSON.stringify(payload);
  if (text === first.text) return result;
  return {
    ...result,
    content: [{ ...first, text }, ...result.content.slice(1)],
    _meta: { ...result._meta, researchSearchDiagnostics: diagnostics },
  };
}

/**
 * Final model-facing shape of a symbol.search result, for every role. Search
 * is a locator: each hit keeps its name, kind, location and handle as one
 * compact row, and a source-text match keeps its path, line and source line.
 * A researcher additionally loses the unrequested "beam" area list whenever
 * there are hits, and its disambiguation block becomes one note. Runs after
 * field-name projection, so owner bookkeeping that reads location objects has
 * already seen the full rows; it reads either field vocabulary.
 *
 * @param {any} result
 * @param {{ researcher?: boolean }} [options]
 */
export function compactSearchRows(result, { researcher = false } = {}) {
  if (result?.isError || !Array.isArray(result?.content)) return result;
  const first = result.content[0];
  if (first?.type !== "text" || typeof first.text !== "string") return result;
  const at = first.text.indexOf("\n\n");
  const head = at < 0 ? first.text : first.text.slice(0, at);
  const tail = at < 0 ? "" : first.text.slice(at);
  let payload;
  try { payload = JSON.parse(head); } catch { return result; }
  if (payload?.ok === false || payload?.error) return result;
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  if (!Array.isArray(data?.items)) return result;
  data.items = data.items.map(compactSearchRow);
  const textMatches = data.source_text_matches ?? data.sourceTextMatches;
  if (Array.isArray(textMatches?.matches)) textMatches.matches = textMatches.matches.map(compactSourceTextMatch);
  if (researcher) compactResearcherSearchExtras(data);
  const text = JSON.stringify(payload) + tail;
  if (text === first.text) return result;
  return { ...result, content: [{ ...first, text }, ...result.content.slice(1)] };
}

function compactResearcherSearchExtras(data) {
  if (data.items.length > 0 && Object.hasOwn(data, "beam")) delete data.beam;
  const meta = data._meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const notes = (Array.isArray(meta.disambiguation) ? meta.disambiguation : [])
      .map((entry) => {
        const files = Array.isArray(entry?.defined_in) ? entry.defined_in.length : 0;
        return entry?.name && files > 1 ? `${entry.name} is defined in ${files} files.` : null;
      })
      .filter(Boolean);
    delete meta.disambiguation;
    if (Array.isArray(meta.warnings)) {
      meta.warnings = meta.warnings.filter((warning) => !/same-named symbols/u.test(String(warning)));
      if (meta.warnings.length === 0) delete meta.warnings;
    }
    if (Object.keys(meta).length === 0) delete data._meta;
    if (notes.length > 0) data.note = notes.join(" ");
  }
}

const SEARCH_LOCATION_FIELDS = new Set(["path", "repo_rel_path", "lines", "startLine", "endLine"]);

// `path:start-end` (or `path:line`, or the bare path) for a hit location, or
// null when the location carries anything that string would not restate.
function searchRowAt(location) {
  if (!location || typeof location !== "object" || Array.isArray(location)) return null;
  if (Object.keys(location).some((key) => !SEARCH_LOCATION_FIELDS.has(key))) return null;
  const path = String(location.path || location.repo_rel_path || "");
  if (!path) return null;
  let lines = location.lines;
  if (lines == null && (location.startLine != null || location.endLine != null)) {
    const start = location.startLine;
    const end = location.endLine;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
    lines = start === end ? String(start) : `${start}-${end}`;
  }
  return lines != null && String(lines) !== "" ? `${path}:${Array.isArray(lines) ? lines.join("-") : lines}` : path;
}

function compactSearchRow(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const { location, qualified_name: qualifiedNameSnake, qualifiedName: qualifiedNameCamel, ...rest } = item;
  const row = { name: rest.name, kind: rest.kind };
  const at = searchRowAt(location);
  if (at) row.at = at;
  else if (location !== undefined) row.location = location;
  if (qualifiedNameSnake && qualifiedNameSnake !== rest.name) row.qualified_name = qualifiedNameSnake;
  if (qualifiedNameCamel && qualifiedNameCamel !== rest.name) row.qualifiedName = qualifiedNameCamel;
  for (const [key, value] of Object.entries(rest)) if (!(key in row)) row[key] = value;
  return row;
}

// A native source-text match states its file and line twice (`path`/`line`
// and the window form `repo_rel_path`/`startLine`/`endLine`), its source line
// twice (`text` is the whitespace-collapsed copy of `content`) and a constant
// content kind. Keep one of each. A match without `content` (the Node rescue
// sidecar) has only `text` and is left as it is.
function compactSourceTextMatch(match) {
  if (!match || typeof match !== "object" || Array.isArray(match) || typeof match.content !== "string") return match;
  const out = { ...match };
  delete out.text;
  if (out.repo_rel_path === out.path) delete out.repo_rel_path;
  if (Number.isSafeInteger(out.line)) {
    for (const key of ["startLine", "endLine"]) if (out[key] === out.line) delete out[key];
    if (out.lines === String(out.line)) delete out.lines;
  }
  for (const key of ["contentKind", "content_kind"]) if (out[key] === "source") delete out[key];
  return out;
}
