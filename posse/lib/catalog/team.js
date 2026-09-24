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

// States a host may choose for a newly issued grant. Re-entry after a terminal
// state goes through a fresh grant request before one of these states is issued.
export const TEAM_GRANT_ISSUABLE_STATES = Object.freeze([
  TEAM_GRANT_STATES.ACTIVE,
  TEAM_GRANT_STATES.WAITING_FOR_FILES,
]);

export const TEAM_GRANT_TERMINAL_STATES = Object.freeze([
  TEAM_GRANT_STATES.REVOKED,
  TEAM_GRANT_STATES.EXPIRED,
  TEAM_GRANT_STATES.MERGED,
]);

export const TEAM_PUBLICATION_MODE = Object.freeze({
  DIRECT: "direct",
  GITHUB_PR: "github-pr",
});

// Branch protection state the host's provider actuator reports for the
// shared trunk in github-pr mode.
export const TEAM_PROTECTION_MODE_GITHUB_PR = "github_pr_protected";

export const TEAM_PUBLICATION_MODES = Object.freeze(
  Object.values(TEAM_PUBLICATION_MODE),
);

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
// the exact path in the same process that performs the write.
export const TEAM_FILE_WRITE_TOOLS = Object.freeze(["write_file", "edit_file"]);

// Transports that can carry a verified, path-bound write context to the code
// that performs the write. The persistent MCP transport does not carry the
// caller's AsyncLocalStorage context across processes; instead its signed boot
// binding carries the WI identity and the receiving process performs the same
// fresh grant lookup before establishing its own local write context.
export const TEAM_GRANT_BOUND_TRANSPORTS = Object.freeze([
  "provider-tool-runtime",
  "persistent-mcp",
]);

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
  APPROVAL_DENIED: "approval_denied",
  PUBLICATION_POLICY_STALE: "team_publication_policy_stale",
  HOST_PROVIDER_MERGE_REQUIRED: "host_provider_merge_required",
  SUBMISSION_IDENTITY_INVALID: "team_submission_identity_invalid",
});

// Submission lifecycle as Remote reports it. The host decides pending rows;
// approved rows are the only ones a member may publish or a host may merge.
export const TEAM_SUBMISSION_STATES = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  DENIED: "denied",
});

// The only Team publication outcomes that mean the candidate itself is wrong
// or the caller is broken, so re-attempting later cannot succeed. Every other
// reason a gate or proof can return is a state of the session (approval not
// yet given, a parked github-pr candidate, a lagging policy view, a Remote or
// transport failure) and defers with the completed passes preserved. The
// gate result is tagged `team: true` and classified by this set rather than
// by an allowlist of transient spellings, so a new reason cannot silently
// finalize a work item.
// After these gate outcomes the candidate has already been submitted to
// Remote (its refs are pushed and pinned by OID) and is waiting on a decision
// or on the host's provider merge. Reconciliation must keep that candidate
// OID instead of re-merging a new one on the next attempt: a new squash
// commit has a new OID, which needs a new submission and a new approval, so
// the approval that was just given would never converge.
export const TEAM_PARKED_CANDIDATE_REASONS = Object.freeze([
  TEAM_FAILURE_REASONS.APPROVAL_PENDING,
  TEAM_FAILURE_REASONS.APPROVAL_UNAVAILABLE,
  TEAM_FAILURE_REASONS.HOST_PROVIDER_MERGE_REQUIRED,
]);

export const TEAM_FATAL_FAILURE_REASONS = Object.freeze([
  TEAM_FAILURE_REASONS.APPROVAL_DENIED,
  TEAM_FAILURE_REASONS.SUBMISSION_IDENTITY_INVALID,
  "out_of_scope",
  "candidate_parent_mismatch",
  "empty_submission",
  "invalid_git_oid",
]);

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

// Deferrable: the work item keeps its completed passes and re-attempts later.
// Every Team publication failure belongs here, because none of them means the
// *work* is bad -- only that publication is not authorized yet. Finalizing a
// work item for an authorization problem throws away every completed pass and
// forces the whole job to be run again, which costs far more than carrying a
// deferred item until a valid grant arrives. Deferring re-attempts cost one
// Remote round trip; re-running costs the entire job.
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
  TEAM_FAILURE_REASONS.SIGNED_GRANT_INVALID,
]);

// Deferrable, but never routine. These survived the deterministic repair, so a
// stale local view is ruled out: the signed material itself does not verify.
// That is a security-relevant condition and must be surfaced as its own
// blocked state rather than folded into an ordinary "shared trunk busy"
// retry notice. The work is still preserved and publication resumes the moment
// a valid grant is issued -- what changes is that a human is told.
export const TEAM_ATTENTION_FAILURE_REASONS = Object.freeze([
  TEAM_FAILURE_REASONS.SIGNED_GRANT_INVALID,
]);

