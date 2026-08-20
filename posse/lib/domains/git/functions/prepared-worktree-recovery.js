// Read-only inspection and non-forcing retirement for prepared worktrees.
// Unexpected state is always returned to the queue owner; this module never
// resets, cleans, snapshots, or recursively removes a prepared checkout.

import fs from "fs";
import path from "path";
import { Worktree } from "../classes/Worktree.js";
import { isInsideRoot } from "../../runtime/functions/fs-safety.js";
import { gitTopLevelAsync } from "./worktree-path.js";
import {
  withRepositoryWorktreeAdminLockAsync,
  withWorktreeLockAsync,
} from "./worktree-locks.js";

// `repositoryRoot` is deliberately the resolved Git top-level, not a nested
// project cwd. Async public entrypoints resolve it before calling this guard.
export function validatePreparedWorktreeRoot(repositoryRoot, worktreeRoot) {
  if (typeof repositoryRoot !== "string" || !repositoryRoot.trim()) {
    throw new TypeError("repositoryRoot must be a non-empty path");
  }
  if (typeof worktreeRoot !== "string" || !worktreeRoot.trim() || !path.isAbsolute(worktreeRoot)) {
    throw new TypeError("prepared worktree root must be a non-empty absolute path");
  }
  const root = path.resolve(worktreeRoot);
  const managedRoot = path.join(path.resolve(repositoryRoot), ".posse-worktrees");
  if (path.dirname(root) !== managedRoot
    || !/^wi-\d+(?:-|$)/u.test(path.basename(root))
    || !isInsideRoot(root, managedRoot, { allowEqual: false, followSymlinks: true })) {
    throw new TypeError("prepared worktree root must be one WI checkout directly under the managed worktree root");
  }
  return root;
}

export function classifyPreparedWorktreeInspection(inspection, { pathExists = false } = {}) {
  if (inspection?.available === false) {
    return { safe: false, preserve: pathExists, reason: inspection.reason || "native_capability_unavailable" };
  }
  const value = inspection?.result || null;
  if (!value?.ok) {
    // A failed inspection reports every checkout flag as false, because the
    // native result builds them with `state.is_some_and(...)` and there is no
    // checkout state to read when it stopped at, say, a missing ownership
    // record. So `clean: false` there means "never looked", not "dirty", and
    // reading it as evidence preserved (and poisoned) lanes whose worktree was
    // never on disk. Dirt cannot exist without a checkout, so the two positive
    // signals below already cover every case where it could.
    return {
      safe: false,
      preserve: pathExists || value?.registered === true,
      reason: value?.status || value?.reason || "inspection_failed",
    };
  }
  if (!value.registered || !value.detached || value.clean !== true || value.sentinelPresent === true) {
    return { safe: false, preserve: true, reason: "prepared_checkout_not_clean_detached" };
  }
  return { safe: true, preserve: false, reason: null };
}

export async function inspectPreparedWorktreeLockedAsync({
  projectDir,
  worktreeRoot,
  preparationId,
  signal = null,
  waitMs = 30_000,
  nativeParity = {},
} = {}) {
  const repoRoot = await gitTopLevelAsync(projectDir, { signal });
  const root = validatePreparedWorktreeRoot(repoRoot, worktreeRoot);
  return withRepositoryWorktreeAdminLockAsync(repoRoot, projectDir, () => {
    return withWorktreeLockAsync(root, projectDir, async () => {
      const worktree = Worktree.at(repoRoot, root);
      const inspection = await worktree.inspectPreparedAsync({ preparationId, signal, nativeParity });
      return {
        inspection,
        classification: classifyPreparedWorktreeInspection(inspection, {
          pathExists: fs.existsSync(root),
        }),
        repoRoot,
        worktree,
      };
    }, { signal, waitMs });
  }, { signal, waitMs });
}

export async function removePreparedWorktreeIfSafeAsync({
  projectDir,
  worktreeRoot,
  preparationId,
  expectedOid = null,
  signal = null,
  waitMs = 30_000,
  nativeParity = {},
} = {}) {
  const repoRoot = await gitTopLevelAsync(projectDir, { signal });
  const root = validatePreparedWorktreeRoot(repoRoot, worktreeRoot);
  return withRepositoryWorktreeAdminLockAsync(repoRoot, projectDir, () => {
    return withWorktreeLockAsync(root, projectDir, async () => {
      const worktree = Worktree.at(repoRoot, root);
      const inspection = await worktree.inspectPreparedAsync({ preparationId, signal, nativeParity });
      const classification = classifyPreparedWorktreeInspection(inspection, {
        pathExists: fs.existsSync(root),
      });
      const actualOid = String(inspection?.result?.headOid || "").trim().toLowerCase();
      const expected = String(expectedOid || inspection?.result?.expectedOid || "").trim().toLowerCase();
      if (classification.safe && expected && actualOid !== expected) {
        return {
          removed: false,
          preserve: true,
          reason: "prepared_checkout_oid_mismatch",
          inspection,
        };
      }
      if (!classification.safe) {
        return {
          removed: false,
          preserve: classification.preserve,
          reason: classification.reason,
          inspection,
        };
      }
      await worktree.removeAsync({
        force: false,
        prune: true,
        fallbackRemove: false,
        signal,
        nativeParity,
      });
      return {
        removed: !fs.existsSync(root),
        preserve: fs.existsSync(root),
        reason: fs.existsSync(root) ? "prepared_remove_incomplete" : null,
        inspection,
      };
    }, { signal, waitMs });
  }, { signal, waitMs });
}
