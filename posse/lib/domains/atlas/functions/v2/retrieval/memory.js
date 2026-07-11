// @ts-check
//
// Native ATLAS v2 memory handlers. These replace the original ATLAS-MCP memory
// graph with a durable ATLAS memory store while keeping public action names stable.

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { okEnvelope, errorEnvelope } from "./envelope.js";
import { sha256Hex } from "../hash.js";
import { normalizeRepoPath } from "../paths.js";
import { parseAtlasSymbolId, sanitizeAtlasSymbolIdList } from "../symbol-id.js";
import { memoryDbPathForLedgerDb } from "../runtime-paths.js";
import { getEffectivePolicy } from "./policy.js";
import { getRetrievalCache } from "../../../classes/v2/RetrievalCache.js";

// Domain is the retrieval FILTER axis: which area of concern a memory is about.
// `general` is the default catch-all bucket — NOT a wildcard. A scoped search
// whitelists its requested domains and never auto-pulls `general`, so a security
// sweep gets security memories only (no design noise, and not flooded by the
// catch-all). The four specific domains are exactly the ones where hiding them
// when out-of-domain is safe; everything broadly-relevant (infra, reliability,
// api, conventions, gotchas) stays `general`.
const MEMORY_DOMAIN_DEFAULT = "general";
const MEMORY_DOMAINS = new Set([
  "general",
  "ux",
  "schema",
  "security",
  "performance",
]);

// Lifespan is the pruning tenure axis (internal, never agent-set). A memory is
// born `ephemeral` and earns `durable` by corroboration (independent
// re-derivation, or an explicit `used` verdict). Pruning is usage-based, never
// time-based: an ephemeral memory is retired once it has been surfaced enough
// times without earning promotion; a dormant memory is never retired by age.
// String enum, future-proofed (room for a `pinned` tier later).
const MEMORY_LIFESPANS = new Set(["ephemeral", "durable"]);
const MEMORY_LIFESPAN = Object.freeze({
  default: "ephemeral",
  durable: "durable",
  surfacedRetireCount: 4,        // ephemeral + surfaced >= this w/o promotion -> pruned
  offerThrottleMs: 15 * 60_000,  // count at most one "offered" per memory per window
});

/**
 * Canonical domain tag list for a memory. Unknown values and the implicit
 * default are dropped; an empty result collapses to the catch-all bucket so a
 * memory is always either ["general"] or one+ specific domains (never both).
 * @param {unknown} values
 * @returns {string[]}
 */
function normalizeDomains(values) {
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const d = String(raw ?? "").trim().toLowerCase();
    if (d && d !== MEMORY_DOMAIN_DEFAULT && MEMORY_DOMAINS.has(d) && !out.includes(d)) {
      out.push(d);
    }
  }
  return out.length > 0 ? out : [MEMORY_DOMAIN_DEFAULT];
}

/**
 * Domain filter request (read side). Unlike the write normalizer, an empty list
 * stays empty (= no filtering, return everything), and `general` is honored only
 * when explicitly asked for — it is never an implicit default here.
 * @param {unknown} values
 * @returns {string[]}
 */
