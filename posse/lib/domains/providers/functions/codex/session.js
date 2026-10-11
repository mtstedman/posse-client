// Session handles supplied by the native Codex adapter.
export function normalizeCodexSessionHandle(value) {
  const text = String(value || "").trim();
  return text || null;
}
