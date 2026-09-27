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
 * Final model-facing shape of a researcher symbol.search result. Search is a
 * locator: each hit keeps its name, kind, location and handle as one compact
 * row; the unrequested "beam" area list is dropped whenever there are hits; the
 * disambiguation block becomes one note. Runs after field-name projection, so
 * owner bookkeeping that reads location objects has already seen the full rows.
 *
 * @param {any} result
 */
export function compactResearchSearchRows(result) {
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
  const text = JSON.stringify(payload) + tail;
  if (text === first.text) return result;
  return { ...result, content: [{ ...first, text }, ...result.content.slice(1)] };
}

function compactSearchRow(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const { location, qualified_name: qualifiedName, ...rest } = item;
  const path = location && typeof location === "object" ? String(location.path || location.repo_rel_path || "") : "";
  const lines = location && typeof location === "object" ? location.lines : null;
  const row = { name: rest.name, kind: rest.kind };
  if (path) row.at = lines != null && String(lines) !== "" ? `${path}:${Array.isArray(lines) ? lines.join("-") : lines}` : path;
  else if (location !== undefined) row.location = location;
  if (qualifiedName && qualifiedName !== rest.name) row.qualified_name = qualifiedName;
  for (const [key, value] of Object.entries(rest)) if (!(key in row)) row[key] = value;
  return row;
}