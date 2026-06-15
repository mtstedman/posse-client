// @ts-check
//
// Hard process ledger for ProcessTransport daemon children (the native-binary
// hosts: `posse-git`/`posse-atlas worker --stdio`). Worker-thread daemons die
// with their host and need no ledger; child processes do NOT — they are unref'd
// so they don't block the parent's exit, which means a hard parent crash
// (SIGKILL, power loss, `node --test` runner abort) orphans them. Left
// unchecked they accumulate ("spiralling") across crashed sessions.
//
// The ledger is the durable record that lets boot reap those orphans:
//
//   - On spawn:    append { pid, bin, startedAt } to THIS thread's ledger shard.
//   - On teardown: each daemon kill forgets its pid; when the last is gone the
//                  ledger shard is deleted. A clean shutdown therefore leaves no
//                  file; a crash leaves the file behind as a breadcrumb.
//   - On boot:     reap ledgers whose OWNER process is dead — kill the orphaned
//                  child pids they list (verified by image name so a recycled
//                  pid can't be friendly-fired), then delete the file. Ledgers
//                  owned by a still-alive process (a concurrent posse instance)
//                  are left untouched.
//
// Files are sharded by owner pid + worker thread:
// <home>/.posse/daemons/<ownerPid>-<threadId>.json. Boot reaping still accepts
// the legacy unsharded <ownerPid>.json shape.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { threadId } from "node:worker_threads";

const LEDGER_LOCK_WAIT_MS = 5000;
const LEDGER_LOCK_RETRY_MS = 2;
const LEDGER_LOCK_STALE_CHECK_MS = 100;
const LEDGER_LOCK_STALE_MS = 30_000;
const LEDGER_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

// Global by default so any boot can find a crashed session's breadcrumbs.
// Overridable only via the test hook below (no env/admin knob — there is no
// production reason to relocate it).
let _dirOverride = null;
function ledgerDir() {
  return _dirOverride || path.join(os.homedir(), ".posse", "daemons");
}

/**
 * Point the ledger at an isolated directory for tests so reaping/recording can
 * never touch the developer's real ~/.posse/daemons. Pass nothing to restore.
 */
export function setDaemonLedgerDirForTests(dir = null) {
  _dirOverride = dir ? String(dir) : null;
}

function ownLedgerPath() {
  return path.join(ledgerDir(), `${process.pid}-${threadId}.json`);
}

function parseLedgerOwnerPid(name) {
  const match = /^(\d+)(?:-\d+)?\.json$/.exec(String(name || ""));
  if (!match) return null;
  const ownerPid = Number(match[1]);
  return Number.isInteger(ownerPid) ? ownerPid : null;
}

function ownLedgerFiles() {
  const dir = ledgerDir();
  try {
    return fs.readdirSync(dir)
      .filter((name) => parseLedgerOwnerPid(name) === process.pid)
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function sleepSync(ms) {
  try { Atomics.wait(LEDGER_LOCK_SLEEP, 0, 0, ms); } catch { /* best effort */ }
}

function readLockInfo(lockFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isStaleLock(lockFile, now = Date.now()) {
  const info = readLockInfo(lockFile);
  const createdAt = Number(info.createdAt || 0);
  const ownerPid = Number(info.pid || 0);
  if (Number.isInteger(ownerPid) && ownerPid > 0 && !isAlive(ownerPid)) return true;
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    try {
      const stat = fs.statSync(lockFile);
      return now - stat.mtimeMs > LEDGER_LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
  return now - createdAt > LEDGER_LOCK_STALE_MS;
}

function removeLockFile(lockFile, waitMs = 0) {
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      fs.rmSync(lockFile, { force: true });
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      sleepSync(LEDGER_LOCK_RETRY_MS);
    }
  }
}

function acquireLedgerLock(file) {
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + LEDGER_LOCK_WAIT_MS;
  let nextStaleCheckAt = 0;
  while (true) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(lockFile, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, threadId, createdAt: Date.now() }));
      } finally {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      return () => {
        removeLockFile(lockFile, 1000);
      };
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== "EEXIST") return null;
      const now = Date.now();
      if (now >= nextStaleCheckAt) {
        nextStaleCheckAt = now + LEDGER_LOCK_STALE_CHECK_MS;
        if (isStaleLock(lockFile) && removeLockFile(lockFile, 1000)) continue;
      }
      if (now >= deadline) return null;
      sleepSync(LEDGER_LOCK_RETRY_MS);
    }
  }
}

function withLedgerLock(file, fn) {
  const release = acquireLedgerLock(file);
  if (!release) return undefined;
  try {
    return fn();
  } finally {
    release();
  }
}

/** @returns {Array<{ pid: number, bin: string, startedAt: number, threadId?: number, label?: string }>} */
function readLedger(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLedger(file, entries) {
  try {
    if (!entries.length) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(ledgerDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entries));
  } catch {
    /* best effort — the ledger is a safety net, never load-bearing */
  }
}

/** Is `pid` a live process? EPERM means it exists but we can't signal it. */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err)?.code === "EPERM";
  }
}

/**
 * Best-effort check that live `pid` is actually the recorded daemon binary, so
 * a recycled pid (reused by an unrelated process since the crash) is never
 * killed. Returns false when it cannot positively confirm a match.
 */
function imageMatches(pid, binBase) {
  if (!binBase) return false;
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        timeout: 1500,
        windowsHide: true,
      });
      return out.toLowerCase().includes(binBase.toLowerCase());
    }
    // posix: the argv buffer is NUL-separated; basename match is enough.
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes(binBase);
  } catch {
    return false;
  }
}