// Native Git methods that publish or commit and therefore run only under a
// verified work-item grant in an approval-managed Session. These are exactly
// the methods whose paths the posse-git binary checks against the pulse's
// write scope. Every other mutation is local coordination or sync (worktree
// setup, snapshot notes, trunk fetch and fast-forward, candidate reset, claim
// and offer refs) and runs under the Session's coordination-only pulse, which
// Remote mints with an empty write scope so none of those paths can be
// used to publish. `git.exec` is pinned only when the subcommand Git runs
// commits or pushes, or cannot be classified (see the sets below).
export const TEAM_GRANT_PINNED_GIT_METHODS = Object.freeze([
  "git.commitScopedTransaction",
  "git.trunk.push",
]);

// `git.exec` argv classification, mirroring posse-git's session-scope check.
// Only the subcommand Git actually runs counts, so `stash push` or
// `log --grep push` is not pinned. Leading global options are skipped by
// these closed sets; any other leading option is unclassifiable and pinned.
export const TEAM_GRANT_PINNED_GIT_EXEC_COMMANDS = Object.freeze([
  "commit",
  "http-push",
  "push",
  "send-pack",
]);
export const TEAM_GRANT_GIT_EXEC_GLOBAL_FLAGS = Object.freeze([
  "-p",
  "-P",
  "--bare",
  "--paginate",
  "--no-pager",
  "--no-replace-objects",
  "--no-optional-locks",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
]);
// Global options that take a value, as `--name value` or `--name=value`.
// Git accepts `-C` and `-c` only with a separate value.
export const TEAM_GRANT_GIT_EXEC_GLOBAL_VALUE_OPTIONS = Object.freeze([
  "-C",
  "-c",
  "--config-env",
  "--git-dir",
  "--namespace",
  "--work-tree",
]);
export const TEAM_GRANT_GIT_EXEC_CONFIG_OPTIONS = Object.freeze(["-c", "--config-env"]);
// Config keys under these sections can define an alias (directly or through
// an included file), so the subcommand could expand to a push.
export const TEAM_GRANT_GIT_EXEC_EXPANDING_CONFIG_SECTIONS = Object.freeze([
  "alias.",
  "include.",
  "includeif.",
]);
// Git builtins (`git --list-cmds=builtins`, excluding push/commit above and
// internal helpers). Git never expands an alias named like a builtin, so
// these cannot publish through config. Any other subcommand may be an alias
// for a push: posse-git reads the alias config and denies it, and the Node
// boundary, which reads no config, pins it.
export const TEAM_GRANT_GIT_EXEC_BUILTIN_COMMANDS = Object.freeze([
  "add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch",
  "bugreport", "bundle", "cat-file", "check-attr", "check-ignore",
  "check-mailmap", "check-ref-format", "checkout", "checkout-index", "cherry",
  "cherry-pick", "clean", "clone", "column", "commit-graph", "commit-tree",
  "config", "count-objects", "credential", "credential-cache",
  "credential-store", "describe", "diagnose", "diff", "diff-files",
  "diff-index", "diff-tree", "difftool", "fast-export", "fast-import", "fetch",
  "fetch-pack", "fmt-merge-msg", "for-each-ref", "for-each-repo",
  "format-patch", "fsck", "fsck-objects", "gc", "get-tar-commit-id", "grep",
  "hash-object", "help", "hook", "index-pack", "init", "init-db",
  "interpret-trailers", "log", "ls-files", "ls-remote", "ls-tree", "mailinfo",
  "mailsplit", "maintenance", "merge", "merge-base", "merge-file",
  "merge-index", "merge-ours", "merge-recursive", "merge-recursive-ours",
  "merge-recursive-theirs", "merge-subtree", "merge-tree", "mktag", "mktree",
  "multi-pack-index", "mv", "name-rev", "notes", "pack-objects",
  "pack-redundant", "pack-refs", "patch-id", "pickaxe", "prune",
  "prune-packed", "pull", "range-diff", "read-tree", "rebase", "receive-pack",
  "reflog", "remote", "remote-ext", "remote-fd", "repack", "replace", "rerere",
  "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "shortlog",
  "show", "show-branch", "show-index", "show-ref", "sparse-checkout", "stage",
  "stash", "status", "stripspace", "switch", "symbolic-ref", "tag",
  "unpack-file", "unpack-objects", "update-index", "update-ref",
  "update-server-info", "upload-archive", "upload-pack", "var",
  "verify-commit", "verify-pack", "verify-tag", "version", "whatchanged",
  "worktree", "write-tree",
]);

// Provider adapters that execute file edits only through Posse's mediated tool
// runtime, where a fresh per-call grant can be bound to the exact path. Claude
// and Codex adapters can expose native shell/patch/file writes that no grant
// check can follow, so approval mode refuses them for every role: the check
// is about what the adapter *can* do, not what the role is expected to do.
export const TEAM_MANAGED_PROVIDERS = Object.freeze(["openai", "grok"]);
