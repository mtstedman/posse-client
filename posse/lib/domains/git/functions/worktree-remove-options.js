export const FORCE_REMOVE_OPTIONS = Object.freeze({
  recursive: true,
  force: true,
  maxRetries: process.platform === "win32" ? 10 : 3,
  retryDelay: process.platform === "win32" ? 150 : 50,
});

const WORKTREE_IN_USE_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);
// The native git binary surfaces a Windows sharing violation as a plain message
// (no Node code), so message-match too.
const WORKTREE_IN_USE_MESSAGE =
  /being used by another process|os error 32|sharing violation|ERROR_SHARING_VIOLATION|resource busy|\bEBUSY\b|\bEPERM\b|\bEACCES\b|access is denied/i;

/**
 * A worktree removal failed because something still holds a handle inside it
 * (a daemon/conductor op, a git child, or a scanner) — NOT because the worktree
 * is corrupt or already gone. The correct response is to DEFER removal to a
 * later GC pass once the holder releases, not to force-fight a live operation.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isWorktreeInUseError(err) {
  if (!err) return false;
  const code = /** @type {any} */ (err)?.code;
  if (code && WORKTREE_IN_USE_CODES.has(String(code))) return true;
  return WORKTREE_IN_USE_MESSAGE.test(String(/** @type {any} */ (err)?.message || err));
}
