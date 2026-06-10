import { getDb } from "../../../shared/storage/functions/index.js";
import { recordMemorySample } from "../../../shared/telemetry/functions/memory.js";
import { readRunArtifactPayload, writeRunArtifactPayload } from "../../../shared/telemetry/functions/run-telemetry.js";

let _artifactHydrateSampleCounter = 0;

function hydrateArtifactRow(row) {
  if (!row) return row;
  if (row.storage_kind !== "file_path" || (!row.file_path && !row.url)) return row;
  if (row.content_long != null || row.content_json != null) return row;
  const byteSize = Number(row.byte_size || 0);
  const shouldSampleMemory = byteSize >= 512 * 1024 || (_artifactHydrateSampleCounter++ % 50 === 0);
  if (shouldSampleMemory) {
    recordMemorySample("artifact.hydrate.before", {
      artifact_id: row.id ?? null,
      work_item_id: row.work_item_id ?? null,
      job_id: row.job_id ?? null,
      byte_size: Number.isFinite(byteSize) ? byteSize : null,
    });
  }
  const payload = readRunArtifactPayload(row.file_path);
  if (!payload) {
    return {
      ...row,
      content_missing: true,
      content_error: row.file_path
        ? `Artifact payload missing or unreadable: ${row.file_path}`
        : "Artifact payload file path missing",
    };
  }
  if (shouldSampleMemory) {
    recordMemorySample("artifact.hydrate.after", {
      artifact_id: row.id ?? null,
      work_item_id: row.work_item_id ?? null,
      job_id: row.job_id ?? null,
      byte_size: Number.isFinite(byteSize) ? byteSize : null,
    });
  }
  return {
    ...row,
    content_long: payload.content_long,
    content_json: payload.content_json,
  };
}

function hydrateArtifactRows(rows) {
  return (rows || []).map(hydrateArtifactRow);
}

export function storeArtifact({
  work_item_id = null,
  job_id = null,
  attempt_id = null,
  artifact_type,
  storage_kind = "inline",
  mime_type = null,
  file_path = null,
  url = null,
  content_long = null,
  content_json = null,
  sha256 = null,
  byte_size = null,
} = {}) {
  const db = getDb();
  let effectiveStorageKind = storage_kind;
  let effectiveFilePath = file_path;
  let effectiveContentLong = content_long;
  let effectiveContentJson = content_json && typeof content_json === "object"
    ? JSON.stringify(content_json)
    : content_json;
  let effectiveSha256 = sha256;
  let effectiveByteSize = byte_size;

  if (effectiveStorageKind === "inline" && (effectiveContentLong != null || effectiveContentJson != null)) {
    try {
      const stored = writeRunArtifactPayload({
        work_item_id,
        job_id,
        attempt_id,
        artifact_type,
        content_long: effectiveContentLong,
        content_json: effectiveContentJson,
      });
      effectiveStorageKind = "file_path";
      effectiveFilePath = stored.file_path;
      effectiveSha256 = effectiveSha256 || stored.sha256;
      effectiveByteSize = effectiveByteSize || stored.byte_size;
      effectiveContentLong = null;
      effectiveContentJson = null;
    } catch {
      // Fall back to inline DB storage if the file backend is unavailable.
    }
  }

  const info = db.prepare(`
    INSERT INTO artifacts (
      work_item_id, job_id, attempt_id, artifact_type, storage_kind,
      mime_type, file_path, url, content_long, content_json, sha256, byte_size
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    work_item_id, job_id, attempt_id, artifact_type, effectiveStorageKind,
    mime_type, effectiveFilePath, url, effectiveContentLong, effectiveContentJson, effectiveSha256, effectiveByteSize,
  );

  return hydrateArtifactRow(db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(info.lastInsertRowid));
}

export function getArtifacts(jobId, typeFilter = null) {
  const db = getDb();
  if (typeFilter) {
    return hydrateArtifactRows(db.prepare(`SELECT * FROM artifacts WHERE job_id = ? AND artifact_type = ? ORDER BY created_at`).all(jobId, typeFilter));
  }
  return hydrateArtifactRows(db.prepare(`SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at`).all(jobId));
}

export function getArtifactsByWorkItem(workItemId, typeFilter = null) {
  const db = getDb();
  if (typeFilter) {
    return hydrateArtifactRows(db.prepare(`SELECT * FROM artifacts WHERE work_item_id = ? AND artifact_type = ? ORDER BY created_at`).all(workItemId, typeFilter));
  }
  return hydrateArtifactRows(db.prepare(`SELECT * FROM artifacts WHERE work_item_id = ? ORDER BY created_at`).all(workItemId));
}

export function getArtifact(id) {
  const db = getDb();
  return hydrateArtifactRow(db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id));
}
