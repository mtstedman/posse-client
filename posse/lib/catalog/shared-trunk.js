// Shared-trunk native protocol catalogue. This is intentionally independent
// from settings and workflow policy: it freezes only the versioned Rust/Node
// method boundary used for feature detection.

export const SHARED_TRUNK_NATIVE_CONTRACT_VERSION = 4;

export const SHARED_TRUNK_NATIVE_METHODS = Object.freeze({
  CAPABILITIES: "git.capabilities",
  PREFLIGHT: "git.trunk.preflight",
  FETCH: "git.trunk.fetch",
  FF_UPDATE: "git.trunk.ffUpdate",
  PUSH: "git.trunk.push",
  RESET_REJECTED: "git.trunk.resetRejected",
  CAS_PUSH_CLAIM: "git.refs.casPush",
});

export const SHARED_TRUNK_NATIVE_MUTATION_METHODS = Object.freeze([
  SHARED_TRUNK_NATIVE_METHODS.PREFLIGHT,
  SHARED_TRUNK_NATIVE_METHODS.FETCH,
  SHARED_TRUNK_NATIVE_METHODS.FF_UPDATE,
  SHARED_TRUNK_NATIVE_METHODS.PUSH,
  SHARED_TRUNK_NATIVE_METHODS.RESET_REJECTED,
  SHARED_TRUNK_NATIVE_METHODS.CAS_PUSH_CLAIM,
]);

// Native `git.trunk.push` outcomes where the remote refused to apply the
// update. Each parks the candidate behind one urgent human gate per branch
// and native reason; neither is retried automatically. A remote error is a
// server that failed to apply the push (disk, permissions, corrupt objects),
// not a branch rule, so its gate says so.
export const SHARED_TRUNK_PUSH_REFUSALS = Object.freeze({
  rejected_policy: Object.freeze({
    reason: "shared_trunk_push_refused",
    gateSubtype: "shared_trunk_push_refused",
    title: "Shared-trunk push refused",
    question: "The remote refused this shared-trunk push. Inspect the branch policy or pre-receive hook, then acknowledge when publication may be retried.",
  }),
  rejected_remote_error: Object.freeze({
    reason: "shared_trunk_push_remote_error",
    gateSubtype: "shared_trunk_push_remote_error",
    title: "Shared-trunk remote failed to apply push",
    question: "The remote server failed to apply this shared-trunk push (it reported a server-side error, not a branch policy). Check the remote repository's disk space, permissions, and object store, then acknowledge when publication may be retried.",
  }),
});
export const SHARED_TRUNK_PUSH_REFUSED_REASONS = Object.freeze(
  Object.values(SHARED_TRUNK_PUSH_REFUSALS).map((refusal) => refusal.reason),
);

// Remote HEAD states that name no default branch. Shared trunk fails closed on
// both. Keys are the code prefixes posse-git puts on its `git.trunk.preflight`
// error message; values are the Node failure codes.
export const SHARED_TRUNK_REMOTE_HEAD_FAILURES = Object.freeze({
  REMOTE_DEFAULT_BRANCH_UNBORN: "remote_default_branch_unborn",
  REMOTE_HEAD_DETACHED: "remote_head_detached",
});
