// @ts-check
//
// Process-local shared AtlasToolExecutor accessor. The mutable singleton here is
// intentionally narrow: it centralizes ATLAS tool request queueing/caching for
// the current owner/orchestrator process.

import { AtlasToolExecutor } from "../../../classes/v2/AtlasToolExecutor.js";

/** @type {AtlasToolExecutor | null} */
let sharedExecutor = null;

export function getSharedAtlasToolExecutor() {
  if (!sharedExecutor) sharedExecutor = new AtlasToolExecutor({ dispatchCache: true });
  return sharedExecutor;
}

export async function closeSharedAtlasToolExecutor() {
  const current = sharedExecutor;
  sharedExecutor = null;
  if (current) await current.close();
}

export function clearSharedAtlasToolExecutorReadContexts(scope = null) {
  if (!sharedExecutor) return;
  if (scope == null) sharedExecutor.clearReadContexts();
  else sharedExecutor.clearReadContext(scope);
}

/**
 * Refresh the files a finished session edited last (see
 * AtlasToolExecutor#deferRefresh). Best effort: callers fire it from session
 * teardown and handoff, which it must never fail.
 */
export function flushSharedAtlasToolExecutorDeferredRefreshes({ sessionId = null } = {}) {
  const executor = sharedExecutor;
  if (typeof executor?.flushDeferredRefreshes !== "function") return Promise.resolve([]);
  return Promise.resolve()
    .then(() => executor.flushDeferredRefreshes({ sessionId }))
    .catch(() => []);
}

export function invalidateSharedAtlasToolExecutorReadCaches(scope = null) {
  sharedExecutor?.invalidateReadCaches?.(scope);
}

export function __testSetSharedAtlasToolExecutor(executor) {
  sharedExecutor = executor || null;
}
