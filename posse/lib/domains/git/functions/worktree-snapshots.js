// Snapshot ref / note inventory and pruning helpers for the recovery
// workflow. Snapshots themselves are created by callers in
// worktree.js (preserveDirtyWorktreeSnapshot / preserveBranchTipSnapshot);
// this module owns the addressing scheme (refs/posse/snapshots/*),
// the parallel JSON metadata stored under refs/notes/posse-snapshots,
// the legacy directory cleanup path, and the dedupe lookups.

import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { slugify } from "../../../shared/format/functions/slug.js";
import { getSetting } from "../../queue/functions/index.js";
import { getRuntimeRoot } from "../../runtime/functions/paths.js";
import { ensurePosseGitInfoExclude } from "../../runtime/functions/ignore.js";
import { isInsideRoot } from "../../runtime/functions/fs-safety.js";
import { isAbortError, throwIfAborted } from "../../runtime/functions/yield.js";
import { gitExec, gitExecAsync, gitExecBuffer, gitExecBufferAsync, isGitCommandFailure } from "./utils.js";
import { SnapshotRef } from "../classes/index.js";
import { nativeAsyncOptions, runGitNativeMethod, runGitNativeMethodAsync } from "./native/invoke.js";

export const SNAPSHOT_REF_PREFIX = "refs/posse/snapshots";
export const SNAPSHOT_NOTES_REF = "refs/notes/posse-snapshots";

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

export function snapshotRefFromNative(value, { metadata = {} } = {}) {
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

// ─── Snapshot creation ──────────────────────────────────────────────

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

export function dirtySnapshotNativePayload(
  wtPath,
  projectDir,
  { reason = "dirty-worktree", branchName = null, wiId = null } = {},
) {
  const mainDir = projectDir || wtPath;
  ensurePosseGitInfoExclude(mainDir);
  return {
    wtPath: path.resolve(wtPath),
    projectDir: path.resolve(mainDir),
    runtimeRoot: getRuntimeRoot(mainDir),
    reason,
    branchName: branchName == null ? null : String(branchName),
    wiId: wiId == null ? null : String(wiId),
    dedup: parseBooleanSetting("snapshot_dedup", true),
  };
}

export function preserveDirtyWorktreeSnapshot(
  wtPath,
  projectDir,
  { reason = "dirty-worktree", branchName = null, wiId = null, onMsg = null, nativeParity = {} } = {},
) {
  try {
    const nativeRef = runGitNativeMethod(
      "git.snapshot.preserveDirty",
      dirtySnapshotNativePayload(wtPath, projectDir, { reason, branchName, wiId }),
      nativeParity,
    );
    const snapshot = snapshotRefFromNative(nativeRef, {
      metadata: { reason, wiId, branchName },
    });
    if (snapshot && typeof onMsg === "function") {
      onMsg(`preserved dirty worktree at ${snapshot.value}`);
    }
    return snapshot;
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
    const nativeRef = await runGitNativeMethodAsync(
      "git.snapshot.preserveDirty",
      dirtySnapshotNativePayload(wtPath, projectDir, { reason, branchName, wiId }),
      nativeAsyncOptions({ signal, nativeParity }),
    );
    const snapshot = snapshotRefFromNative(nativeRef, {
      metadata: { reason, wiId, branchName },
    });
    if (snapshot && typeof onMsg === "function") {
      onMsg(`preserved dirty worktree at ${snapshot.value}`);
    }
    return snapshot;
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
