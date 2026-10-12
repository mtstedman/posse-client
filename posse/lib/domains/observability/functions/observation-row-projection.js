// @ts-check
import "../../../shared/format/functions/json-text.js";
export { normalizeJsonText } from "../../../shared/format/functions/json-text.js";



export function normalizeObservationRow(row) {
  if (!row) return null;
  const id = Number(row.id || 0);
  return {
    id: Number.isFinite(id) && id > 0 ? id : null,
    work_item_id: row.work_item_id ?? row.wi ?? null,
    job_id: row.job_id ?? row.job ?? null,
    attempt_id: row.attempt_id ?? row.attempt ?? null,
    observation_type: row.observation_type ?? row.type ?? null,
    summary: row.summary ?? null,
    detail_json: row.detail_json ?? null,
    created_at: row.created_at || row.t || null,
  };
}

export function observationSortValue(row) {
  if (row?.id != null) return Number(row.id);
  return Date.parse(row?.created_at || "") || 0;
}

export function observationKey(row) {
  if (row?.id != null) return `id:${row.id}`;
  return [
    row?.created_at || "",
    row?.work_item_id ?? "",
    row?.job_id ?? "",
    row?.attempt_id ?? "",
    row?.observation_type || "",
    row?.summary || "",
  ].join("|");
}

export function mergeObservationRows(rows, order = "desc", limit = 100) {
  const deduped = new Map();
  for (const raw of rows || []) {
    const row = normalizeObservationRow(raw);
    if (!row?.observation_type) continue;
    deduped.set(observationKey(row), row);
  }
  const sorted = [...deduped.values()].sort((a, b) => {
    const delta = observationSortValue(a) - observationSortValue(b);
    return order === "asc" ? delta : -delta;
  });
  const max = limit == null ? sorted.length : Math.max(0, Number(limit) || 0);
  return sorted.slice(0, max);
}
