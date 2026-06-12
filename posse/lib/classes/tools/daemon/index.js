// @ts-check
//
// The shared Daemon primitive. One governance layer (Daemon) over a pluggable
// Transport (process or thread), a runDaemonThread helper for thread-backed
// hosts, and a process-wide DaemonSupervisor that owns host lifecycle. Every
// long-lived helper in the system — posse-git, posse-atlas, the ONNX encoder,
// the SCIP conductor — is an instance of this, not a bespoke implementation.

export { Daemon } from "./Daemon.js";
export { ProcessTransport, ThreadTransport } from "./transport.js";
export { runDaemonThread } from "./thread-host.js";
export { DaemonSupervisor, daemonSupervisor } from "./supervisor.js";
export {
  recordDaemonSpawn,
  forgetDaemonSpawn,
  reapOrphanedDaemons,
  reapOwnDaemonSpawns,
  listOwnDaemonSpawns,
  cleanupOwnDaemonLedger,
  setDaemonLedgerDirForTests,
} from "./process-ledger.js";
