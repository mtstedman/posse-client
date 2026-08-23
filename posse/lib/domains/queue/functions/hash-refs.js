import crypto from "crypto";

import { HashMinter } from "../../../shared/tools/classes/hash-store/HashMinter.js";
import { HashRefCapabilityStore } from "../../../shared/tools/classes/hash-store/HashRefCapabilityStore.js";
import { HashRefStore } from "../../../shared/tools/classes/hash-store/HashRefStore.js";
import {
  HASH_REF_OWNER_SCOPE_SET,
  normalizeHashRefAlias,
} from "../../../catalog/hash-store.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import {
  hashRefModelVisibility,
  hashRefModelVisibleScope,
} from "../../../shared/tools/functions/fetch-ref-policy.js";
import { materializeHashRefView } from "../../../shared/tools/functions/hash-ref-view.js";

function positiveInt(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function normalizeScope(scope) {
  const normalized = String(scope || "").trim();
  return HASH_REF_OWNER_SCOPE_SET.has(normalized) ? normalized : null;
}

function capabilityStoreForResolvedContext(resolved, db) {
  if (!resolved || resolved.error) return null;
  if (!resolved.agentCallId && !resolved.attemptId && !resolved.jobId && !resolved.workItemId) return null;
  return new HashRefCapabilityStore({ db, context: resolved });
}

function matchingSurfaceScope(metadata, resolved) {
  const scopes = Array.isArray(metadata?.model_visible_scopes)
    ? metadata.model_visible_scopes
    : [];
  const attemptId = Number(resolved?.attemptId) || null;
  const agentCallId = Number(resolved?.agentCallId) || null;
  return [...scopes].reverse().find((scope) => {
    const scopeAttempt = Number(scope?.attempt_id) || null;
    const scopeCall = Number(scope?.agent_call_id) || null;
    if (attemptId && scopeAttempt && attemptId !== scopeAttempt) return false;
    if (agentCallId && scopeCall) return agentCallId === scopeCall;
    return !!(
      (attemptId && scopeAttempt && attemptId === scopeAttempt)
      || (agentCallId && scopeCall && agentCallId === scopeCall)
    );
  }) || null;
}

function syncSurfaceCapability(store, resolved, surfaced) {
  const entry = surfaced?.entry;
  if (!store || !entry?.ref) return null;
  const visible = matchingSurfaceScope(entry.metadata, resolved);
  if (!visible) return null;
  if (visible.visibility === "full") {
    return store.registerEvidence({
      ref: entry.ref,
      sourceRef: entry.ref,
      selector: { mode: "full" },
      sourceContentHash: entry.content_hash,
      viewText: entry.entry_kind === "materialized" ? entry.payload_text : null,
    });
  }
  if (visible.issued_as === "traversal" || visible.visibility === "hidden") {
    return store.issueTraversal({
      ref: entry.ref,
      sourceRef: entry.ref,
      selector: entry.metadata?.traversal_selector || null,
      sourceContentHash: entry.content_hash,
    });
  }
  return null;
}

function rawPayloadLineSpans(value) {
  const text = String(value ?? "");
  const spans = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index];
    if (index < text.length && char !== "\n" && char !== "\r") continue;
    spans.push({ start, end: index });
    if (char === "\r" && text[index + 1] === "\n") index += 1;
    start = index + 1;
  }
  if (spans.length > 1 && spans.at(-1).start === text.length) spans.pop();
  return spans;
}

