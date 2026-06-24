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

export function __testSetSharedAtlasToolExecutor(executor) {
  sharedExecutor = executor || null;
}
