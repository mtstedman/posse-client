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
