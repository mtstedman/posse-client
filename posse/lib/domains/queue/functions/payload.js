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

// Payload state that belongs to one execution of a job's implementation and
// its assessment. A requeue that re-runs the implementation clears it, or the
// worker resumes the previous candidate's assessment (`_assess_only`) and
// recovery reads a stale verification block. History the retry builds on
// (review feedback, clarifications, scope grants) is left alone.
const REEXECUTION_RESET_KEYS = Object.freeze(["_assess_only", "_verification_blocked"]);

/** Reset a parsed job payload for re-execution in place; returns it. */
export function resetJobPayloadForReexecution(payload) {
  for (const key of REEXECUTION_RESET_KEYS) delete payload[key];
  return payload;
}
