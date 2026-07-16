// Snapshot ref / note inventory and pruning helpers for the recovery
// workflow. Snapshots themselves are created by callers in
// worktree.js (preserveDirtyWorktreeSnapshot / preserveBranchTipSnapshot);
// this module owns the addressing scheme (refs/posse/snapshots/*),
// the parallel JSON metadata stored under refs/notes/posse-snapshots,
// the legacy directory cleanup path, and the dedupe lookups.

import fs from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { slugify } from "../../../shared/format/functions/slug.js";
import { getSetting } from "../../queue/functions/index.js";
import { getRuntimeRoot } from "../../runtime/functions/paths.js";
import { ensurePosseGitInfoExclude } from "../../runtime/functions/ignore.js";
import { isInsideRoot } from "../../runtime/functions/fs-safety.js";
import { isAbortError, throwIfAborted } from "../../runtime/functions/yield.js";
import { gitExec, gitExecAsync, gitExecBuffer, gitExecBufferAsync, isGitCommandFailure } from "./utils.js";
import {
  acquireWorktreeLock,
  acquireWorktreeLockAsync,
  gitStashLockPath,
} from "./worktree-locks.js";
import { SnapshotRef } from "../classes/index.js";
import { nativeAsyncOptions, runGitNativeMethod, runGitNativeMethodAsync } from "./native/invoke.js";

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

