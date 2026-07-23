export const HASH_REF_OWNER_SCOPES = Object.freeze([
  "work_item",
  "job",
  "agent_run",
]);

export const HASH_REF_OWNER_SCOPE_SET = new Set(HASH_REF_OWNER_SCOPES);
export const HASH_REF_OWNER_SCOPE_LIST_SQL = HASH_REF_OWNER_SCOPES.map((value) => `'${value}'`).join(",");

export const HASH_REF_ENTRY_KINDS = Object.freeze([
  "materialized",
  "descriptor",
]);

export const HASH_REF_ENTRY_KIND_SET = new Set(HASH_REF_ENTRY_KINDS);
export const HASH_REF_ENTRY_KIND_LIST_SQL = HASH_REF_ENTRY_KINDS.map((value) => `'${value}'`).join(",");

export const HASH_REF_LANES = Object.freeze([
  "proof",
  "support",
  "decoy",
]);

export const HASH_REF_LANE_SET = new Set(HASH_REF_LANES);
export const HASH_REF_LANE_LIST_SQL = HASH_REF_LANES.map((value) => `'${value}'`).join(",");

export const HASH_REF_ALIAS_PATTERN = /^#[0-9a-z]{4,12}$/;
export const HASH_REF_SELECTOR_PATTERN = /^(#[0-9a-z]{4,12})(?::l?(\d+)-l?(\d+))?$/i;

export function normalizeHashRefAlias(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}

export function isHashRefAlias(value) {
  return HASH_REF_ALIAS_PATTERN.test(normalizeHashRefAlias(value));
}

export function parseHashRefSelector(value) {
  const raw = String(value || "").trim().toLowerCase();
  const normalized = raw.startsWith("#") ? raw : `#${raw}`;
  const match = HASH_REF_SELECTOR_PATTERN.exec(normalized);
  if (!match) return null;
  const start = match[2] == null ? null : Number(match[2]);
  const end = match[3] == null ? null : Number(match[3]);
  if (start != null && (
    !Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 1
    || end < start
  )) return null;
  return {
    ref: match[1],
    lines: start == null ? null : { start, end },
  };
}

export function formatHashRefSelector(ref, lines = null) {
  const alias = normalizeHashRefAlias(ref);
  if (!isHashRefAlias(alias)) return "";
  if (!lines) return alias;
  const start = Number(lines.start);
  const end = Number(lines.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return "";
  return `${alias}:L${start}-L${end}`;
}

export const HASH_REF_DESTINATIONS = Object.freeze([
  "brief",
  "compaction",
  "handoff",
]);

export const HASH_REF_DESTINATION_SET = new Set(HASH_REF_DESTINATIONS);
export const HASH_REF_DESTINATION_LIST_SQL = HASH_REF_DESTINATIONS.map((value) => `'${value}'`).join(",");