function normalizeRequestedDomains(values) {
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const d = String(raw ?? "").trim().toLowerCase();
    if (d && MEMORY_DOMAINS.has(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

const MEMORY_SCHEMA_VERSION = 1;

// Confidence is an INTERNAL-ONLY signal: it is never surfaced to agents (it is
// meaningless as a number to read). It exists to (a) order which memories
// surface first as a repo's table grows and (b) drive pruning as it drops. A
// memory therefore starts at a moderate base with headroom to rise (it is
// independently re-derived, or an agent reports it as used) and to fall (it is
// proven wrong, or — Phase 2 — the code it is anchored to changes underneath
// it). Pinning every write to 1.0 made the column dead weight; these are the
// knobs that bring it to life. Thresholds live here, not in settings, on
// purpose: this is behaviour derived from runtime state, not a user toggle.
const MEMORY_CONFIDENCE = Object.freeze({
  base: 0.6,            // unanchored write
  anchoredBonus: 0.1,   // has file/symbol anchors -> more verifiable
  max: 1,
  reviveBump: 0.1,      // automatic corroboration: independently re-derived
  usedBump: 0.15,       // explicit verdict=used
  wrongFactor: 0.4,     // proven wrong: sharp multiplicative drop
  softFactor: 0.8,      // duplicate/stale verdict: gentle drop
  driftWeight: 0.5,     // anchored code changed: erosion per drifted-anchor fraction
  floor: 0.15,          // at/below this a memory is pruned from the active set
});

// memory.get groups bodies by anchor; cap how many surface per anchor so a
// bloated table cannot dump every historical note about one file on the agent.
// Ordering (confidence + recency) decides which ones win the slots.
const MEMORY_GET_PER_ANCHOR_LIMIT = 8;

/**
 * @param {number} value
 * @returns {number}
 */
function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MEMORY_CONFIDENCE.base;
  return Math.max(0, Math.min(MEMORY_CONFIDENCE.max, Math.round(n * 1000) / 1000));
}

const MEMORY_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memory_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO memory_meta(key, value)
VALUES ('schema_version', '${MEMORY_SCHEMA_VERSION}')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

CREATE TABLE IF NOT EXISTS memories (
  memory_id       TEXT PRIMARY KEY,
  repo_id         TEXT,
  domains_json    TEXT NOT NULL DEFAULT '["general"]',
  lifespan        TEXT NOT NULL DEFAULT 'ephemeral',
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  tags_json       TEXT NOT NULL DEFAULT '[]',
  confidence      REAL NOT NULL DEFAULT 0.5,
  content_hash    TEXT NOT NULL,
  stale           INTEGER NOT NULL DEFAULT 0,
  stale_reason    TEXT,
  wrong_at        TEXT,
  wrong_count     INTEGER NOT NULL DEFAULT 0,
  offered_count   INTEGER NOT NULL DEFAULT 0,
  last_offered_at TEXT,
  deleted         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  source          TEXT NOT NULL DEFAULT 'agent'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash_active
  ON memories(repo_id, content_hash)
  WHERE deleted = 0;

-- NOTE: the lifespan index is created in upgradeMemorySchema, AFTER the column
-- is guaranteed; a legacy table lacks the lifespan column when this DDL runs.

CREATE INDEX IF NOT EXISTS idx_memories_updated
  ON memories(updated_at DESC)
  WHERE deleted = 0;

CREATE TABLE IF NOT EXISTS memory_symbol_links (
  memory_id       TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  local_id        INTEGER NOT NULL,
  PRIMARY KEY(memory_id, content_hash, local_id),
  FOREIGN KEY(memory_id) REFERENCES memories(memory_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_symbol_links_symbol
  ON memory_symbol_links(content_hash, local_id);

CREATE TABLE IF NOT EXISTS memory_file_links (
  memory_id       TEXT NOT NULL,
  repo_rel_path   TEXT NOT NULL,
  content_hash    TEXT,           -- file blob hash when the link was last reconciled; NULL until first seen
  PRIMARY KEY(memory_id, repo_rel_path),
  FOREIGN KEY(memory_id) REFERENCES memories(memory_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_file_links_path
  ON memory_file_links(repo_rel_path);
`;

/**
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").MemoryStoreParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 *   view?: import("../contracts/api.js").View | null,
 * }} args
 */
export function memoryStore({ versionId, params, ledger, repoId, view = null }) {
  // Policy gate BEFORE the DB open: openMemoryActionDb mkdirs + runs DDL, so
  // checking afterwards materialized a memory.db as a side effect of a call
  // the policy was about to refuse.
  const policy = getEffectivePolicy(ledger, effectiveRepo(repoId, params.repoId));
  if (!policy.memoryEnabled) {
    return memoryDisabled("memory.store", versionId);
  }
  const opened = openMemoryActionDb({ ledger, action: "memory.store", versionId });
  if (opened.error) return opened.error;
  const db = opened.db;
  const finish = (result) => {
    closeMemoryDb(db);
    return result;
  };

  const domains = normalizeDomains(params.domains);
  const title = cleanString(params.title, 120);
  const content = cleanString(params.content, 1200);
  if (!title || !content) {
    return finish(errorEnvelope({
      action: "memory.store",
      versionId,
      code: "invalid_memory",
      message: "memory.store requires non-empty title and content",
    }));
  }

  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  const tags = [];
  let symbolIds;
  try {
    symbolIds = sanitizeAtlasSymbolIdList(params.symbolIds || [], 100, "memory.store symbolIds");
  } catch (err) {
    return finish(errorEnvelope({
      action: "memory.store",
      versionId,
      code: "invalid_symbol_id",
      message: err?.message || String(err),
    }));
  }
  const fileRelPaths = normalizePaths(params.fileRelPaths || []);
  const hasAnchors = symbolIds.length > 0 || fileRelPaths.length > 0;
  const confidence = clampConfidence(
    MEMORY_CONFIDENCE.base + (hasAnchors ? MEMORY_CONFIDENCE.anchoredBonus : 0),
  );
  const providedId = cleanMemoryId(params.memoryId);
  // A provided id that fails validation must error — silently minting a
  // random id instead meant an explicit refresh-by-id quietly created a
  // duplicate memory rather than updating the intended one.
  if (params.memoryId != null && String(params.memoryId).trim() !== "" && !providedId) {
    return finish(errorEnvelope({
      action: "memory.store",
      versionId,
      code: "invalid_memory_id",
      message: "memory.store memoryId may only contain [A-Za-z0-9_.:-] (max 120 chars)",
    }));
  }
  const contentHash = memoryContentHash({ title, content, tags, symbolIds, fileRelPaths });
  const memoryId = providedId || `mem_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const existing = providedId ? findMemoryById(db, memoryId) : null;
  if (existing && existing.repo_id !== effectiveRepoId) {
    return finish(errorEnvelope({
      action: "memory.store",
      versionId,
      code: "memory_id_conflict",
      message: `Memory ${memoryId} already belongs to a different repository`,
    }));
  }
  const sameIdSameContent = !!(existing && existing.content_hash === contentHash);
  const existingByHash = sameIdSameContent ? null : findActiveMemoryByHash(db, effectiveRepoId, contentHash);
  const duplicateToReplace = existing && existingByHash && existingByHash.memory_id !== memoryId
    ? existingByHash.memory_id
    : null;
  if (existingByHash && existingByHash.memory_id !== memoryId) {
    if (providedId && !existing) {
      return finish(errorEnvelope({
        action: "memory.store",
        versionId,
        code: "duplicate_memory_content",
        message: `Memory content already exists as ${existingByHash.memory_id}`,
      }));
    }
    if (!providedId) {
      reviveMemory(db, existingByHash.memory_id, new Date().toISOString());
      mergeMemoryLinks(db, existingByHash.memory_id, symbolIds, fileRelPaths, viewFilePathHashes(view, fileRelPaths));
      return finish(okEnvelope({
        action: "memory.store",
        versionId,
        data: {
          ok: true,
          memoryId: existingByHash.memory_id,
          memory_id: existingByHash.memory_id,
          created: false,
          deduplicated: true,
        },
      }));
    }
  }

  // Resurrection: the exact content was written before but later pruned
  // (soft-deleted) as confidence fell. Re-deriving it now is proof it still
  // matters, so bring the original row back rather than minting a new id — the
  // active unique index is deleted=0, so the soft-deleted twin is invisible to
  // findActiveMemoryByHash and would otherwise be silently duplicated.
  if (!providedId && !existing && !existingByHash) {
    const resurrected = findDeletedMemoryByHash(db, effectiveRepoId, contentHash);
    if (resurrected) {
      reviveMemory(db, resurrected.memory_id, new Date().toISOString());
      // Re-baseline the anchors to today's view: a resurrected memory judged
      // against its pre-prune baselines would flip straight back to dead on
      // the next reconcile.
      mergeMemoryLinks(db, resurrected.memory_id, symbolIds, fileRelPaths, viewFilePathHashes(view, fileRelPaths));
      return finish(okEnvelope({
        action: "memory.store",
        versionId,
        data: {
          ok: true,
          memoryId: resurrected.memory_id,
          memory_id: resurrected.memory_id,
          created: false,
          deduplicated: true,
          resurrected: true,
        },
      }));
    }
  }

  // Exact-hash dedupe misses rewordings of the same knowledge. For
  // auto-generated ids (agent "just remember this" writes) a conservative
  // near-duplicate check folds the write into the existing memory instead of
  // accumulating parallel variants. Explicit ids are intentional updates and
  // are never redirected.
  if (!providedId && !existing) {
    const nearDuplicate = findNearDuplicateMemory(db, effectiveRepoId, title, content);
    if (nearDuplicate) {
      reviveMemory(db, nearDuplicate.memory_id, new Date().toISOString());
      // A reworded re-derivation may carry NEW valid anchors — folding the
      // write into the twin used to drop them on the floor.
      mergeMemoryLinks(db, nearDuplicate.memory_id, symbolIds, fileRelPaths, viewFilePathHashes(view, fileRelPaths));
      return finish(okEnvelope({
        action: "memory.store",
        versionId,
        data: {
          ok: true,
          memoryId: nearDuplicate.memory_id,
          memory_id: nearDuplicate.memory_id,
          created: false,
          deduplicated: true,
          nearDuplicate: true,
        },
      }));
    }
  }

  const now = new Date().toISOString();
  // Snapshot the current blob hash of each anchored file so a later edit (a
  // different hash) is detectable as drift. No view -> NULL baselines, adopted
  // without penalty on the first reconcile that does see a view.
  const fileBaselines = viewFilePathHashes(view, fileRelPaths);
  const txn = db.transaction(() => {
    if (duplicateToReplace) {
      db.prepare(
        "UPDATE memories SET deleted = 1, deleted_at = ?, updated_at = ? WHERE memory_id = ?",
      ).run(now, now, duplicateToReplace);
    }
    db.prepare(
      `INSERT INTO memories
         (memory_id, repo_id, domains_json, lifespan, title, content, tags_json, confidence,
          content_hash, stale, deleted, created_at, updated_at, deleted_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, NULL, 'agent')
       ON CONFLICT(memory_id) DO UPDATE SET
          domains_json = excluded.domains_json,
          title = excluded.title,
          content = excluded.content,
          tags_json = excluded.tags_json,
          -- Keep any confidence the memory has earned; a corrective refresh of a
          -- wrong memory already had its confidence knocked down, so max() lands
          -- back at base, while a same-content re-assert is corroboration — the
          -- exact signal the auto-id dedupe path routes through reviveMemory —
          -- so it earns the revive bump and durable tenure. Durable also makes
          -- the just-refreshed row immune to this same call's
          -- pruneSurfacedEphemeral (which would otherwise revive/kill an
          -- over-surfaced ephemeral in one store). Lifespan is never demoted.
          confidence = CASE WHEN memories.content_hash IS excluded.content_hash
                            THEN MIN(?, memories.confidence + ?)
                            ELSE MAX(memories.confidence, excluded.confidence) END,
          lifespan = CASE WHEN memories.content_hash IS excluded.content_hash
                          THEN 'durable' ELSE memories.lifespan END,
          content_hash = excluded.content_hash,
          stale = 0,
          stale_reason = NULL,
          wrong_at = NULL,
          -- wrong_count is repeat-offender HISTORY, not suppression state: a
          -- same-content re-assert clears the flag (wrong_at) but must not
          -- whitewash how often this exact claim was called wrong. A content
          -- rewrite is a new claim and starts clean.
          wrong_count = CASE WHEN memories.content_hash IS excluded.content_hash
                             THEN memories.wrong_count ELSE 0 END,
          deleted = 0,
          updated_at = excluded.updated_at,
          deleted_at = NULL,
          -- offered_count is the OLD content's surfaced history. A same-content
          -- re-assert keeps it (an explicit refresh must not wipe a memory's
          -- standing). But a corrective refresh (content_hash changed) rewrites
          -- the memory, so its surfacing budget resets to zero — otherwise the
          -- inherited retire count trips pruneSurfacedEphemeral and soft-deletes
          -- the just-written correction in this same store call, defeating the
          -- deliberate refresh-by-id recovery route.
          offered_count = CASE WHEN memories.content_hash IS NOT excluded.content_hash
                               THEN 0 ELSE memories.offered_count END,
          last_offered_at = CASE WHEN memories.content_hash IS NOT excluded.content_hash
                                 THEN NULL ELSE memories.last_offered_at END`,
    ).run(
      memoryId,
      effectiveRepoId,
      JSON.stringify(domains),
      MEMORY_LIFESPAN.default,
      title,
      content,
      JSON.stringify(tags),
      confidence,
      contentHash,
      existing?.created_at || now,
      now,
      MEMORY_CONFIDENCE.max,
      MEMORY_CONFIDENCE.reviveBump,
    );
    replaceMemoryLinks(db, memoryId, symbolIds, fileRelPaths, fileBaselines);
  });
  try {
    txn();
  } catch (err) {
    // Cross-session race: dedupe is check-then-insert, so two writers storing
    // identical new content can both miss the twin and the loser trips the
    // (repo_id, content_hash) WHERE deleted=0 unique index. That's a
    // dedupe outcome, not a failure — re-run the lookup and fold into the
    // winner exactly as the pre-check would have.
    if (String(/** @type {any} */ (err)?.code || "").startsWith("SQLITE_CONSTRAINT")) {
      const twin = findActiveMemoryByHash(db, effectiveRepoId, contentHash);
      if (twin && twin.memory_id !== memoryId) {
        reviveMemory(db, twin.memory_id, new Date().toISOString());
        return finish(okEnvelope({
          action: "memory.store",
          versionId,
          data: {
            ok: true,
            memoryId: twin.memory_id,
            memory_id: twin.memory_id,
            created: false,
            deduplicated: true,
          },
        }));
      }
    }
    return finish(errorEnvelope({
      action: "memory.store",
      versionId,
      code: "memory_store_failed",
      message: err?.message || String(err),
    }));
  }
  // Anchor-drift decay: reconcile every memory's confidence against the code it
  // points at, once per view rebuild. Runs before the cap so drift-pruned rows
  // free their slots first. Only possible with a view (the write path is
  // otherwise blind to code state).
  if (view) reconcileAnchorConfidence(db, view, effectiveRepoId, now);
  sweepStaleMemories(db, effectiveRepoId, policy);
  pruneSurfacedEphemeral(db, effectiveRepoId, now);
  enforceMemoryCap(db, effectiveRepoId, policy, now);
  getRetrievalCache().invalidateAll();

  return finish(okEnvelope({
    action: "memory.store",
    versionId,
    data: {
      ok: true,
      memoryId,
      memory_id: memoryId,
      created: !existing,
      deduplicated: false,
      ...(duplicateToReplace ? { mergedDuplicateMemoryId: duplicateToReplace } : {}),
    },
  }));
}

const MEMORY_FLAG_REASONS = new Set(["wrong", "anchors_missing", "manual", "duplicate"]);

/**
 * Evidence-based staleness: flag a memory stale WITH a reason instead of
 * deleting it. 'wrong' (assessment/work proved it wrong) also stamps
 * wrong_at and bumps wrong_count. Flagged memories stop
 * surfacing proactively but stay correctable — suppression
 * stays a deliberate GC decision.
 *
 * @param {{
 *   versionId: string,
 *   params: { repoId?: string, memoryId: string, reason: string, detail?: string },
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
function memoryFlagInternal({ versionId, params, ledger, repoId }) {
  const opened = openMemoryActionDb({ ledger, action: "memory.feedback", versionId });
  if (opened.error) return opened.error;
  const db = opened.db;
  const finish = (result) => {
    closeMemoryDb(db);
    return result;
  };
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  if (!getEffectivePolicy(ledger, effectiveRepoId).memoryEnabled) {
    return finish(memoryDisabled("memory.feedback", versionId));
  }
  const memoryId = cleanMemoryId(params.memoryId);
  if (!memoryId) {
    return finish(errorEnvelope({
      action: "memory.feedback",
      versionId,
      code: "invalid_memory_id",
      message: "memory.feedback requires memoryId",
    }));
  }
  const reason = String(params.reason || "").trim().toLowerCase();
  if (!MEMORY_FLAG_REASONS.has(reason)) {
    return finish(errorEnvelope({
      action: "memory.feedback",
      versionId,
      code: "invalid_flag_reason",
      message: `memory.feedback stale reason must be one of: ${[...MEMORY_FLAG_REASONS].join(", ")}`,
    }));
  }
  const row = findMemoryById(db, memoryId);
  if (!row || Number(row.deleted || 0) === 1 || row.repo_id !== effectiveRepoId) {
    return finish(errorEnvelope({
      action: "memory.feedback",
      versionId,
      code: "memory_not_found",
      message: `Memory ${memoryId} was not found`,
    }));
  }
  const now = new Date().toISOString();
  flagMemoryStale(db, memoryId, reason, now);
  getRetrievalCache().invalidateAll();
  const updated = findMemoryById(db, memoryId);
  return finish(okEnvelope({
    action: "memory.feedback",
    versionId,
    data: {
      ok: true,
      memoryId,
      memory_id: memoryId,
      stale: true,
      staleReason: reason,
      wrongCount: Number(updated?.wrong_count || 0),
      detail: cleanString(params.detail, 500) || undefined,
    },
  }));
}

const MEMORY_FEEDBACK_VERDICTS = new Set(["used", "stale", "wrong", "duplicate", "suppress"]);

/**
 * Deliberate suppression: soft-delete the memory so it stops surfacing AND
 * stops being queryable as active. This is the human-review GC route (the
 * agent-facing catalog advertises only the evidence verdicts); it stays
 * recoverable — re-derivation of the same content resurrects via reviveMemory.
 *
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").MemoryFeedbackParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
function memorySuppressInternal({ versionId, params, ledger, repoId }) {
  const opened = openMemoryActionDb({ ledger, action: "memory.feedback", versionId });
  if (opened.error) return opened.error;
  const db = opened.db;
  const finish = (result) => {
    closeMemoryDb(db);
    return result;
  };
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  if (!getEffectivePolicy(ledger, effectiveRepoId).memoryEnabled) {
    return finish(memoryDisabled("memory.feedback", versionId));
  }
  const memoryId = cleanMemoryId(params.memoryId);
  if (!memoryId) {
    return finish(errorEnvelope({
      action: "memory.feedback",
      versionId,
      code: "invalid_memory_id",
      message: "memory.feedback requires memoryId",
    }));
  }
  const row = findMemoryById(db, memoryId);
  if (!row || row.repo_id !== effectiveRepoId) {
    return finish(errorEnvelope({
      action: "memory.feedback",
      versionId,
      code: "memory_not_found",
      message: `Memory ${memoryId} was not found`,
    }));
  }
  const alreadyDeleted = Number(row.deleted || 0) === 1;
  if (!alreadyDeleted) {
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE memories SET deleted = 1, deleted_at = ?, updated_at = ? WHERE memory_id = ?",
    ).run(now, now, memoryId);
    getRetrievalCache().invalidateAll();
  }
  return finish(okEnvelope({
    action: "memory.feedback",
    versionId,
    data: {
      ok: true,
      memoryId,
      memory_id: memoryId,
      verdict: "suppress",
      suppressed: true,
      ...(alreadyDeleted ? { alreadyDeleted: true } : {}),
      ...(params.detail ? { detail: cleanString(params.detail, 500) } : {}),
    },
  }));
}

/**
 * First-pass memory feedback surface. Negative freshness verdicts suppress the
 * memory until it is refreshed; positive feedback resets the recency head.
 *
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").MemoryFeedbackParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
export function memoryFeedback({ versionId, params, ledger, repoId }) {
  const verdict = String(params.verdict || "").trim().toLowerCase();
  if (!MEMORY_FEEDBACK_VERDICTS.has(verdict)) {
    return errorEnvelope({
      action: "memory.feedback",
      versionId,
      code: "invalid_memory_feedback_verdict",
      message: "memory.feedback verdict must be one of: used, stale, wrong, duplicate, suppress",
    });
  }
  if (verdict === "suppress") {
    return memorySuppressInternal({ versionId, params, ledger, repoId });
  }
  if (verdict === "stale" || verdict === "wrong" || verdict === "duplicate") {
    const flagged = memoryFlagInternal({
      versionId,
      params: {
        repoId: params.repoId,
        memoryId: params.memoryId,
        reason: verdict === "wrong" ? "wrong" : verdict === "duplicate" ? "duplicate" : "manual",
        detail: params.detail,
      },
      ledger,
      repoId,
    });
    if (!flagged?.ok) return flagged;
    return okEnvelope({
      action: "memory.feedback",
      versionId,
      data: {
        ok: true,
        memoryId: flagged.data.memoryId,
        memory_id: flagged.data.memory_id,
        verdict,
        stale: true,
        staleReason: flagged.data.staleReason,
        wrongCount: flagged.data.wrongCount,
        ...(params.detail ? { detail: cleanString(params.detail, 500) } : {}),
      },
    });
  }

  const opened = openMemoryActionDb({ ledger, action: "memory.feedback", versionId });
  if (opened.error) return opened.error;
  const db = opened.db;
  const finish = (result) => {
    closeMemoryDb(db);
    return result;
  };
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  if (!getEffectivePolicy(ledger, effectiveRepoId).memoryEnabled) {
    return finish(memoryDisabled("memory.feedback", versionId));
  }
  const memoryId = cleanMemoryId(params.memoryId);
  const row = memoryId ? findMemoryById(db, memoryId) : null;
  if (!row || Number(row.deleted || 0) === 1 || row.repo_id !== effectiveRepoId) {
    return finish(errorEnvelope({
      action: "memory.feedback",
      versionId,
      code: "memory_not_found",
      message: `Memory ${memoryId || "(missing)"} was not found`,
    }));
  }
  const now = new Date().toISOString();
  if (verdict === "used") {
    // An agent reporting a memory materially informed the work is the explicit
    // positive signal: clear suppression, raise confidence toward proven, and
    // promote it to durable — being used is exactly what earns durable tenure
    // and takes it out of the usage-based prune path.
    db.prepare(
      `UPDATE memories
       SET stale = 0,
           stale_reason = NULL,
           wrong_at = NULL,
           confidence = MIN(?, confidence + ?),
           lifespan = 'durable',
           updated_at = ?
       WHERE memory_id = ?`,
    ).run(MEMORY_CONFIDENCE.max, MEMORY_CONFIDENCE.usedBump, now, memoryId);
    getRetrievalCache().invalidateAll();
  }
  return finish(okEnvelope({
    action: "memory.feedback",
    versionId,
    data: {
      ok: true,
      memoryId,
      memory_id: memoryId,
      verdict,
      recorded: verdict === "used",
      ...(params.detail ? { detail: cleanString(params.detail, 500) } : {}),
    },
  }));
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} memoryId
 * @param {string} reason
 * @param {string} now
 */
function flagMemoryStale(db, memoryId, reason, now) {
  // updated_at is deliberately NOT bumped: it drives the recency score and
  // the age sweep, and flagging a memory must not make it look fresher.
  // Confidence DOES drop, multiplicatively, so repeated negative evidence
  // compounds toward the prune floor. The row is left soft-flagged (not
  // deleted) so the deliberate refresh-by-id recovery route still works; only
  // anchor-drift reconciliation and the cap actually soft-delete.
  if (reason === "wrong") {
    db.prepare(
      `UPDATE memories
       SET stale = 1, stale_reason = ?, wrong_at = ?,
           wrong_count = wrong_count + 1,
           confidence = MAX(0, confidence * ?)
       WHERE memory_id = ?`,
    ).run(reason, now, MEMORY_CONFIDENCE.wrongFactor, memoryId);
  } else {
    db.prepare(
      `UPDATE memories
       SET stale = 1, stale_reason = ?,
           confidence = MAX(0, confidence * ?)
       WHERE memory_id = ?`,
    ).run(reason, MEMORY_CONFIDENCE.softFactor, memoryId);
  }
}

/**
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").MemorySurfaceParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 *   view?: import("../contracts/api.js").View | null,
 * }} args
 */
export function memorySurface({ versionId, params, ledger, repoId, view = null }) {
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  const policy = getEffectivePolicy(ledger, effectiveRepoId);
  if (!policy.memoryEnabled) {
    return memoryDisabled("memory.surface", versionId);
  }
  const requested = {
    symbolIds: safeSymbolIds(params.symbolIds || [], "memory.surface symbolIds"),
    fileRelPaths: normalizePaths(params.fileRelPaths || []),
  };
  if (requested.symbolIds.length === 0 && requested.fileRelPaths.length === 0) {
    return okEnvelope({
      action: "memory.surface",
      versionId,
      data: { symbols: [], files: [] },
    });
  }
  const opened = openMemoryReadDb({ ledger, action: "memory.surface", versionId });
  if (opened.error) return opened.error;
  if (opened.missing) {
    return okEnvelope({ action: "memory.surface", versionId, data: { symbols: [], files: [] } });
  }
  const db = opened.db;
  const finish = (result) => {
    closeMemoryDb(db);
    return result;
  };
  try {
    const rows = candidateRows(db, effectiveRepoId, { includeDeleted: false, policy });
    const links = fetchMemoryLinks(db, rows.map((row) => row.memory_id));
    let filtered = filterRows(rows, params, links, { anchorMode: "any", excludeStale: true, policy });
    filtered = applyAnchorEvidence(view, filtered, links);
    const presence = memoryAnchorPresence(filtered, links, requested);
    return finish(okEnvelope({
      action: "memory.surface",
      versionId,
      data: presence,
    }));
  } catch (err) {
    return finish(errorEnvelope({
      action: "memory.surface",
      versionId,
      code: "memory_surface_failed",
      message: err?.message || String(err),
    }));
  }
}

/**
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").MemoryGetParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 *   view?: import("../contracts/api.js").View | null,
 * }} args
 */
export function memoryGet({ versionId, params, ledger, repoId, view = null }) {
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  const policy = getEffectivePolicy(ledger, effectiveRepoId);
  if (!policy.memoryEnabled) {
    return memoryDisabled("memory.get", versionId);
  }
  const requested = {
    symbolIds: safeSymbolIds(params.symbolIds || [], "memory.get symbolIds"),
    fileRelPaths: normalizePaths(params.fileRelPaths || []),
  };
  if (requested.symbolIds.length === 0 && requested.fileRelPaths.length === 0) {
    return okEnvelope({
      action: "memory.get",
      versionId,
      data: { symbols: {}, files: {} },
    });
  }
  const opened = openMemoryReadDb({ ledger, action: "memory.get", versionId });
  if (opened.error) return opened.error;
  if (opened.missing) {
    return okEnvelope({ action: "memory.get", versionId, data: { symbols: {}, files: {} } });
  }
  const db = opened.db;
  const finish = (result) => {
    closeMemoryDb(db);
    return result;
  };
  try {
    const rows = candidateRows(db, effectiveRepoId, { includeDeleted: false, policy });
    const links = fetchMemoryLinks(db, rows.map((row) => row.memory_id));
    let filtered = filterRows(rows, params, links, { anchorMode: "any", excludeStale: true, policy });
    filtered = applyAnchorEvidence(view, filtered, links);
    const data = memoryContentByAnchor(filtered, links, requested);
    // Pulling a memory body IS the "surfaced" event that the usage-based prune
    // counts. Record it after the read connection closes (best-effort, throttled,
    // its own RW connection) so a write hiccup never fails the get.
    const result = finish(okEnvelope({ action: "memory.get", versionId, data }));
    recordMemoriesOffered(ledger, collectOfferedMemoryIds(data));
    return result;
  } catch (err) {
    return finish(errorEnvelope({
      action: "memory.get",
      versionId,
      code: "memory_get_failed",
      message: err?.message || String(err),
    }));
  }
}

function ledgerDbPathFromHandle(ledger) {
  return typeof /** @type {any} */ (ledger)?._dbPath === "function"
    ? /** @type {any} */ (ledger)._dbPath()
    : "";
}

function memoryDbPathForLedger(ledger) {
  const ledgerPath = ledgerDbPathFromHandle(ledger);
  return memoryDbPathForLedgerDb(ledgerPath);
}

function openMemoryDbForLedger(ledger) {
  const dbPath = memoryDbPathForLedger(ledger);
  if (!dbPath) return null;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  db.exec(MEMORY_DDL);
  upgradeMemorySchema(db);
  db.pragma("foreign_keys = ON");
  return db;
}

function openMemoryReadDbForLedger(ledger) {
  const dbPath = memoryDbPathForLedger(ledger);
  if (!dbPath) return { db: null, missing: false };
  if (!fs.existsSync(dbPath)) return { db: null, missing: true };
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    return { db, missing: false };
  } catch {
    return { db: null, missing: true };
  }
}

function closeMemoryDb(db) {
  try { db?.close?.(); } catch { /* ignore */ }
}

function openMemoryActionDb({ ledger, action, versionId }) {
  const db = openMemoryDbForLedger(ledger);
  if (!db) {
    return {
      error: errorEnvelope({
        action: /** @type {any} */ (action),
        versionId,
        code: "memory_store_unavailable",
        message: "ATLAS memory requires an ATLAS repository context",
      }),
      db: null,
    };
  }
  return { db, error: null };
}

function openMemoryReadDb({ ledger, action, versionId }) {
  const opened = openMemoryReadDbForLedger(ledger);
  if (opened.db || opened.missing) return { db: opened.db, missing: opened.missing, error: null };
  return {
    db: null,
    missing: false,
    error: errorEnvelope({
      action: /** @type {any} */ (action),
      versionId,
      code: "memory_store_unavailable",
      message: "ATLAS memory requires an ATLAS repository context",
    }),
  };
}

function upgradeMemorySchema(db) {
  const columns = new Set(
    db.prepare("PRAGMA table_info(memories)").all().map((row) => String(row.name || "")),
  );
  if (!columns.has("wrong_at")) {
    db.prepare("ALTER TABLE memories ADD COLUMN wrong_at TEXT").run();
  }
  if (!columns.has("wrong_count")) {
    db.prepare("ALTER TABLE memories ADD COLUMN wrong_count INTEGER NOT NULL DEFAULT 0").run();
  }
  // Domain (filter) + lifespan (pruning tenure) replace the dead `type` enum.
  // Add the new columns (ALTER-ADD backfills existing rows to the defaults:
  // domains=["general"], lifespan='ephemeral'), then retire `type`. Its partial
  // index references the column, so drop the index before the column.
  if (!columns.has("domains_json")) {
    db.prepare("ALTER TABLE memories ADD COLUMN domains_json TEXT NOT NULL DEFAULT '[\"general\"]'").run();
  }
  if (!columns.has("lifespan")) {
    db.prepare("ALTER TABLE memories ADD COLUMN lifespan TEXT NOT NULL DEFAULT 'ephemeral'").run();
  }
  if (!columns.has("offered_count")) {
    db.prepare("ALTER TABLE memories ADD COLUMN offered_count INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!columns.has("last_offered_at")) {
    db.prepare("ALTER TABLE memories ADD COLUMN last_offered_at TEXT").run();
  }
  if (columns.has("type")) {
    db.prepare("DROP INDEX IF EXISTS idx_memories_repo_type_updated").run();
    try {
      db.prepare("ALTER TABLE memories DROP COLUMN type").run();
    } catch {
      // Older SQLite without DROP COLUMN: leave the dormant column in place. It
      // is no longer read or written; new inserts never name it.
    }
  }
  // Created here (not in the DDL) so it lands only after `lifespan` exists — a
  // legacy table acquires the column above, a fresh table already has it.
  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_memories_repo_lifespan_updated
       ON memories(repo_id, lifespan, updated_at DESC)
       WHERE deleted = 0`,
  ).run();
  const fileLinkColumns = new Set(
    db.prepare("PRAGMA table_info(memory_file_links)").all().map((row) => String(row.name || "")),
  );
  if (!fileLinkColumns.has("content_hash")) {
    // Existing file links predate anchor-drift tracking; NULL baseline means
    // "not yet seen", and the first reconcile adopts the current hash without
    // penalty rather than retroactively condemning old memories.
    db.prepare("ALTER TABLE memory_file_links ADD COLUMN content_hash TEXT").run();
  }
}

function memoryDisabled(action, versionId) {
  return errorEnvelope({
    action: /** @type {any} */ (action),
    versionId,
    code: "memory_disabled",
    message: "Native ATLAS v2 memory is disabled by policy",
  });
}

function effectiveRepo(ctxRepoId, paramRepoId) {
  return cleanString(paramRepoId || ctxRepoId || "default", 200) || "default";
}

function cleanString(value, maxLen) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function cleanMemoryId(value) {
  const text = cleanString(value, 120);
  if (!text) return "";
  return /^[A-Za-z0-9_.:-]+$/.test(text) ? text : "";
}

function normalizePaths(values) {
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const p = normalizeRepoPath(String(raw || ""));
    if (!p || out.includes(p)) continue;
    out.push(p);
    if (out.length >= 100) break;
  }
  return out;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// Identity hash. Domain/lifespan are mutable policy (filter + tenure), not
// identity, so the same knowledge re-derived with different domain tags still
// dedupes. `type` was dropped from the model, so it is gone from the hash too.
function memoryContentHash({ title, content, tags, symbolIds, fileRelPaths }) {
  return sha256Hex(JSON.stringify({
    title,
    content,
    tags: [...tags].sort(),
    symbolIds: [...symbolIds].sort(),
    fileRelPaths: [...fileRelPaths].sort(),
  }));
}

function findActiveMemoryByHash(db, repoId, contentHash) {
  return db.prepare(
    "SELECT * FROM memories WHERE repo_id = ? AND content_hash = ? AND deleted = 0 LIMIT 1",
  ).get(repoId, contentHash);
}

// Most-recently pruned soft-deleted twin for a content hash. Drives
// resurrection: re-deriving pruned content revives the original row.
function findDeletedMemoryByHash(db, repoId, contentHash) {
  return db.prepare(
    `SELECT * FROM memories
     WHERE repo_id = ? AND content_hash = ? AND deleted = 1
     ORDER BY deleted_at DESC
     LIMIT 1`,
  ).get(repoId, contentHash);
}

function findMemoryById(db, memoryId) {
  return db.prepare("SELECT * FROM memories WHERE memory_id = ? LIMIT 1").get(memoryId);
}

// High bar on purpose: only near-verbatim rewordings fold into an existing
// memory. Distinct lessons that merely share vocabulary must stay separate.
const NEAR_DUPLICATE_JACCARD = 0.9;

function findNearDuplicateMemory(db, repoId, title, content) {
  const target = new Set(tokenize(`${title}\n${content}`));
  if (target.size === 0) return null;
  const rows = db.prepare(
    `SELECT memory_id, title, content FROM memories
     WHERE repo_id = ? AND deleted = 0
     ORDER BY updated_at DESC
     LIMIT 200`,
  ).all(repoId);
  for (const row of rows) {
    const candidate = new Set(tokenize(`${row.title || ""}\n${row.content || ""}`));
    if (jaccardSimilarity(target, candidate) >= NEAR_DUPLICATE_JACCARD) return row;
  }
  return null;
}

function jaccardSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Usage-based ephemeral prune (NOT time-based): an ephemeral memory that has
 * been surfaced to agents enough times without earning promotion to durable has
 * had its chance and is dead weight, so soft-delete it. Because corroboration
 * promotes to durable, `ephemeral` already implies `uncorroborated` — the rule
 * is simply ephemeral AND offered_count >= K. A dormant memory (never surfaced)
 * is never touched, no matter how old. Soft-delete is recoverable: re-derivation
 * resurrects and promotes it.
 */
function pruneSurfacedEphemeral(db, repoId, now) {
  try {
    db.prepare(
      `UPDATE memories
       SET deleted = 1, deleted_at = ?, updated_at = ?
       WHERE repo_id = ? AND deleted = 0
         AND lifespan = 'ephemeral' AND offered_count >= ?`,
    ).run(now, now, repoId, MEMORY_LIFESPAN.surfacedRetireCount);
  } catch {
    // Pruning is best-effort; never fail a write because the sweep could not run.
  }
}

/**
 * Keep each repo's active memory count under policy.memoryMaxPerRepo by
 * soft-deleting the least valuable rows. Order: stale first, then ephemeral
 * (transient) over durable, then the more-surfaced-yet-still-ephemeral (clearer
 * noise), then lowest confidence, then oldest. The just-written memory has the
 * newest updated_at, so it is only evicted if everything else outranks it.
 */
function enforceMemoryCap(db, repoId, policy, now) {
  const cap = clampInt(policy?.memoryMaxPerRepo, 0, 100_000, 0);
  if (cap <= 0) return;
  const count = db.prepare(
    "SELECT COUNT(*) AS c FROM memories WHERE repo_id = ? AND deleted = 0",
  ).get(repoId)?.c || 0;
  if (count <= cap) return;
  const victims = db.prepare(
    `SELECT memory_id FROM memories
     WHERE repo_id = ? AND deleted = 0
     ORDER BY stale DESC,
              (lifespan = 'ephemeral') DESC,
              -- more-surfaced-yet-still-ephemeral = clearer noise; but for
              -- DURABLE rows high offered_count means most-consulted, so the
              -- term must not apply there or the cap evicts the most useful
              -- durable memories first.
              CASE WHEN lifespan = 'ephemeral' THEN offered_count ELSE 0 END DESC,
              confidence ASC,
              updated_at ASC
     LIMIT ?`,
  ).all(repoId, count - cap);
  const evict = db.prepare(
    "UPDATE memories SET deleted = 1, deleted_at = ?, updated_at = ? WHERE memory_id = ?",
  );
  for (const victim of victims) evict.run(now, now, victim.memory_id);
}

function reviveMemory(db, memoryId, now) {
  // Independent re-derivation is the strongest automatic signal a memory is
  // still true: clear any suppression, bump confidence toward corroborated,
  // promote it to durable (corroboration is exactly what earns durable tenure),
  // and resurrect it if a prior prune had soft-deleted it. Resurrection IS the
  // recovery route that keeps usage-driven pruning from being a one-way door —
  // a wrongly-dropped fact comes back the moment it is rediscovered.
  db.prepare(
    `UPDATE memories
     SET stale = 0,
         stale_reason = NULL,
         wrong_at = NULL,
         -- wrong_count deliberately survives revival: it is repeat-offender
         -- history, and zeroing it made negative feedback free to whitewash
         -- by re-storing the same content.
         confidence = MIN(?, confidence + ?),
         lifespan = 'durable',
         deleted = 0,
         deleted_at = NULL,
         updated_at = ?
     WHERE memory_id = ?`,
  ).run(MEMORY_CONFIDENCE.max, MEMORY_CONFIDENCE.reviveBump, now, memoryId);
  getRetrievalCache().invalidateAll();
}

/**
 * Additive link merge for the revive/dedupe paths: keeps the twin's existing
 * anchors, adds the fresh write's, and re-baselines file links to the current
 * view so revived memories are judged against today's code, not the state
 * that got them pruned.
 */
function mergeMemoryLinks(db, memoryId, symbolIds, fileRelPaths, fileBaselines = new Map()) {
  const symIns = db.prepare(
    "INSERT OR IGNORE INTO memory_symbol_links(memory_id, content_hash, local_id) VALUES(?, ?, ?)",
  );
  for (const symbolId of symbolIds || []) {
    const parsed = parseAtlasSymbolId(symbolId);
    if (!parsed) continue;
    symIns.run(memoryId, parsed.content_hash, parsed.local_id);
  }
  const fileIns = db.prepare(
    "INSERT OR IGNORE INTO memory_file_links(memory_id, repo_rel_path, content_hash) VALUES(?, ?, ?)",
  );
  const fileUpd = db.prepare(
    "UPDATE memory_file_links SET content_hash = ? WHERE memory_id = ? AND repo_rel_path = ?",
  );
  for (const repoRelPath of fileRelPaths || []) {
    const baseline = fileBaselines.get(repoRelPath) ?? null;
    fileIns.run(memoryId, repoRelPath, baseline);
    if (baseline) fileUpd.run(baseline, memoryId, repoRelPath);
  }
}

function replaceMemoryLinks(db, memoryId, symbolIds, fileRelPaths, fileBaselines = new Map()) {
  db.prepare("DELETE FROM memory_symbol_links WHERE memory_id = ?").run(memoryId);
  db.prepare("DELETE FROM memory_file_links WHERE memory_id = ?").run(memoryId);
  const symIns = db.prepare(
    "INSERT OR IGNORE INTO memory_symbol_links(memory_id, content_hash, local_id) VALUES(?, ?, ?)",
  );
  for (const symbolId of symbolIds) {
    const parsed = parseAtlasSymbolId(symbolId);
    if (!parsed) continue;
    symIns.run(memoryId, parsed.content_hash, parsed.local_id);
  }
  const fileIns = db.prepare(
    "INSERT OR IGNORE INTO memory_file_links(memory_id, repo_rel_path, content_hash) VALUES(?, ?, ?)",
  );
  for (const repoRelPath of fileRelPaths) {
    fileIns.run(memoryId, repoRelPath, fileBaselines.get(repoRelPath) ?? null);
  }
}

/**
 * Current blob hash for each anchored file, read from the view's path_to_blob.
 * The baseline that anchor-drift reconciliation later compares against. Returns
 * an empty map when there is no view (baselines stay NULL until first reconcile).
 *
 * @param {import("../contracts/api.js").View | null | undefined} view
 * @param {string[]} fileRelPaths
 * @returns {Map<string, string>}
 */
function viewFilePathHashes(view, fileRelPaths) {
  const out = new Map();
  if (typeof view?.query?.contentHashForPath !== "function" || fileRelPaths.length === 0) return out;
  try {
    for (const repoRelPath of fileRelPaths) {
      const hash = view.query.contentHashForPath(repoRelPath);
      if (hash) out.set(repoRelPath, String(hash));
    }
  } catch {
    return out; // baseline capture is best-effort
  }
  return out;
}

/** Memory ids actually returned (surfaced) by a memory.get response. */
function collectOfferedMemoryIds(data) {
  const ids = new Set();
  for (const group of [data?.symbols, data?.files]) {
    if (!group || typeof group !== "object") continue;
    for (const list of Object.values(group)) {
      for (const memory of Array.isArray(list) ? list : []) {
        if (memory?.memoryId) ids.add(memory.memoryId);
      }
    }
  }
  return [...ids];
}

/**
 * Record that memories were surfaced to an agent (the signal the usage-based
 * prune counts). Opens its own brief read-write connection so the read path
 * stays read-only, throttles to at most one count per memory per window, and is
 * fully best-effort — a failure here must never affect the get it accompanies.
 */
function recordMemoriesOffered(ledger, memoryIds) {
  if (!Array.isArray(memoryIds) || memoryIds.length === 0) return;
  let db = null;
  try {
    db = openMemoryDbForLedger(ledger);
    if (!db) return;
    const now = new Date().toISOString();
    const throttleCutoff = new Date(Date.now() - MEMORY_LIFESPAN.offerThrottleMs).toISOString();
    const stmt = db.prepare(
      `UPDATE memories
       SET offered_count = offered_count + 1, last_offered_at = ?
       WHERE memory_id = ? AND deleted = 0
         AND (last_offered_at IS NULL OR last_offered_at < ?)`,
    );
    db.transaction(() => {
      for (const id of memoryIds) stmt.run(now, id, throttleCutoff);
    })();
  } catch {
    // Best-effort surfacing accounting; never break a read.
  } finally {
    try { db?.close?.(); } catch { /* ignore */ }
  }
}

function candidateRows(db, repoId, { includeDeleted = false, policy = null } = {}) {
  const deletedSql = includeDeleted ? "" : "AND deleted = 0";
  // The scan bound follows the effective cap: with the default 5000-row cap,
  // 5000 covers every active row, but a raised cap (or memoryMaxPerRepo=0 =
  // uncapped) must not leave older active rows silently unreachable by
  // get/surface. Uncapped repos get a hard ceiling instead of an unbounded
  // scan.
  const cap = clampInt(/** @type {any} */ (policy)?.memoryMaxPerRepo, 0, 100_000, 0);
  const scanLimit = cap > 0 ? Math.max(cap, 5000) : 50_000;
  return db.prepare(
    `SELECT * FROM memories
     WHERE repo_id = ? ${deletedSql}
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).all(repoId, scanLimit);
}

/**
 * Batch-fetch symbol/file links for a set of memories in chunked IN queries so
 * filtering and hydration never issue per-row lookups.
 */
function fetchMemoryLinks(db, memoryIds) {
  const symbolsById = new Map();
  const filesById = new Map();
  const unique = [...new Set(memoryIds)];
  for (let start = 0; start < unique.length; start += 400) {
    const chunk = unique.slice(start, start + 400);
    const placeholders = chunk.map(() => "?").join(", ");
    const symbolRows = db.prepare(
      `SELECT memory_id, content_hash, local_id FROM memory_symbol_links
       WHERE memory_id IN (${placeholders})
       ORDER BY content_hash, local_id`,
    ).all(...chunk);
    for (const row of symbolRows) {
      if (!symbolsById.has(row.memory_id)) symbolsById.set(row.memory_id, []);
      symbolsById.get(row.memory_id).push(`${row.content_hash}:${row.local_id}`);
    }
    const fileRows = db.prepare(
      `SELECT memory_id, repo_rel_path FROM memory_file_links
       WHERE memory_id IN (${placeholders})
       ORDER BY repo_rel_path`,
    ).all(...chunk);
    for (const row of fileRows) {
      if (!filesById.has(row.memory_id)) filesById.set(row.memory_id, []);
      filesById.get(row.memory_id).push(row.repo_rel_path);
    }
  }
  return { symbolsById, filesById };
}

// Domains a memory carries, parsed from domains_json. Legacy/empty rows read as
// the catch-all bucket.
function memoryRowDomains(row) {
  try {
    const parsed = JSON.parse(String(row?.domains_json || "[]"));
    const out = Array.isArray(parsed) ? parsed.map((d) => String(d || "").toLowerCase()).filter(Boolean) : [];
    return out.length > 0 ? out : [MEMORY_DOMAIN_DEFAULT];
  } catch {
    return [MEMORY_DOMAIN_DEFAULT];
  }
}

function filterRows(rows, params = {}, links, { anchorMode = "all", excludeStale = false, policy = null } = {}) {
  const symbols = safeSymbolIds(params.symbolIds || []);
  const files = normalizePaths(params.fileRelPaths || []);
  // Domain filter is a strict whitelist: a scoped request returns only memories
  // tagged with one of the requested domains. `general` is its own bucket, not a
  // wildcard, so it is excluded unless explicitly requested. No request = no
  // domain filtering (the normal anchor-only path).
  const requestedDomains = normalizeRequestedDomains(params.domains);
  return rows.filter((row) => {
    if (excludeStale && memoryIsStaleForRead(row, policy)) return false;
    if (requestedDomains.length > 0) {
      const rowDomains = memoryRowDomains(row);
      if (!rowDomains.some((d) => requestedDomains.includes(d))) return false;
    }
    const linkedSymbols = links.symbolsById.get(row.memory_id) || [];
    const linkedFiles = links.filesById.get(row.memory_id) || [];
    const symbolHit = symbols.length > 0 && symbols.some((s) => linkedSymbols.includes(s));
    const fileHit = files.length > 0 && linkedFiles.some((f) => files.includes(f));
    if (anchorMode === "any") {
      // Proactive surfacing: any provided anchor (symbol OR file) qualifies.
      if ((symbols.length > 0 || files.length > 0) && !symbolHit && !fileHit) return false;
    } else {
      if (symbols.length > 0 && !symbolHit) return false;
      if (files.length > 0 && !fileHit) return false;
    }
    return true;
  });
}

function memoryIsStaleForRead(row, policy) {
  if (Number(row.stale || 0) === 1) return true;
  const days = clampInt(policy?.memoryStaleAfterDays, 0, 3650, 0);
  if (days <= 0) return false;
  const updatedAt = Date.parse(String(row.updated_at || ""));
  if (!Number.isFinite(updatedAt)) return false;
  return updatedAt < Date.now() - days * 86_400_000;
}

function safeSymbolIds(values, label = "memory symbolIds") {
  try {
    return sanitizeAtlasSymbolIdList(values, 500, label);
  } catch {
    return [];
  }
}

function memoryAnchorPresence(rows, links, params = {}) {
  const requestedSymbols = safeSymbolIds(params.symbolIds || [], "memory.surface symbolIds");
  const requestedFiles = normalizePaths(params.fileRelPaths || []);
  const symbols = new Set();
  const files = new Set();
  for (const row of rows) {
    const linkedSymbols = links.symbolsById.get(row.memory_id) || [];
    const linkedFiles = activeMemoryFileLinks(row, links);
    for (const symbolId of requestedSymbols) {
      if (linkedSymbols.includes(symbolId)) symbols.add(symbolId);
    }
    for (const fileRelPath of requestedFiles) {
      if (linkedFiles.includes(fileRelPath)) files.add(fileRelPath);
    }
  }
  return {
    symbols: requestedSymbols.filter((symbolId) => symbols.has(symbolId)),
    files: requestedFiles.filter((fileRelPath) => files.has(fileRelPath)),
  };
}

function memoryContentByAnchor(rows, links, params = {}) {
  const requestedSymbols = safeSymbolIds(params.symbolIds || [], "memory.get symbolIds");
  const requestedFiles = normalizePaths(params.fileRelPaths || []);
  const symbols = Object.fromEntries(requestedSymbols.map((symbolId) => [symbolId, []]));
  const files = Object.fromEntries(requestedFiles.map((fileRelPath) => [fileRelPath, []]));
  // Confidence-aware ordering: the strongest, freshest memories win the limited
  // per-anchor slots as a repo's table grows. Ties fall back to recency so the
  // ordering stays deterministic. memoryScore folds confidence + recency and is
  // the same scorer mirrored by the Rust port, so JS and native agree.
  const nowMs = Date.now();
  const sorted = [...rows].sort((a, b) => {
    const delta = memoryScore(b, { nowMs }) - memoryScore(a, { nowMs });
    if (delta !== 0) return delta;
    return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  });
  for (const row of sorted) {
    const linkedSymbols = links.symbolsById.get(row.memory_id) || [];
    const linkedFiles = activeMemoryFileLinks(row, links);
    const memory = memoryForAnchorGet(row, links);
    for (const symbolId of requestedSymbols) {
      if (linkedSymbols.includes(symbolId) && symbols[symbolId].length < MEMORY_GET_PER_ANCHOR_LIMIT) {
        symbols[symbolId].push(memory);
      }
    }
    for (const fileRelPath of requestedFiles) {
      if (linkedFiles.includes(fileRelPath) && files[fileRelPath].length < MEMORY_GET_PER_ANCHOR_LIMIT) {
        files[fileRelPath].push(memory);
      }
    }
  }
  for (const key of Object.keys(symbols)) {
    if (symbols[key].length === 0) delete symbols[key];
  }
  for (const key of Object.keys(files)) {
    if (files[key].length === 0) delete files[key];
  }
  return { symbols, files };
}

function memoryForAnchorGet(row, links) {
  return {
    memoryId: row.memory_id,
    memory_id: row.memory_id,
    title: row.title,
    content: row.content,
    domains: memoryRowDomains(row),
    source: row.source || "agent",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    symbolIds: links.symbolsById.get(row.memory_id) || [],
    fileRelPaths: activeMemoryFileLinks(row, links),
    ...(missingMemoryFileAnchors(row).length > 0
      ? { missingAnchors: missingMemoryFileAnchors(row) }
      : {}),
  };
}

function missingMemoryFileAnchors(row) {
  return Array.isArray(row?._missingAnchors)
    ? row._missingAnchors.map(String).filter(Boolean)
    : [];
}

function activeMemoryFileLinks(row, links) {
  const linkedFiles = links.filesById.get(row.memory_id) || [];
  const missing = new Set(missingMemoryFileAnchors(row));
  if (missing.size === 0) return linkedFiles;
  return linkedFiles.filter((fileRelPath) => !missing.has(fileRelPath));
}

function memoryScore(row, detail) {
  const matchedSymbols = Array.isArray(detail?.matchedSymbols) ? detail.matchedSymbols : [];
  const matchedFiles = Array.isArray(detail?.matchedFiles) ? detail.matchedFiles : [];
  let score = 0;
  score += Number(row.confidence || 0) || 0;
  score += recencyScore(row.updated_at, detail?.nowMs ?? Date.now());
  score += matchedSymbols.length * 2;
  score += matchedFiles.length;
  // Domain-relevance bonus: when the caller scopes to domains, a memory tagged
  // with one of them ranks above the rest within the (already domain-filtered)
  // set. Replaces the old type===taskType bonus, whose taxonomies never matched.
  const scopeDomains = Array.isArray(detail?.domains) ? detail.domains.map((d) => String(d).toLowerCase()) : [];
  if (scopeDomains.length > 0 && memoryRowDomains(row).some((d) => scopeDomains.includes(d))) {
    score += 0.75;
  }
  const query = cleanString(detail?.query, 1000).toLowerCase();
  if (query) {
    const text = memorySearchText(row, Array.isArray(detail?.tags) ? detail.tags : []);
    for (const token of tokenize(query)) {
      if (text.includes(token)) score += 0.5;
    }
  }
  return Math.round(score * 1000) / 1000;
}

function recencyScore(value, nowMs = Date.now()) {
  const ts = Date.parse(String(value || ""));
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (nowMs - ts) / 86_400_000);
  return Math.exp(-ageDays / 45);
}

function memorySearchText(row, tags) {
  return `${row.title || ""}\n${row.content || ""}\n${tags.join(" ")}`.toLowerCase();
}

function tokenize(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 2);
}

// Deterministic method core, exported for parity fixtures and the Rust port
// (posse-encoder-rust atlas_core::memory_rank). Keep these pure.
export {
  tokenize as memoryRankTokenize,
  recencyScore as memoryRecencyScore,
  memoryScore as memoryRankScore,
  jaccardSimilarity as memoryJaccardSimilarity,
  NEAR_DUPLICATE_JACCARD as MEMORY_NEAR_DUPLICATE_JACCARD,
};

/**
 * Deterministic anchor evidence: a memory whose EVERY anchored file has
 * vanished from the indexed tree describes code that no longer exists, so
 * read paths skip it without mutating memory.db. Partial loss only decorates
 * the surfaced memory with the missing paths. Guards:
 * - needs an open view (ledger-only surfacing skips the check),
 * - only memories created BEFORE the view was built can be flagged — the
 *   surface route is freshness-exempt, so a fresh memory anchored to a file
 *   newer than a stale view must not be punished for the view's lag.
 *
 * @param {import("../contracts/api.js").View | null | undefined} view
 * @param {any[]} rows
 * @param {{ filesById: Map<string, string[]> }} links
 */
function applyAnchorEvidence(view, rows, links) {
  if (typeof view?.query?.contentHashForPath !== "function") return rows;
  let viewBuiltAt = "";
  let hasPath;
  try {
    viewBuiltAt = String(/** @type {any} */ (view).meta?.()?.built_at || "");
    const cache = new Map();
    hasPath = (p) => {
      if (!cache.has(p)) cache.set(p, view.query.contentHashForPath(p) != null);
      return cache.get(p);
    };
  } catch {
    return rows; // anchor evidence is advisory; never fail a surface read
  }
  const kept = [];
  for (const row of rows) {
    const files = links.filesById.get(row.memory_id) || [];
    if (files.length === 0) { kept.push(row); continue; }
    let missing;
    try {
      missing = files.filter((f) => !hasPath(f));
    } catch {
      kept.push(row);
      continue;
    }
    if (missing.length === 0) { kept.push(row); continue; }
    // Unknown built_at must KEEP the memory (decorate only): a fresh memory
    // whose anchors simply post-date the view must not be punished for the
    // view's lag — treating unknown as "older" inverted that guard and hid
    // every all-anchors-missing memory whenever built_at was absent.
    const olderThanView = !!viewBuiltAt
      && String(row.created_at || "") < viewBuiltAt;
    if (missing.length === files.length && olderThanView) {
      continue; // every anchor gone: do not surface
    }
    row._missingAnchors = missing;
    kept.push(row);
  }
  return kept;
}

/**
 * Opportunistic staleness sweep: memories untouched for longer than the policy
 * window are flagged stale so proactive surfacing skips them. memory.store
 * resets the flag when a memory is refreshed.
 */
function sweepStaleMemories(db, repoId, policy) {
  const days = clampInt(policy?.memoryStaleAfterDays, 0, 3650, 0);
  if (days <= 0) return;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  try {
    db.prepare(
      "UPDATE memories SET stale = 1, stale_reason = 'age' WHERE repo_id = ? AND deleted = 0 AND stale = 0 AND updated_at < ?",
    ).run(repoId, cutoff);
  } catch {
    // Staleness is best-effort; never fail a read because the sweep could not run.
  }
}

// Baseline marker for a file link already counted once as deleted, so the same
// deletion does not re-penalize a partially-surviving memory on every rebuild.
const ANCHOR_DELETED_TOMBSTONE = "";

/**
 * Anchor-drift decay: confidence falls when the CODE a memory is anchored to
 * changes underneath it — the signal the model is built on, not a clock. Runs
 * at most once per view rebuild (gated by built_at recorded in memory_meta) so
 * each real code change is accounted exactly once. A file's blob content_hash
 * subsumes symbol-level change: edit any symbol and the file hash moves.
 *
 * Per active anchored memory:
 *   - file link missing from path_to_blob          -> DELETED (tombstoned)
 *   - file link present, blob hash != baseline      -> CHANGED (re-baselined)
 *   - symbol link's blob hash gone from path_to_blob -> DRIFTED (dead link dropped)
 * Every anchor gone -> soft-deleted (resurrectable on re-derivation). Partial
 * drift -> confidence *= (1 - driftWeight * driftedFraction); crossing the floor
 * soft-deletes. Intact anchors are never touched.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {import("../contracts/api.js").View | null | undefined} view
 * @param {string} repoId
 * @param {string} now
 */
function reconcileAnchorConfidence(db, view, repoId, now) {
  if (typeof view?.query?.contentHashForPath !== "function"
      || typeof view?.query?.hasSnapshotContentHash !== "function") return;
  const builtAt = String(/** @type {any} */ (view)?.meta?.()?.built_at || "");
  if (!builtAt) return;
  // Per-repo gate: one memory.db can hold several repos, each with its own code
  // state, so a global gate would let the first repo's store starve the rest.
  const metaKey = `last_anchor_reconcile_built_at:${repoId}`;
  const seen = db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(metaKey)?.value;
  if (seen === builtAt) return; // this view rebuild was already reconciled for this repo

  const pathHashCache = new Map();
  const pathHash = (p) => {
    if (!pathHashCache.has(p)) pathHashCache.set(p, view.query.contentHashForPath(p));
    return pathHashCache.get(p);
  };
  const blobAliveCache = new Map();
  const blobAlive = (h) => {
    if (!blobAliveCache.has(h)) blobAliveCache.set(h, view.query.hasSnapshotContentHash(h));
    return blobAliveCache.get(h);
  };

  const memories = db.prepare(
    "SELECT memory_id, confidence FROM memories WHERE repo_id = ? AND deleted = 0",
  ).all(repoId);
  const fileLinksStmt = db.prepare("SELECT repo_rel_path, content_hash FROM memory_file_links WHERE memory_id = ?");
  const symLinksStmt = db.prepare("SELECT content_hash, local_id FROM memory_symbol_links WHERE memory_id = ?");
  const rebaseFile = db.prepare("UPDATE memory_file_links SET content_hash = ? WHERE memory_id = ? AND repo_rel_path = ?");
  const dropSym = db.prepare("DELETE FROM memory_symbol_links WHERE memory_id = ? AND content_hash = ? AND local_id = ?");
  const setConf = db.prepare("UPDATE memories SET confidence = ? WHERE memory_id = ?");
  const softDelete = db.prepare("UPDATE memories SET deleted = 1, deleted_at = ?, updated_at = ? WHERE memory_id = ?");

  const run = db.transaction(() => {
    for (const mem of memories) {
      const fileLinks = fileLinksStmt.all(mem.memory_id);
      const symLinks = symLinksStmt.all(mem.memory_id);
      const total = fileLinks.length + symLinks.length;
      if (total === 0) continue; // unanchored memories have no drift signal

      let drifted = 0;
      let filesDeleted = 0;
      for (const link of fileLinks) {
        const current = pathHash(link.repo_rel_path);
        const baseline = link.content_hash;
        if (current === null) {
          // Only a previously-known file (a real captured baseline that is now
          // gone) counts as deleted. A NULL baseline means the path was never
          // indexed — newer than the view or outside its scope — so we must not
          // condemn the memory for the view's blind spot.
          if (baseline && baseline !== ANCHOR_DELETED_TOMBSTONE) {
            drifted += 1;
            filesDeleted += 1;
            rebaseFile.run(ANCHOR_DELETED_TOMBSTONE, mem.memory_id, link.repo_rel_path);
          } else if (baseline === ANCHOR_DELETED_TOMBSTONE) {
            filesDeleted += 1; // already counted once on a prior reconcile
          }
        } else if (!baseline || baseline === ANCHOR_DELETED_TOMBSTONE) {
          // First sight, or a deleted file that returned: adopt as baseline.
          rebaseFile.run(current, mem.memory_id, link.repo_rel_path);
        } else if (baseline !== current) {
          drifted += 1;
          rebaseFile.run(current, mem.memory_id, link.repo_rel_path);
        }
      }
      let symbolsDrifted = 0;
      for (const link of symLinks) {
        if (!blobAlive(link.content_hash)) {
          drifted += 1;
          symbolsDrifted += 1;
          dropSym.run(mem.memory_id, link.content_hash, link.local_id);
        }
      }

      const everyFileGone = fileLinks.length === 0 || filesDeleted === fileLinks.length;
      const everySymbolGone = symLinks.length === 0 || symbolsDrifted === symLinks.length;
      if (everyFileGone && everySymbolGone && (filesDeleted > 0 || symbolsDrifted > 0)) {
        softDelete.run(now, now, mem.memory_id);
        continue;
      }
      if (drifted > 0) {
        const factor = 1 - MEMORY_CONFIDENCE.driftWeight * (drifted / total);
        const next = clampConfidence(Number(mem.confidence || 0) * factor);
        if (next <= MEMORY_CONFIDENCE.floor) {
          softDelete.run(now, now, mem.memory_id);
        } else {
          setConf.run(next, mem.memory_id);
        }
      }
    }
    db.prepare(
      "INSERT INTO memory_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(metaKey, builtAt);
  });
  try {
    run();
  } catch {
    // Advisory: a reconciliation failure must never break a memory write.
  }
}
