// Compatibility facade for the queue domain. Queue-store remains the single
// transaction owner; capability modules should be introduced only when they
// own actual implementation rather than re-exporting this store.

// Scheduler-facing queue contracts. Keep these narrow helpers public so the
// scheduler can depend on Queue's facade instead of private implementation
// files during its extraction.
export { parseJobPayload } from "./payload.js";
export { runImmediateTransaction } from "./common.js";
export {
  RUNTIME_STATUS_KEYS,
  BRIDGE_PRESENCE_FRESH_MS,
  isBridgePresenceFresh,
  readRuntimeStatus,
  writeRuntimeStatus,
  clearRuntimeStatus,
  markCleanShutdown,
} from "./runtime-status.js";
export * from "./waiting-lane-preparations.js";

// Existing consumers also use queue's smaller entity/service exports.  They
// intentionally continue to resolve from the original store during the
// incremental migration, so transactions, lease tokens, locks, and wake/event
// ordering have precisely the same owner and call graph.
export * from "./queue-store.js";
