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

export function normalizeHashRefAlias(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}

export function isHashRefAlias(value) {
  return HASH_REF_ALIAS_PATTERN.test(normalizeHashRefAlias(value));
}

export const HASH_REF_DESTINATIONS = Object.freeze([
  "brief",
  "compaction",
  "handoff",
]);

export const HASH_REF_DESTINATION_SET = new Set(HASH_REF_DESTINATIONS);
export const HASH_REF_DESTINATION_LIST_SQL = HASH_REF_DESTINATIONS.map((value) => `'${value}'`).join(",");