function sourceMetadataForPartialHashRefView(source, view) {
  const materialized = {
    line_semantics: "materialized",
    source_windows: [],
    path: null,
  };
  if (view?.page?.mode === "search") {
    return {
      ...materialized,
      citable: false,
      non_citable_reason: "search_result_view",
      parent_ref: source?.ref || null,
    };
  }
  if (String(source?.metadata?.line_semantics || "").toLowerCase() !== "source"
    || view?.page?.mode !== "offset") return materialized;
  const sourceText = String(source?.payload_text ?? "");
  const rawLineEncodings = new Set([
    "delegated_excerpt",
    "raw_source_lines",
    "worktree_excerpt",
  ]);
  const worktreeExcerpt = sourceText.startsWith("[posse.worktree_evidence.v1 ");
  const viewStart = Number(view.page.offset);
  const viewEnd = viewStart + String(view.text ?? "").length;
  if (!Number.isInteger(viewStart) || viewStart < 0 || viewEnd <= viewStart) return materialized;
  const lineSpans = rawPayloadLineSpans(sourceText);
  let anchorLineIndex = lineSpans.findIndex((span) => (
    span.start <= viewStart && viewStart <= span.end
  ));
  if (anchorLineIndex < 0) {
    const nextLineIndex = lineSpans.findIndex((span) => span.start > viewStart);
    // rawPayloadLineSpans excludes the LF byte in a CRLF separator. A view
    // beginning on that byte still starts with the preceding logical line's
    // empty tail, so the next full source line is materialized line 2.
    anchorLineIndex = Math.max(
      0,
      (nextLineIndex < 0 ? lineSpans.length : nextLineIndex) - 1,
    );
  }
  const windows = [];
  for (const rawWindow of Array.isArray(source.metadata?.source_windows)
    ? source.metadata.source_windows
    : []) {
    const sourcePath = String(rawWindow?.path ?? rawWindow?.repo_rel_path ?? "").trim();
    const sourceStart = Number(rawWindow?.source_start_line ?? rawWindow?.start_line);
    const sourceEnd = Number(rawWindow?.source_end_line ?? rawWindow?.end_line);
    const materializedStart = Number(rawWindow?.materialized_start_line);
    const materializedEnd = Number(rawWindow?.materialized_end_line);
    const repositoryIdentity = rawWindow?.repository_identity
      ?? source?.metadata?.repository_identity
      ?? null;
    const sourceVersion = rawWindow?.source_version
      ?? source?.metadata?.source_version
      ?? null;
    const sourceEncoding = String(
      rawWindow?.source_payload_encoding
        ?? source?.metadata?.source_payload_encoding
        ?? "",
    ).toLowerCase();
    if (!sourcePath || !Number.isInteger(sourceStart) || !Number.isInteger(sourceEnd)
      || !Number.isInteger(materializedStart) || !Number.isInteger(materializedEnd)
      || sourceEnd - sourceStart !== materializedEnd - materializedStart) continue;
    for (let line = materializedStart; line <= materializedEnd; line += 1) {
      const span = lineSpans[line - 1];
      if (!span || span.start < viewStart || span.end > viewEnd) continue;
      const sourceLine = sourceStart + line - materializedStart;
      const physicalLine = sourceText.slice(span.start, span.end);
      const gutter = /^\s*(\d+)\t/.exec(physicalLine);
      const verifiedLineEncoding = rawLineEncodings.has(sourceEncoding)
        || worktreeExcerpt
        || Number(gutter?.[1]) === sourceLine;
      if (!verifiedLineEncoding) continue;
      const viewLine = line - 1 - anchorLineIndex + 1;
      const prior = windows.at(-1);
      if (prior?.path === sourcePath
        && prior.source_end_line + 1 === sourceLine
        && prior.materialized_end_line + 1 === viewLine
        && (prior.repository_identity ?? null) === repositoryIdentity
        && (prior.source_version ?? null) === sourceVersion
        && (prior.source_payload_encoding ?? "") === sourceEncoding) {
        prior.source_end_line = sourceLine;
        prior.materialized_end_line = viewLine;
      } else {
        windows.push({
          path: sourcePath,
          source_start_line: sourceLine,
          source_end_line: sourceLine,
          materialized_start_line: viewLine,
          materialized_end_line: viewLine,
          ...(repositoryIdentity != null ? { repository_identity: repositoryIdentity } : {}),
          ...(sourceVersion != null ? { source_version: sourceVersion } : {}),
          ...(sourceEncoding ? { source_payload_encoding: sourceEncoding } : {}),
        });
      }
    }
  }
  if (windows.length === 0) return materialized;
  const paths = [...new Set(windows.map((window) => window.path))];
  const aggregateProvenance = {};
  for (const key of ["repository_identity", "source_version", "source_payload_encoding"]) {
    const values = windows.map((window) => window[key]);
    const known = values.filter((value) => value != null && String(value).trim() !== "");
    const distinct = new Set(known.map((value) => String(value)));
    if (known.length === windows.length && distinct.size === 1) {
      aggregateProvenance[key] = known[0];
      aggregateProvenance[`${key}_conflict`] = false;
    } else if (distinct.size > 1) {
      aggregateProvenance[key] = null;
      aggregateProvenance[`${key}_conflict`] = true;
    }
  }
  return {
    line_semantics: "source",
    source_windows: windows,
    path: paths.length === 1 ? paths[0] : null,
    citable: true,
    ...aggregateProvenance,
  };
}

