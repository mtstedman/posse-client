// Classify peer-advertised shared-trunk heads against this clone's fetched
// origin head. Read-only object queries only: a peer SHA is never fetched by
// name, reset to, merged, or used as a base. The poller runs this after a
// completed fetch of the named shared branch, never per heartbeat.

import {
  PEER_TRUNK_HEAD_RELATIONS,
  SESSION_SYNC_POLICY,
  TRUNK_HEAD_PATTERN,
} from "../../../catalog/session-sync.js";
import { isGitCommandFailure } from "../classes/Repo.js";
import { gitExecAsync } from "./utils.js";

const GIT_TIMEOUT_MS = 5_000;

/**
 * @returns {Promise<{ relation: string, behind_count: number|null }|null>}
 *   null when Git could not answer (gate busy, native transport): an
 *   infrastructure failure proves nothing about the peer head.
 */
export async function classifyPeerTrunkHead(projectDir, {
  head,
  remoteSha,
  exec = gitExecAsync,
} = {}) {
  const peerHead = String(head || "").toLowerCase();
  const originHead = String(remoteSha || "").toLowerCase();
  if (!TRUNK_HEAD_PATTERN.test(peerHead) || !TRUNK_HEAD_PATTERN.test(originHead)) return null;
  if (peerHead === originHead) return { relation: PEER_TRUNK_HEAD_RELATIONS.SYNCED, behind_count: 0 };
  try {
    await exec(["cat-file", "-e", `${peerHead}^{commit}`], projectDir, { timeoutMs: GIT_TIMEOUT_MS });
  } catch (error) {
    return isGitCommandFailure(error)
      ? { relation: PEER_TRUNK_HEAD_RELATIONS.UNVERIFIED, behind_count: null }
      : null;
  }
  let counts;
  try {
    counts = String(await exec(
      ["rev-list", "--left-right", "--count", `${peerHead}...${originHead}`],
      projectDir,
      { timeoutMs: GIT_TIMEOUT_MS },
    ) || "").trim().split(/\s+/u).map((value) => Number.parseInt(value, 10));
  } catch {
    return null;
  }
  const [peerOnly, originOnly] = counts;
  if (!Number.isSafeInteger(peerOnly) || !Number.isSafeInteger(originOnly)) return null;
  if (peerOnly > 0) return { relation: PEER_TRUNK_HEAD_RELATIONS.AHEAD, behind_count: null };
  return originOnly > 0
    ? { relation: PEER_TRUNK_HEAD_RELATIONS.BEHIND, behind_count: originOnly }
    : { relation: PEER_TRUNK_HEAD_RELATIONS.SYNCED, behind_count: 0 };
}

/**
 * Merge fresh classifications into the persisted peer_heads cache and keep
 * the newest entries only (bounded to PEER_HEAD_CACHE_MAX).
 */
export function mergePeerHeadCache(prior, updates, { max = SESSION_SYNC_POLICY.PEER_HEAD_CACHE_MAX } = {}) {
  const merged = new Map();
  const add = (head, entry) => {
    const sha = String(head || "").toLowerCase();
    if (!TRUNK_HEAD_PATTERN.test(sha) || !entry || typeof entry !== "object") return;
    if (!Object.values(PEER_TRUNK_HEAD_RELATIONS).includes(entry.relation)) return;
    merged.set(sha, {
      relation: entry.relation,
      behind_count: Number.isSafeInteger(entry.behind_count) && entry.behind_count >= 0 ? entry.behind_count : null,
      checked_at: String(entry.checked_at || ""),
      against: TRUNK_HEAD_PATTERN.test(String(entry.against || "")) ? String(entry.against) : null,
    });
  };
  for (const [head, entry] of Object.entries(prior && typeof prior === "object" ? prior : {})) add(head, entry);
  for (const [head, entry] of Object.entries(updates && typeof updates === "object" ? updates : {})) {
    merged.delete(String(head || "").toLowerCase());
    add(head, entry);
  }
  const newestFirst = [...merged.entries()]
    .sort((left, right) => String(right[1].checked_at).localeCompare(String(left[1].checked_at)))
    .slice(0, Math.max(0, max));
  return Object.fromEntries(newestFirst);
}
