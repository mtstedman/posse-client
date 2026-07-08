import crypto from "crypto";

import {
  HASH_REF_ENTRY_KIND_LIST_SQL,
  HASH_REF_ENTRY_KIND_SET,
  HASH_REF_OWNER_SCOPE_SET,
} from "../../catalog/hash-store.js";
import { HashMinter } from "./HashMinter.js";

const OWNER_TABLES = Object.freeze({
  work_item: Object.freeze({
    table: "work_item_hash_refs",
    ownerColumn: "work_item_id",
    required: ["workItemId"],
  }),
  job: Object.freeze({
    table: "job_hash_refs",
    ownerColumn: "job_id",
    required: ["workItemId", "jobId"],
  }),
  agent_run: Object.freeze({
    table: "agent_run_hash_refs",
    ownerColumn: "attempt_id",
    required: ["attemptId"],
  }),
});

function nowIso() {
  return new Date().toISOString();
}

function normalizeRef(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function stableJsonStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(",")}}`;
}

function jsonText(value) {
  if (value == null) return null;
  return JSON.stringify(value);
}

function parseJson(value) {
  if (value == null || value === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function contentHashForEntry({ payloadText, descriptor, fingerprintMap, contentHash }) {
  const normalized = String(contentHash || "").trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(normalized)) return normalized;
  if (payloadText != null) return sha256Hex(String(payloadText));
  return sha256Hex(stableJsonStringify({
    descriptor: descriptor ?? null,
    fingerprintMap: fingerprintMap ?? null,
  }));
}

function mergeNotes(existing, next) {
  const oldText = String(existing || "").trim();
  const nextText = String(next || "").trim();
  if (!nextText) return oldText || null;
  if (!oldText) return nextText;
  if (oldText === nextText || oldText.includes(nextText)) return oldText;
  if (nextText.includes(oldText)) return nextText;
  return `${oldText} | ${nextText}`.slice(0, 1000);
}

export class HashRefStore {
  constructor({
    db,
    minter = null,
    ownerScope,
    workItemId = null,
    jobId = null,
    attemptId = null,
    agentCallId = null,
    parent = null,
  } = {}) {
    if (!db) throw new Error("HashRefStore requires a db");
    const scope = String(ownerScope || "").trim();
    if (!HASH_REF_OWNER_SCOPE_SET.has(scope)) {
      throw new Error(`Unsupported hash ref owner scope: ${ownerScope}`);
    }
    const config = OWNER_TABLES[scope];
    for (const key of config.required) {
      if (this.constructor._idFromKey({ workItemId, jobId, attemptId }, key) == null) {
        throw new Error(`HashRefStore ${scope} requires ${key}`);
      }
    }
    this.db = db;
    this.minter = minter || new HashMinter({ db });
    this.ownerScope = scope;
    this.workItemId = workItemId == null ? null : Number(workItemId);
    this.jobId = jobId == null ? null : Number(jobId);
    this.attemptId = attemptId == null ? null : Number(attemptId);
    this.agentCallId = agentCallId == null ? null : Number(agentCallId);
    this.parent = parent || null;
    this.config = config;
  }

  static _idFromKey(ids, key) {
    const value = ids[key];
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  get ownerId() {
    if (this.ownerScope === "work_item") return this.workItemId;
    if (this.ownerScope === "job") return this.jobId;
    return this.attemptId;
  }

  ensureSchema() {
    this.minter.ensureSchema();
    const table = this.config.table;
    const jobRequired = this.ownerScope === "job" ? "NOT NULL" : "";
    const attemptRequired = this.ownerScope === "agent_run" ? "NOT NULL" : "";
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id INTEGER ${this.ownerScope === "agent_run" ? "" : "NOT NULL"},
        job_id INTEGER ${jobRequired},
        attempt_id INTEGER ${attemptRequired},
        agent_call_id INTEGER,
        ref TEXT NOT NULL UNIQUE,
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        object_type TEXT NOT NULL DEFAULT 'text',
        source TEXT,
        entry_kind TEXT NOT NULL DEFAULT 'materialized' CHECK (entry_kind IN (${HASH_REF_ENTRY_KIND_LIST_SQL})),
        payload_text TEXT,
        descriptor_json TEXT CHECK (descriptor_json IS NULL OR json_valid(descriptor_json)),
        fingerprint_json TEXT CHECK (fingerprint_json IS NULL OR json_valid(fingerprint_json)),
        note TEXT,
        size_chars INTEGER NOT NULL DEFAULT 0,
        version_id TEXT,
        recomputable INTEGER NOT NULL DEFAULT 0 CHECK (recomputable IN (0, 1)),
        degraded INTEGER NOT NULL DEFAULT 0 CHECK (degraded IN (0, 1)),
        metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE SET NULL,
        FOREIGN KEY (ref) REFERENCES hash_ref_aliases(ref) ON DELETE CASCADE
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_ref ON ${table}(ref)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_content ON ${table}(${this.config.ownerColumn}, content_hash)`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_owner_content_unique ON ${table}(${this.config.ownerColumn}, content_hash)`);
  }

  surface(entry = {}) {
    this.ensureSchema();
    const payloadText = entry.payloadText ?? entry.payload_text ?? entry.text ?? null;
    const descriptor = entry.descriptor ?? null;
    const fingerprintMap = entry.fingerprintMap ?? entry.fingerprint_map ?? null;
    const entryKind = String(
      entry.entryKind || entry.entry_kind || (payloadText == null ? "descriptor" : "materialized"),
    ).trim();
    if (!HASH_REF_ENTRY_KIND_SET.has(entryKind)) {
      throw new Error(`Unsupported hash ref entry kind: ${entryKind}`);
    }
    if (entryKind === "materialized" && payloadText == null) {
      throw new Error("materialized hash ref entries require payloadText");
    }
    if (entryKind === "descriptor" && descriptor == null) {
      throw new Error("descriptor hash ref entries require descriptor");
    }
    const contentHash = contentHashForEntry({ payloadText, descriptor, fingerprintMap, contentHash: entry.contentHash || entry.content_hash });
    const source = entry.source == null ? null : String(entry.source);
    const objectType = String(entry.objectType || entry.object_type || "text").trim() || "text";
    const note = entry.note == null ? null : String(entry.note).trim() || null;
    const versionId = entry.versionId ?? entry.version_id ?? null;
    const metadata = entry.metadata ?? null;
    const sizeChars = Number.isFinite(Number(entry.sizeChars ?? entry.size_chars))
      ? Math.max(0, Number(entry.sizeChars ?? entry.size_chars))
      : (payloadText == null ? 0 : String(payloadText).length);
    const recomputable = entry.recomputable === true ? 1 : 0;
    const degraded = entry.degraded === true ? 1 : 0;

    const run = () => {
      const existing = this._selectByContentHash(contentHash);
      if (existing) {
        const mergedNote = mergeNotes(existing.note, note);
        if (mergedNote !== (existing.note || null)) {
          this.db.prepare(`
            UPDATE ${this.config.table}
            SET note = ?, updated_at = ?
            WHERE id = ?
          `).run(mergedNote, nowIso(), existing.id);
        }
        return {
          reused: true,
          entry: this._deserializeRow(this._selectByRef(existing.ref)),
        };
      }

      const minted = this.minter.mint();
      this.db.prepare(`
        INSERT INTO ${this.config.table} (
          work_item_id, job_id, attempt_id, agent_call_id,
          ref, content_hash, object_type, source, entry_kind,
          payload_text, descriptor_json, fingerprint_json, note,
          size_chars, version_id, recomputable, degraded, metadata_json,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.workItemId,
        this.jobId,
        this.attemptId,
        this.agentCallId,
        minted.ref,
        contentHash,
        objectType,
        source,
        entryKind,
        payloadText == null ? null : String(payloadText),
        jsonText(descriptor),
        jsonText(fingerprintMap),
        note,
        sizeChars,
        versionId == null ? null : String(versionId),
        recomputable,
        degraded,
        jsonText(metadata),
        nowIso(),
        nowIso(),
      );
      return {
        reused: false,
        entry: this._deserializeRow(this._selectByRef(minted.ref)),
      };
    };

    return this.db.inTransaction ? run() : this.db.transaction(run)();
  }

  fetch(ref, opts = {}) {
    this.ensureSchema();
    const normalized = normalizeRef(ref);
    if (!normalized) return { ok: false, found: false, ref: "", error: "missing_ref" };
    const own = this._selectByRef(normalized);
    if (own) {
      return {
        ok: true,
        found: true,
        ref: normalized,
        owner_scope: this.ownerScope,
        owner_id: this.ownerId,
        via_parent: opts.depth > 0,
        depth: opts.depth || 0,
        entry: this._deserializeRow(own),
      };
    }
    if (this.parent) {
      return this.parent.fetch(normalized, { ...opts, depth: (opts.depth || 0) + 1 });
    }
    return { ok: false, found: false, ref: normalized, error: "not_found_or_not_visible" };
  }

  _selectByContentHash(contentHash) {
    return this.db.prepare(`
      SELECT * FROM ${this.config.table}
      WHERE ${this.config.ownerColumn} = ? AND content_hash = ?
      LIMIT 1
    `).get(this.ownerId, contentHash);
  }

  _selectByRef(ref) {
    const normalized = normalizeRef(ref);
    return this.db.prepare(`
      SELECT * FROM ${this.config.table}
      WHERE ${this.config.ownerColumn} = ? AND ref = ?
      LIMIT 1
    `).get(this.ownerId, normalized);
  }

  _deserializeRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      ref: row.ref,
      content_hash: row.content_hash,
      object_type: row.object_type,
      source: row.source || null,
      entry_kind: row.entry_kind,
      payload_text: row.payload_text,
      descriptor: parseJson(row.descriptor_json),
      fingerprint_map: parseJson(row.fingerprint_json),
      note: row.note || null,
      size_chars: row.size_chars,
      version_id: row.version_id || null,
      recomputable: row.recomputable === 1,
      degraded: row.degraded === 1,
      metadata: parseJson(row.metadata_json),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

export const __testHashRefStoreInternals = Object.freeze({
  OWNER_TABLES,
  contentHashForEntry,
  normalizeRef,
  stableJsonStringify,
});
