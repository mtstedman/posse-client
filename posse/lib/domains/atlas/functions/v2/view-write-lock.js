// @ts-check

import path from "node:path";

const VIEW_WRITE_LOCKS = new Map();

/**
 * Serialize destructive/open-for-write work per view DB path. The lock is
 * process-local by design: every Atlas view writer in this process shares it,
 * while SQLite remains the cross-process durability and exclusion boundary.
 *
 * Keeping this helper outside ParseEngine lets activation hold the parked
 * source fence continuously while it moves/rebrands that file into the final
 * mounted destination.
 *
 * @template T
 * @param {string} viewPath
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withAtlasViewWriteLock(viewPath, fn) {
  const raw = path.resolve(String(viewPath || "view")).replaceAll("\\", "/");
  const key = process.platform === "win32" ? raw.toLowerCase() : raw;
  const previous = VIEW_WRITE_LOCKS.get(key) || Promise.resolve();
  const waitForPrevious = Promise.resolve(previous).catch(() => {});
  let release = () => {};
  const current = waitForPrevious.then(() => new Promise((resolve) => {
    release = () => resolve(undefined);
  }));
  VIEW_WRITE_LOCKS.set(key, current);
  await waitForPrevious;
  try {
    return await fn();
  } finally {
    release();
    if (VIEW_WRITE_LOCKS.get(key) === current) VIEW_WRITE_LOCKS.delete(key);
  }
}
