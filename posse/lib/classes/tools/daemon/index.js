// @ts-check
//
// The shared Daemon primitive. One governance layer (Daemon) over a pluggable
// Transport (process or thread), with a blocking SyncBridge for process-backed
// daemons and a runDaemonThread helper for thread-backed ones. Every long-lived
// helper in the system — posse-git, posse-atlas, the ONNX encoder, the SCIP
// conductor — is an instance of this, not a bespoke implementation.

export { Daemon } from "./Daemon.js";
export { ProcessTransport, ThreadTransport } from "./transport.js";
export { SyncBridge } from "./sync-bridge.js";
export { runDaemonThread } from "./thread-host.js";
export {
  createSyncChannel,
  bindSyncChannel,
  channelArm,
  channelWait,
  channelRespond,
} from "./sync-channel.js";
export {
  recordDaemonSpawn,
  forgetDaemonSpawn,
  reapOrphanedDaemons,
  cleanupOwnDaemonLedger,
  setDaemonLedgerDirForTests,
} from "./process-ledger.js";
