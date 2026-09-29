// Canonical closed sets and timing policy for the pairing-session sync
// indicator, the per-checkout hold, and peer trunk-head hints.
//
// The indicator is a truthfulness contract: every state below is derived from
// persisted evidence (the session link, shared-trunk health, the hold row and
// lock liveness), and "synced" is reachable only from a fresh completed fetch.
// Register each spelling here once; surfaces and derivations import it.

export const SESSION_SYNC_STATES = Object.freeze({
  DISCONNECTED: "disconnected",
  BLOCKED: "blocked",
  DIVERGED: "diverged",
  HELD: "held",
  PUBLISHING: "publishing",
  NOT_SYNCING: "not_syncing",
  STALE: "stale",
  BEHIND: "behind",
  SYNCED: "synced",
  UNKNOWN: "unknown",
});

export const SESSION_SYNC_GLYPHS = Object.freeze({
  [SESSION_SYNC_STATES.DISCONNECTED]: "✖",
  [SESSION_SYNC_STATES.BLOCKED]: "⊘",
  [SESSION_SYNC_STATES.DIVERGED]: "⊘",
  [SESSION_SYNC_STATES.HELD]: "⏸",
  [SESSION_SYNC_STATES.PUBLISHING]: "⇡",
  [SESSION_SYNC_STATES.NOT_SYNCING]: "○",
  [SESSION_SYNC_STATES.STALE]: "⚠",
  [SESSION_SYNC_STATES.BEHIND]: "↓",
  [SESSION_SYNC_STATES.SYNCED]: "●",
  [SESSION_SYNC_STATES.UNKNOWN]: "?",
});

// Why a checkout is blocked, highest precedence first. These are the reason
// tokens carried in a derived state's `reasons` list.
export const SESSION_SYNC_BLOCK_REASONS = Object.freeze({
  PROVENANCE_REVIEW: "provenance-review",
  PROVENANCE_REJECTED: "provenance-rejected",
  PUBLICATION_BLOCKED: "publication-blocked",
  FAST_FORWARD_BLOCKED: "fast-forward-blocked",
  CONFIGURATION_INVALID: "configuration-invalid",
  DISABLED: "shared-trunk-disabled",
});

// A peer's advertised trunk head relative to this clone's fetched origin ref.
export const PEER_TRUNK_HEAD_RELATIONS = Object.freeze({
  SYNCED: "synced",
  BEHIND: "behind",
  AHEAD: "ahead",
  UNVERIFIED: "unverified",
});

export const PEER_SYNC_STATES = Object.freeze({
  ...PEER_TRUNK_HEAD_RELATIONS,
  STALE: "stale",
  UNKNOWN: "unknown",
});

// Which local process last wrote the session link row.
export const SESSION_LINK_OWNERS = Object.freeze({
  CONSOLE: "console",
  SCHEDULER: "scheduler",
});

// The Remote's membership lease per role (rust/catalog/pairing.rs:6-7): a
// participant whose heartbeats stop for this long is dropped from the session.
export const SESSION_LEASE_SEC = Object.freeze({
  host: 90,
  member: 60,
});

/** The Remote membership lease for `role`; unknown roles get the shorter one. */
export function sessionLeaseSec(role) {
  return SESSION_LEASE_SEC[role] ?? SESSION_LEASE_SEC.member;
}

export const SESSION_SYNC_POLICY = Object.freeze({
  // A link counts as disconnected only after both a quiet window and repeated
  // failures, so one slow heartbeat never flips the indicator.
  LINK_DISCONNECT_AFTER_MS: 12_000,
  LINK_DISCONNECT_MIN_FAILURES: 2,
  // No heartbeat attempted for three beats: no process speaks for this clone
  // (for example posse go in its wrap-up screen), so the lease is running out.
  LINK_SILENT_AFTER_MS: 15_000,
  // Fetch freshness budget: two missed cadence windows plus transport slack.
  STALE_INTERVAL_MULTIPLIER: 2,
  STALE_SLACK_SEC: 90,
  HOLD_DEFAULT_TTL_MS: 30 * 60_000,
  HOLD_MIN_TTL_MS: 1_000,
  HOLD_MAX_TTL_MS: 24 * 60 * 60_000,
  // Peer hints can only pull the next cadence fetch earlier, never add load
  // beyond one hinted fetch per floor window.
  HINT_FETCH_FLOOR_MS: 10_000,
  HINT_HEADS_PER_POLL: 32,
  HINT_CLASSIFY_BUDGET_MS: 5_000,
  HINT_TRIED_MAX: 128,
  HINT_NEGATIVE_TTL_MS: 5 * 60_000,
  PEER_MUTE_AFTER_UNVERIFIED: 2,
  PEER_MUTE_MS: 5 * 60_000,
  PEER_STALE_AFTER_SEC: 15,
  PEER_LAST_SEEN_MAX_SEC: 86_400,
  PEER_HEAD_CACHE_MAX: 128,
  PEER_SNAPSHOT_MAX_PEERS: 100,
});

// Full SHA-1 or SHA-256 object names, lowercase: the only trunk-head spelling
// that crosses the relay in either direction.
export const TRUNK_HEAD_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/u;

export const SESSION_SYNC_TEXT_LIMITS = Object.freeze({
  HOLD_REASON: 200,
  LINK_ERROR: 240,
  ERROR_CODE: 80,
});
