import crypto from "crypto";

import {
  HASH_REF_ALIAS_PATTERN,
  normalizeHashRefAlias,
} from "../../../../catalog/hash-store.js";
import { HashMinter } from "./HashMinter.js";

const TABLES = Object.freeze({
  traversal: "hash_ref_traversal_refs",
  evidence: "hash_ref_evidence_refs",
});

function nowIso() {
  return new Date().toISOString();
}

function normalizedIds(context = {}) {
  const value = (camel, snake) => {
    const parsed = Number(context[camel] ?? context[snake]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  return {
    workItemId: value("workItemId", "work_item_id"),
    jobId: value("jobId", "job_id"),
    attemptId: value("attemptId", "attempt_id"),
    agentCallId: value("agentCallId", "agent_call_id"),
  };
}

function scopeKey(ids) {
  if (ids.agentCallId) return `agent_call:${ids.agentCallId}`;
  if (ids.attemptId) return `attempt:${ids.attemptId}`;
  if (ids.jobId) return `job:${ids.jobId}`;
  if (ids.workItemId) return `work_item:${ids.workItemId}`;
  return "";
}

function json(value) {
  return value == null ? null : JSON.stringify(value);
}

function parsedJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function normalizedRef(value, label) {
  const ref = normalizeHashRefAlias(value);
  if (!HASH_REF_ALIAS_PATTERN.test(ref)) throw new Error(`Invalid ${label}: ${ref || value}`);
  return ref;
}

function deserialize(row) {
  if (!row) return null;
  return {
    ref: row.ref,
    source_ref: row.source_ref,
    scope_key: row.scope_key,
    selector: parsedJson(row.selector_json),
    work_item_id: row.work_item_id == null ? null : Number(row.work_item_id),
    job_id: row.job_id == null ? null : Number(row.job_id),
    attempt_id: row.attempt_id == null ? null : Number(row.attempt_id),
    agent_call_id: row.agent_call_id == null ? null : Number(row.agent_call_id),
    source_content_hash: row.source_content_hash || null,
    view_sha256: row.view_sha256 || null,
    view_chars: row.view_chars == null ? null : Number(row.view_chars),
    view_lines: row.view_lines == null ? null : Number(row.view_lines),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class HashRefCapabilityStore {
  constructor({ db, minter = null, context = {} } = {}) {
    if (!db) throw new Error("HashRefCapabilityStore requires a db");
    this.db = db;
    this.minter = minter || new HashMinter({ db });
    this.ids = normalizedIds(context);
    this.scopeKey = scopeKey(this.ids);
    if (!this.scopeKey) throw new Error("HashRefCapabilityStore requires a hash-ref scope");
  }

  _row(table, ref) {
    return this.db.prepare(`
      SELECT * FROM ${table}
      WHERE ref = ? AND scope_key = ?
    `).get(normalizeHashRefAlias(ref), this.scopeKey);
  }

  traversal(ref) {
    return deserialize(this._row(TABLES.traversal, ref));
  }

  evidence(ref) {
    return deserialize(this._row(TABLES.evidence, ref));
  }

  _insert(table, {
    ref,
    sourceRef,
    selector = null,
    sourceContentHash = null,
    viewText = null,
  }) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO ${table} (
        ref, scope_key, source_ref, selector_json,
        work_item_id, job_id, attempt_id, agent_call_id,
        source_content_hash, view_sha256, view_chars, view_lines,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ref, scope_key) DO UPDATE SET
        source_ref = excluded.source_ref,
        selector_json = excluded.selector_json,
        source_content_hash = COALESCE(excluded.source_content_hash, source_content_hash),
        view_sha256 = COALESCE(excluded.view_sha256, view_sha256),
        view_chars = COALESCE(excluded.view_chars, view_chars),
        view_lines = COALESCE(excluded.view_lines, view_lines),
        updated_at = excluded.updated_at
    `).run(
      ref,
      this.scopeKey,
      sourceRef,
      json(selector),
      this.ids.workItemId,
      this.ids.jobId,
      this.ids.attemptId,
      this.ids.agentCallId,
      sourceContentHash,
      viewText == null ? null : sha256(viewText),
      viewText == null ? null : String(viewText).length,
      viewText == null ? null : String(viewText).replace(/\r\n?/g, "\n").split("\n").length,
      timestamp,
      timestamp,
    );
  }

  issueTraversal({
    ref = null,
    sourceRef,
    selector = null,
    sourceContentHash = null,
  } = {}) {
    const source = normalizedRef(sourceRef, "traversal source ref");
    let publicRef = ref == null ? "" : normalizedRef(ref, "traversal ref");
    const existingEvidence = publicRef ? this.evidence(publicRef) : null;
    if (existingEvidence) publicRef = "";
    if (!publicRef) publicRef = this.minter.mint().ref;
    const existing = this.traversal(publicRef);
    if (existing && (
      existing.source_ref !== source
      || JSON.stringify(existing.selector) !== JSON.stringify(selector)
    )) {
      publicRef = this.minter.mint().ref;
    } else if (!this.minter.refExists(publicRef)) {
      this.minter.reserve(publicRef);
    }
    this._insert(TABLES.traversal, {
      ref: publicRef,
      sourceRef: source,
      selector,
      sourceContentHash,
    });
    return this.traversal(publicRef);
  }

  registerEvidence({
    ref = null,
    sourceRef,
    selector = null,
    sourceContentHash = null,
    viewText = null,
  } = {}) {
    const source = normalizedRef(sourceRef, "evidence source ref");
    let publicRef = ref == null ? "" : normalizedRef(ref, "evidence ref");
    const existing = publicRef ? this.evidence(publicRef) : null;
    if (existing && (
      existing.source_ref !== source
      || JSON.stringify(existing.selector) !== JSON.stringify(selector)
    )) {
      // A public evidence identity is immutable. If the backing view changes,
      // issue another identity instead of silently changing what an already
      // surfaced ref proves.
      publicRef = "";
    }
    if (!publicRef) publicRef = this.minter.mint().ref;
    if (!this.minter.refExists(publicRef)) this.minter.reserve(publicRef);
    const run = this.db.transaction(() => {
      this._insert(TABLES.evidence, {
        ref: publicRef,
        sourceRef: source,
        selector,
        sourceContentHash,
        viewText,
      });
      this.db.prepare(`
        DELETE FROM ${TABLES.traversal}
        WHERE ref = ? AND scope_key = ?
      `).run(publicRef, this.scopeKey);
    });
    run();
    return this.evidence(publicRef);
  }

  promoteTraversal(ref, {
    selector,
    sourceContentHash = null,
    viewText,
  } = {}) {
    const traversal = this.traversal(ref);
    if (!traversal) return null;
    return this.registerEvidence({
      ref: traversal.ref,
      sourceRef: traversal.source_ref,
      selector: selector ?? traversal.selector,
      sourceContentHash: sourceContentHash || traversal.source_content_hash,
      viewText,
    });
  }
}
