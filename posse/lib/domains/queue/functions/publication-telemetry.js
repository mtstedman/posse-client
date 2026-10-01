import { getDb } from "../../../shared/storage/functions/index.js";
import { PUSH_OFFER_SUBTYPE } from "./common.js";

function object(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function getPublicationTelemetry() {
  try {
    const row = getDb().prepare(`
      SELECT id, status, payload_json, result_json, created_at, updated_at
      FROM jobs
      WHERE job_type = 'human_input'
        AND json_valid(payload_json)
        AND json_extract(payload_json, '$.subtype') = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(PUSH_OFFER_SUBTYPE);
    if (!row) {
      return {
        publication_state: "unknown",
        deployment_state: "unverified",
        detail: "No publication receipt has been recorded.",
      };
    }
    const payload = object(row.payload_json);
    const result = object(row.result_json);
    const pushed = row.status === "succeeded" && result.pushed === true;
    const pending = ["queued", "leased", "running", "waiting_on_human", "waiting_on_review", "blocked"].includes(row.status)
      || result.declined === true;
    return {
      publication_state: pushed ? "pushed" : pending ? "local_only" : "unknown",
      deployment_state: "unverified",
      remote: payload.remote || result.remote || null,
      branch: payload.push_branch || result.branch || null,
      head: payload.push_head_hash || null,
      ahead_count: Number.isFinite(Number(payload.ahead_count)) ? Number(payload.ahead_count) : null,
      recorded_at: row.updated_at || row.created_at || null,
      detail: pushed
        ? "Remote push was recorded; no deployment acknowledgement is configured."
        : pending
          ? "Changes are local and still require publication."
          : "Publication outcome could not be verified from the latest offer.",
    };
  } catch {
    return {
      publication_state: "unknown",
      deployment_state: "unverified",
      detail: "Publication telemetry is unavailable.",
    };
  }
}
