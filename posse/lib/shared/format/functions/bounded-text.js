export const DEFAULT_BOUNDED_TEXT_MAX_CHARS = 4 * 1024 * 1024;

export function appendBoundedText(current = "", chunk = "", maxChars = DEFAULT_BOUNDED_TEXT_MAX_CHARS) {
  const text = typeof chunk === "string" ? chunk : String(chunk ?? "");
  if (!text) return String(current || "");
  const next = `${current || ""}${text}`;
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0 || next.length <= limit) return next;
  return next.slice(next.length - limit);
}

export function retainBoundedText(value = "", maxChars = DEFAULT_BOUNDED_TEXT_MAX_CHARS) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) {
    return { text, retained: true, originalChars: text.length };
  }
  return {
    text: text.slice(0, limit),
    retained: false,
    originalChars: text.length,
  };
}
