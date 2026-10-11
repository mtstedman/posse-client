// Planning-domain catalogue.

// A plan anchor records content hashes for at most this many scoped files,
// and the drift check before a dev or fix prompt compares at most as many.
export const PLAN_ANCHOR_MAX_FILES = 100;

// Bound on each read-only Git probe that snapshots or checks a plan anchor.
export const PLAN_ANCHOR_GIT_TIMEOUT_MS = 5_000;
