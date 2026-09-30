// @ts-check
//
// Bounded, best-effort native Git authorization prewarm for processes that
// serve agent tools.
//
// Synchronous native Git calls read the pulse cache only: the first sync call
// per route in a cold process fails closed (POSSE_NATIVE_PULSE_COLD) and just
// requests a background mint. The orchestrator awaits both Git route grants
// at boot (orchestrator-app init). A tool-serving child must hold them before
// its first tool call as well, but it must never block indefinitely or fail
// to serve when native auth is slow or unavailable: the call then fails closed
// on its own, exactly as it would have without the prewarm.

import { nativeBinaries } from "../../../../shared/tools/classes/BinaryManager.js";
import { GIT_MUTATE_ROUTE, GIT_READ_ROUTE } from "../../../../catalog/binary.js";

// Both routes: read-shaped tools also need git:mutate, because the native
// encoder classifies `git check-ignore` (the list_files/search_files ignore
// check) as mutate.
export const NATIVE_GIT_PREWARM_ROUTES = Object.freeze([GIT_READ_ROUTE, GIT_MUTATE_ROUTE]);
export const NATIVE_GIT_PREWARM_TIMEOUT_MS = 5_000;

/**
 * @typedef {{ warmed: boolean, reason: string | null, elapsedMs: number }} NativeGitPrewarmOutcome
 */

/**
 * Await the Git route grants on the process's live git handle, bounded by
 * `timeoutMs`. Never throws; a mint still in flight at the deadline keeps
 * running in the background and fills the cache when it lands.
 *
 * @param {{ manager?: { shouldUse(name: string): boolean, binary(name: string): { ensureNativeAuth(routes?: string[]): Promise<unknown> } }, routes?: readonly string[], timeoutMs?: number }} [options]
 * @returns {Promise<NativeGitPrewarmOutcome>}
 */
export async function prewarmNativeGitAuth({
  manager = nativeBinaries,
  routes = NATIVE_GIT_PREWARM_ROUTES,
  timeoutMs = NATIVE_GIT_PREWARM_TIMEOUT_MS,
} = {}) {
  const startedAt = Date.now();
  /** @returns {NativeGitPrewarmOutcome} */
  const outcome = (warmed, reason = null) => ({ warmed, reason, elapsedMs: Date.now() - startedAt });
  let binary;
  try {
    if (!manager?.shouldUse?.("git")) return outcome(false, "git_unavailable");
    binary = manager.binary("git");
  } catch (error) {
    return outcome(false, String(/** @type {any} */ (error)?.code || "git_unavailable"));
  }
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const deadline = new Promise((resolve) => {
    const ms = Number(timeoutMs);
    timer = setTimeout(() => resolve(outcome(false, "timeout")), Number.isFinite(ms) && ms > 0 ? ms : NATIVE_GIT_PREWARM_TIMEOUT_MS);
    timer.unref?.();
  });
  const warm = Promise.resolve()
    .then(() => binary.ensureNativeAuth([...routes]))
    .then(
      () => outcome(true),
      (error) => outcome(false, String(error?.code || "native_auth_unavailable")),
    );
  try {
    return /** @type {NativeGitPrewarmOutcome} */ (await Promise.race([warm, deadline]));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
