// Snapshot ref / note inventory and pruning helpers for the recovery
// workflow. Snapshots themselves are created by callers in
// worktree.js (preserveDirtyWorktreeSnapshot / preserveBranchTipSnapshot);
// this module owns the addressing scheme (refs/posse/snapshots/*),
// the parallel JSON metadata stored under refs/notes/posse-snapshots,
// the legacy directory cleanup path, and the dedupe lookups.

import fs from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { execFile, execFileSync } from "child_process";
import { slugify } from "../../../shared/format/functions/slug.js";
import { getSetting } from "../../queue/functions/index.js";
import { getRuntimeRoot } from "../../runtime/functions/paths.js";
import { ensurePosseGitInfoExclude } from "../../runtime/functions/ignore.js";
import { isInsideRoot } from "../../runtime/functions/fs-safety.js";
import { isAbortError, throwIfAborted } from "../../runtime/functions/yield.js";
import { gitExec, gitExecAsync } from "./utils.js";
import {
  acquireWorktreeLock,
  acquireWorktreeLockAsync,
  gitStashLockPath,
} from "./worktree-locks.js";
import { SnapshotRef } from "../classes/index.js";
import { runGitNativeMethod, runGitNativeMethodAsync } from "./native/invoke.js";

export const SNAPSHOT_REF_PREFIX = "refs/posse/snapshots";
export const SNAPSHOT_NOTES_REF = "refs/notes/posse-snapshots";
export const STASH_LIST_FORMAT = "%H%x00%gd%x00%s";
export const SNAPSHOT_HASH_FILE_CHUNK_BYTES = 64 * 1024;

const DEFAULT_SNAPSHOT_RETENTION_DAYS = 30;
const DEFAULT_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_SNAPSHOT_MAX_FILES = 500;
const DEFAULT_SNAPSHOT_MAX_COPY_BYTES = 100 * 1024 * 1024;
const DEFAULT_SNAPSHOT_MAX_REFS = 500;
const SNAPSHOT_NATIVE_DEDUP_LOOKUP_TIMEOUT_MS = 180_000;

export {
  DEFAULT_SNAPSHOT_RETENTION_DAYS,
  DEFAULT_SNAPSHOT_MAX_BYTES,
  DEFAULT_SNAPSHOT_MAX_FILES,
  DEFAULT_SNAPSHOT_MAX_COPY_BYTES,
  DEFAULT_SNAPSHOT_MAX_REFS,
};

function nativeAsyncOptions(options = {}) {
  // Only native-parity keys cross into the native invocation, plus the
  // explicitly threaded manager/signal/timeout — never the whole caller
  // options bag.
  const parity = options.nativeParity || {};
  return {
    ...parity,
    manager: options.manager ?? parity.manager,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  };
}

function snapshotRefFromNative(value, { metadata = {} } = {}) {
  if (!value || typeof value !== "object") return null;
  const raw = /** @type {Record<string, unknown>} */ (value);
  const refValue = raw.value == null ? null : String(raw.value);
  if (!refValue) return null;
  const storageType = String(raw.storageType || raw.storage_type || "git-ref");
  const nativeMetadata = raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
    ? raw.metadata
    : {};
  return SnapshotRef.from(refValue, {
    storageType,
    objectHash: raw.objectHash || raw.object_hash ? String(raw.objectHash || raw.object_hash) : null,
    projectDir: raw.projectDir || raw.project_dir ? String(raw.projectDir || raw.project_dir) : null,
    worktreePath: raw.worktreePath || raw.worktree_path ? String(raw.worktreePath || raw.worktree_path) : null,
    metadata: {
      ...nativeMetadata,
      ...metadata,
    },
  });
}

function nodeGitAsyncOptions(options = {}) {
  return {
    ...options,
    nativeParity: { disabled: true },
  };
}

function randomToken(bytes = 4) {
  return randomBytes(bytes).toString("hex");
}

function safeFilenameNode(text) {
  return slugify(text, { alphabet: "filename", fallback: "snapshot" });
}

function withDefaultTimeout(nativeParity = {}, timeoutMs = SNAPSHOT_NATIVE_DEDUP_LOOKUP_TIMEOUT_MS) {
  return {
    ...nativeParity,
    timeoutMs: nativeParity?.timeoutMs ?? timeoutMs,
  };
}

export function safeFilename(text, nativeParity = {}) {
  if (nativeParity?.disabled === true) return safeFilenameNode(text);
  try {
    return runGitNativeMethod("git.snapshot.safeFilename", { text: String(text || "") }, nativeParity);
  } catch {
    return safeFilenameNode(text);
  }
}

export function parsePositiveIntSetting(name, defaultValue) {
  let raw = null;
  try { raw = getSetting(name); } catch { raw = null; }
  if (raw == null || raw === "") return defaultValue;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return parsed;
}

