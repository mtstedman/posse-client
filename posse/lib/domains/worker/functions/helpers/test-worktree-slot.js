// @ts-check
// Heavy verification commands (builds, browser suites) from different jobs of
// one work item share a single worktree and its build output, ports and
// browsers. Run them one at a time per checkout so a neighbour's build cannot
// turn a passing check into a timeout. A receipt runs in a private detached
// checkout of that worktree and names the worktree's key explicitly, so it
// still waits its turn with the work item's other jobs.

import fs from "node:fs";
import path from "node:path";

/** @type {Map<string, Promise<void>>} */
const tails = new Map();
const MAX_ASCENT = 24;

/** The checkout a command runs in: the nearest ancestor holding `.git`. */
export function testWorktreeSlotKey(cwd) {
  let dir;
  try { dir = fs.realpathSync(path.resolve(String(cwd || process.cwd()))); } catch { dir = path.resolve(String(cwd || process.cwd())); }
  const start = dir;
  for (let i = 0; i < MAX_ASCENT; i += 1) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/**
 * Wait for this checkout's turn. FIFO. Resolves to a release function; an
 * aborted wait never takes the turn and never breaks the queue behind it.
 * `key` overrides the checkout derived from `cwd`. `onWait(true)` reports that
 * the caller is queued and `onWait(false)` that its wait ended, so a caller
 * can keep the wait out of its own time budgets.
 *
 * @param {string} cwd
 * @param {{ key?: string | null, signal?: AbortSignal | null, onWait?: ((waitingBehind: boolean) => void) | null }} [opts]
 * @returns {Promise<() => void>}
 */
export async function acquireTestWorktreeSlot(cwd, { key: explicitKey = null, signal = null, onWait = null } = {}) {
  signal?.throwIfAborted();
  const key = explicitKey || testWorktreeSlotKey(cwd);
  const previous = tails.get(key) || null;
  /** @type {() => void} */
  let release = () => {};
  const mine = new Promise((resolve) => { release = () => resolve(undefined); });
  const tail = (previous || Promise.resolve()).then(() => mine);
  tails.set(key, tail);
  const releaseOnce = (() => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release();
      if (tails.get(key) === tail) tails.delete(key);
    };
  })();
  if (!previous) return releaseOnce;
  try { onWait?.(true); } catch { /* observational */ }
  await new Promise((resolve, reject) => {
    const onAbort = () => reject(signal?.reason || Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    previous.then(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(undefined);
    });
  }).catch((error) => {
    // Give the turn straight back once the predecessor finishes so the queue
    // behind an aborted waiter is unaffected.
    previous.then(releaseOnce);
    throw error;
  }).finally(() => {
    try { onWait?.(false); } catch { /* observational */ }
  });
  return releaseOnce;
}

/**
 * Run `run` in the checkout's turn and give the turn back however it ends.
 *
 * @template T
 * @param {string} cwd
 * @param {{ key?: string | null, signal?: AbortSignal | null, onWait?: ((waitingBehind: boolean) => void) | null }} opts
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withTestWorktreeSlot(cwd, opts, run) {
  const release = await acquireTestWorktreeSlot(cwd, opts);
  try {
    return await run();
  } finally {
    release();
  }
}
