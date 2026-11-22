// @ts-check
import { SESSION_ROUTABLE_JOB_TYPES } from "./session-sync.js";



export const PAIRING_WORK_ITEM_LIMIT = 50;

export const PAIRING_JOB_LIMIT = 100;

export const PAIRING_PEER_SNAPSHOT_MAX_AGE_MS = 20_000;

export const PAIRING_PEER_SNAPSHOT_PROTOCOL = "posse.pairing_peers.v1";

// A member advertises exactly the job types the session router offers.
export const SESSION_JOB_TYPES = SESSION_ROUTABLE_JOB_TYPES;

export const SESSION_IDENTITIES_MAX = 256;
