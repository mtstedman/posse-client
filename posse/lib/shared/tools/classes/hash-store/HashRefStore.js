import crypto from "crypto";

import {
  HASH_REF_ALIAS_PATTERN,
  HASH_REF_ENTRY_KIND_LIST_SQL,
  HASH_REF_ENTRY_KIND_SET,
  HASH_REF_OWNER_SCOPE_SET,
} from "../../../../catalog/hash-store.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../../catalog/event.js";
import { logEvent } from "../../../../domains/queue/functions/events.js";
import { HashMinter } from "./HashMinter.js";

const OWNER_TABLES = Object.freeze({
  work_item: Object.freeze({
    table: "work_item_hash_refs",
    aliasTable: "work_item_hash_ref_aliases",
    ownerColumn: "work_item_id",
    required: ["workItemId"],
  }),
  job: Object.freeze({
    table: "job_hash_refs",
    aliasTable: "job_hash_ref_aliases",
    ownerColumn: "job_id",
    required: ["workItemId", "jobId"],
  }),
  agent_run: Object.freeze({
    table: "agent_run_hash_refs",
    aliasTable: "agent_run_hash_ref_aliases",
    ownerColumn: "attempt_id",
    required: ["attemptId"],
  }),
});

const DEFAULT_MAX_MATERIALIZED_ROWS_PER_OWNER = 256;
// The legacy option name says bytes, but SQLite length() and JS String.length
// both govern this cache in characters. maxMaterializedChars is the honest
// name; maxMaterializedBytes remains accepted for existing callers.
const DEFAULT_MAX_MATERIALIZED_BYTES_PER_OWNER = 4 * 1024 * 1024;
const PINNED_PRESSURE_BUDGET_MULTIPLIER = 2;
const READY_OWNER_SCHEMAS_BY_DB = new WeakMap();

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

function lineFingerprintMap(text, chunkLines = 80) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const chunks = {};
  for (let i = 0; i < lines.length; i += chunkLines) {
    const key = `lines:${i + 1}-${Math.min(lines.length, i + chunkLines)}`;
    const body = lines.slice(i, i + chunkLines).join("\n");
    chunks[key] = sha256Hex(body);
  }
  return {
    line_count: lines.length,
    char_count: String(text || "").length,
    chunks,
  };
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
  if (payloadText != null) {
    const computed = sha256Hex(String(payloadText));
    if (/^[0-9a-f]{64}$/.test(normalized) && normalized !== computed) {
      throw new Error("materialized hash ref contentHash does not match payloadText");
    }
    return computed;
  }
  const computed = sha256Hex(stableJsonStringify({
    descriptor: descriptor ?? null,
    fingerprintMap: fingerprintMap ?? null,
  }));
  if (/^[0-9a-f]{64}$/.test(normalized)) return normalized;
  return computed;
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

function runImmediateTransaction(db, fn) {
  if (db.inTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    throw err;
  }
}

function isUniqueConstraintError(err) {
  return /UNIQUE constraint failed/i.test(String(err?.message || err || ""));
}

export class HashRefStore {
  #schemaReady = false;

