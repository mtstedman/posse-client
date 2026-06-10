// @ts-check

const LEGACY_ALIAS = Object.freeze({
  "atlas.parse.discover.started": "atlas.warm.discover.started",
  "atlas.parse.discover.completed": "atlas.warm.discover.completed",
  "atlas.parse.parse.started": "atlas.warm.parse.started",
  "atlas.parse.parse.progress": "atlas.warm.parse.progress",
  "atlas.parse.parse.completed": "atlas.warm.parse.completed",
  "atlas.parse.parse.failed": "atlas.warm.parse.failed",
  "atlas.parse.merge.completed": "atlas.warm.merge.completed",
});

/**
 * @param {string} kind
 * @param {Record<string, unknown>} [payload]
 */
export function atlasParseEvent(kind, payload = {}) {
  return {
    kind,
    ...payload,
  };
}

/**
 * One-release event compatibility for consumers still listening for warm
 * lifecycle events.
 *
 * @param {{ kind: string, [k: string]: unknown }} event
 */
export function legacyAtlasWarmAlias(event) {
  const legacyKind = LEGACY_ALIAS[event.kind];
  return legacyKind ? { ...event, kind: legacyKind, aliasedFrom: event.kind } : null;
}

/**
 * @param {((event: Record<string, unknown>) => void) | undefined} onEvent
 * @param {{ kind: string, [k: string]: unknown }} event
 * @param {{ legacyAlias?: boolean }} [opts]
 */
export function emitParseEvent(onEvent, event, opts = {}) {
  if (typeof onEvent !== "function") return;
  onEvent(event);
  if (opts.legacyAlias) {
    const legacy = legacyAtlasWarmAlias(event);
    if (legacy) onEvent(legacy);
  }
}