function readSnapshotNotesByObjectHash(projectDir, objectHashes = []) {
  const wanted = new Set((Array.isArray(objectHashes) ? objectHashes : []).filter(Boolean));
  const notesByObject = new Map();
  if (wanted.size === 0) return notesByObject;

  let notesListRaw = "";
  try {
    notesListRaw = gitExec(
      ["notes", `--ref=${SNAPSHOT_NOTES_REF}`, "list"],
      projectDir,
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
    batchOut = gitExecBuffer(["cat-file", "--batch"], projectDir, {
      input: `${noteObjects.join("\n")}\n`,
    });
  } catch {
    return notesByObject;
  }

  return parseBatchCatFileNotes(batchOut, noteObjectByTarget);
}

async function gitCatFileBatchAsync(projectDir, objectHashes = [], options = {}) {
  const input = `${objectHashes.join("\n")}\n`;
  return await gitExecBufferAsync(["cat-file", "--batch"], projectDir, {
    ...options,
    input,
    maxBuffer: 1024 * 1024 * 16,
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

export async function listSnapshotRefsAsync(projectDir, options = {}) {
  if (options?.disabled === true || options?.nativeParity?.disabled === true) {
    return await listSnapshotRefsViaGitExecAsync(projectDir, options);
  }
  try {
    return await runGitNativeMethodAsync(
      "git.snapshot.listRefs",
      { projectDir: path.resolve(projectDir) },
      nativeAsyncOptions(options),
    );
  } catch (err) {
    if (isAbortError(err)) throw err;
    return await listSnapshotRefsViaGitExecAsync(projectDir, options);
  }
}

function listSnapshotRefsViaGitExec(projectDir) {
  let raw = "";
  try {
    raw = gitExec([
      "for-each-ref",
      "--format=%(refname)|%(objectname)|%(creatordate:unix)",
      SNAPSHOT_REF_PREFIX,
    ], projectDir);
  } catch (err) {
    // Degrading to "no snapshots" on infrastructure failures (gate busy,
    // native unavailable) hides recoverable work — surface those before
    // returning empty. Genuine git failures stay silent (repo may lack refs).
    if (!isGitCommandFailure(err)) {
      console.warn(`[worktree-snapshots] snapshot ref listing degraded to empty: ${err?.message || err}`);
    }
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

async function listSnapshotRefsViaGitExecAsync(projectDir, options = {}) {
  let raw = "";
  try {
    raw = await gitExecAsync([
      "for-each-ref",
      "--format=%(refname)|%(objectname)|%(creatordate:unix)",
      SNAPSHOT_REF_PREFIX,
    ], projectDir, options);
  } catch (err) {
    if (isAbortError(err)) throw err;
    // See the sync twin: infra failures degrading to "no snapshots" must
    // leave a trace; git-said-no stays silent.
    if (!isGitCommandFailure(err)) {
      console.warn(`[worktree-snapshots] snapshot ref listing degraded to empty: ${err?.message || err}`);
    }
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
    options,
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

function readSnapshotNotePayload(projectDir, objectHash) {
  return { projectDir: path.resolve(projectDir), objectHash: String(objectHash || "") };
}

export function readSnapshotNote(projectDir, objectHash, nativeParity = {}) {
  return runGitNativeMethod("git.snapshot.readNote", readSnapshotNotePayload(projectDir, objectHash), nativeParity);
}

export async function readSnapshotNoteAsync(projectDir, objectHash, options = {}) {
  return await runGitNativeMethodAsync(
    "git.snapshot.readNote",
    readSnapshotNotePayload(projectDir, objectHash),
    nativeAsyncOptions(options),
  );
}

async function readSnapshotNoteNodeAsync(projectDir, objectHash, options = {}) {
  if (!objectHash) return null;
  try {
    const raw = await gitExecAsync(
      ["notes", `--ref=${SNAPSHOT_NOTES_REF}`, "show", objectHash],
      projectDir,
      options,
    );
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    if (isAbortError(err)) throw err;
    return null;
  }
}

// writeSnapshotNote routes via node-git while writeSnapshotNoteAsync routes
// via the native git.snapshot.writeNote method — intentionally divergent
// routing (the async lane keeps note writes on the daemon). Both persist the
// same payloads; those are built by the shared note layer above.
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

function findDedupRefPayload(projectDir, { wiId, reason, dedupHash }) {
  return {
    projectDir: path.resolve(projectDir),
    wiId: wiId == null ? null : String(wiId),
    reason,
    dedupHash: String(dedupHash || ""),
  };
}

export function findExistingDedupSnapshotRef(projectDir, { wiId = null, reason = "dirty-worktree", dedupHash = null, nativeParity = {} } = {}) {
  if (nativeParity?.disabled === true) {
    return findExistingDedupSnapshotRefNode(projectDir, { wiId, reason, dedupHash });
  }
  try {
    return runGitNativeMethod(
      "git.snapshot.findExistingDedupRef",
      findDedupRefPayload(projectDir, { wiId, reason, dedupHash }),
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
      findDedupRefPayload(projectDir, { wiId, reason, dedupHash }),
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
  const refs = listSnapshotRefsViaGitExec(projectDir);
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
  const refs = await listSnapshotRefsViaGitExecAsync(projectDir, { signal });
  const candidates = refs.filter((ref) => {
    if (!ref.refName || !ref.refName.endsWith(`-${dedupHash}`)) return false;
    return ref.refName.includes(`/${wiPart}-${reasonPart}-`);
  });
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
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
    // A fresh entry can be the only copy of work reset moments ago (a single
    // >cap fallback would otherwise be reaped by the next GC pass), so the
    // byte cap never consumes entries younger than an hour.
    const minAgeCutoffMs = Date.now() - (60 * 60 * 1000);
    for (const entry of kept) {
      if (totalBytes <= maxBytes) break;
      if (entry.mtimeMs > 0 && entry.mtimeMs > minAgeCutoffMs) continue;
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
  // Positional refs go stale if anything pushes to the shared refs/stash
  // between list and drop (a user's own `git stash` in a terminal is the
  // irreducible writer no lock covers) — never drop a slot whose commit no
  // longer matches the token's hash.
  const resolved = (() => {
    try { return gitExec(["rev-parse", entry.ref], wtPath).trim(); } catch { return null; }
  })();
  if (resolved !== entry.hash) return false;
  gitExec(["stash", "drop", entry.ref], wtPath);
  return true;
}

async function dropStashEntryByTokenAsync(wtPath, uniqueToken, options = {}) {
  const entry = await findStashEntryByTokenAsync(wtPath, uniqueToken, options);
  if (!entry?.ref) return false;
  const resolved = await gitExecAsync(["rev-parse", entry.ref], wtPath, options)
    .then((out) => String(out || "").trim())
    .catch((err) => {
      if (isAbortError(err)) throw err;
      return null;
    });
  if (resolved !== entry.hash) return false;
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

// ─── Shared note/fingerprint layer for the preserve twins ───────────────────
// The sync/async twins differ only in how git output is gathered and which
// lock primitive they hold; every payload the pair persists (dedup hash,
// stash message, notes, failure records, the directory fallback) is built
// here once so the two lanes cannot drift on preserved data.

function newSnapshotToken() {
  return `${process.pid}-${Date.now()}-${randomToken()}`;
}

function snapshotStashMessage(reason, uniqueToken) {
  return `posse-snapshot:${reason}:${new Date().toISOString()}:${uniqueToken}`;
}

function dirtyStateFingerprint({ status, diffPatch, stagedPatch }, wtPath, untracked) {
  const hasher = createHash("sha256")
    .update(status || "")
    .update("\n---\n")
    .update(diffPatch || "")
    .update("\n---\n")
    .update(stagedPatch || "");
  updateHashWithUntrackedContents(hasher, wtPath, untracked);
  return hasher.digest("hex").slice(0, 16);
}

function dedupReuseNotePayload(existingNote, dedupHash, seenAt) {
  const existingSeenAt = Array.isArray(existingNote?.seen_at) ? existingNote.seen_at : [];
  const nextSeenCount = Number.isFinite(Number(existingNote?.seen_count))
    ? Number(existingNote.seen_count) + 1
    : 2;
  return {
    ...(existingNote || {}),
    dedup_hash: dedupHash,
    seen_count: nextSeenCount,
    seen_at: [...existingSeenAt.slice(-19), seenAt],
    // Retention ages refs from captured_at (both the node and native list
    // lanes prefer it over ref creatordate). A reused ref may have just become
    // the only copy of freshly reset work, so the retention anchor must move
    // with the reuse; the original capture time survives in first_captured_at.
    first_captured_at: existingNote?.first_captured_at || existingNote?.captured_at || seenAt,
    captured_at: seenAt,
  };
}

function restoreFailureNoteFields(existingNote, at, wtPath, restoreError) {
  return {
    restore_failed_count: Number.isFinite(Number(existingNote?.restore_failed_count))
      ? Number(existingNote.restore_failed_count) + 1
      : 1,
    last_restore_failure: {
      at,
      worktree_path: wtPath,
      error: restoreError,
    },
  };
}

function snapshotNotePayload({ refName, stashHash, wtPath, projectDir, branchName, wiId, reason, headSha, trackedDirty, untracked, dedupHash, status, diffPatch, stagedPatch }) {
  return {
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
}

// Last-resort data preservation when the stash route is unavailable: write the
// captured dirty state (patches + untracked file copies) to a recovery
// directory. Both twins use this — data-preserving degradation is the
// canonical posture, not a sync-only behavior. Exported for the admin git
// adapter, which degrades the same way but supplies its own recoveryRootFn
// so the operator lane never depends on the native daemon.
export function writeLegacyFallbackSnapshot({ wtPath, projectDir, reason, branchName, wiId, onMsg, status, diffPatch, stagedPatch, trackedDirty, untracked, dedupHash, headSha, recoveryRootFn = recoveryRoot }) {
  // Tracked modifications exist in this snapshot only as the captured patches.
  // If patch capture failed and tracked dirt exists, a directory snapshot
  // would silently miss it — refuse so callers cannot treat it as preserved.
  if ((diffPatch == null || stagedPatch == null) && (trackedDirty?.length || 0) > 0) {
    if (typeof onMsg === "function") {
      onMsg(`directory fallback refused for ${wtPath}: tracked changes present but patch capture failed`);
    }
    return null;
  }
  const baseName = [wiId != null ? `wi-${wiId}` : null, safeFilename(reason), dedupHash].filter(Boolean).join("-");
  const outDir = path.join(recoveryRootFn(projectDir), baseName);
  const partDir = `${outDir}.part-${process.pid}-${Date.now()}`;
  const untrackedRel = untracked.map((relPath) => String(relPath || "").replace(/\\/g, "/")).filter(Boolean);
  // The diff/staged patches cannot carry untracked contents (the stash push
  // already failed), so the only copy lives in the worktree until the files
  // are mirrored under <snapshot>/untracked/. Never hand back a snapshot
  // ref that misses any of them — `git clean -fd` runs right after.
  const untrackedPreservedIn = (dir) => untrackedRel.every((relPath) =>
    fs.existsSync(path.join(dir, "untracked", ...relPath.split("/")))
  );
  const directoryRef = (snapshotDir = outDir, metadata = {}) => SnapshotRef.directory(snapshotDir, {
    projectDir,
    worktreePath: wtPath,
    metadata: { reason, wiId, branchName, dedupHash, headSha, ...metadata },
  });
  const untrackedCopyWarnings = [];
  try {
    if (fs.existsSync(outDir)) {
      if (untrackedPreservedIn(outDir)) {
        return directoryRef();
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
    fs.writeFileSync(path.join(partDir, "diff.patch"), diffPatch ?? "", "utf-8");
    fs.writeFileSync(path.join(partDir, "staged.patch"), stagedPatch ?? "", "utf-8");
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
  let renameError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (fs.existsSync(outDir) && untrackedPreservedIn(outDir)) {
      try { fs.rmSync(partDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return directoryRef();
    }
    try {
      fs.renameSync(partDir, outDir);
      renameError = null;
      break;
    } catch (err) {
      renameError = err;
      const retryable = process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(err?.code);
      if (!retryable || attempt === 4) break;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1)); } catch { /* best effort */ }
    }
  }
  if (renameError) {
    // The complete .part directory is the only surviving copy. Keep it with
    // its manifest for operator recovery instead of deleting preserved data.
    const partComplete = fs.existsSync(path.join(partDir, "manifest.json")) && untrackedPreservedIn(partDir);
    if (partComplete) {
      if (typeof onMsg === "function") {
        onMsg(`legacy fallback snapshot retained for recovery at ${partDir}; finalization at ${outDir} failed: ${renameError?.message || renameError}`);
      }
      return directoryRef(partDir, { finalization_failed: true, intended_path: outDir });
    }
    if (typeof onMsg === "function") {
      onMsg(`legacy fallback snapshot could not be finalized at ${outDir}; refusing to report dirty state as preserved`);
    }
    return null;
  }
  return directoryRef();
}

export const __testWriteLegacyFallbackSnapshot = writeLegacyFallbackSnapshot;

export function preserveDirtyWorktreeSnapshot(
  wtPath,
  projectDir,
  { reason = "dirty-worktree", branchName = null, wiId = null, onMsg = null } = {},
) {
  try {
    const status = gitExec(["status", "--porcelain"], wtPath);
    // --binary: without it a modified tracked binary survives only as a
    // "Binary files differ" stub that git apply cannot restore. A capture
    // failure (e.g. diff beyond the exec output cap) must not abort the
    // preserve — the stash route doesn't need the patches; only the
    // directory fallback does, and it refuses tracked dirt without them.
    let diffPatch = null;
    let stagedPatch = null;
    let patchCaptureFailed = false;
    try {
      diffPatch = gitExec(["diff", "--binary"], wtPath, { trim: false });
      stagedPatch = gitExec(["diff", "--binary", "--cached"], wtPath, { trim: false });
    } catch (captureErr) {
      patchCaptureFailed = true;
      if (typeof onMsg === "function") {
        onMsg(`snapshot patch capture failed (${captureErr?.message || String(captureErr)}); relying on stash capture`);
      }
    }
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

    // Without the patches the fingerprint would collide with a same-status
    // snapshot, so dedup is disabled for this capture.
    const dedupHash = patchCaptureFailed
      ? null
      : dirtyStateFingerprint({ status, diffPatch, stagedPatch }, wtPath, untracked);
    const headSha = (() => {
      try { return gitExec(["rev-parse", "HEAD"], wtPath).trim(); } catch { return null; }
    })();
    const fallbackState = { wtPath, projectDir, reason, branchName, wiId, onMsg, status, diffPatch, stagedPatch, trackedDirty, untracked, dedupHash, headSha };

    const uniqueToken = newSnapshotToken();
    const stashMessage = snapshotStashMessage(reason, uniqueToken);
    const repoCwd = wtPath;
    const stashLockPath = gitStashLockPath(wtPath, projectDir, { disabled: true });
    const stashLock = acquireWorktreeLock(stashLockPath);
    if (!stashLock.acquired) return writeLegacyFallbackSnapshot(fallbackState);
    try {
    try {
      gitExec(["stash", "push", "--include-untracked", "-m", stashMessage], wtPath);
    } catch {
      return writeLegacyFallbackSnapshot(fallbackState);
    }
    let stashHash = null;
    let stashRef = null;
    try {
      const entry = findStashEntryByToken(wtPath, uniqueToken);
      stashHash = entry?.hash || null;
      stashRef = entry?.ref || null;
    } catch { /* fall through to fallback */ }
    if (!stashHash || !stashRef) return writeLegacyFallbackSnapshot(fallbackState);

    const dedupEnabled = parseBooleanSetting("snapshot_dedup", true);
    const existingDedupRef = dedupEnabled && dedupHash
      ? findExistingDedupSnapshotRef(repoCwd, { wiId, reason, dedupHash })
      : null;
    if (existingDedupRef?.refName) {
      const seenAt = new Date().toISOString();
      const existingNote = readSnapshotNote(repoCwd, existingDedupRef.objectHash);
      const nextNote = dedupReuseNotePayload(existingNote, dedupHash, seenAt);
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
          ...restoreFailureNoteFields(existingNote, seenAt, wtPath, restoreError),
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

    const note = snapshotNotePayload({ refName, stashHash, wtPath, projectDir, branchName, wiId, reason, headSha, trackedDirty, untracked, dedupHash, status, diffPatch, stagedPatch });
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
        ...restoreFailureNoteFields(null, new Date().toISOString(), wtPath, restoreError),
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
    const status = await gitExecAsync(["status", "--porcelain"], wtPath, { signal });
    // --binary + capture-failure tolerance: see the sync twin for rationale.
    let diffPatch = null;
    let stagedPatch = null;
    let patchCaptureFailed = false;
    try {
      diffPatch = await gitExecAsync(["diff", "--binary"], wtPath, { signal, trim: false });
      stagedPatch = await gitExecAsync(["diff", "--binary", "--cached"], wtPath, { signal, trim: false });
    } catch (captureErr) {
      if (isAbortError(captureErr)) throw captureErr;
      patchCaptureFailed = true;
      if (typeof onMsg === "function") {
        onMsg(`snapshot patch capture failed (${captureErr?.message || String(captureErr)}); relying on stash capture`);
      }
    }
    const trackedDirty = [
      ...new Set(
        `${await gitExecAsync(["-c", "core.quotePath=false", "diff", "--name-only"], wtPath, { signal })}\n${await gitExecAsync(["-c", "core.quotePath=false", "diff", "--name-only", "--cached"], wtPath, { signal })}`
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    ];
    const untracked = (await gitExecAsync(["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"], wtPath, { signal }))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    // Without the patches the fingerprint would collide with a same-status
    // snapshot, so dedup is disabled for this capture.
    const dedupHash = patchCaptureFailed
      ? null
      : dirtyStateFingerprint({ status, diffPatch, stagedPatch }, wtPath, untracked);
    const headSha = await gitExecAsync(["rev-parse", "HEAD"], wtPath, { signal }).catch((err) => {
      if (isAbortError(err)) throw err;
      return null;
    });
    const repoCwd = wtPath;
    const fallbackState = { wtPath, projectDir, reason, branchName, wiId, onMsg, status, diffPatch, stagedPatch, trackedDirty, untracked, dedupHash, headSha };

    const uniqueToken = newSnapshotToken();
    const stashMessage = snapshotStashMessage(reason, uniqueToken);
    const stashLockPath = gitStashLockPath(wtPath, projectDir, { disabled: true });
    const stashLock = await acquireWorktreeLockAsync(stashLockPath, { signal });
    if (!stashLock.acquired) {
      // Degrade to the directory fallback like the sync twin. The fallback
      // never touches refs/stash, so it is safe to write without the lock.
      // Throwing here instead taught callers to answer with an unsnapshotted
      // reset — the one outcome this module exists to prevent.
      if (typeof onMsg === "function") {
        onMsg(`stash lock contended for ${wtPath}; writing directory fallback snapshot`);
      }
      return writeLegacyFallbackSnapshot(fallbackState);
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
        onMsg(`snapshot lookup failed; writing directory fallback (stash also preserved: ${stashMessage})`);
      }
      return writeLegacyFallbackSnapshot(fallbackState);
    }
    if (!stashHash || !stashRef) {
      if (typeof onMsg === "function") {
        onMsg(`snapshot lookup missed stashed entry; writing directory fallback (stash also preserved: ${stashMessage})`);
      }
      return writeLegacyFallbackSnapshot(fallbackState);
    }

    const dedupEnabled = parseBooleanSetting("snapshot_dedup", true);
    const existingDedupRef = dedupEnabled && dedupHash
      ? await findExistingDedupSnapshotRefNodeAsync(repoCwd, { wiId, reason, dedupHash, signal })
      : null;
    if (existingDedupRef?.refName) {
      const seenAt = new Date().toISOString();
      const existingNote = await readSnapshotNoteNodeAsync(repoCwd, existingDedupRef.objectHash, { signal });
      const nextNote = dedupReuseNotePayload(existingNote, dedupHash, seenAt);
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
          ...restoreFailureNoteFields(existingNote, seenAt, wtPath, restoreError),
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

    const note = snapshotNotePayload({ refName, stashHash, wtPath, projectDir, branchName, wiId, reason, headSha, trackedDirty, untracked, dedupHash, status, diffPatch, stagedPatch });
    await writeSnapshotNoteAsync(repoCwd, stashHash, note, { signal, nativeParity });

    let restoreFailed = false;
    let restoreError = null;
    try {
      await gitExecAsync(["stash", "apply", "--index", stashHash], wtPath, { signal });
    } catch (applyErr) {
      restoreFailed = true;
      restoreError = applyErr?.message || String(applyErr);
      const failedNote = {
        ...note,
        ...restoreFailureNoteFields(null, new Date().toISOString(), wtPath, restoreError),
      };
      await writeSnapshotNoteAsync(repoCwd, stashHash, failedNote, { signal, nativeParity });
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

// preserveBranchTipSnapshot / preserveBranchTipSnapshotAsync are intentionally
// NOT twins of one body: the sync fn builds the tip snapshot in node-git,
// while the async fn delegates the whole semantics to the native Rust method
// (git.snapshot.preserveBranchTip). Changes here must be mirrored in Rust.
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
      const capturedAt = new Date().toISOString();
      const existingNote = readSnapshotNote(projectDir, existingDedupRef.objectHash);
      const refreshedNote = {
        ...(existingNote || {}),
        storage: "branch-ref",
        ref_name: existingDedupRef.refName,
        object_hash: existingDedupRef.objectHash,
        project_dir: projectDir,
        branch_name: branchName,
        work_item_id: wiId,
        reason,
        first_captured_at: existingNote?.first_captured_at || existingNote?.captured_at || capturedAt,
        captured_at: capturedAt,
        head_sha: existingDedupRef.objectHash,
      };
      if (!writeSnapshotNote(projectDir, existingDedupRef.objectHash, refreshedNote)) return null;
      return SnapshotRef.gitRef(existingDedupRef.refName, {
        storageType: "branch-ref",
        objectHash: existingDedupRef.objectHash,
        projectDir,
        metadata: { reason, wiId, branchName, reused: true },
      });
    }

    const refName = snapshotRefName({ wiId, reason: snapshotReason, dedupHash });
    gitExec(["update-ref", refName, branchHash], projectDir);
    const noteWritten = writeSnapshotNote(projectDir, branchHash, {
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
    if (!noteWritten) return null;
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
