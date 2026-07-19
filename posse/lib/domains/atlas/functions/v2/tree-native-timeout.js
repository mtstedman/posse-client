// @ts-check
//
// Tree construction and compression scale with the number of semantic symbols
// in the view. The generic native-worker timeout is intentionally short for
// interactive methods, but it is not an appropriate ceiling for full rebuilds.

export const ATLAS_TREE_NATIVE_BASE_TIMEOUT_MS = 60_000;
export const ATLAS_TREE_NATIVE_MAX_TIMEOUT_MS = 10 * 60_000;

/**
 * Allow 2.5ms per symbol above the worker's base minute, capped so corrupted
 * requests cannot hold a rebuild forever. A 64k-symbol view receives ~220s.
 *
 * @param {number} symbolCount
 */
export function atlasTreeNativeTimeoutMs(symbolCount) {
  const count = Number.isFinite(Number(symbolCount)) ? Math.max(0, Math.floor(Number(symbolCount))) : 0;
  return Math.min(
    ATLAS_TREE_NATIVE_MAX_TIMEOUT_MS,
    Math.max(ATLAS_TREE_NATIVE_BASE_TIMEOUT_MS, ATLAS_TREE_NATIVE_BASE_TIMEOUT_MS + Math.ceil(count * 2.5)),
  );
}