export function parseBooleanSetting(name, defaultValue = false) {
  let raw = null;
  try { raw = getSetting(name); } catch { raw = null; }
  if (raw == null || raw === "") return defaultValue;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

export function recoveryRoot(projectDir, nativeParity = {}) {
  ensurePosseGitInfoExclude(projectDir);
  return runGitNativeMethod(
    "git.snapshot.recoveryRoot",
    { projectDir: path.resolve(projectDir), runtimeRoot: getRuntimeRoot(projectDir) },
    nativeParity,
  );
}

export function snapshotRefName({ wiId = null, reason = "dirty-worktree", dedupHash = null, nativeParity = {} } = {}) {
  // The timestamp and (when dedup is off) the random token are non-deterministic
  // and computed in Node; the native method assembles the ref name from them.
  const capturedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const uniqueToken = dedupHash || randomToken();
  return runGitNativeMethod(
    "git.snapshot.refName",
    {
      wiId: wiId == null ? null : String(wiId),
      reason,
      dedupHash: dedupHash || null,
      uniqueToken,
      capturedAt,
    },
    nativeParity,
  );
}

export function dirSizeBytes(dirPath, nativeParity = {}) {
  return runGitNativeMethod("git.snapshot.dirSizeBytes", { dirPath: path.resolve(dirPath) }, nativeParity);
}

export async function dirSizeBytesAsync(dirPath, nativeParity = {}) {
  return await runGitNativeMethodAsync(
    "git.snapshot.dirSizeBytes",
    { dirPath: path.resolve(dirPath) },
    nativeParity,
  );
}

export function readSnapshotNotesByObjectHash(projectDir, objectHashes = []) {
  const wanted = new Set((Array.isArray(objectHashes) ? objectHashes : []).filter(Boolean));
  const notesByObject = new Map();
  if (wanted.size === 0) return notesByObject;

  let notesListRaw = "";
  try {
    notesListRaw = gitExec(
      ["notes", `--ref=${SNAPSHOT_NOTES_REF}`, "list"],
      projectDir,
      { nativeParity: { disabled: true } },
    );
  } catch {
    return notesByObject;
  }

  const noteObjectByTarget = new Map();
  for (const line of String(notesListRaw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const noteObject = parts[0];
    const targetObject = parts[1];
    if (!wanted.has(targetObject)) continue;
    noteObjectByTarget.set(targetObject, noteObject);
  }
  if (noteObjectByTarget.size === 0) return notesByObject;

  const noteObjects = [...new Set([...noteObjectByTarget.values()])];
  let batchOut;
  try {
    batchOut = execFileSync("git", ["cat-file", "--batch"], {
      cwd: projectDir,
      input: `${noteObjects.join("\n")}\n`,
      encoding: null,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return notesByObject;
  }

  return parseBatchCatFileNotes(batchOut, noteObjectByTarget);
}

async function gitCatFileBatchAsync(projectDir, objectHashes = [], options = {}) {
  const input = `${objectHashes.join("\n")}\n`;
  return await new Promise((resolve, reject) => {
    const execOptions = {
      cwd: projectDir,
      encoding: null,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 16,
    };
    if (options.signal) execOptions.signal = options.signal;
    const child = execFile("git", ["cat-file", "--batch"], execOptions, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ""));
    });
    child.stdin?.end(input);
  });
}

function parseBatchCatFileNotes(batchOut, noteObjectByTarget) {
  const notesByObject = new Map();
  const noteBlobByObject = new Map();
  let offset = 0;
  while (offset < batchOut.length) {
    const nl = batchOut.indexOf(0x0a, offset);
    if (nl === -1) break;
    const header = batchOut.slice(offset, nl).toString("utf-8").trim();
    offset = nl + 1;
    if (!header) continue;
    const missingMatch = header.match(/^([0-9a-f]{40}) missing$/i);
    if (missingMatch) continue;
    const metaMatch = header.match(/^([0-9a-f]{40})\s+\S+\s+(\d+)$/i);
    if (!metaMatch) break;
    const objectId = metaMatch[1];
    const size = Number.parseInt(metaMatch[2], 10);
    if (!Number.isFinite(size) || size < 0) break;
    if (offset + size > batchOut.length) break;
    const body = batchOut.slice(offset, offset + size).toString("utf-8");
    noteBlobByObject.set(objectId, body);
    offset += size;
    if (offset < batchOut.length && batchOut[offset] === 0x0a) offset += 1;
  }

  for (const [targetObject, noteObject] of noteObjectByTarget.entries()) {
    const raw = noteBlobByObject.get(noteObject);
    if (!raw) continue;
    try {
      notesByObject.set(targetObject, JSON.parse(raw));
    } catch {
      // Ignore malformed note payloads.
    }
  }
  return notesByObject;
}

export async function readSnapshotNotesByObjectHashAsync(projectDir, objectHashes = [], options = {}) {
  const wanted = new Set((Array.isArray(objectHashes) ? objectHashes : []).filter(Boolean));
  const empty = new Map();
  if (wanted.size === 0) return empty;

  let notesListRaw = "";
  try {
    notesListRaw = await gitExecAsync(["notes", `--ref=${SNAPSHOT_NOTES_REF}`, "list"], projectDir, options);
  } catch (err) {
    if (isAbortError(err)) throw err;
    return empty;
  }

  const noteObjectByTarget = new Map();
  for (const line of String(notesListRaw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const noteObject = parts[0];
    const targetObject = parts[1];
    if (!wanted.has(targetObject)) continue;
    noteObjectByTarget.set(targetObject, noteObject);
  }
  if (noteObjectByTarget.size === 0) return empty;

  const noteObjects = [...new Set([...noteObjectByTarget.values()])];
  let batchOut;
  try {
    batchOut = await gitCatFileBatchAsync(projectDir, noteObjects, options);
  } catch (err) {
    if (isAbortError(err)) throw err;
    return empty;
  }

  return parseBatchCatFileNotes(batchOut, noteObjectByTarget);
}

export function listSnapshotRefs(projectDir, nativeParity = {}) {
  if (nativeParity?.disabled === true) return listSnapshotRefsNode(projectDir);
  try {
    return runGitNativeMethod("git.snapshot.listRefs", { projectDir: path.resolve(projectDir) }, nativeParity);
  } catch {
    return listSnapshotRefsNode(projectDir);
  }
}

export async function listSnapshotRefsAsync(projectDir, options = {}) {
  if (options?.disabled === true || options?.nativeParity?.disabled === true) {
    return await listSnapshotRefsNodeAsync(projectDir, options);
  }
  try {
    return await runGitNativeMethodAsync(
      "git.snapshot.listRefs",
      { projectDir: path.resolve(projectDir) },
      nativeAsyncOptions(options),
    );
  } catch (err) {
    if (isAbortError(err)) throw err;
    return await listSnapshotRefsNodeAsync(projectDir, options);
  }
}

function listSnapshotRefsNode(projectDir) {
  let raw = "";
  try {
    raw = gitExec([
      "for-each-ref",
      "--format=%(refname)|%(objectname)|%(creatordate:unix)",
      SNAPSHOT_REF_PREFIX,
    ], projectDir, { nativeParity: { disabled: true } });
  } catch {
    return [];
  }
  const refRows = String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [refName, objectHash, createdUnix] = line.split("|");
      return { refName, objectHash, createdUnix };
    });
  const notesByObject = readSnapshotNotesByObjectHash(
    projectDir,
    refRows.map((row) => row.objectHash),
  );
  return refRows
    .map(({ refName, objectHash, createdUnix }) => {
      const note = notesByObject.get(objectHash) || null;
      const noteCapturedMs = note?.captured_at ? Date.parse(note.captured_at) : NaN;
      const fallbackMs = Number(createdUnix) * 1000;
      const createdMs = Number.isFinite(noteCapturedMs) && noteCapturedMs > 0
        ? noteCapturedMs
        : (Number.isFinite(fallbackMs) ? fallbackMs : 0);
      return {
        refName,
        objectHash,
        createdMs: Number.isFinite(createdMs) ? createdMs : 0,
      };
    })
    .sort((a, b) => a.createdMs - b.createdMs);
}

