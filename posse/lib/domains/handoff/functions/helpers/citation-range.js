// @ts-check



export function normalizeLineRange(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const start = Number(value.start);
  const count = value.count == null ? null : Number(value.count);
  const end = count == null ? Number(value.end) : start + count - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  return { start, end };
}
