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
//                  child pids they list only after executable path + OS process
//                  birth identity match, then delete the file. Ledgers
//                  owned by a still-alive process (a concurrent posse instance)
//                  are left untouched.
//
// Files are sharded by owner pid + worker thread + process-instance nonce:
// <home>/.posse/daemons/<ownerPid>-<threadId>-<nonce>.json. The nonce prevents
// a process that reuses an owner pid from appending to the prior owner's shard.
// Boot reaping still accepts legacy pid-only/thread shard names.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { threadId } from "node:worker_threads";

const LEDGER_LOCK_WAIT_MS = 5000;
const LEDGER_LOCK_RETRY_MS = 2;
const LEDGER_LOCK_STALE_CHECK_MS = 100;
const LEDGER_LOCK_STALE_MS = 30_000;
const LEDGER_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));
const PROCESS_IDENTITY_TIMEOUT_MS = 5_000;
const pendingIdentityCaptures = new Set();
let ownProcessIdentityPromise = null;
/** @type {Map<number, Array<(identity: any) => void>>} */
let pendingWindowsIdentityRequests = new Map();
let windowsIdentityBatchScheduled = false;
let windowsIdentityBatchRunning = false;
const LEDGER_INSTANCE_ID = crypto.randomBytes(8).toString("hex");

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
  return path.join(ledgerDir(), `${process.pid}-${threadId}-${LEDGER_INSTANCE_ID}.json`);
}

function parseLedgerOwnerPid(name) {
  const match = /^(\d+)(?:-[^.]+)*\.json$/.exec(String(name || ""));
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

/** @returns {Array<{ pid: number, bin: string, startedAt: number, threadId?: number, label?: string, cwd?: string, birthIdentity?: Record<string, string> | null, ownerBirthIdentity?: Record<string, string> | null, captureNonce?: string }>} */
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

function linuxProcessIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEnd = stat.lastIndexOf(")");
    if (commEnd < 0) return null;
    const fieldsFromState = stat.slice(commEnd + 2).trim().split(/\s+/);
    const startTicks = String(fieldsFromState[19] || ""); // proc stat field 22
    const executablePath = normalizedFsPath(fs.readlinkSync(`/proc/${pid}/exe`));
    if (!startTicks || !executablePath) return null;
    return { kind: "linux-proc", startTicks, executablePath };
  } catch {
    return null;
  }
}

function windowsIdentityArgs(pid) {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=[System.Diagnostics.Process]::GetProcessById(${Number(pid)})`,
    "$path=$p.MainModule.FileName",
    "$ticks=$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)",
    "$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path))",
    "[Console]::Out.Write($encoded+'|'+$ticks)",
  ].join(";");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script];
}

function windowsIdentityBatchArgs(pids) {
  const ids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$ids=@(${ids.join(",")})`,
    "foreach($id in $ids){try{$p=[System.Diagnostics.Process]::GetProcessById($id);$path=$p.MainModule.FileName;$ticks=$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture);$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path));[Console]::Out.WriteLine($id.ToString()+'|'+$encoded+'|'+$ticks)}catch{}}",
  ].join(";");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script];
}

function parseWindowsIdentity(stdout) {
  try {
    const text = String(stdout || "").trim();
    const separator = text.lastIndexOf("|");
    if (separator <= 0) return null;
    const executablePath = normalizedFsPath(Buffer.from(text.slice(0, separator), "base64").toString("utf8"));
    const creationTicks = text.slice(separator + 1).trim();
    if (!executablePath || !/^\d+$/.test(creationTicks)) return null;
    return { kind: "windows-process", creationTicks, executablePath };
  } catch {
    return null;
  }
}

function parseWindowsIdentityBatch(stdout) {
  const identities = new Map();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const separator = line.indexOf("|");
    if (separator <= 0) continue;
    const pid = Number(line.slice(0, separator));
    const identity = parseWindowsIdentity(line.slice(separator + 1));
    if (Number.isInteger(pid) && identity) identities.set(pid, identity);
  }
  return identities;
}