async function listSnapshotRefsNodeAsync(projectDir, options = {}) {
  let raw = "";
  try {
    raw = await gitExecAsync([
      "for-each-ref",
      "--format=%(refname)|%(objectname)|%(creatordate:unix)",
      SNAPSHOT_REF_PREFIX,
    ], projectDir, nodeGitAsyncOptions(options));
  } catch (err) {
    if (isAbortError(err)) throw err;
    return [];
  }
  const refRows = String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [refName, objectHash, createdUnix] = line.split("|");
      return { refName, objectHash, createdUnix };
    });
  const notesByObject = await readSnapshotNotesByObjectHashAsync(
    projectDir,
    refRows.map((row) => row.objectHash),
    nodeGitAsyncOptions(options),
  );
  return refRows
    .map(({ refName, objectHash, createdUnix }) => {
      const note = notesByObject.get(objectHash) || null;
      const noteCapturedMs = note?.captured_at ? Date.parse(note.captured_at) : NaN;
      const fallbackMs = Number(createdUnix) * 1000;
      const createdMs = Number.isFinite(noteCapturedMs) && noteCapturedMs > 0
        ? noteCapturedMs
        : (Number.isFinite(fallbackMs) ? fallbackMs : 0);
      return {
        refName,
        objectHash,
        createdMs: Number.isFinite(createdMs) ? createdMs : 0,
      };
    })
    .sort((a, b) => a.createdMs - b.createdMs);
}

export function readSnapshotNote(projectDir, objectHash, nativeParity = {}) {
  return runGitNativeMethod(
    "git.snapshot.readNote",
    { projectDir: path.resolve(projectDir), objectHash: String(objectHash || "") },
    nativeParity,
  );
}

export async function readSnapshotNoteAsync(projectDir, objectHash, options = {}) {
  return await runGitNativeMethodAsync(
    "git.snapshot.readNote",
    { projectDir: path.resolve(projectDir), objectHash: String(objectHash || "") },
    nativeAsyncOptions(options),
  );
}

async function readSnapshotNoteNodeAsync(projectDir, objectHash, options = {}) {
  if (!objectHash) return null;
  try {
    const raw = await gitExecAsync(
      ["notes", `--ref=${SNAPSHOT_NOTES_REF}`, "show", objectHash],
      projectDir,
      nodeGitAsyncOptions(options),
    );
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    if (isAbortError(err)) throw err;
    return null;
  }
}

export function writeSnapshotNote(projectDir, objectHash, note) {
  if (!objectHash || !note) return false;
  try {
    gitExec(["notes", `--ref=${SNAPSHOT_NOTES_REF}`, "add", "-f", "-m", JSON.stringify(note), objectHash], projectDir);
    return true;
  } catch {
    return false;
  }
}

export async function writeSnapshotNoteAsync(projectDir, objectHash, note, options = {}) {
  if (!objectHash || !note) return false;
  return await runGitNativeMethodAsync(
    "git.snapshot.writeNote",
    {
      projectDir: path.resolve(projectDir),
      objectHash: String(objectHash || ""),
      note,
    },
    nativeAsyncOptions(options),
  );
}

export function findExistingDedupSnapshotRef(projectDir, { wiId = null, reason = "dirty-worktree", dedupHash = null, nativeParity = {} } = {}) {
  if (nativeParity?.disabled === true) {
    return findExistingDedupSnapshotRefNode(projectDir, { wiId, reason, dedupHash });
  }
  try {
    return runGitNativeMethod(
      "git.snapshot.findExistingDedupRef",
      { projectDir: path.resolve(projectDir), wiId: wiId == null ? null : String(wiId), reason, dedupHash: String(dedupHash || "") },
      withDefaultTimeout(nativeParity),
    );
  } catch {
    return findExistingDedupSnapshotRefNode(projectDir, { wiId, reason, dedupHash });
  }
}

export async function findExistingDedupSnapshotRefAsync(projectDir, { wiId = null, reason = "dirty-worktree", dedupHash = null, signal = null, nativeParity = {} } = {}) {
  if (nativeParity?.disabled === true) {
    return await findExistingDedupSnapshotRefNodeAsync(projectDir, { wiId, reason, dedupHash, signal });
  }
  try {
    return await runGitNativeMethodAsync(
      "git.snapshot.findExistingDedupRef",
      {
        projectDir: path.resolve(projectDir),
        wiId: wiId == null ? null : String(wiId),
        reason,
        dedupHash: String(dedupHash || ""),
      },
      { ...withDefaultTimeout(nativeParity), signal },
    );
  } catch (err) {
    if (isAbortError(err)) throw err;
    return await findExistingDedupSnapshotRefNodeAsync(projectDir, { wiId, reason, dedupHash, signal });
  }
}

