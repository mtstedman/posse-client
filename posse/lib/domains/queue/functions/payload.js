export function parseJsonObject(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (!value || typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function parseJobPayload(jobOrPayload, fallback = {}) {
  const value = jobOrPayload && typeof jobOrPayload === "object"
    ? jobOrPayload.payload_json !== undefined
      ? jobOrPayload.payload_json
      : jobOrPayload.row?.payload_json !== undefined
        ? jobOrPayload.row.payload_json
        : jobOrPayload
    : jobOrPayload;
  return parseJsonObject(value, fallback);
}