function windowsProcessIdentitySync(pid) {
  try {
    const stdout = execFileSync("powershell.exe", windowsIdentityArgs(pid), {
      encoding: "utf8",
      timeout: PROCESS_IDENTITY_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseWindowsIdentity(stdout);
  } catch {
    return null;
  }
}

function windowsProcessIdentityAsync(pid) {
  return new Promise((resolve) => {
    const waiters = pendingWindowsIdentityRequests.get(pid) || [];
    waiters.push(resolve);
    pendingWindowsIdentityRequests.set(pid, waiters);
    scheduleWindowsIdentityBatch();
  });
}

function scheduleWindowsIdentityBatch() {
  if (windowsIdentityBatchScheduled || windowsIdentityBatchRunning) return;
  windowsIdentityBatchScheduled = true;
  setImmediate(runWindowsIdentityBatch);
}

function runWindowsIdentityBatch() {
  windowsIdentityBatchScheduled = false;
  if (windowsIdentityBatchRunning || pendingWindowsIdentityRequests.size === 0) return;
  windowsIdentityBatchRunning = true;
  const ids = [...pendingWindowsIdentityRequests.keys()].slice(0, 64);
  const requests = new Map(ids.map((pid) => [pid, pendingWindowsIdentityRequests.get(pid) || []]));
  for (const pid of ids) pendingWindowsIdentityRequests.delete(pid);
  execFile("powershell.exe", windowsIdentityBatchArgs(ids), {
    encoding: "utf8",
    timeout: PROCESS_IDENTITY_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: Math.max(32 * 1024, ids.length * 1024),
  }, (error, stdout) => {
    const identities = error ? new Map() : parseWindowsIdentityBatch(stdout);
    for (const [pid, waiters] of requests) {
      const identity = identities.get(pid) || null;
      for (const resolve of waiters) resolve(identity);
    }
    windowsIdentityBatchRunning = false;
    scheduleWindowsIdentityBatch();
  });
}

function processIdentitySync(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return linuxProcessIdentity(pid);
  if (process.platform === "win32") return windowsProcessIdentitySync(pid);
  // macOS and other non-/proc platforms currently have no dependency-free API
  // for arbitrary process birth identity. Fail closed instead of guessing.
  return null;
}

function processIdentitiesSync(pids) {
  const ids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  const identities = new Map();
  if (process.platform !== "win32") {
    for (const pid of ids) identities.set(pid, processIdentitySync(pid));
    return identities;
  }
  for (let offset = 0; offset < ids.length; offset += 64) {
    const chunk = ids.slice(offset, offset + 64);
    try {
      const stdout = execFileSync("powershell.exe", windowsIdentityBatchArgs(chunk), {
        encoding: "utf8",
        timeout: PROCESS_IDENTITY_TIMEOUT_MS,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const [pid, identity] of parseWindowsIdentityBatch(stdout)) identities.set(pid, identity);
    } catch { /* missing rows remain unverifiable */ }
  }
  return identities;
}

function processIdentityAsync(pid) {
  if (process.platform === "win32") return windowsProcessIdentityAsync(pid);
  return Promise.resolve(processIdentitySync(pid));
}

function ownProcessIdentityAsync() {
  if (!ownProcessIdentityPromise) {
    ownProcessIdentityPromise = processIdentityAsync(process.pid).then((identity) => {
      if (!identity) ownProcessIdentityPromise = null;
      return identity;
    });
  }
  return ownProcessIdentityPromise;
}

function identitiesEqual(expected, observed) {
  if (!expected || !observed || expected.kind !== observed.kind) return false;
  return expected.executablePath === observed.executablePath
    && (expected.kind === "linux-proc"
      ? expected.startTicks === observed.startTicks
      : expected.creationTicks === observed.creationTicks);
}

// true = exact process, false = positively a different birth, null = legacy or
// unavailable identity and therefore unsafe to kill.
function verifyLedgerIdentity(pid, expected, observedIdentity = undefined) {
  if (!expected) return null;
  const observed = observedIdentity === undefined ? processIdentitySync(pid) : observedIdentity;
  if (!observed) return null;
  if (!identitiesEqual(expected, observed)) return false;
  return true;
}

function trackIdentityCapture(promise) {
  pendingIdentityCaptures.add(promise);
  promise.finally(() => pendingIdentityCaptures.delete(promise));
  return promise;
}

/** Await asynchronous Windows identity hydration before a process-ledger sweep. */
export async function waitForPendingDaemonIdentityCaptures() {
  await Promise.allSettled([...pendingIdentityCaptures]);
}

export const waitForPendingDaemonIdentityCapturesForTests = waitForPendingDaemonIdentityCaptures;

/**
 * Wait for this module graph's captures, then briefly poll every process-owned
 * shard so worker-thread module graphs can finish hydrating their rows too.
 * Rows still missing proof at the deadline remain ledgered and fail closed.
 */
export async function waitForOwnDaemonLedgerIdentityHydration({ timeoutMs = 5_000, pollMs = 50 } = {}) {
  await waitForPendingDaemonIdentityCaptures();
  if (process.platform !== "win32") return;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (true) {
    const missing = ownLedgerFiles().some((file) => readLedger(file).some((entry) => (
      isAlive(entry.pid) && (!entry.birthIdentity || !entry.ownerBirthIdentity)
    )));
    if (!missing || Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, Math.max(10, Number(pollMs) || 50)));
  }
}

function windowsIdentityMatchesRecordedStart(identity, startedAt) {
  if (identity?.kind !== "windows-process") return true;
  try {
    const unixEpochTicks = 621355968000000000n;
    const creationMs = Number((BigInt(identity.creationTicks) - unixEpochTicks) / 10000n);
    return Number.isFinite(creationMs)
      && creationMs <= Number(startedAt) + 2_000
      && creationMs >= Number(startedAt) - 30_000;
  } catch {
    return false;
  }
}

function normalizedFsPath(value) {
  if (!value) return "";
  try {
    const resolved = path.resolve(String(value));
    const normalized = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  } catch {
    return "";
  }
}

function cwdIsInside(entryCwd, rootCwd) {
  const cwd = normalizedFsPath(entryCwd);
  const root = normalizedFsPath(rootCwd);
  if (!cwd || !root) return false;
  return cwd === root || cwd.startsWith(`${root}/`);
}

function killLedgeredProcess(entry, { force = true, tree = process.platform === "win32" } = {}) {
  const pid = Number(entry?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32" && tree) {
    try {
      const args = ["/pid", String(pid), "/T"];
      if (force) args.push("/F");
      execFileSync("taskkill", args, { stdio: "ignore", timeout: 5000, windowsHide: true });
      return true;
    } catch {
      // Fall through to process.kill best-effort.
    }
  }
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    return true;
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
 * @param {{ label?: string, cwd?: string }} [context]
 */
export function recordDaemonSpawn(pid, bin, context = {}) {
  if (!Number.isInteger(pid) || /** @type {number} */ (pid) <= 0) return;
  const numericPid = /** @type {number} */ (pid);
  const captureNonce = crypto.randomUUID();
  const startedAt = Date.now();
  const immediateBirthIdentity = process.platform === "win32" ? null : processIdentitySync(numericPid);
  const immediateOwnerIdentity = process.platform === "win32" ? null : processIdentitySync(process.pid);
  const file = ownLedgerPath();
  let inserted = false;
  try {
    withLedgerLock(file, () => {
      const entries = readLedger(file);
      if (entries.some((e) => e.pid === pid)) return;
      entries.push({
        pid: numericPid,
        bin: path.basename(String(bin || "")),
        startedAt,
        threadId,
        label: String(context?.label || "") || undefined,
        cwd: context?.cwd ? path.resolve(String(context.cwd)) : undefined,
        birthIdentity: immediateBirthIdentity,
        ownerBirthIdentity: immediateOwnerIdentity,
        captureNonce,
      });
      inserted = true;
      writeLedger(file, entries);
    });
  } catch {
    /* best effort */
  }
  if (inserted && process.platform === "win32" && isAlive(numericPid)) {
    const capture = Promise.all([processIdentityAsync(numericPid), ownProcessIdentityAsync()])
      .then(([birthIdentity, ownerBirthIdentity]) => {
        if (!birthIdentity || !ownerBirthIdentity) return;
        withLedgerLock(file, () => {
          const entries = readLedger(file);
          const entry = entries.find((candidate) => (
            candidate.pid === numericPid
            && candidate.captureNonce === captureNonce
            && candidate.startedAt === startedAt
          ));
          if (!entry) return;
          if (!windowsIdentityMatchesRecordedStart(birthIdentity, startedAt)) return;
          entry.birthIdentity = birthIdentity;
          entry.ownerBirthIdentity = ownerBirthIdentity;
          writeLedger(file, entries);
        });
      })
      .catch(() => undefined);
    trackIdentityCapture(capture);
  }
}

/**
 * Snapshot of this process's recorded daemon children across all thread shards.
 * @returns {Array<{ pid: number, bin: string, startedAt: number, threadId?: number, label?: string, cwd?: string, birthIdentity?: Record<string, string> | null, ownerBirthIdentity?: Record<string, string> | null, captureNonce?: string }>}
 */
export function listOwnDaemonSpawns() {
  return ownLedgerFiles().flatMap((file) => withLedgerLock(file, () => readLedger(file)) || []);
}

/**
 * Snapshot this process's recorded child processes that were spawned from a cwd
 * at or inside `cwd`. Used by worktree GC to explain live Windows handles.
 * @param {string} cwd
 * @returns {Array<{ pid: number, bin: string, startedAt: number, threadId?: number, label?: string, cwd?: string, birthIdentity?: Record<string, string> | null, ownerBirthIdentity?: Record<string, string> | null, captureNonce?: string }>}
 */
export function listOwnDaemonSpawnsForCwd(cwd) {
  return listOwnDaemonSpawns().filter((entry) => cwdIsInside(entry.cwd, cwd));
}

/**
 * Shutdown safety net: kill every daemon child this process still has on the
 * ledger, except `exceptPids` (hosts a caller just retired gracefully and is
 * still waiting out). Covers hosts minted by worker threads whose module-graph
 * daemons were never disposed — the exact leak class where entries accumulate
 * because the spawning thread died without observing its child's exit.
 * Executable-path and process-birth verified so a recycled pid is never
 * friendly-fired. Legacy/unverifiable rows are retained but never killed.
 * @param {{ exceptPids?: Iterable<number> }} [opts]
 * @returns {{ killed: number, skipped: number }}
 */
export function reapOwnDaemonSpawns(opts = {}) {
  let killed = 0;
  let skipped = 0;
  const except = new Set(opts.exceptPids || []);
  try {
    const files = ownLedgerFiles();
    const observedIdentities = processIdentitiesSync(files.flatMap((file) => (
      readLedger(file).filter((entry) => isAlive(entry.pid)).map((entry) => entry.pid)
    )));
    for (const file of files) {
      withLedgerLock(file, () => {
        const entries = readLedger(file);
        if (!entries.length) return;
        /** @type {typeof entries} */
        const remaining = [];
        for (const entry of entries) {
          if (except.has(entry.pid)) { remaining.push(entry); continue; }
          if (isAlive(entry.pid)) {
            const identityMatch = verifyLedgerIdentity(entry.pid, entry.birthIdentity, observedIdentities.get(entry.pid) ?? null);
            if (identityMatch === true) {
              if (killLedgeredProcess(entry, { force: true })) killed++;
              else { skipped++; remaining.push(entry); continue; }
            } else {
              skipped++;
              // A positively different birth is stale. Missing/unverifiable
              // identity is retained so an in-flight Windows capture can still
              // hydrate it; killing without proof would fail open.
              if (identityMatch == null) remaining.push(entry);
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
 * Kill this process's recorded child processes whose recorded cwd is at or
 * inside `cwd`. This is deliberately narrower than `reapOwnDaemonSpawns()`:
 * terminal worktree cleanup may call it after the queue says no job owns the
 * worktree, and it must never touch unrelated live children.
 * @param {string} cwd
 * @param {{ exceptPids?: Iterable<number>, force?: boolean, tree?: boolean }} [opts]
 * @returns {{ killed: number, skipped: number, matched: number }}
 */
export function reapOwnDaemonSpawnsForCwd(cwd, opts = {}) {
  let killed = 0;
  let skipped = 0;
  let matched = 0;
  const except = new Set(opts.exceptPids || []);
  try {
    const files = ownLedgerFiles();
    const observedIdentities = processIdentitiesSync(files.flatMap((file) => (
      readLedger(file).filter((entry) => isAlive(entry.pid)).map((entry) => entry.pid)
    )));
    for (const file of files) {
      withLedgerLock(file, () => {
        const entries = readLedger(file);
        if (!entries.length) return;
        /** @type {typeof entries} */
        const remaining = [];
        for (const entry of entries) {
          if (!cwdIsInside(entry.cwd, cwd)) {
            remaining.push(entry);
            continue;
          }
          matched++;
          if (except.has(entry.pid)) { remaining.push(entry); continue; }
          if (isAlive(entry.pid)) {
            const identityMatch = verifyLedgerIdentity(entry.pid, entry.birthIdentity, observedIdentities.get(entry.pid) ?? null);
            if (identityMatch === true) {
              if (killLedgeredProcess(entry, { force: opts.force !== false, tree: opts.tree !== false })) killed++;
              else { skipped++; remaining.push(entry); continue; }
            } else {
              skipped++;
              if (identityMatch == null) remaining.push(entry);
              continue;
            }
          }
          // Dead or killed entries are dropped from the ledger.
        }
        writeLedger(file, remaining);
      });
    }
  } catch {
    /* best effort */
  }
  return { killed, skipped, matched };
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
    // Apply the work cap to ledger shards, not arbitrary directory entries.
    // Stale lock/temp files otherwise consume the entire 200-entry budget and
    // can starve a real orphan ledger on every boot.
    names = fs.readdirSync(dir).filter((name) => (
      name.endsWith(".json") && Number.isInteger(parseLedgerOwnerPid(name))
    ));
  } catch {
    return { killed, skipped, ledgers }; // no dir → nothing to reap
  }
  // Bound the work — a runaway ledger dir must not turn a best-effort sweep into
  // a long synchronous stall. Real sessions leave a handful of files; anything
  // past the cap is left for the next boot's sweep.
  if (names.length > 200) names = names.slice(0, 200);
  const identityPids = [];
  for (const name of names) {
    const ownerPid = parseLedgerOwnerPid(name);
    if (!Number.isInteger(ownerPid)) continue;
    if (isAlive(ownerPid)) identityPids.push(ownerPid);
    for (const entry of readLedger(path.join(dir, name))) {
      if (isAlive(entry.pid)) identityPids.push(entry.pid);
    }
  }
  const observedIdentities = processIdentitiesSync(identityPids);
  for (const name of names) {
    const ownerPid = parseLedgerOwnerPid(name);
    if (!Number.isInteger(ownerPid)) continue;
    const file = path.join(dir, name);
    const entries = readLedger(file);
    if (isAlive(ownerPid)) {
      const expectedOwnerIdentity = entries.find((entry) => entry.ownerBirthIdentity)?.ownerBirthIdentity || null;
      const ownerMatch = verifyLedgerIdentity(ownerPid, expectedOwnerIdentity, observedIdentities.get(ownerPid) ?? null);
      // Matching owner is a concurrent live instance. Legacy/unverifiable
      // owner identity also fails closed; only a positive birth mismatch proves
      // that the ledger pid was recycled and the original owner is gone.
      if (ownerMatch !== false) continue;
    }
    const remaining = [];
    for (const entry of entries) {
      if (!isAlive(entry.pid)) continue;
      const identityMatch = verifyLedgerIdentity(entry.pid, entry.birthIdentity, observedIdentities.get(entry.pid) ?? null);
      if (identityMatch !== true) {
        skipped++;
        // A positive mismatch is a recycled child pid and can be discarded.
        // Legacy/unverifiable live rows retain their breadcrumb for a future
        // boot rather than permanently losing the only safe recovery record.
        if (identityMatch == null) remaining.push(entry);
        continue;
      }
      try {
        if (killLedgeredProcess(entry, { force: true })) killed++;
        else { skipped++; remaining.push(entry); }
      } catch {
        skipped++;
        remaining.push(entry);
      }
    }
    writeLedger(file, remaining);
    if (remaining.length === 0 && !fs.existsSync(file)) ledgers++;
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