function findExistingDedupSnapshotRefNode(projectDir, { wiId = null, reason = "dirty-worktree", dedupHash = null } = {}) {
  if (!dedupHash) return null;
  const wiPart = wiId != null ? `wi-${wiId}` : "wi-unknown";
  const reasonPart = safeFilenameNode(reason);
  const refs = listSnapshotRefsNode(projectDir);
  const candidates = refs.filter((ref) => {
    if (!ref.refName || !ref.refName.endsWith(`-${dedupHash}`)) return false;
    return ref.refName.includes(`/${wiPart}-${reasonPart}-`);
  });
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

async function findExistingDedupSnapshotRefNodeAsync(projectDir, { wiId = null, reason = "dirty-worktree", dedupHash = null, signal = null } = {}) {
  if (!dedupHash) return null;
  const wiPart = wiId != null ? `wi-${wiId}` : "wi-unknown";
  const reasonPart = safeFilename(reason, { disabled: true });
  const refs = await listSnapshotRefsNodeAsync(projectDir, { signal });
  const candidates = refs.filter((ref) => {
    if (!ref.refName || !ref.refName.endsWith(`-${dedupHash}`)) return false;
    return ref.refName.includes(`/${wiPart}-${reasonPart}-`);
  });
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

export function pruneRecoveredWorktreeSnapshots(projectDir, onMsg = () => {}) {
  const retentionDays = parsePositiveIntSetting("snapshot_retention_days", DEFAULT_SNAPSHOT_RETENTION_DAYS);
  const maxBytes = parsePositiveIntSetting("snapshot_max_bytes", DEFAULT_SNAPSHOT_MAX_BYTES);
  const maxRefs = parsePositiveIntSetting("snapshot_max_refs", DEFAULT_SNAPSHOT_MAX_REFS);

  // Preferred storage: git refs under refs/posse/snapshots/*
  const refs = listSnapshotRefs(projectDir, { disabled: true });
  const refToRemove = [];
  if (refs.length > 0) {
    if (retentionDays > 0) {
      const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
      for (const ref of refs) {
        if (ref.createdMs > 0 && ref.createdMs < cutoffMs) refToRemove.push(ref.refName);
      }
    }
    const kept = refs.filter((ref) => !refToRemove.includes(ref.refName));
    if (maxRefs > 0 && kept.length > maxRefs) {
      const over = kept.length - maxRefs;
      for (let i = 0; i < over; i++) refToRemove.push(kept[i].refName);
    }
    for (const refName of refToRemove) {
      try { gitExec(["update-ref", "-d", refName], projectDir); } catch { /* best effort */ }
    }
    if (refToRemove.length > 0) {
      try { gitExec(["notes", `--ref=${SNAPSHOT_NOTES_REF}`, "prune"], projectDir); } catch { /* best effort */ }
      try { gitExec(["gc", "--auto"], projectDir); } catch { /* best effort */ }
      onMsg(`GC: pruned ${refToRemove.length} snapshot ref(s)`);
    }
  }

  // Backward-compat cleanup for legacy directory snapshots.
  const root = path.join(getRuntimeRoot(projectDir), "recovered-worktrees");
  if (!fs.existsSync(root)) return { removed: refToRemove.length, bytesFreed: 0 };

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(root, entry.name);
        let mtimeMs = 0;
        try { mtimeMs = Number(fs.statSync(dir).mtimeMs || 0); } catch { /* ignore */ }
        return {
          dir,
          name: entry.name,
          mtimeMs,
          sizeBytes: dirSizeBytes(dir),
        };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch {
    return { removed: 0, bytesFreed: 0 };
  }

  const toRemove = [];
  let totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

  if (retentionDays > 0) {
    const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    for (const entry of entries) {
      if (entry.mtimeMs > 0 && entry.mtimeMs < cutoffMs) {
        toRemove.push(entry);
        totalBytes -= entry.sizeBytes;
      }
    }
  }

  const kept = entries.filter((entry) => !toRemove.includes(entry));
  if (maxBytes > 0 && totalBytes > maxBytes) {
    for (const entry of kept) {
      if (totalBytes <= maxBytes) break;
      toRemove.push(entry);
      totalBytes -= entry.sizeBytes;
    }
  }

  let removed = 0;
  let bytesFreed = 0;
  for (const entry of toRemove) {
    try {
      fs.rmSync(entry.dir, { recursive: true, force: true });
      removed++;
      bytesFreed += entry.sizeBytes;
    } catch {
      // Best effort pruning.
    }
  }
  if (removed > 0) {
    onMsg(`GC: pruned ${removed} recovery snapshot(s), freed ${bytesFreed} bytes`);
  }
  return { removed: removed + refToRemove.length, bytesFreed };
}

export async function pruneRecoveredWorktreeSnapshotsAsync(projectDir, onMsg = () => {}, { signal = null } = {}) {
  throwIfAborted(signal);
  const retentionDays = parsePositiveIntSetting("snapshot_retention_days", DEFAULT_SNAPSHOT_RETENTION_DAYS);
  const maxBytes = parsePositiveIntSetting("snapshot_max_bytes", DEFAULT_SNAPSHOT_MAX_BYTES);
  const maxRefs = parsePositiveIntSetting("snapshot_max_refs", DEFAULT_SNAPSHOT_MAX_REFS);

  const refs = await listSnapshotRefsAsync(projectDir, { signal, nativeParity: { disabled: true } });
  const refToRemove = [];
  if (refs.length > 0) {
    if (retentionDays > 0) {
      const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
      for (const ref of refs) {
        if (ref.createdMs > 0 && ref.createdMs < cutoffMs) refToRemove.push(ref.refName);
      }
    }
    const kept = refs.filter((ref) => !refToRemove.includes(ref.refName));
    if (maxRefs > 0 && kept.length > maxRefs) {
      const over = kept.length - maxRefs;
      for (let i = 0; i < over; i++) refToRemove.push(kept[i].refName);
    }
    for (const refName of refToRemove) {
      try { await gitExecAsync(["update-ref", "-d", refName], projectDir, { signal }); } catch (err) { if (isAbortError(err)) throw err; }
    }
    if (refToRemove.length > 0) {
      try { await gitExecAsync(["notes", `--ref=${SNAPSHOT_NOTES_REF}`, "prune"], projectDir, { signal }); } catch (err) { if (isAbortError(err)) throw err; }
      try { await gitExecAsync(["gc", "--auto"], projectDir, { signal }); } catch (err) { if (isAbortError(err)) throw err; }
      onMsg(`GC: pruned ${refToRemove.length} snapshot ref(s)`);
    }
  }

  const root = path.join(getRuntimeRoot(projectDir), "recovered-worktrees");
  let rootStat = null;
  try { rootStat = await fs.promises.stat(root); } catch { rootStat = null; }
  if (!rootStat?.isDirectory()) return { removed: refToRemove.length, bytesFreed: 0 };

  let entries;
  try {
    const dirents = await fs.promises.readdir(root, { withFileTypes: true });
    entries = [];
    for (const entry of dirents) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      let mtimeMs = 0;
      try { mtimeMs = Number((await fs.promises.stat(dir)).mtimeMs || 0); } catch { /* ignore */ }
      entries.push({
        dir,
        name: entry.name,
        mtimeMs,
        sizeBytes: await dirSizeBytesAsync(dir),
      });
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch {
    return { removed: refToRemove.length, bytesFreed: 0 };
  }

  const toRemove = [];
  let totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

  if (retentionDays > 0) {
    const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    for (const entry of entries) {
      if (entry.mtimeMs > 0 && entry.mtimeMs < cutoffMs) {
        toRemove.push(entry);
        totalBytes -= entry.sizeBytes;
      }
    }
  }

  const kept = entries.filter((entry) => !toRemove.includes(entry));
  if (maxBytes > 0 && totalBytes > maxBytes) {
    for (const entry of kept) {
      if (totalBytes <= maxBytes) break;
      toRemove.push(entry);
      totalBytes -= entry.sizeBytes;
    }
  }

  let removed = 0;
  let bytesFreed = 0;
  for (const entry of toRemove) {
    throwIfAborted(signal);
    try {
      await fs.promises.rm(entry.dir, { recursive: true, force: true });
      removed++;
      bytesFreed += entry.sizeBytes;
    } catch {
      // Best effort pruning.
    }
  }
  if (removed > 0) {
    onMsg(`GC: pruned ${removed} recovery snapshot(s), freed ${bytesFreed} bytes`);
  }
  return { removed: removed + refToRemove.length, bytesFreed };
}

// ─── Stash entry helpers ────────────────────────────────────────────
// refs/stash is shared across all linked worktrees in the repo, so a
// positional `stash@{0}` is racy after `stash push`. We tag each
// snapshot stash with a unique message and resolve it back to its
// commit hash / reflog ref by that tag.

function parseStashEntryByToken(list, uniqueToken) {
  for (const line of String(list || "").split("\n")) {
    if (!line) continue;
    const parts = line.split("\0");
    if (parts.length < 3) continue;
    const [hash, ref, subject] = parts;
    if (subject && subject.includes(uniqueToken)) {
      return { hash, ref, subject };
    }
  }
  return null;
}

function findStashEntryByToken(wtPath, uniqueToken) {
  const list = gitExec(["stash", "list", `--format=${STASH_LIST_FORMAT}`], wtPath);
  return parseStashEntryByToken(list, uniqueToken);
}

async function findStashEntryByTokenAsync(wtPath, uniqueToken, options = {}) {
  const list = await gitExecAsync(["stash", "list", `--format=${STASH_LIST_FORMAT}`], wtPath, options);
  return parseStashEntryByToken(list, uniqueToken);
}

function dropStashEntryByToken(wtPath, uniqueToken) {
  const entry = findStashEntryByToken(wtPath, uniqueToken);
  if (!entry?.ref) return false;
  gitExec(["stash", "drop", entry.ref], wtPath);
  return true;
}

async function dropStashEntryByTokenAsync(wtPath, uniqueToken, options = {}) {
  const entry = await findStashEntryByTokenAsync(wtPath, uniqueToken, options);
  if (!entry?.ref) return false;
  await gitExecAsync(["stash", "drop", entry.ref], wtPath, options);
  return true;
}

// ─── Dedupe hash helpers ───────────────────────────────────────────

function updateHashWithFileContents(hash, fullPath) {
  const fd = fs.openSync(fullPath, "r");
  const buffer = Buffer.allocUnsafe(SNAPSHOT_HASH_FILE_CHUNK_BYTES);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function updateHashWithUntrackedContents(hash, wtPath, untracked = []) {
  for (const relPath of untracked) {
    const normalized = String(relPath || "").replace(/\\/g, "/");
    if (!normalized) continue;
    const fullPath = path.resolve(wtPath, normalized);
    if (!isInsideRoot(fullPath, wtPath, { allowEqual: false, followSymlinks: false })) continue;
    try {
      const stat = fs.lstatSync(fullPath);
      hash.update("\n---untracked---\n");
      hash.update(normalized);
      hash.update("\0");
      hash.update(String(stat.mode || ""));
      hash.update("\0");
      hash.update(String(stat.size || ""));
      hash.update("\0");
      if (stat.isSymbolicLink()) {
        hash.update("symlink\0");
        hash.update(fs.readlinkSync(fullPath));
      } else if (stat.isFile()) {
        hash.update("file\0");
        updateHashWithFileContents(hash, fullPath);
      } else {
        hash.update(`other:${stat.isDirectory() ? "dir" : "special"}\0`);
      }
    } catch (err) {
      hash.update("\n---untracked-missing---\n");
      hash.update(normalized);
      hash.update("\0");
      hash.update(err?.code || err?.message || "unreadable");
    }
  }
}

// ─── Snapshot creation ──────────────────────────────────────────────

export function preserveDirtyWorktreeSnapshot(
  wtPath,
  projectDir,
  { reason = "dirty-worktree", branchName = null, wiId = null, onMsg = null } = {},
) {
  try {
    const status = gitExec(["status", "--porcelain"], wtPath);
    const diffPatch = gitExec(["diff"], wtPath, { trim: false });
    const stagedPatch = gitExec(["diff", "--cached"], wtPath, { trim: false });
    const trackedDirty = [
      ...new Set(
        `${gitExec(["-c", "core.quotePath=false", "diff", "--name-only"], wtPath)}\n${gitExec(["-c", "core.quotePath=false", "diff", "--name-only", "--cached"], wtPath)}`
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    ];
    const untracked = gitExec(["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"], wtPath)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const dedupHasher = createHash("sha256")
      .update(status || "")
      .update("\n---\n")
      .update(diffPatch || "")
      .update("\n---\n")
      .update(stagedPatch || "");
    updateHashWithUntrackedContents(dedupHasher, wtPath, untracked);
    const dedupHash = dedupHasher.digest("hex").slice(0, 16);
    const headSha = (() => {
      try { return gitExec(["rev-parse", "HEAD"], wtPath).trim(); } catch { return null; }
    })();
    const writeLegacyFallback = () => {
      const baseName = [wiId != null ? `wi-${wiId}` : null, safeFilename(reason), dedupHash].filter(Boolean).join("-");
      const outDir = path.join(recoveryRoot(projectDir), baseName);
      const partDir = `${outDir}.part-${process.pid}-${Date.now()}`;
      const untrackedRel = untracked.map((relPath) => String(relPath || "").replace(/\\/g, "/")).filter(Boolean);
      // The diff/staged patches cannot carry untracked contents (the stash push
      // already failed), so the only copy lives in the worktree until the files
      // are mirrored under <snapshot>/untracked/. Never hand back a snapshot
      // ref that misses any of them — `git clean -fd` runs right after.
      const untrackedPreservedIn = (dir) => untrackedRel.every((relPath) =>
        fs.existsSync(path.join(dir, "untracked", ...relPath.split("/")))
      );
      const untrackedCopyWarnings = [];
      try {
        if (fs.existsSync(outDir)) {
          if (untrackedPreservedIn(outDir)) {
            return SnapshotRef.directory(outDir, {
              projectDir,
              worktreePath: wtPath,
              metadata: { reason, wiId, branchName, dedupHash, headSha },
            });
          }
          // Existing snapshot predates untracked content copies; rewrite it.
          fs.rmSync(outDir, { recursive: true, force: true });
        }
      } catch {
        // proceed with best effort write
      }
      try {
        fs.mkdirSync(partDir, { recursive: true });
        fs.writeFileSync(path.join(partDir, "status.txt"), status ? `${status}\n` : "", "utf-8");
        fs.writeFileSync(path.join(partDir, "diff.patch"), diffPatch, "utf-8");
        fs.writeFileSync(path.join(partDir, "staged.patch"), stagedPatch, "utf-8");
        for (const relPath of untrackedRel) {
          const srcPath = path.resolve(wtPath, relPath);
          if (!isInsideRoot(srcPath, wtPath, { allowEqual: false, followSymlinks: false })) {
            untrackedCopyWarnings.push({ file: relPath, error: "path escapes worktree root; skipped" });
            continue;
          }
          const destPath = path.join(partDir, "untracked", ...relPath.split("/"));
          try {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(srcPath, destPath);
          } catch (copyErr) {
            if (copyErr?.code === "ENOENT" && !fs.existsSync(srcPath)) {
              // File vanished between enumeration and copy; nothing left to preserve.
              untrackedCopyWarnings.push({ file: relPath, error: "vanished before copy" });
              continue;
            }
            throw copyErr;
          }
        }
        fs.writeFileSync(path.join(partDir, "manifest.json"), JSON.stringify({
          source_worktree: wtPath,
          project_dir: projectDir,
          branch_name: branchName,
          work_item_id: wiId,
          reason,
          captured_at: new Date().toISOString(),
          tracked_dirty: trackedDirty,
          untracked,
          untracked_copy_warnings: untrackedCopyWarnings,
          dedup_hash: dedupHash,
          head_sha: headSha,
          storage: "directory-fallback",
        }, null, 2) + "\n", "utf-8");
      } catch (err) {
        try { fs.rmSync(partDir, { recursive: true, force: true }); } catch { /* ignore */ }
        throw err;
      }
      try {
        fs.renameSync(partDir, outDir);
      } catch (err) {
        if (fs.existsSync(outDir)) {
          // Lost a race (or could not clear a stale dir above). Reuse the
          // winner only if it actually preserved the untracked contents.
          if (untrackedPreservedIn(outDir)) {
            try { fs.rmSync(partDir, { recursive: true, force: true }); } catch { /* ignore */ }
            return SnapshotRef.directory(outDir, {
              projectDir,
              worktreePath: wtPath,
              metadata: { reason, wiId, branchName, dedupHash, headSha },
            });
          }
          try {
            fs.rmSync(outDir, { recursive: true, force: true });
            fs.renameSync(partDir, outDir);
          } catch {
            try { fs.rmSync(partDir, { recursive: true, force: true }); } catch { /* ignore */ }
            if (typeof onMsg === "function") {
              onMsg(`legacy fallback snapshot could not be finalized at ${outDir}; refusing to report dirty state as preserved`);
            }
            return null;
          }
          return SnapshotRef.directory(outDir, {
            projectDir,
            worktreePath: wtPath,
            metadata: { reason, wiId, branchName, dedupHash, headSha },
          });
        }
        throw err;
      }
      return SnapshotRef.directory(outDir, {
        projectDir,
        worktreePath: wtPath,
        metadata: { reason, wiId, branchName, dedupHash, headSha },
      });
    };

    const uniqueToken = `${process.pid}-${Date.now()}-${randomToken()}`;
    const stashMessage = `posse-snapshot:${reason}:${new Date().toISOString()}:${uniqueToken}`;
    const repoCwd = wtPath;
    const stashLockPath = gitStashLockPath(wtPath, projectDir);
    const stashLock = acquireWorktreeLock(stashLockPath);
    if (!stashLock.acquired) return writeLegacyFallback();
    try {
    try {
      gitExec(["stash", "push", "--include-untracked", "-m", stashMessage], wtPath);
    } catch {
      return writeLegacyFallback();
    }
    let stashHash = null;
    let stashRef = null;
    try {
      const entry = findStashEntryByToken(wtPath, uniqueToken);
      stashHash = entry?.hash || null;
      stashRef = entry?.ref || null;
    } catch { /* fall through to fallback */ }
    if (!stashHash || !stashRef) return writeLegacyFallback();

    const dedupEnabled = parseBooleanSetting("snapshot_dedup", true);
    const existingDedupRef = dedupEnabled
      ? findExistingDedupSnapshotRef(repoCwd, { wiId, reason, dedupHash })
      : null;
    if (existingDedupRef?.refName) {
      const seenAt = new Date().toISOString();
      const existingNote = readSnapshotNote(repoCwd, existingDedupRef.objectHash);
      const existingSeenAt = Array.isArray(existingNote?.seen_at) ? existingNote.seen_at : [];
      const nextSeenCount = Number.isFinite(Number(existingNote?.seen_count))
        ? Number(existingNote.seen_count) + 1
        : 2;
      const nextNote = {
        ...(existingNote || {}),
        dedup_hash: dedupHash,
        seen_count: nextSeenCount,
        seen_at: [...existingSeenAt.slice(-19), seenAt],
      };
      writeSnapshotNote(repoCwd, existingDedupRef.objectHash, nextNote);
      let restoreFailed = false;
      let restoreError = null;
      try {
        gitExec(["stash", "apply", "--index", stashHash], wtPath);
        dropStashEntryByToken(wtPath, uniqueToken);
      } catch (applyErr) {
        restoreFailed = true;
        restoreError = applyErr?.message || String(applyErr);
        try { dropStashEntryByToken(wtPath, uniqueToken); } catch { /* ignore */ }
        try { gitExec(["reset", "--hard", "HEAD"], wtPath); } catch { /* worktree may be too broken to reset */ }
        const failedNote = {
          ...nextNote,
          restore_failed_count: Number.isFinite(Number(existingNote?.restore_failed_count))
            ? Number(existingNote.restore_failed_count) + 1
            : 1,
          last_restore_failure: {
            at: seenAt,
            worktree_path: wtPath,
            error: restoreError,
          },
        };
        writeSnapshotNote(repoCwd, existingDedupRef.objectHash, failedNote);
        if (typeof onMsg === "function") {
          onMsg(`snapshot apply failed after dedup reuse; content preserved at ${existingDedupRef.refName} (${restoreError})`);
        }
      }
      return SnapshotRef.gitRef(existingDedupRef.refName, {
        objectHash: existingDedupRef.objectHash,
        projectDir: repoCwd,
        worktreePath: wtPath,
        metadata: { reason, wiId, branchName, dedupHash, reused: true, restoreFailed, restoreError },
      });
    }

    const refName = snapshotRefName({
      wiId,
      reason,
      dedupHash: dedupEnabled ? dedupHash : null,
    });
    try {
      gitExec(["update-ref", refName, stashHash], repoCwd);
    } catch {
      if (typeof onMsg === "function") {
        onMsg(`snapshot pin failed; stash preserved for manual recovery (${stashMessage})`);
      }
      return null;
    }

    const note = {
      storage: "git-ref",
      ref_name: refName,
      object_hash: stashHash,
      source_worktree: wtPath,
      project_dir: projectDir,
      branch_name: branchName,
      work_item_id: wiId,
      reason,
      captured_at: new Date().toISOString(),
      head_sha: headSha,
      tracked_dirty: trackedDirty,
      untracked,
      dedup_hash: dedupHash,
      status,
      diff_patch: diffPatch,
      staged_patch: stagedPatch,
    };
    writeSnapshotNote(repoCwd, stashHash, note);

    let restoreFailed = false;
    let restoreError = null;
    try {
      gitExec(["stash", "apply", "--index", stashHash], wtPath);
    } catch (applyErr) {
      restoreFailed = true;
      restoreError = applyErr?.message || String(applyErr);
      const failedNote = {
        ...note,
        restore_failed_count: 1,
        last_restore_failure: {
          at: new Date().toISOString(),
          worktree_path: wtPath,
          error: restoreError,
        },
      };
      writeSnapshotNote(repoCwd, stashHash, failedNote);
      try { gitExec(["reset", "--hard", "HEAD"], wtPath); } catch { /* worktree may be too broken to reset */ }
      if (typeof onMsg === "function") {
        onMsg(`snapshot restore failed after pinning ${refName}; inspect with git show ${refName} and restore with git stash apply ${refName} (${restoreError})`);
      }
    } finally {
      try { dropStashEntryByToken(wtPath, uniqueToken); } catch { /* ignore */ }
    }
    return SnapshotRef.gitRef(refName, {
      objectHash: stashHash,
      projectDir: repoCwd,
      worktreePath: wtPath,
      metadata: { reason, wiId, branchName, dedupHash, restoreFailed, restoreError },
    });
    } finally {
      stashLock.release();
    }
  } catch (err) {
    if (typeof onMsg === "function") {
      onMsg(`snapshot failed for ${wtPath}: ${err?.message || String(err)}`);
    }
    throw err;
  }
}

export async function preserveDirtyWorktreeSnapshotAsync(
  wtPath,
  projectDir,
  { reason = "dirty-worktree", branchName = null, wiId = null, onMsg = null, signal = null, nativeParity = {} } = {},
) {
  try {
    const status = await gitExecAsync(["status", "--porcelain"], wtPath, nodeGitAsyncOptions({ signal }));
    const diffPatch = await gitExecAsync(["diff"], wtPath, nodeGitAsyncOptions({ signal, trim: false }));
    const stagedPatch = await gitExecAsync(["diff", "--cached"], wtPath, nodeGitAsyncOptions({ signal, trim: false }));
    const trackedDirty = [
      ...new Set(
        `${await gitExecAsync(["-c", "core.quotePath=false", "diff", "--name-only"], wtPath, nodeGitAsyncOptions({ signal }))}\n${await gitExecAsync(["-c", "core.quotePath=false", "diff", "--name-only", "--cached"], wtPath, nodeGitAsyncOptions({ signal }))}`
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    ];
    const untracked = (await gitExecAsync(["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"], wtPath, nodeGitAsyncOptions({ signal })))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const dedupHasher = createHash("sha256")
      .update(status || "")
      .update("\n---\n")
      .update(diffPatch || "")
      .update("\n---\n")
      .update(stagedPatch || "");
    updateHashWithUntrackedContents(dedupHasher, wtPath, untracked);
    const dedupHash = dedupHasher.digest("hex").slice(0, 16);
    const headSha = await gitExecAsync(["rev-parse", "HEAD"], wtPath, nodeGitAsyncOptions({ signal })).catch((err) => {
      if (isAbortError(err)) throw err;
      return null;
    });
    const repoCwd = wtPath;

    const uniqueToken = `${process.pid}-${Date.now()}-${randomToken()}`;
    const stashMessage = `posse-snapshot:${reason}:${new Date().toISOString()}:${uniqueToken}`;
    const stashLockPath = gitStashLockPath(wtPath, projectDir, { disabled: true });
    const stashLock = await acquireWorktreeLockAsync(stashLockPath, { signal });
    if (!stashLock.acquired) {
      throw new Error(`Timed out waiting for git stash lock: ${stashLockPath}`);
    }
    let stashLockReleased = false;
    try {
    try {
      await gitExecAsync(["stash", "push", "--include-untracked", "-m", stashMessage], wtPath, { signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      // Release before falling through to the sync path — that path re-acquires
      // the same lock, so we must not hold it.
      await stashLock.releaseAsync();
      stashLockReleased = true;
      return preserveDirtyWorktreeSnapshot(wtPath, projectDir, { reason, branchName, wiId, onMsg });
    }

    let stashHash = null;
    let stashRef = null;
    try {
      const entry = await findStashEntryByTokenAsync(wtPath, uniqueToken, { signal });
      stashHash = entry?.hash || null;
      stashRef = entry?.ref || null;
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (typeof onMsg === "function") {
        onMsg(`snapshot lookup failed; stash preserved for manual recovery (${stashMessage})`);
      }
      return null;
    }
    if (!stashHash || !stashRef) {
      if (typeof onMsg === "function") {
        onMsg(`snapshot lookup missed stashed entry; stash preserved for manual recovery (${stashMessage})`);
      }
      return null;
    }

    const dedupEnabled = parseBooleanSetting("snapshot_dedup", true);
    const existingDedupRef = dedupEnabled
      ? await findExistingDedupSnapshotRefNodeAsync(repoCwd, { wiId, reason, dedupHash, signal })
      : null;
    if (existingDedupRef?.refName) {
      const seenAt = new Date().toISOString();
      const existingNote = await readSnapshotNoteNodeAsync(repoCwd, existingDedupRef.objectHash, { signal });
      const existingSeenAt = Array.isArray(existingNote?.seen_at) ? existingNote.seen_at : [];
      const nextSeenCount = Number.isFinite(Number(existingNote?.seen_count))
        ? Number(existingNote.seen_count) + 1
        : 2;
      const nextNote = {
        ...(existingNote || {}),
        dedup_hash: dedupHash,
        seen_count: nextSeenCount,
        seen_at: [...existingSeenAt.slice(-19), seenAt],
      };
      await writeSnapshotNoteAsync(repoCwd, existingDedupRef.objectHash, nextNote, { signal, nativeParity });

      let restoreFailed = false;
      let restoreError = null;
      try {
        await gitExecAsync(["stash", "apply", "--index", stashHash], wtPath, { signal });
        await dropStashEntryByTokenAsync(wtPath, uniqueToken, { signal });
      } catch (applyErr) {
        if (isAbortError(applyErr)) throw applyErr;
        restoreFailed = true;
        restoreError = applyErr?.message || String(applyErr);
        try { await dropStashEntryByTokenAsync(wtPath, uniqueToken, { signal }); } catch { /* ignore */ }
        try { await gitExecAsync(["reset", "--hard", "HEAD"], wtPath, { signal }); } catch { /* worktree may be too broken to reset */ }
        const failedNote = {
          ...nextNote,
          restore_failed_count: Number.isFinite(Number(existingNote?.restore_failed_count))
            ? Number(existingNote.restore_failed_count) + 1
            : 1,
          last_restore_failure: {
            at: seenAt,
            worktree_path: wtPath,
            error: restoreError,
          },
        };
        await writeSnapshotNoteAsync(repoCwd, existingDedupRef.objectHash, failedNote, { signal, nativeParity });
        if (typeof onMsg === "function") {
          onMsg(`snapshot apply failed after dedup reuse; content preserved at ${existingDedupRef.refName} (${restoreError})`);
        }
      }
      return SnapshotRef.gitRef(existingDedupRef.refName, {
        objectHash: existingDedupRef.objectHash,
        projectDir: repoCwd,
        worktreePath: wtPath,
        metadata: { reason, wiId, branchName, dedupHash, reused: true, restoreFailed, restoreError },
      });
    }

    const refName = snapshotRefName({
      wiId,
      reason,
      dedupHash: dedupEnabled ? dedupHash : null,
    });
    try {
      await gitExecAsync(["update-ref", refName, stashHash], repoCwd, { signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (typeof onMsg === "function") {
        onMsg(`snapshot pin failed; stash preserved for manual recovery (${stashMessage})`);
      }
      return null;
    }

    await writeSnapshotNoteAsync(repoCwd, stashHash, {
      storage: "git-ref",
      ref_name: refName,
      object_hash: stashHash,
      source_worktree: wtPath,
      project_dir: projectDir,
      branch_name: branchName,
      work_item_id: wiId,
      reason,
      captured_at: new Date().toISOString(),
      head_sha: headSha,
      tracked_dirty: trackedDirty,
      untracked,
      dedup_hash: dedupHash,
      status,
      diff_patch: diffPatch,
      staged_patch: stagedPatch,
    }, { signal, nativeParity });

    let restoreFailed = false;
    let restoreError = null;
    try {
      await gitExecAsync(["stash", "apply", "--index", stashHash], wtPath, { signal });
    } catch (applyErr) {
      restoreFailed = true;
      restoreError = applyErr?.message || String(applyErr);
      await writeSnapshotNoteAsync(repoCwd, stashHash, {
        storage: "git-ref",
        ref_name: refName,
        object_hash: stashHash,
        source_worktree: wtPath,
        project_dir: projectDir,
        branch_name: branchName,
        work_item_id: wiId,
        reason,
        captured_at: new Date().toISOString(),
        head_sha: headSha,
        tracked_dirty: trackedDirty,
        untracked,
        dedup_hash: dedupHash,
        status,
        diff_patch: diffPatch,
        staged_patch: stagedPatch,
        restore_failed_count: 1,
        last_restore_failure: {
          at: new Date().toISOString(),
          worktree_path: wtPath,
          error: restoreError,
        },
      }, { signal, nativeParity });
      try { await gitExecAsync(["reset", "--hard", "HEAD"], wtPath, { signal }); } catch { /* worktree may be too broken to reset */ }
      if (typeof onMsg === "function") {
        onMsg(`snapshot restore failed after pinning ${refName}; inspect with git show ${refName} and restore with git stash apply ${refName} (${restoreError})`);
      }
    } finally {
      try { await dropStashEntryByTokenAsync(wtPath, uniqueToken, { signal }); } catch { /* ignore */ }
    }
    return SnapshotRef.gitRef(refName, {
      objectHash: stashHash,
      projectDir: repoCwd,
      worktreePath: wtPath,
      metadata: { reason, wiId, branchName, dedupHash, restoreFailed, restoreError },
    });
    } finally {
      if (!stashLockReleased) {
        await stashLock.releaseAsync();
      }
    }
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (typeof onMsg === "function") {
      onMsg(`snapshot failed for ${wtPath}: ${err?.message || String(err)}`);
    }
    throw err;
  }
}

export function preserveBranchTipSnapshot(
  projectDir,
  branchName,
  { reason = "branch-cleanup", wiId = null, onMsg = null } = {},
) {
  if (!branchName) return null;
  try {
    const branchHash = gitExec(["rev-parse", "--verify", `${branchName}^{commit}`], projectDir).trim();
    const snapshotReason = `${reason}-${safeFilename(branchName)}`;
    const dedupHash = branchHash.slice(0, 16);
    const existingDedupRef = findExistingDedupSnapshotRef(projectDir, {
      wiId,
      reason: snapshotReason,
      dedupHash,
    });
    if (existingDedupRef?.refName) {
      return SnapshotRef.gitRef(existingDedupRef.refName, {
        storageType: "branch-ref",
        objectHash: existingDedupRef.objectHash,
        projectDir,
        metadata: { reason, wiId, branchName, reused: true },
      });
    }

    const refName = snapshotRefName({ wiId, reason: snapshotReason, dedupHash });
    gitExec(["update-ref", refName, branchHash], projectDir);
    writeSnapshotNote(projectDir, branchHash, {
      storage: "branch-ref",
      ref_name: refName,
      object_hash: branchHash,
      project_dir: projectDir,
      branch_name: branchName,
      work_item_id: wiId,
      reason,
      captured_at: new Date().toISOString(),
      head_sha: branchHash,
    });
    if (typeof onMsg === "function") {
      onMsg(`preserved branch ${branchName} tip at ${refName}`);
    }
    return SnapshotRef.gitRef(refName, {
      storageType: "branch-ref",
      objectHash: branchHash,
      projectDir,
      metadata: { reason, wiId, branchName },
    });
  } catch (err) {
    if (typeof onMsg === "function") {
      onMsg(`branch tip snapshot failed for ${branchName}: ${err?.message || err}`);
    }
    return null;
  }
}

export async function preserveBranchTipSnapshotAsync(
  projectDir,
  branchName,
  { reason = "branch-cleanup", wiId = null, onMsg = null, signal = null, nativeParity = {} } = {},
) {
  if (!branchName) return null;
  try {
    const nativeRef = await runGitNativeMethodAsync(
      "git.snapshot.preserveBranchTip",
      {
        projectDir: path.resolve(projectDir),
        branchName: String(branchName || ""),
        reason,
        wiId: wiId == null ? null : String(wiId),
      },
      nativeAsyncOptions({ signal, nativeParity }),
    );
    const snapshot = snapshotRefFromNative(nativeRef, {
      metadata: { reason, wiId, branchName },
    });
    if (!snapshot) return null;
    if (typeof onMsg === "function") {
      onMsg(`preserved branch ${branchName} tip at ${snapshot.value}`);
    }
    return snapshot;
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (typeof onMsg === "function") {
      onMsg(`branch tip snapshot failed for ${branchName}: ${err?.message || err}`);
    }
    return null;
  }
}
