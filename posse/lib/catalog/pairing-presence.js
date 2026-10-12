// @ts-check



export const PAIRING_WORK_ITEM_LIMIT = 50;

export const PAIRING_JOB_LIMIT = 100;

export const PAIRING_PEER_SNAPSHOT_MAX_AGE_MS = 20_000;

export const PAIRING_PEER_SNAPSHOT_PROTOCOL = "posse.pairing_peers.v1";

export const SESSION_JOB_TYPES = Object.freeze([
  "research", "plan", "dev", "assess", "fix", "summarize", "artificer",
]);

export const SESSION_IDENTITIES_MAX = 256;
