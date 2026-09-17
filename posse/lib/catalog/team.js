// Canonical closed sets and policy tables for the cooperative Team session.
//
// Remote arbitrates exclusive write claims by literal path comparison and
// never reads Git objects, while the host re-derives scope from those objects
// and verifies the signed grant locally. Both sides therefore have to agree on
// exactly one spelling of every rule registered here. Each set previously had
// two or three independent implementations that disagreed, so register the
// canonical form once and import it rather than restating it.

export const TEAM_SCOPE_LIMITS = Object.freeze({
  MAX_PATH_LENGTH: 1024,
  MAX_WRITE_ENTRIES: 256,
  MAX_TOOL_ENTRIES: 128,
  MAX_DATABASE_ENTRIES: 64,
  MAX_LABEL_LENGTH: 128,
});

// A glob is not a path. Remote compares claims literally, so a wildcard root
// would claim the whole repository to its holder while overlapping no other
// claim, and the host could not narrow it to a real path. Scope entries are
// exact literal repository paths on both sides of the boundary.
export const TEAM_SCOPE_GLOB_PATTERN = /[*?[\]]/u;

export const TEAM_SCOPE_LABEL_PATTERN = /^[A-Za-z0-9_:.\-]+$/u;

export const TEAM_GRANT_STATES = Object.freeze({
  REQUESTED: "requested",
  WAITING_FOR_FILES: "waiting_for_files",
  ACTIVE: "active",
  REVOKED: "revoked",
  EXPIRED: "expired",
  MERGED: "merged",
});

// A host may only issue over a grant that has not reached a terminal state.
// Re-entry after a terminal state goes through a fresh grant request.
export const TEAM_GRANT_ISSUABLE_STATES = Object.freeze([
  TEAM_GRANT_STATES.ACTIVE,
  TEAM_GRANT_STATES.WAITING_FOR_FILES,
]);

export const TEAM_GRANT_TERMINAL_STATES = Object.freeze([
  TEAM_GRANT_STATES.REVOKED,
  TEAM_GRANT_STATES.EXPIRED,
  TEAM_GRANT_STATES.MERGED,
]);

export const TEAM_PUBLICATION_MODES = Object.freeze(["direct", "github-pr"]);

// Approval mode deliberately exposes a small executable surface. These names
// are checked at the tool dispatch boundary, before arbitrary handlers
// (including shell, image, database, ATLAS and custom tools) can run.
export const TEAM_READ_TOOLS = Object.freeze([
  "read_file", "list_files", "search_files", "git_history", "inspect_file",
  "hash_file", "get_brief", "pull_brief", "read_image_metadata",
  "validate_artifact_output", "agent_feedback", "get_operator_feedback",
  "ack_operator_feedback", "agent_handoff", "request_scope",
]);

// A file write is admitted only where a fresh per-call grant can be bound to
// the exact path in the same process that performs the write. The in-process
// provider tool runtime can do that; see TEAM_GRANT_BOUND_TRANSPORTS.
export const TEAM_FILE_WRITE_TOOLS = Object.freeze(["write_file", "edit_file"]);

// Transports that can carry a verified, path-bound write context to the code
// that performs the write. The MCP transport is JSON-RPC to a separate owner
// process, so the async write context cannot follow the call and a write
// arriving that way can never be grant-checked; approval mode refuses it at
// admission rather than admitting it and failing later at the write guard.
export const TEAM_GRANT_BOUND_TRANSPORTS = Object.freeze(["provider-tool-runtime"]);

export const TEAM_FAILURE_REASONS = Object.freeze({
  APPROVAL_PENDING: "approval_pending",
  APPROVAL_UNAVAILABLE: "approval_unavailable",
  APPROVAL_STALE: "approval_stale",
  WAITING_FOR_FILES: "waiting_for_files",
  GRANT_MISSING: "team_grant_missing",
  GRANT_INACTIVE: "team_grant_inactive",
  SIGNED_GRANT_EXPIRED: "signed_grant_expired",
  SIGNED_GRANT_UNCONFIRMED: "signed_grant_unconfirmed",
  SIGNED_GRANT_INVALID: "signed_grant_invalid",
  INVALID_GRANT_RESPONSE: "invalid_grant_response",
});

// A grant is verified by comparing its signed claims against local session
// state (branch, repository fingerprint, policy revision) and the local grant
// record. Stale local state therefore produces a verification failure with
// nothing actually wrong with the signed material, and that is the common
// case. These reasons earn exactly one deterministic repair — re-sync the
// authoritative session state from Remote, refetch the grant, verify again —
// before anything is treated as fatal. The repair refreshes only the inputs;
// it never relaxes the verification itself.
export const TEAM_GRANT_REPAIRABLE_REASONS = Object.freeze([
  TEAM_FAILURE_REASONS.SIGNED_GRANT_INVALID,
  TEAM_FAILURE_REASONS.INVALID_GRANT_RESPONSE,
]);

// Retryable: the condition clears on its own once the host issues, approves,
// or reissues. A publication attempt may defer and re-attempt on these.
export const TEAM_TRANSIENT_FAILURE_REASONS = Object.freeze([
  TEAM_FAILURE_REASONS.APPROVAL_PENDING,
  TEAM_FAILURE_REASONS.APPROVAL_UNAVAILABLE,
  TEAM_FAILURE_REASONS.APPROVAL_STALE,
  TEAM_FAILURE_REASONS.WAITING_FOR_FILES,
  TEAM_FAILURE_REASONS.GRANT_MISSING,
  TEAM_FAILURE_REASONS.GRANT_INACTIVE,
  TEAM_FAILURE_REASONS.SIGNED_GRANT_EXPIRED,
  // The repair could not run to completion (Remote unreachable, a status that
  // did not match, or a policy the local side must not adopt). Nothing has
  // been confirmed about the signed material, so this defers rather than
  // hard-failing on what may be a transport blip.
  TEAM_FAILURE_REASONS.SIGNED_GRANT_UNCONFIRMED,
]);

// Never retryable, and only ever reported after the deterministic repair above
// has run and failed. A signature that does not verify, a key ID that does not
// match, claims bound to another audience, or permissions that differ from the
// signed token is then a security event rather than a stale local view:
// re-resolving against authoritative Remote state has already been tried and
// changed nothing. Retrying further cannot clear it, and deferring would hide
// the one indicator of tampering behind an ordinary "will retry" notice.
export const TEAM_FATAL_FAILURE_REASONS = Object.freeze([
  TEAM_FAILURE_REASONS.SIGNED_GRANT_INVALID,
]);
