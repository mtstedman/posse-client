// boot-maintenance-worker.js is a worker-thread ENTRY point, not a library
// module — it exports nothing and its side-effecting main() is guarded behind
// !isMainThread. Deliberately NOT re-exported here: pulling it into the barrel
// added no symbols and only risked running queue maintenance on import.
export * from "./config.js";
export * from "./file-scope.js";
export * from "./headless-recovery.js";
export * from "./held-locks.js";
export * from "./lock-timing.js";
