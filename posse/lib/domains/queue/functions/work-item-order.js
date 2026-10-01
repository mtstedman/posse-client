// Work-item ordering for overlapping write scopes (NEW-H5).
//
// File locks only order individual paths. Work items that planned edits to
// the same files used to interleave by handing an idle lock from one unmerged
// branch to the next and syncing its commits along. The downstream branch then
// carried another work item's unreviewed edits and could only merge after it,
// so a rejected or failed upstream stranded it (wowiekowie 2026-10-01: WI 170
// carried WI 167's rejected planner.js commit; WI 169 carried WI 164's
// SCHEMA.md). Instead, while a work item's planned write scope overlaps an
// earlier unmerged work item, none of its code jobs start until that work
// item merges, fails or is canceled; they then build on the fresh target.
//
// The wait is per work item, not per job. A sibling job with a disjoint scope
// that started anyway would take work-item locks the earlier work item may
// plan later (an assessment fix), and the handoff then ran backwards: the
// earlier work item copied the later one's unmerged file and had to merge
// after it, while the waiting sibling took the earlier work item's own lock
// through a bare release and both edited it from the same base (run 1250b red
// team 2, finding 4).
//
// "Earlier" is one strict total order over the work items that progress
// toward merge on their own (unmerged, not failed or canceled, and, once
// complete, not parked until an operator acts; queue file-locks
// workItemMergeParking), rebuilt from queue state whenever it is consulted:
//   1. Merge-order dependencies (left by cross-WI syncs): a work item that
//      must merge after another is placed after it.
//   2. Lock holding: a work item holding a work-item lock on a path that
//      another plans to edit is placed before it, since the lock is kept
//      until it merges.
//   3. Otherwise work items that already started editing (they hold or held
//      a work-item lock) come first, by first lock time; then work items that
//      have not started but have a code job that could start now (past its
//      ready_at); then the rest (waiting on a plan approval, earlier jobs, a
//      retry backoff or a quota pause). Ties go by id.
// Rules 1 and 2 are applied with Kahn's algorithm: among the work items whose
// constraints are all placed, the smallest rule-3 key goes next. If rule-2
// constraints cycle (two started work items each later planned edits to files
// the other holds), the cycle is broken by the rule-3 key, never against a
// rule-1 constraint. Every order wait points at an earlier work item in a
// single order, so order waits cannot form a cycle. A lock wait that runs
// against the order exists only where rule 1 overrode rule 2 or a rule-2 cycle
// was broken (two started work items each later planned files the other
// holds); the scheduler's cross-WI handoff resolves exactly those by
// releasing the holder's lock without its content (an existing-order or
// order release), so the holder's edits stay claimed and it rebuilds on the
// requester's merge. A parked work item is not ordered at all: a job reaching
// its locks waits for the operator to settle it (the scheduler finishes the
// run as needs-action naming it and its gate). Nothing unmerged is copied
// between work items.

import { isUnderRoot, rootsOverlap } from "../../../shared/scope/functions/path.js";

export const WORK_ITEM_ORDER_WAIT_REASON = "work_item_order";

function lockRowsOverlap(left, right) {
  if (left.lock_kind === "file" && right.lock_kind === "file") return left.path === right.path;
  if (left.lock_kind === "file" && right.lock_kind === "root") return isUnderRoot(left.path, [right.path]);
  if (left.lock_kind === "root" && right.lock_kind === "file") return isUnderRoot(right.path, [left.path]);
  if (left.lock_kind === "root" && right.lock_kind === "root") return rootsOverlap(left.path, right.path);
  return false;
}

/** First overlapping pair between two lists of `{ path, lock_kind }` rows. */
export function findLockRowOverlap(leftRows = [], rightRows = []) {
  for (const left of leftRows) {
    for (const right of rightRows) {
      if (lockRowsOverlap(left, right)) return { left, right };
    }
  }
  return null;
}

function orderTier(entry) {
  if (entry.started) return 0;
  return entry.ready ? 1 : 2;
}

