// Bounded, credential-free diagnostic projections shared by MCP boot paths.

export function capString(value, max = 500) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

export function errorSummary(err) {
  if (!err) return null;
  const cause = err.cause && err.cause !== err ? err.cause : null;
  return {
    name: err?.name || null,
    code: err?.code || err?.errno || null,
    status: err?.status || err?.statusCode || err?.response?.status || null,
    message: capString(err?.message || String(err), 700),
    cause: cause ? {
      name: cause?.name || null,
      code: cause?.code || cause?.errno || null,
      status: cause?.status || cause?.statusCode || cause?.response?.status || null,
      message: capString(cause?.message || String(cause), 700),
    } : null,
  };
}

export function safeRemoteOrigin(baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function remoteSurfaceSummary(surface = null) {
  if (!surface || typeof surface !== "object") {
    return { present: false, suite_count: 0, tool_count: 0, tool_names_sample: [] };
  }
  const tools = Array.isArray(surface.tools) ? surface.tools : [];
  const suites = Array.isArray(surface.suites) ? surface.suites : [];
  return {
    present: true,
    suite_count: suites.length,
    tool_count: tools.length,
    tool_names_sample: tools
      .map((tool) => String(tool?.name || tool?.local_name || "").trim())
      .filter(Boolean)
      .slice(0, 30),
  };
}