function markContextMismatch(out, field, expected, actual) {
  if (out.error) return;
  out.error = "hash_ref_context_mismatch";
  out.error_detail = `${field} expected ${expected ?? "null"} but got ${actual ?? "null"}`;
}

function acceptResolvedId(out, key, value, field) {
  const normalized = positiveInt(value);
  if (!normalized) return;
  if (out[key] && out[key] !== normalized) {
    markContextMismatch(out, field, out[key], normalized);
    return;
  }
  out[key] = normalized;
}

function jobAncestorRows(db, jobId, workItemId) {
  const rows = [];
  const seen = new Set();
  let currentId = positiveInt(jobId);
  let guard = 0;
  while (currentId && guard < 32 && !seen.has(currentId)) {
    guard += 1;
    seen.add(currentId);
    const row = db.prepare(`
      SELECT id, work_item_id, parent_job_id
      FROM jobs
      WHERE id = ?
    `).get(currentId);
    if (!row) break;
    const rowWorkItemId = positiveInt(row.work_item_id);
    if (workItemId && rowWorkItemId !== workItemId) break;
    rows.push({
      id: positiveInt(row.id),
      work_item_id: rowWorkItemId,
      parent_job_id: positiveInt(row.parent_job_id),
    });
    currentId = positiveInt(row.parent_job_id);
  }
  return rows;
}

function createJobStoreChain({
  db,
  minter,
  rows,
  fallbackWorkItemId,
  parent,
  currentAttemptId = null,
  currentAgentCallId = null,
  maxMaterializedRows = undefined,
  maxMaterializedBytes = undefined,
}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let nextParent = parent || null;
  const ordered = rows.slice().reverse();
  const currentJobId = rows[0]?.id || null;
  for (const row of ordered) {
    const isCurrentJob = row.id === currentJobId;
    nextParent = new HashRefStore({
      db,
      minter,
      ownerScope: "job",
      workItemId: row.work_item_id || fallbackWorkItemId,
      jobId: row.id,
      attemptId: isCurrentJob ? currentAttemptId : null,
      agentCallId: isCurrentJob ? currentAgentCallId : null,
      parent: nextParent,
      maxMaterializedRows,
      maxMaterializedBytes,
    });
  }
  return nextParent;
}