function compareOrderKey(left, right) {
  const leftTier = orderTier(left);
  const rightTier = orderTier(right);
  if (leftTier !== rightTier) return leftTier - rightTier;
  if (leftTier === 0) {
    const leftAt = String(left.first_lock_at || "");
    const rightAt = String(right.first_lock_at || "");
    if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
  }
  return left.id - right.id;
}

/**
 * Build the total order from active work-item entries:
 * `{ id, started, first_lock_at, ready, planned, held, merge_after }`, where
 * `planned` and `held` are `{ path, lock_kind }` rows and `merge_after` lists
 * the work items this one must merge after.
 */
export function buildWorkItemOrder(entries = []) {
  const byId = new Map();
  for (const entry of entries) {
    const id = Number(entry?.id);
    if (!Number.isInteger(id) || id <= 0 || byId.has(id)) continue;
    byId.set(id, {
      ...entry,
      id,
      planned: Array.isArray(entry.planned) ? entry.planned : [],
      held: Array.isArray(entry.held) ? entry.held : [],
    });
  }
  const hardBefore = new Map();
  const softBefore = new Map();
  for (const entry of byId.values()) {
    hardBefore.set(entry.id, new Set([...(entry.merge_after || [])]
      .map(Number)
      .filter((id) => id !== entry.id && byId.has(id))));
    softBefore.set(entry.id, new Set());
  }
  for (const holder of byId.values()) {
    if (holder.held.length === 0) continue;
    for (const other of byId.values()) {
      if (other.id === holder.id || other.planned.length === 0) continue;
      if (findLockRowOverlap(holder.held, other.planned)) softBefore.get(other.id).add(holder.id);
    }
  }

  const placed = new Set();
  const ordered = [];
  const readyBy = (constraints) => (id) => constraints.every((before) =>
    [...before.get(id)].every((predecessor) => placed.has(predecessor)));
  const fullyReady = readyBy([hardBefore, softBefore]);
  const hardReady = readyBy([hardBefore]);
  while (placed.size < byId.size) {
    const remaining = [...byId.keys()].filter((id) => !placed.has(id));
    let pool = remaining.filter(fullyReady);
    if (pool.length === 0) pool = remaining.filter(hardReady);
    if (pool.length === 0) pool = remaining;
    pool.sort((left, right) => compareOrderKey(byId.get(left), byId.get(right)));
    placed.add(pool[0]);
    ordered.push(pool[0]);
  }
  return {
    byId,
    ordered,
    rank: new Map(ordered.map((id, index) => [id, index])),
  };
}

/**
 * The earliest work item ordered before `workItemId` whose planned scope or
 * held locks overlap that work item's planned scope (every non-terminal code
 * job, plus `extraRows`, the scope of a job the order was built without).
 * The wait is per work item: while any of its planned scope overlaps an
 * earlier work item, none of its code jobs start, so it takes no work-item
 * lock that the earlier one may need later (finding 4). Null when it may
 * start.
 */
export function findWorkItemOrderUpstream(order, workItemId, extraRows = []) {
  const id = Number(workItemId);
  if (!order || !Number.isInteger(id) || id <= 0) return null;
  const entry = order.byId.get(id);
  const planned = [...(entry?.planned || []), ...(Array.isArray(extraRows) ? extraRows : [])];
  if (planned.length === 0) return null;
  // A work item created after the order was built has not started, has a job
  // asking to start, and the largest id so far.
  const upstreamIds = order.rank.has(id)
    ? order.ordered.slice(0, order.rank.get(id))
    : order.ordered.filter((otherId) => compareOrderKey(order.byId.get(otherId), { id, started: false, ready: true }) < 0);
  for (const upstreamId of upstreamIds) {
    const upstream = order.byId.get(upstreamId);
    const overlap = findLockRowOverlap(planned, upstream.held) || findLockRowOverlap(planned, upstream.planned);
    if (overlap) return { upstream, candidate: overlap.left, holder: overlap.right };
  }
  return null;
}
