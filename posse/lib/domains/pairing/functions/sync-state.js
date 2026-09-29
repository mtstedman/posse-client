// Pure derivation of the pairing-session sync indicator. No I/O: callers
// gather the persisted evidence (session link, shared-trunk health, hold row,
// lock liveness, peer snapshot) and this module turns it into one state.
//
// Truthfulness rules: precedence is fixed and deterministic, every age is
// computed from a persisted timestamp, and "synced" is reached only from a
// fresh completed fetch whose origin head the checkout contains. Anything the
// evidence cannot prove falls through to "unknown", never to "synced".

import {
  PEER_SYNC_STATES,
  PEER_TRUNK_HEAD_RELATIONS,
  SESSION_SYNC_BLOCK_REASONS,
  SESSION_SYNC_GLYPHS,
  SESSION_SYNC_POLICY,
  SESSION_SYNC_STATES,
  TRUNK_HEAD_PATTERN,
} from "../../../catalog/session-sync.js";
import { SHARED_TRUNK_DEFAULTS } from "../../../catalog/settings.js";

const STATES = SESSION_SYNC_STATES;
const BLOCK = SESSION_SYNC_BLOCK_REASONS;

function parseMs(value) {
  if (value == null || value === "") return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function ageSecFrom(atMs, nowMs) {
  return atMs == null ? null : Math.max(0, Math.floor((nowMs - atMs) / 1000));
}

function countOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function shortSha(value) {
  const sha = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/u.test(sha) ? sha.slice(0, 7) : null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Compact age: 45s, 12m, 3h, 2d. */
export function formatSyncAge(ageSec) {
  if (ageSec == null || !Number.isFinite(Number(ageSec))) return "never";
  const seconds = Math.max(0, Math.floor(Number(ageSec)));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function result(state, label, { behind = null, head = null, ageSec = null, reasons = [] } = {}) {
  const glyph = SESSION_SYNC_GLYPHS[state];
  return {
    state,
    glyph,
    label: `${glyph} ${label}`,
    behind,
    head,
    ageSec,
    reasons,
  };
}

function trunkHasData(trunk) {
  return isRecord(trunk) && Object.keys(trunk).length > 0;
}

function blockedReasons(trunk) {
  if (!isRecord(trunk)) return [];
  const reasons = [];
  if (trunk.provenance_blocked === true) reasons.push(BLOCK.PROVENANCE_REVIEW);
  if (trunk.provenance_gate_rejected === true) reasons.push(BLOCK.PROVENANCE_REJECTED);
  if (trunk.publication_unresolved === true) reasons.push(BLOCK.PUBLICATION_BLOCKED);
  if (typeof trunk.blocked_reason === "string" && trunk.blocked_reason.trim()) {
    reasons.push(BLOCK.FAST_FORWARD_BLOCKED);
  }
  if (trunk.configuration_error === true) reasons.push(BLOCK.CONFIGURATION_INVALID);
  if (trunk.enabled === false) reasons.push(BLOCK.DISABLED);
  return reasons;
}

const BLOCK_LABELS = Object.freeze({
  [BLOCK.PROVENANCE_REVIEW]: "provenance review",
  [BLOCK.PROVENANCE_REJECTED]: "provenance rejected",
  [BLOCK.PUBLICATION_BLOCKED]: "publication unresolved",
  [BLOCK.FAST_FORWARD_BLOCKED]: "checkout blocks fast-forward",
  [BLOCK.CONFIGURATION_INVALID]: "configuration invalid",
  [BLOCK.DISABLED]: "shared trunk disabled",
});

// What stops a person's own checkout from fast-forwarding, in their words.
const FAST_FORWARD_BLOCK_DETAILS = Object.freeze({
  dirty: "uncommitted changes · commit or stash them to update",
  wrong_checkout: "this folder is not on the session branch",
  ignored_path_collision: "an ignored file is in the way",
});

/** Last proven completed fetch: the dedicated stamp, else a legacy success. */
function lastFetchOkMs(trunk) {
  return parseMs(trunk?.last_fetch_ok_at) ?? parseMs(trunk?.last_success_at);
}

function pollIntervalSec(trunk) {
  const parsed = Number(trunk?.poll_interval_sec);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SHARED_TRUNK_DEFAULTS.fetchIntervalSec;
}

/**
 * Derive this checkout's sync indicator.
 *
 * @param {object} input
 * @param {number} input.nowMs
 * @param {"host"|"member"|null} [input.role]
 * @param {object|null} [input.link]  SESSION_LINK row for this session
 * @param {object|null} [input.trunk] SHARED_TRUNK runtime status
 * @param {object|null} [input.hold]  the ACTIVE SESSION_HOLD row, or null
 * @param {boolean} [input.fetchOwnerAlive] a live scheduler owns the poller
 * @param {boolean} [input.publishing] a live process holds the merge lock
 * @param {string[]} [input.unresolvedPeerHeads] peer heads not yet proven
 * @returns {{ state: string, glyph: string, label: string,
 *   behind: number|null, head: string|null, ageSec: number|null,
 *   reasons: string[] }}
 */
export function deriveSessionSyncState({
  nowMs = Date.now(),
  role: _role = null,
  link = null,
  trunk = null,
  hold = null,
  fetchOwnerAlive = undefined,
  publishing = undefined,
  unresolvedPeerHeads = [],
} = {}) {
  const now = Number(nowMs);
  const trunkRow = isRecord(trunk) ? trunk : {};
  const head = shortSha(trunkRow.local_sha) || shortSha(trunkRow.remote_sha);
  const behindCount = countOrNull(trunkRow.behind_count);
  const unresolved = Array.isArray(unresolvedPeerHeads) ? unresolvedPeerHeads.filter(Boolean) : [];

  if (!isRecord(link) && !trunkHasData(trunk) && !isRecord(hold)
    && typeof fetchOwnerAlive !== "boolean" && typeof publishing !== "boolean") {
    return result(STATES.UNKNOWN, "unknown", { reasons: ["no-data"] });
  }

  // 1. Relay link lost: quiet for longer than the window AND failing, or no
  //    process has even attempted a heartbeat for several beats.
  if (isRecord(link)) {
    const lastOkMs = parseMs(link.last_ok_at);
    // A success is also an attempt; older rows may carry only last_ok_at.
    const lastAttemptMs = parseMs(link.last_attempt_at) ?? lastOkMs;
    const failures = Math.max(0, Number(link.consecutive_failures) || 0);
    const quiet = lastOkMs == null || now - lastOkMs > SESSION_SYNC_POLICY.LINK_DISCONNECT_AFTER_MS;
    const failing = quiet && failures >= SESSION_SYNC_POLICY.LINK_DISCONNECT_MIN_FAILURES;
    const silent = lastAttemptMs == null || now - lastAttemptMs > SESSION_SYNC_POLICY.LINK_SILENT_AFTER_MS;
    if (failing || silent) {
      const ageSec = ageSecFrom(lastOkMs, now);
      const leaseSec = Number(link.lease_sec);
      const lapse = ageSec != null && Number.isFinite(leaseSec) && leaseSec > 0
        ? ` · lapses in ${Math.max(0, Math.floor(leaseSec - ageSec))}s`
        : "";
      return result(STATES.DISCONNECTED, `disconnected${failing ? "" : " · no heartbeat"}${lapse}`, {
        behind: behindCount,
        head,
        ageSec,
        reasons: [
          failing ? "link-failing" : "link-silent",
          ...(link.last_error ? [`link-error:${link.last_error}`] : []),
        ],
      });
    }
  }

  // 2. Recovery-relevant blocks, then divergence.
  const blocked = blockedReasons(trunkRow);
  if (blocked.length > 0) {
    const gateId = Number(trunkRow.provenance_gate_job_id);
    const detail = blocked[0] === BLOCK.FAST_FORWARD_BLOCKED
      ? FAST_FORWARD_BLOCK_DETAILS[trunkRow.blocked_reason] || BLOCK_LABELS[blocked[0]]
      : blocked[0] === BLOCK.PROVENANCE_REVIEW && Number.isSafeInteger(gateId) && gateId > 0
        ? `unknown commits need review · posse gate answer ${gateId} accept (or reject)`
        : BLOCK_LABELS[blocked[0]];
    const waiting = behindCount != null && behindCount > 0 ? ` · ↓${behindCount}` : "";
    return result(STATES.BLOCKED, `blocked${waiting} · ${detail}`, {
      behind: behindCount,
      head,
      ageSec: ageSecFrom(lastFetchOkMs(trunkRow), now),
      reasons: blocked,
    });
  }
  if (trunkRow.diverged === true) {
    const ahead = countOrNull(trunkRow.ahead_count);
    const counts = ahead != null || behindCount != null
      ? ` · ↑${ahead ?? "?"} ↓${behindCount ?? "?"}`
      : "";
    return result(STATES.DIVERGED, `diverged${counts}`, {
      behind: behindCount,
      head,
      ageSec: ageSecFrom(lastFetchOkMs(trunkRow), now),
      reasons: ["diverged"],
    });
  }

  // 3. Operator hold: fetches continue, the checkout is frozen.
  if (isRecord(hold)) {
    const setMs = parseMs(hold.set_at);
    const ageSec = ageSecFrom(setMs, now);
    return result(STATES.HELD, `held ${formatSyncAge(ageSec)} · ↓${behindCount ?? "?"}`, {
      behind: behindCount,
      head,
      ageSec,
      reasons: ["held", ...(hold.reason ? [`hold-reason:${hold.reason}`] : [])],
    });
  }

  // 4. A live process is inside the merge/publish critical section.
  if (publishing === true) {
    return result(STATES.PUBLISHING, "publishing", {
      behind: behindCount,
      head,
      ageSec: ageSecFrom(lastFetchOkMs(trunkRow), now),
      reasons: ["merge-lock-held"],
    });
  }

  // 5. Nobody owns the poller, so nothing will refresh the checkout.
  if (fetchOwnerAlive !== true) {
    return result(STATES.NOT_SYNCING, "not syncing · no session console or posse go is running here", {
      behind: behindCount,
      head,
      ageSec: ageSecFrom(lastFetchOkMs(trunkRow), now),
      reasons: ["no-fetch-owner"],
    });
  }

  // 6. Fetch freshness against the cadence actually in effect.
  const fetchOkMs = lastFetchOkMs(trunkRow);
  const fetchAgeSec = ageSecFrom(fetchOkMs, now);
  const errorCode = typeof trunkRow.last_sync_error_code === "string" && trunkRow.last_sync_error_code
    ? trunkRow.last_sync_error_code
    : null;
  const staleAfterSec = SESSION_SYNC_POLICY.STALE_INTERVAL_MULTIPLIER * pollIntervalSec(trunkRow)
    + SESSION_SYNC_POLICY.STALE_SLACK_SEC;
  const attemptsFailed = errorCode != null || (Number(trunkRow.sync_unavailable_count) || 0) > 0;
  if ((fetchOkMs != null && fetchAgeSec > staleAfterSec) || (fetchOkMs == null && attemptsFailed)) {
    return result(STATES.STALE, `stale ${formatSyncAge(fetchAgeSec)}${errorCode ? ` (${errorCode})` : ""}`, {
      behind: behindCount,
      head,
      ageSec: fetchAgeSec,
      reasons: ["fetch-stale", ...(errorCode ? [`sync-error:${errorCode}`] : [])],
    });
  }
  if (fetchOkMs == null) {
    // A live fetch owner that has not completed its first fetch yet.
    return result(STATES.UNKNOWN, "first sync in progress", { behind: behindCount, head, reasons: ["never-fetched"] });
  }
  // A sync step failed after the last completed fetch (for example recovery or
  // provenance threw before the fast-forward): the checkout is unproven.
  const errorMs = parseMs(trunkRow.last_sync_error_at);
  if (errorCode != null && errorMs != null && errorMs >= fetchOkMs) {
    return result(STATES.STALE, `sync error · ${errorCode}`, {
      behind: behindCount,
      head,
      ageSec: fetchAgeSec,
      reasons: ["sync-error-after-fetch", `sync-error:${errorCode}`],
    });
  }

  // 7. Behind origin, or a peer advertises a head this clone has not proven.
  const localSha = String(trunkRow.local_sha || "");
  const remoteHead = String(trunkRow.remote_sha || "");
  const aheadCount = countOrNull(trunkRow.ahead_count);
  // Origin contained in the checkout (equal, or only unpublished local work).
  const holdsOrigin = Boolean(localSha && remoteHead)
    && (localSha === remoteHead || (behindCount === 0 && aheadCount != null && aheadCount > 0));
  if (localSha && remoteHead && !holdsOrigin && !(behindCount != null && behindCount > 0)) {
    return result(STATES.BEHIND, "?", {
      behind: null,
      head,
      ageSec: fetchAgeSec,
      reasons: ["checkout-not-at-origin"],
    });
  }
  if (behindCount != null && behindCount > 0) {
    return result(STATES.BEHIND, `${behindCount} behind`, {
      behind: behindCount,
      head,
      ageSec: fetchAgeSec,
      reasons: ["behind-origin", ...(unresolved.length ? ["peer-head-unresolved"] : [])],
    });
  }
  if (unresolved.length > 0) {
    return result(STATES.BEHIND, "?", {
      behind: null,
      head,
      ageSec: fetchAgeSec,
      reasons: ["peer-head-unresolved"],
    });
  }

  // 8. Proven: a fresh completed fetch whose origin head the checkout holds.
  if (behindCount === 0 && holdsOrigin) {
    const ahead = countOrNull(trunkRow.ahead_count);
    return result(STATES.SYNCED, `synced ${formatSyncAge(fetchAgeSec)} · ${head || "???????"}`, {
      behind: 0,
      head,
      ageSec: fetchAgeSec,
      reasons: [...(ahead ? [`local-ahead:${ahead}`] : []), ...(errorCode ? [`sync-error:${errorCode}`] : [])],
    });
  }
  return result(STATES.UNKNOWN, "unknown", {
    behind: behindCount,
    head,
    ageSec: fetchAgeSec,
    reasons: ["unproven-head"],
  });
}

function peerHeadEntry(trunk, head) {
  const heads = isRecord(trunk?.peer_heads) ? trunk.peer_heads : {};
  const entry = heads[head];
  return isRecord(entry) ? entry : null;
}

function peerLastSeen(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= SESSION_SYNC_POLICY.PEER_LAST_SEEN_MAX_SEC
    ? parsed
    : null;
}

/**
 * Relation of one advertised peer head to this clone's fetched origin head.
 * Only a classification made against the current origin head is trusted;
 * after origin advanced, a peer that was synced or behind is still behind by
 * an unknown count, and anything else is unknown until the next fetch.
 */
export function peerHeadRelation(trunk, head) {
  const sha = String(head || "").toLowerCase();
  if (!TRUNK_HEAD_PATTERN.test(sha)) return { relation: null, behind_count: null };
  const remoteSha = String(trunk?.remote_sha || "").toLowerCase();
  if (remoteSha && sha === remoteSha) return { relation: PEER_TRUNK_HEAD_RELATIONS.SYNCED, behind_count: 0 };
  const entry = peerHeadEntry(trunk, sha);
  if (!entry || !Object.values(PEER_TRUNK_HEAD_RELATIONS).includes(entry.relation)) {
    return { relation: null, behind_count: null };
  }
  if (remoteSha && entry.against === remoteSha) {
    return { relation: entry.relation, behind_count: countOrNull(entry.behind_count) };
  }
  if ([PEER_TRUNK_HEAD_RELATIONS.SYNCED, PEER_TRUNK_HEAD_RELATIONS.BEHIND].includes(entry.relation)) {
    return { relation: PEER_TRUNK_HEAD_RELATIONS.BEHIND, behind_count: null };
  }
  return { relation: null, behind_count: null };
}

/**
 * Peer heads this clone has not proven it contains: unclassified heads and
 * heads classified ahead of the fetched origin. Unverified heads (absent after
 * a completed fetch) are excluded so a bogus advert cannot hold "↓ ?".
 */
export function unresolvedPeerTrunkHeads(peers, trunk) {
  const local = String(trunk?.local_sha || "").toLowerCase();
  const heads = new Set();
  for (const peer of Array.isArray(peers) ? peers : []) {
    const head = String(peer?.trunk_head || "").toLowerCase();
    if (!TRUNK_HEAD_PATTERN.test(head) || head === local) continue;
    const { relation } = peerHeadRelation(trunk, head);
    if (relation == null || relation === PEER_TRUNK_HEAD_RELATIONS.AHEAD) heads.add(head);
  }
  return [...heads];
}

/**
 * Per-peer sync rows for the session surfaces.
 * @returns {Array<{ instance_id: string, role: string, label: string,
 *   trunk_head: string|null, last_seen_age_sec: number|null, state: string,
 *   behind_count: number|null }>}
 */
export function derivePeerSyncStates({ peers = [], trunk = null, nowMs: _nowMs = Date.now() } = {}) {
  return (Array.isArray(peers) ? peers : []).map((peer) => {
    const head = String(peer?.trunk_head || "").toLowerCase();
    const validHead = TRUNK_HEAD_PATTERN.test(head) ? head : null;
    const lastSeen = peerLastSeen(peer?.last_seen_age_sec);
    let state;
    let behindCount = null;
    if (lastSeen != null && lastSeen > SESSION_SYNC_POLICY.PEER_STALE_AFTER_SEC) {
      state = PEER_SYNC_STATES.STALE;
    } else if (!validHead) {
      state = PEER_SYNC_STATES.UNKNOWN;
    } else {
      const { relation, behind_count: count } = peerHeadRelation(trunk, validHead);
      state = relation || PEER_SYNC_STATES.UNKNOWN;
      behindCount = relation === PEER_TRUNK_HEAD_RELATIONS.BEHIND ? count : null;
    }
    return {
      instance_id: String(peer?.instance_id || ""),
      role: String(peer?.role || ""),
      label: String(peer?.label || ""),
      trunk_head: validHead ? validHead.slice(0, 7) : null,
      last_seen_age_sec: lastSeen,
      state,
      behind_count: behindCount,
    };
  });
}

/**
 * The indicator as a one-off feed line: a synced checkout drops its fetch age
 * (it only grows) and keeps the head, so the line names the state change.
 */
export function sessionSyncFeedLabel(sync) {
  if (!isRecord(sync) || !sync.state) return `${SESSION_SYNC_GLYPHS[STATES.UNKNOWN]} unknown`;
  if (sync.state === STATES.SYNCED) {
    return `${sync.glyph || SESSION_SYNC_GLYPHS[STATES.SYNCED]} synced · ${sync.head || "???????"}`;
  }
  return String(sync.label || `${sync.glyph || SESSION_SYNC_GLYPHS[STATES.UNKNOWN]} ${sync.state}`);
}

/** One compact peer row: "Ana (member) · behind ↓2 · aaaaaaa · seen 4s ago". */
export function formatPeerSyncRow(peer) {
  const instanceId = String(peer?.instance_id || "");
  const advertised = String(peer?.label || "").trim();
  // Until a peer's first full heartbeat the relay may echo its instance id.
  const machine = instanceId.replace(/^posse-/u, "").slice(0, 8);
  const name = (advertised && advertised !== instanceId ? advertised : "") || (machine ? `machine ${machine}` : "peer");
  const role = peer?.role ? ` (${peer.role})` : "";
  const state = String(peer?.state || PEER_SYNC_STATES.UNKNOWN);
  const behind = state === PEER_SYNC_STATES.BEHIND && countOrNull(peer?.behind_count) != null
    ? ` ↓${countOrNull(peer.behind_count)}`
    : "";
  const head = peer?.trunk_head ? ` · ${peer.trunk_head}` : "";
  const seen = peer?.last_seen_age_sec != null ? ` · seen ${formatSyncAge(peer.last_seen_age_sec)} ago` : "";
  // A peer whose sync is not relayed (an older Remote, or no fetch yet).
  const label = state === PEER_SYNC_STATES.UNKNOWN ? "sync unknown" : state;
  return `${name}${role} · ${label}${behind}${head}${seen}`;
}