export function resolveHashRefContext(context = {}, db = getDb()) {
  const out = {
    workItemId: positiveInt(context.workItemId ?? context.work_item_id),
    jobId: positiveInt(context.jobId ?? context.job_id),
    attemptId: positiveInt(context.attemptId ?? context.attempt_id),
    agentCallId: positiveInt(context.agentCallId ?? context.agent_call_id),
  };

  if (out.agentCallId) {
    const call = db.prepare(`
      SELECT id, work_item_id, job_id, attempt_id
      FROM agent_calls
      WHERE id = ?
    `).get(out.agentCallId);
    if (!call) {
      out.error = "invalid_agent_call_id";
      return out;
    }
    acceptResolvedId(out, "workItemId", call.work_item_id, "work_item_id");
    acceptResolvedId(out, "jobId", call.job_id, "job_id");
    acceptResolvedId(out, "attemptId", call.attempt_id, "attempt_id");
    if (out.error) return out;
  }

  if (out.attemptId) {
    const attempt = db.prepare(`
      SELECT a.id, a.job_id, j.work_item_id
      FROM job_attempts a
      LEFT JOIN jobs j ON j.id = a.job_id
      WHERE a.id = ?
    `).get(out.attemptId);
    if (!attempt) {
      out.error = "invalid_attempt_id";
      return out;
    }
    acceptResolvedId(out, "jobId", attempt.job_id, "job_id");
    acceptResolvedId(out, "workItemId", attempt.work_item_id, "work_item_id");
    if (out.error) return out;
  }

  if (out.jobId) {
    const job = db.prepare(`SELECT id, work_item_id FROM jobs WHERE id = ?`).get(out.jobId);
    if (!job) {
      out.error = "invalid_job_id";
      return out;
    }
    acceptResolvedId(out, "workItemId", job.work_item_id, "work_item_id");
    if (out.error) return out;
  }

  if (out.workItemId) {
    const workItem = db.prepare(`SELECT id FROM work_items WHERE id = ?`).get(out.workItemId);
    if (!workItem) {
      out.error = "invalid_work_item_id";
      return out;
    }
  }

  return out;
}

function createHashRefStoreForResolvedContext(resolved, {
  db = getDb(),
  minter = null,
  ownerScope = null,
  maxMaterializedRows = undefined,
  maxMaterializedBytes = undefined,
} = {}) {
  if (!resolved || resolved.error) return null;
  const sharedMinter = minter || new HashMinter({ db });
  const workItemStore = resolved.workItemId
    ? new HashRefStore({
      db,
      minter: sharedMinter,
      ownerScope: "work_item",
      workItemId: resolved.workItemId,
      maxMaterializedRows,
      maxMaterializedBytes,
    })
    : null;
  const jobStore = resolved.jobId && resolved.workItemId
    ? createJobStoreChain({
      db,
      minter: sharedMinter,
      rows: jobAncestorRows(db, resolved.jobId, resolved.workItemId),
      fallbackWorkItemId: resolved.workItemId,
      parent: workItemStore,
      currentAttemptId: resolved.attemptId,
      currentAgentCallId: resolved.agentCallId,
      maxMaterializedRows,
      maxMaterializedBytes,
    })
    : null;
  const agentRunStore = resolved.attemptId
    ? new HashRefStore({
      db,
      minter: sharedMinter,
      ownerScope: "agent_run",
      workItemId: resolved.workItemId,
      jobId: resolved.jobId,
      attemptId: resolved.attemptId,
      agentCallId: resolved.agentCallId,
      parent: jobStore || workItemStore,
      maxMaterializedRows,
      maxMaterializedBytes,
    })
    : null;

  const explicit = normalizeScope(ownerScope);
  if (explicit === "agent_run") return agentRunStore;
  if (explicit === "job") return jobStore;
  if (explicit === "work_item") return workItemStore;
  return agentRunStore || jobStore || workItemStore;
}

export function createHashRefStoreForContext(context = {}, opts = {}) {
  const db = opts.db || getDb();
  const resolved = resolveHashRefContext(context, db);
  return createHashRefStoreForResolvedContext(resolved, { ...opts, db });
}

export function surfaceHashRefForContext(context = {}, entry = {}, opts = {}) {
  const db = opts.db || getDb();
  const resolved = resolveHashRefContext(context, db);
  if (resolved.error) {
    return { ok: false, error: resolved.error, detail: resolved.error_detail || null };
  }
  const store = createHashRefStoreForResolvedContext(resolved, { ...opts, db });
  if (!store) {
    return { ok: false, error: "missing_hash_ref_scope" };
  }
  const surfaced = store.surface(entry);
  let capability = null;
  try {
    capability = syncSurfaceCapability(
      capabilityStoreForResolvedContext(resolved, db),
      resolved,
      surfaced,
    );
  } catch {
    // Payload storage is the primary operation. Capability registration is
    // retried lazily by traversal compatibility if an older or partially
    // migrated database cannot accept the model-facing row yet.
  }
  return {
    ok: true,
    ...surfaced,
    ...(capability ? { model_ref: capability.ref, capability } : {}),
  };
}

