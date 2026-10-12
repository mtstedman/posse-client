// @ts-check
import { readonlySet } from "./readonly-collections.js";



export const PAIRING_AUTH_ROUTE = "pairing:session";

export const PAIRING_PROTOCOL = "posse.pairing.v1";

export const DEFAULT_TIMEOUT_MS = 20_000;

export const ADMISSION_POLL_INTERVAL_MS = 2_000;
export const ADMISSION_MAX_CONSECUTIVE_FAILURES = 3;

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const PAIRING_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/u;

export const TOKEN_RE = /^pp[hm]_[0-9a-f]{32}$/u;

export const COUNTERSIGN_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/u;

export const FINGERPRINT_RE = /^[0-9a-f]{64}$/u;

export const SESSION_STATUSES = readonlySet(["active", "draining", "closed", "expired"]);

export const PEER_ROLES = readonlySet(["host", "member"]);

export const MAX_PEERS = 100;

export const MAX_WORK_ITEMS = 50;

export const MAX_JOBS = 100;

export const MAX_PAIRING_RESPONSE_BYTES = 8 * 1024 * 1024;

// Remote error codes whose remedy is local, with the message the operator
// needs instead of the relay's terse text.
export const REMOTE_ERROR_MESSAGES = Object.freeze({
  pairing_instance_conflicts_with_host:
    "This folder's Posse instance id matches the session host's (was .posse copied from the host?). "
    + "Join from a fresh empty folder.",
});
