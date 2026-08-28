// Shared-trunk native protocol catalogue. This is intentionally independent
// from settings and workflow policy: it freezes only the versioned Rust/Node
// method boundary used for feature detection.

export const SHARED_TRUNK_NATIVE_CONTRACT_VERSION = 2;

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