export function issueHashRefTraversalForContext(context = {}, {
  ref = null,
  sourceRef,
  selector = null,
  sourceContentHash = null,
} = {}, opts = {}) {
  const db = opts.db || getDb();
  const resolved = resolveHashRefContext(context, db);
  const store = capabilityStoreForResolvedContext(resolved, db);
  if (!store) return { ok: false, error: resolved.error || "missing_hash_ref_scope" };
  const source = fetchHashRefForContext(context, sourceRef, { db });
  if (!source?.found || !source.entry) return { ok: false, error: "source_ref_not_found_or_not_visible" };
  const capability = store.issueTraversal({
    ref,
    sourceRef: source.entry.ref,
    selector,
    sourceContentHash: sourceContentHash || source.entry.content_hash,
  });
  return { ok: true, capability, source: source.entry };
}

export function fetchHashRefTraversalForContext(context = {}, ref, opts = {}) {
  const db = opts.db || getDb();
  const resolved = resolveHashRefContext(context, db);
  const store = capabilityStoreForResolvedContext(resolved, db);
  if (!store) return { ok: false, found: false, error: resolved.error || "missing_hash_ref_scope" };
  const capability = store.traversal(ref);
  if (!capability) return { ok: true, found: false, ref: String(ref || "") };
  const source = fetchHashRefForContext(context, capability.source_ref, { db });
  if (!source?.found || !source.entry) {
    return { ok: false, found: false, ref: capability.ref, error: "source_ref_not_found_or_not_visible" };
  }
  return { ok: true, found: true, capability, source: source.entry };
}

export function fetchHashRefEvidenceForContext(context = {}, ref, opts = {}) {
  const db = opts.db || getDb();
  const resolved = resolveHashRefContext(context, db);
  const store = capabilityStoreForResolvedContext(resolved, db);
  if (!store) return { ok: false, found: false, error: resolved.error || "missing_hash_ref_scope" };
  const capability = store.evidence(ref);
  if (!capability) return { ok: true, found: false, ref: String(ref || "") };
  const source = fetchHashRefForContext(context, capability.source_ref, { db });
  if (!source?.found || !source.entry) {
    return { ok: false, found: false, ref: capability.ref, error: "source_ref_not_found_or_not_visible" };
  }
  return { ok: true, found: true, capability, source: source.entry };
}

export function promoteHashRefTraversalForContext(context = {}, ref, {
  selector,
  viewText,
  sourceContentHash = null,
} = {}, opts = {}) {
  const db = opts.db || getDb();
  const resolved = resolveHashRefContext(context, db);
  const store = capabilityStoreForResolvedContext(resolved, db);
  if (!store) return { ok: false, error: resolved.error || "missing_hash_ref_scope" };
  const evidence = store.promoteTraversal(ref, {
    selector,
    viewText,
    sourceContentHash,
  });
  return evidence
    ? { ok: true, evidence }
    : { ok: false, error: "traversal_ref_not_issued" };
}

export function createHashRefEvidenceForContext(context = {}, {
  ref = null,
  sourceRef,
  selector,
  viewText,
  sourceContentHash = null,
} = {}, opts = {}) {
  const db = opts.db || getDb();
  const resolved = resolveHashRefContext(context, db);
  const store = capabilityStoreForResolvedContext(resolved, db);
  if (!store) return { ok: false, error: resolved.error || "missing_hash_ref_scope" };
  const source = fetchHashRefForContext(context, sourceRef, { db });
  if (!source?.found || !source.entry) return { ok: false, error: "source_ref_not_found_or_not_visible" };
  const evidence = store.registerEvidence({
    ref,
    sourceRef: source.entry.ref,
    selector,
    sourceContentHash: sourceContentHash || source.entry.content_hash,
    viewText,
  });
  return { ok: true, evidence, source: source.entry };
}

