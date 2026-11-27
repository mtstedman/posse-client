export function mcpToolTextPayload(text) {
  const value = String(text || "");
  return {
    content: [{ type: "text", text: value }],
    isError: /^Error:/i.test(value),
  };
}

export function deliveredTraversalRefs(text, requestedRefs = []) {
  try {
    const parsed = JSON.parse(String(text || ""));
    if (Array.isArray(parsed?.refs)) {
      return requestedRefs.filter((_ref, index) => parsed.refs[index]?.ok === true);
    }
    return parsed?.ok === true && requestedRefs[0] ? [requestedRefs[0]] : [];
  } catch {
    return [];
  }
}

export function fetchRefMcpPayload(text) {
  const value = String(text || "");
  let data;
  try {
    data = JSON.parse(value);
  } catch {
    data = {
      ok: false,
      code: "invalid_fetch_ref_payload",
      error: "fetch_ref returned an invalid result payload",
    };
  }
  if (data?.ok === true) return mcpToolTextPayload(value);

  const code = String(data?.code || "fetch_ref_rejected");
  const message = String(data?.message || data?.error || "fetch_ref was rejected");
  const structured = {
    code,
    message,
    details: {
      status: "rejected",
      retryable: data?.retryable === true,
      ...(data?.classification ? { classification: String(data.classification) } : {}),
    },
  };
  return {
    // Preserve the existing model-visible payload exactly. The failure bit and
    // structured channels make provider/owner accounting truthful.
    content: [{ type: "text", text: value }],
    isError: true,
    structuredContent: { error: structured, data },
    _meta: { atlasError: structured, fetchRefResult: data },
  };
}

export function createRefMcpPayload(data = {}) {
  const result = /** @type {{ ok?: boolean, code?: string, error?: string, failed?: number, created?: number, status?: string, count?: number, [key: string]: unknown }} */ (data && typeof data === "object" ? data : {
    ok: false,
    code: "invalid_create_ref_payload",
    error: "create_ref returned an invalid result payload",
  });
  const text = JSON.stringify(result, null, 2);
  if (result.ok === true) return mcpToolTextPayload(text);

  const code = String(result.code || "create_ref_failed");
  const message = String(result.error || "create_ref failed");
  const failed = Math.max(0, Number(result.failed || 0));
  const created = Math.max(0, Number(result.created || 0));
  const status = ["failed", "rejected"].includes(String(result.status || ""))
    ? String(result.status)
    : (code === "create_ref_scope_unavailable" || code === "create_failed" || code === "create_ref_partial"
      ? "failed"
      : "rejected");
  const structured = {
    code,
    message,
    details: {
      status,
      retryable: false,
      ...(Number.isFinite(Number(result.count)) ? { count: Number(result.count) } : {}),
      ...(created > 0 ? { created } : {}),
      ...(failed > 0 ? { failed } : {}),
    },
  };
  return {
    content: [{ type: "text", text }],
    isError: true,
    structuredContent: { error: structured, data: result },
    _meta: { atlasError: structured, createRefResult: result },
  };
}