  constructor({
    db,
    minter = null,
    ownerScope,
    workItemId = null,
    jobId = null,
    attemptId = null,
    agentCallId = null,
    parent = null,
    maxMaterializedRows = DEFAULT_MAX_MATERIALIZED_ROWS_PER_OWNER,
    maxMaterializedChars = null,
    maxMaterializedBytes = DEFAULT_MAX_MATERIALIZED_BYTES_PER_OWNER,
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
    this.maxMaterializedRows = Math.max(1, Number(maxMaterializedRows) || DEFAULT_MAX_MATERIALIZED_ROWS_PER_OWNER);
    const configuredCharBudget = maxMaterializedChars == null ? maxMaterializedBytes : maxMaterializedChars;
    this.maxMaterializedChars = Math.max(0, Number(configuredCharBudget) || DEFAULT_MAX_MATERIALIZED_BYTES_PER_OWNER);
    this.maxMaterializedBytes = this.maxMaterializedChars;
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
    if (this.#schemaReady) return;
    let readyTables = READY_OWNER_SCHEMAS_BY_DB.get(this.db);
    if (!readyTables) {
      readyTables = new Set();
      READY_OWNER_SCHEMAS_BY_DB.set(this.db, readyTables);
    }
    if (readyTables.has(this.config.table)) {
      this.#schemaReady = true;
      return;
    }
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

    const aliasTable = this.config.aliasTable;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${aliasTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id INTEGER ${this.ownerScope === "agent_run" ? "" : "NOT NULL"},
        job_id INTEGER ${jobRequired},
        attempt_id INTEGER ${attemptRequired},
        agent_call_id INTEGER,
        ref TEXT NOT NULL UNIQUE,
        target_ref TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (attempt_id) REFERENCES job_attempts(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_call_id) REFERENCES agent_calls(id) ON DELETE SET NULL,
        FOREIGN KEY (ref) REFERENCES hash_ref_aliases(ref) ON DELETE CASCADE,
        FOREIGN KEY (target_ref) REFERENCES hash_ref_aliases(ref) ON DELETE CASCADE
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${aliasTable}_ref ON ${aliasTable}(ref)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${aliasTable}_target ON ${aliasTable}(${this.config.ownerColumn}, target_ref)`);
    readyTables.add(this.config.table);
    this.#schemaReady = true;
  }

  surface(entry = {}) {
    this.ensureSchema();
    const preferredRef = normalizeRef(entry.ref ?? entry.refAlias ?? entry.hash ?? "");
    if (preferredRef && !HASH_REF_ALIAS_PATTERN.test(preferredRef)) {
      throw new Error(`Invalid hash ref alias: ${preferredRef}`);
    }
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
      if (preferredRef) {
        const existingRef = this._selectByRef(preferredRef);
        if (existingRef) {
          if (existingRef.content_hash !== contentHash) {
            throw new Error(`hash ref alias collision for ${preferredRef}`);
          }
          const reused = this._reuseRow(existingRef, {
            payloadText,
            sizeChars,
            metadata,
            note,
          });
          return {
            reused: true,
            rematerialized: reused.rematerialized,
            entry: this._deserializeRow(reused.row),
          };
        }
        const existingAlias = this._selectAliasByRef(preferredRef);
        if (existingAlias) {
          const target = this._selectByRef(existingAlias.target_ref);
          if (!target || target.content_hash !== contentHash) {
            throw new Error(`hash ref alias collision for ${preferredRef}`);
          }
          const reused = this._reuseRow(target, {
            payloadText,
            sizeChars,
            metadata,
            note,
          });
          return {
            reused: true,
            aliased: true,
            rematerialized: reused.rematerialized,
            entry: this._deserializeAliasRow(existingAlias, reused.row),
          };
        }
      }
      const existing = this._selectByContentHash(contentHash);
      if (existing) {
        const reused = this._reuseRow(existing, {
          payloadText,
          sizeChars,
          metadata,
          note,
        });
        if (preferredRef && preferredRef !== existing.ref) {
          const aliasRow = this._bindAlias(preferredRef, existing.ref);
          return {
            reused: true,
            aliased: true,
            rematerialized: reused.rematerialized,
            entry: this._deserializeAliasRow(aliasRow, reused.row),
          };
        }
        return {
          reused: true,
          rematerialized: reused.rematerialized,
          entry: this._deserializeRow(reused.row),
        };
      }

      let minted = null;
      let reservedPreferred = false;
      if (preferredRef) {
        if (!this.minter.refExists(preferredRef)) {
          this.minter.reserve(preferredRef);
          reservedPreferred = true;
        }
        minted = { ref: preferredRef, width: preferredRef.length - 1 };
      } else {
        minted = this.minter.mint();
      }
      try {
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
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        if (!preferredRef || reservedPreferred) this.minter.release(minted.ref);
        const raced = this._selectByContentHash(contentHash);
        if (!raced) throw err;
        const reused = this._reuseRow(raced, {
          payloadText,
          sizeChars,
          metadata,
          note,
        });
        return {
          reused: true,
          rematerialized: reused.rematerialized,
          entry: this._deserializeRow(reused.row),
        };
      }
      return {
        reused: false,
        entry: this._deserializeRow(this._selectByRef(minted.ref)),
      };
    };

    const result = runImmediateTransaction(this.db, run);
    if (entryKind === "materialized") {
      this._enforceMaterializedBudget({
        preserveRefOnTimestampTie: result.rematerialized ? result.entry?.ref : null,
      });
    }
    return {
      ...result,
      entry: this._selectDeserializedRef(result.entry?.ref),
    };
  }

  takeHash(source, opts = {}) {
    const fetchResult = source?.entry ? source : { entry: source };
    const entry = fetchResult?.entry;
    if (!entry) return { ok: false, error: "missing_hash_entry" };
    const custodyMetadata = { ...(entry.metadata || {}) };
    // Pressure reporting is owner-local state, not content provenance. A child
    // marker must never suppress the parent owner's independent watchdog.
    delete custodyMetadata.pinned_pressure_reported;
    const payload = entry.entry_kind === "materialized"
      ? {
        entryKind: "materialized",
        payloadText: entry.payload_text || "",
      }
      : {
        entryKind: "descriptor",
        descriptor: entry.descriptor,
        fingerprintMap: entry.fingerprint_map,
        recomputable: entry.recomputable === true,
        degraded: entry.degraded === true,
      };
    const surfaced = this.surface({
      ...payload,
      ref: opts.ref || entry.ref,
      contentHash: entry.content_hash,
      objectType: entry.object_type,
      source: entry.source,
      note: entry.note,
      sizeChars: entry.size_chars,
      versionId: entry.version_id,
      metadata: {
        ...custodyMetadata,
        taken_by: "hash_ref_store",
        custody_from_ref: entry.ref,
      },
    });
    return {
      ok: true,
      ...surfaced,
    };
  }

  giveHash(ref, opts = {}) {
    this.ensureSchema();
    if (!this.parent) return { ok: false, found: false, ref: normalizeRef(ref), error: "missing_parent_hash_owner" };
    const normalized = normalizeRef(ref);
    if (!normalized) return { ok: false, found: false, ref: "", error: "missing_ref" };
    const own = this._selectOwnedRef(normalized);
    if (!own?.entry) return { ok: false, found: false, ref: normalized, error: "not_owned_by_current_hash_owner" };
    const source = {
      ok: true,
      found: true,
      ref: normalized,
      entry: own.entry,
    };
    const run = () => {
      const taken = this.parent.takeHash(source, opts);
      if (!taken?.ok || !taken.entry?.ref) return taken;
      if (opts.keepLocal !== true) {
        this._deleteOwnedRef(normalized, own);
      }
      return {
        ...taken,
        given: true,
      };
    };
    return runImmediateTransaction(this.db, run);
  }

  fetch(ref, opts = {}) {
    this.ensureSchema();
    const normalized = normalizeRef(ref);
    if (!normalized) return { ok: false, found: false, ref: "", error: "missing_ref" };
    const own = this._selectByRef(normalized);
    if (own) {
      this._touchRow(own);
      return {
        ok: true,
        found: true,
        ref: normalized,
        depth: opts.depth || 0,
        entry: this._deserializeRow(own),
      };
    }
    const alias = this._selectAliasByRef(normalized);
    if (alias) {
      const target = this._selectByRef(alias.target_ref);
      if (target) {
        this._touchRow(target);
        return {
          ok: true,
          found: true,
          ref: normalized,
          depth: opts.depth || 0,
          entry: this._deserializeAliasRow(alias, target),
        };
      }
    }
    if (this.parent) {
      return this.parent.fetch(normalized, { ...opts, depth: (opts.depth || 0) + 1 });
    }
    return { ok: false, found: false, ref: normalized, error: "not_found_or_not_visible" };
  }

  _reuseRow(row, {
    payloadText = null,
    sizeChars = 0,
    metadata = null,
    note = null,
  } = {}) {
    const rematerialized = payloadText != null
      && row.entry_kind === "descriptor"
      && row.degraded === 1;
    const currentMetadata = parseJson(row.metadata_json);
    const shouldPin = metadata?.bounded_ingress === true || metadata?.bounded_ingress === 1;
    const pinChanged = shouldPin && currentMetadata?.bounded_ingress !== true && currentMetadata?.bounded_ingress !== 1;
    const nextMetadata = pinChanged
      ? { ...(currentMetadata || {}), bounded_ingress: true }
      : currentMetadata;
    const mergedNote = mergeNotes(row.note, note);
    const shouldTouch = rematerialized || row.entry_kind === "materialized" || pinChanged || mergedNote !== (row.note || null);
    if (!shouldTouch) return { row, rematerialized: false };

    this.db.prepare(`
      UPDATE ${this.config.table}
      SET entry_kind = CASE WHEN ? = 1 THEN 'materialized' ELSE entry_kind END,
          payload_text = CASE WHEN ? = 1 THEN ? ELSE payload_text END,
          size_chars = CASE WHEN ? = 1 THEN ? ELSE size_chars END,
          degraded = CASE WHEN ? = 1 THEN 0 ELSE degraded END,
          metadata_json = ?,
          note = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      rematerialized ? 1 : 0,
      rematerialized ? 1 : 0,
      rematerialized ? String(payloadText) : null,
      rematerialized ? 1 : 0,
      sizeChars,
      rematerialized ? 1 : 0,
      jsonText(nextMetadata),
      mergedNote,
      nowIso(),
      row.id,
    );
    return {
      row: this._selectByRef(row.ref),
      rematerialized,
    };
  }

  _bindAlias(ref, targetRef) {
    const normalized = normalizeRef(ref);
    const target = normalizeRef(targetRef);
    if (!HASH_REF_ALIAS_PATTERN.test(normalized)) {
      throw new Error(`Invalid hash ref alias: ${normalized}`);
    }
    if (!this.minter.refExists(normalized)) this.minter.reserve(normalized);
    const existingAlias = this._selectAliasByRef(normalized);
    if (existingAlias) {
      if (existingAlias.target_ref !== target) {
        throw new Error(`hash ref alias collision for ${normalized}`);
      }
      return existingAlias;
    }
    const existingRef = this._selectByRef(normalized);
    if (existingRef) {
      if (existingRef.ref !== target) throw new Error(`hash ref alias collision for ${normalized}`);
      return { ref: normalized, target_ref: target };
    }
    this.db.prepare(`
      INSERT INTO ${this.config.aliasTable} (
        work_item_id, job_id, attempt_id, agent_call_id,
        ref, target_ref, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.workItemId,
      this.jobId,
      this.attemptId,
      this.agentCallId,
      normalized,
      target,
      nowIso(),
      nowIso(),
    );
    return this._selectAliasByRef(normalized);
  }

  _selectOwnedRef(ref) {
    const row = this._selectByRef(ref);
    if (row) return { kind: "row", row, entry: this._deserializeRow(row) };
    const alias = this._selectAliasByRef(ref);
    if (!alias) return null;
    const target = this._selectByRef(alias.target_ref);
    if (!target) return null;
    return { kind: "alias", alias, row: target, entry: this._deserializeAliasRow(alias, target) };
  }

  _deleteOwnedRef(ref, selected) {
    const normalized = normalizeRef(ref);
    if (selected?.kind === "alias") {
      this.db.prepare(`
        DELETE FROM ${this.config.aliasTable}
        WHERE ${this.config.ownerColumn} = ? AND ref = ?
      `).run(this.ownerId, normalized);
      return;
    }
    this.db.prepare(`
      DELETE FROM ${this.config.aliasTable}
      WHERE ${this.config.ownerColumn} = ? AND target_ref = ?
    `).run(this.ownerId, normalized);
    this.db.prepare(`
      DELETE FROM ${this.config.table}
      WHERE ${this.config.ownerColumn} = ? AND ref = ?
    `).run(this.ownerId, normalized);
  }

  _touchRow(row) {
    if (!row || row.entry_kind !== "materialized") return;
    this.db.prepare(`
      UPDATE ${this.config.table}
      SET updated_at = ?
      WHERE id = ?
    `).run(nowIso(), row.id);
  }

  _enforceMaterializedBudget({ preserveRefOnTimestampTie = null } = {}) {
    const statsQuery = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(length(COALESCE(payload_text, ''))), 0) AS chars
      FROM ${this.config.table}
      WHERE ${this.config.ownerColumn} = ?
        AND entry_kind = 'materialized'
        AND COALESCE(json_extract(metadata_json, '$.bounded_ingress'), 0) != 1
    `);
    while (true) {
      const stats = statsQuery.get(this.ownerId);
      const count = Number(stats?.count || 0);
      const chars = Number(stats?.chars || 0);
      if (count <= this.maxMaterializedRows
        && (this.maxMaterializedChars <= 0 || chars <= this.maxMaterializedChars)) break;
      const row = this.db.prepare(`
        SELECT *
        FROM ${this.config.table}
        WHERE ${this.config.ownerColumn} = ?
          AND entry_kind = 'materialized'
          AND COALESCE(json_extract(metadata_json, '$.bounded_ingress'), 0) != 1
        ORDER BY updated_at ASC,
                 CASE WHEN ref = ? THEN 1 ELSE 0 END ASC,
                 id ASC
        LIMIT 1
      `).get(this.ownerId, preserveRefOnTimestampTie || "");
      if (!row) break;
      this._evictMaterializedRow(row);
    }
    this._reportPinnedPressure();
  }

  _reportPinnedPressure() {
    if (this.maxMaterializedChars <= 0) return;
    const stats = this.db.prepare(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(length(COALESCE(payload_text, ''))), 0) AS chars,
             MAX(COALESCE(json_extract(metadata_json, '$.pinned_pressure_reported'), 0)) AS reported
      FROM ${this.config.table}
      WHERE ${this.config.ownerColumn} = ?
        AND entry_kind = 'materialized'
        AND COALESCE(json_extract(metadata_json, '$.bounded_ingress'), 0) = 1
    `).get(this.ownerId);
    const pinnedChars = Number(stats?.chars || 0);
    const thresholdChars = this.maxMaterializedChars * PINNED_PRESSURE_BUDGET_MULTIPLIER;
    if (pinnedChars < thresholdChars || Number(stats?.reported || 0) === 1) return;

    const marker = this.db.prepare(`
      UPDATE ${this.config.table}
      SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.pinned_pressure_reported', 1)
      WHERE id = (
        SELECT id
        FROM ${this.config.table}
        WHERE ${this.config.ownerColumn} = ?
          AND entry_kind = 'materialized'
          AND COALESCE(json_extract(metadata_json, '$.bounded_ingress'), 0) = 1
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      )
    `).run(this.ownerId);
    if (marker.changes !== 1) return;
    try {
      logEvent({
        work_item_id: this.workItemId,
        job_id: this.jobId,
        attempt_id: this.attemptId,
        event_type: EVENT_TYPES.HASH_REF_PINNED_PRESSURE,
        actor_type: EVENT_ACTORS.SYSTEM,
        actor_id: "hash_ref_store",
        message: `Pinned hash-ref recovery payloads reached ${pinnedChars} chars`,
        event_json: {
          owner_scope: this.ownerScope,
          owner_id: this.ownerId,
          pinned_rows: Number(stats?.count || 0),
          pinned_chars: pinnedChars,
          reporting_threshold_chars: thresholdChars,
          materialized_budget_chars: this.maxMaterializedChars,
        },
      });
    } catch {
      // Cache pressure telemetry must never break hash-ref delivery.
    }
  }

  _evictMaterializedRow(row) {
    const payload = String(row.payload_text || "");
    const existingDescriptor = parseJson(row.descriptor_json);
    const descriptor = existingDescriptor || {
      kind: "evicted_materialized_hash_ref",
      ref: row.ref,
      object_type: row.object_type,
      source: row.source || null,
      evicted_at: nowIso(),
    };
    const fingerprintMap = parseJson(row.fingerprint_json) || lineFingerprintMap(payload);
    const recomputable = existingDescriptor && row.recomputable === 1 ? 1 : 0;
    this.db.prepare(`
      UPDATE ${this.config.table}
      SET entry_kind = 'descriptor',
          payload_text = NULL,
          descriptor_json = ?,
          fingerprint_json = ?,
          recomputable = ?,
          degraded = 1,
          updated_at = ?
      WHERE id = ?
    `).run(
      jsonText(descriptor),
      jsonText(fingerprintMap),
      recomputable,
      nowIso(),
      row.id,
    );
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

  _selectAliasByRef(ref) {
    const normalized = normalizeRef(ref);
    return this.db.prepare(`
      SELECT *
      FROM ${this.config.aliasTable}
      WHERE ${this.config.ownerColumn} = ? AND ref = ?
      LIMIT 1
    `).get(this.ownerId, normalized);
  }

  _selectDeserializedRef(ref) {
    const row = this._selectByRef(ref);
    if (row) return this._deserializeRow(row);
    const alias = this._selectAliasByRef(ref);
    if (!alias) return null;
    return this._deserializeAliasRow(alias, this._selectByRef(alias.target_ref));
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

  _deserializeAliasRow(aliasRow, targetRow) {
    const entry = this._deserializeRow(targetRow);
    if (!entry) return null;
    return {
      ...entry,
      ref: aliasRow.ref,
    };
  }
}

export const __testHashRefStoreInternals = Object.freeze({
  OWNER_TABLES,
  contentHashForEntry,
  lineFingerprintMap,
  normalizeRef,
  stableJsonStringify,
});