export function materializeHashRefEvidenceForContext(context = {}, ref, opts = {}) {
  const resolved = fetchHashRefEvidenceForContext(context, ref, opts);
  if (!resolved?.found || !resolved.source || !resolved.capability) return resolved;
  const source = resolved.source;
  if (source.entry_kind !== "materialized" || source.payload_text == null) {
    return { ok: false, found: true, ref: resolved.capability.ref, error: "evidence_source_not_materialized" };
  }
  const selector = resolved.capability.selector || { mode: "full" };
  const view = selector.mode === "full"
    ? {
        text: String(source.payload_text),
        page: {
          mode: "offset",
          offset: 0,
          limit: String(source.payload_text).length,
          returned_chars: String(source.payload_text).length,
          next_offset: null,
          has_more: false,
        },
      }
    : materializeHashRefView(source.payload_text, selector);
  const actualHash = crypto.createHash("sha256").update(view.text, "utf8").digest("hex");
  if (resolved.capability.view_sha256 && resolved.capability.view_sha256 !== actualHash) {
    return { ok: false, found: true, ref: resolved.capability.ref, error: "evidence_view_integrity_mismatch" };
  }
  const preservesWholeSource = view.text === String(source.payload_text);
  const partialSourceMetadata = preservesWholeSource
    ? null
    : sourceMetadataForPartialHashRefView(source, view);
  const entry = {
    ...source,
    ref: resolved.capability.ref,
    payload_text: view.text,
    size_chars: view.text.length,
    content_hash: actualHash,
    descriptor: {
      ...(source.descriptor || {}),
      capability_view: {
        kind: "hash_ref_evidence_view",
        source_ref: source.ref,
        selector,
      },
    },
    metadata: {
      ...(source.metadata || {}),
      ...(partialSourceMetadata || {}),
      surfaced_by: "hash_ref_evidence_capability",
      fetch_class: "visible_view",
      capability_source_ref: source.ref,
      exact_visible_field: "text",
      ...hashRefModelVisibility(context, {
        visibility: "full",
        ranges: [{ start: 0, end: view.text.length }],
        issuedAs: "evidence",
      }),
    },
  };
  return {
    ok: true,
    found: true,
    ref: resolved.capability.ref,
    capability: resolved.capability,
    source,
    view,
    entry,
  };
}

export function discardHashRefTraversalsForAgentCall(agentCallId, opts = {}) {
  const id = positiveInt(agentCallId);
  if (!id) return 0;
  const db = opts.db || getDb();
  return db.prepare(`
    DELETE FROM hash_ref_traversal_refs
    WHERE agent_call_id = ?
  `).run(id).changes;
}

export function fetchHashRefForContext(context = {}, ref, opts = {}) {
  const db = opts.db || getDb();
  const resolved = resolveHashRefContext(context, db);
  if (resolved.error) {
    return { ok: false, found: false, ref: String(ref || ""), error: resolved.error };
  }
  const store = createHashRefStoreForResolvedContext(resolved, { ...opts, db });
  if (!store) {
    return { ok: false, found: false, ref: String(ref || ""), error: "missing_hash_ref_scope" };
  }
  return store.fetch(ref);
}

/**
 * Find exact traversal views derived from one stored ref and visible through
 * the current hash-ref scope. Terminal handoff validation uses this to
 * canonicalize a model's source-ref citation after that same model fetched an
 * exact view but repeated the source alias instead of the returned evidence_ref.
 */