/**
 * Record a freshly spawned daemon child in this process's ledger. The entry
 * carries owner attribution (spawning thread id + creator label) so a leaked
 * host is identifiable by lookup instead of forensic reconstruction.
 * @param {number | null | undefined} pid
 * @param {string | null | undefined} bin resolved binary path (basename is stored)
 * @param {{ label?: string }} [context]
 */
export function recordDaemonSpawn(pid, bin, context = {}) {
  if (!Number.isInteger(pid) || /** @type {number} */ (pid) <= 0) return;
  try {
    const file = ownLedgerPath();
    withLedgerLock(file, () => {
      const entries = readLedger(file);
      if (entries.some((e) => e.pid === pid)) return;
      entries.push({
        pid: /** @type {number} */ (pid),
        bin: path.basename(String(bin || "")),
        startedAt: Date.now(),
        threadId,
        label: String(context?.label || "") || undefined,
      });
      writeLedger(file, entries);
    });
  } catch {
    /* best effort */
  }
}

/**
 * Snapshot of this process's recorded daemon children across all thread shards.
 * @returns {Array<{ pid: number, bin: string, startedAt: number, threadId?: number, label?: string }>}
 */
export function listOwnDaemonSpawns() {
  return ownLedgerFiles().flatMap((file) => withLedgerLock(file, () => readLedger(file)) || []);
}

/**
 * Shutdown safety net: kill every daemon child this process still has on the
 * ledger, except `exceptPids` (hosts a caller just retired gracefully and is
 * still waiting out). Covers hosts minted by worker threads whose module-graph
 * daemons were never disposed — the exact leak class where entries accumulate
 * because the spawning thread died without observing its child's exit.
 * Image-name verified so a recycled pid is never friendly-fired.
 * @param {{ exceptPids?: Iterable<number> }} [opts]
 * @returns {{ killed: number, skipped: number }}
 */
export function reapOwnDaemonSpawns(opts = {}) {
  let killed = 0;
  let skipped = 0;
  const except = new Set(opts.exceptPids || []);
  try {
    for (const file of ownLedgerFiles()) {
      withLedgerLock(file, () => {
        const entries = readLedger(file);
        if (!entries.length) return;
        /** @type {typeof entries} */
        const remaining = [];
        for (const entry of entries) {
          if (except.has(entry.pid)) { remaining.push(entry); continue; }
          if (isAlive(entry.pid)) {
            if (imageMatches(entry.pid, entry.bin)) {
              try { process.kill(entry.pid, "SIGKILL"); killed++; } catch { skipped++; remaining.push(entry); continue; }
            } else {
              // Alive but not our binary (recycled pid) — drop the stale entry.
              skipped++;
            }
          }
          // Dead entries are simply dropped from the ledger.
        }
        writeLedger(file, remaining);
      });
    }
  } catch {
    /* best effort */
  }
  return { killed, skipped };
}

/**
 * Forget a daemon child (it has been killed / has exited). Deletes the ledger
 * file once it holds no more pids — so a clean teardown leaves nothing behind.
 * @param {number | null | undefined} pid
 */
export function forgetDaemonSpawn(pid) {
  if (!Number.isInteger(pid) || /** @type {number} */ (pid) <= 0) return;
  try {
    const file = ownLedgerPath();
    withLedgerLock(file, () => {
      const entries = readLedger(file);
      if (!entries.length) return;
      writeLedger(file, entries.filter((e) => e.pid !== pid));
    });
  } catch {
    /* best effort */
  }
}

/**
 * Boot-time reaper. Kills orphaned daemon children left by crashed prior
 * sessions, then deletes their ledgers. Ledgers owned by a live process are
 * left alone (could be a concurrent posse instance). Returns a small summary.
 * @returns {{ killed: number, skipped: number, ledgers: number }}
 */
export function reapOrphanedDaemons() {
  let killed = 0;
  let skipped = 0;
  let ledgers = 0;
  const dir = ledgerDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { killed, skipped, ledgers }; // no dir → nothing to reap
  }
  // Bound the work — a runaway ledger dir must not turn a best-effort sweep into
  // a long synchronous stall. Real sessions leave a handful of files; anything
  // past the cap is left for the next boot's sweep.
  if (names.length > 200) names = names.slice(0, 200);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const ownerPid = parseLedgerOwnerPid(name);
    if (!Number.isInteger(ownerPid)) continue;
    if (ownerPid === process.pid) continue; // our own live ledger
    if (isAlive(ownerPid)) continue; // a concurrent live instance owns it
    const file = path.join(dir, name);
    for (const entry of readLedger(file)) {
      if (!isAlive(entry.pid)) continue;
      if (!imageMatches(entry.pid, entry.bin)) { skipped++; continue; }
      try {
        process.kill(entry.pid, "SIGKILL");
        killed++;
      } catch {
        skipped++;
      }
    }
    try { fs.rmSync(file, { force: true }); ledgers++; } catch { /* best effort */ }
  }
  return { killed, skipped, ledgers };
}

/** Delete this process's ledger shards outright (final clean-exit sweep). */
export function cleanupOwnDaemonLedger() {
  try {
    for (const file of ownLedgerFiles()) {
      withLedgerLock(file, () => fs.rmSync(file, { force: true }));
    }
  } catch { /* best effort */ }
}