export function findFetchedHashRefViewsForContext(context = {}, sourceRef, opts = {}) {
  const db = opts.db || getDb();
  const resolved = resolveHashRefContext(context, db);
  const normalizedSourceRef = normalizeHashRefAlias(sourceRef);
  if (resolved.error || !normalizedSourceRef) return [];

  const ownerQueries = [];
  if (resolved.attemptId) {
    ownerQueries.push({
      table: "agent_run_hash_refs",
      ownerColumn: "attempt_id",
      ownerIds: [resolved.attemptId],
    });
  }
  if (resolved.jobId) {
    ownerQueries.push({
      table: "job_hash_refs",
      ownerColumn: "job_id",
      ownerIds: jobAncestorRows(db, resolved.jobId, resolved.workItemId).map((row) => row.id),
    });
  }
  if (resolved.workItemId) {
    ownerQueries.push({
      table: "work_item_hash_refs",
      ownerColumn: "work_item_id",
      ownerIds: [resolved.workItemId],
    });
  }

  const refs = [];
  for (const query of ownerQueries) {
    if (query.ownerIds.length === 0) continue;
    const placeholders = query.ownerIds.map(() => "?").join(", ");
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT ref
        FROM ${query.table}
        WHERE ${query.ownerColumn} IN (${placeholders})
          AND entry_kind = 'materialized'
          AND payload_text IS NOT NULL
          AND json_valid(metadata_json)
          AND json_extract(metadata_json, '$.surfaced_by') = 'fetch_ref_view'
          AND lower(json_extract(metadata_json, '$.source_ref')) = ?
        ORDER BY updated_at DESC, id DESC
      `).all(...query.ownerIds, normalizedSourceRef);
    } catch {
      continue;
    }
    refs.push(...rows.map((row) => row.ref));
  }

  const entries = [];
  const seen = new Set();
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const fetched = fetchHashRefForContext(context, ref, opts);
    if (fetched?.found && fetched.entry) entries.push(fetched.entry);
  }
  return entries;
}

/**
 * Return canonical source paths carried by refs that were fully visible to
 * this exact model call. Deliberately ignore descriptor arguments and payload
 * text: only source provenance captured at surfacing is authoritative.
 */
export function findVisibleHashRefSourcePathsForContext(context = {}, opts = {}) {
  const db = opts.db || getDb();
  const resolved = resolveHashRefContext(context, db);
  if (resolved.error) return [];

  const ownerQueries = [];
  if (resolved.attemptId) {
    ownerQueries.push({
      table: "agent_run_hash_refs",
      ownerColumn: "attempt_id",
      ownerIds: [resolved.attemptId],
    });
  }
  if (resolved.jobId) {
    ownerQueries.push({
      table: "job_hash_refs",
      ownerColumn: "job_id",
      ownerIds: jobAncestorRows(db, resolved.jobId, resolved.workItemId).map((row) => row.id),
    });
  }
  if (resolved.workItemId) {
    ownerQueries.push({
      table: "work_item_hash_refs",
      ownerColumn: "work_item_id",
      ownerIds: [resolved.workItemId],
    });
  }

  const refs = [];
  for (const query of ownerQueries) {
    if (query.ownerIds.length === 0) continue;
    const placeholders = query.ownerIds.map(() => "?").join(", ");
    try {
      refs.push(...db.prepare(`
        SELECT ref
        FROM ${query.table}
        WHERE ${query.ownerColumn} IN (${placeholders})
          AND json_valid(metadata_json)
        ORDER BY updated_at DESC, id DESC
      `).all(...query.ownerIds).map((row) => row.ref));
    } catch {
      // Compatibility databases may not have every owner table yet.
    }
  }

  const paths = new Set();
  const seen = new Set();
  const addPath = (value) => {
    const normalized = String(value || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+/g, "/");
    if (normalized) paths.add(normalized);
  };
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const fetched = fetchHashRefForContext(context, ref, { db });
    const entry = fetched?.found ? fetched.entry : null;
    if (!entry || !hashRefModelVisibleScope(entry, resolved).fully_visible) continue;
    addPath(entry.metadata?.path);
    addPath(entry.metadata?.repo_rel_path);
    for (const window of Array.isArray(entry.metadata?.source_windows)
      ? entry.metadata.source_windows
      : []) {
      addPath(window?.path ?? window?.repo_rel_path);
    }
  }
  return [...paths].sort();
}

export function giveHashRefToParentForContext(context = {}, ref, opts = {}) {
  const db = opts.db || getDb();
  const resolved = resolveHashRefContext(context, db);
  if (resolved.error) {
    return { ok: false, found: false, ref: String(ref || ""), error: resolved.error };
  }
  const store = createHashRefStoreForResolvedContext(resolved, { ...opts, db });
  if (!store) {
    return { ok: false, found: false, ref: String(ref || ""), error: "missing_hash_ref_scope" };
  }
  return store.giveHash(ref, opts);
}
