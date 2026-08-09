// @ts-check

import { performance } from "node:perf_hooks";
import { planQuery } from "./orchestrator/query-planner.js";

const MAX_IDENTIFIERS = 12;
const MAX_MATCHES_PER_IDENTIFIER = 32;
const PROSE_IDENTIFIER_WORDS = new Set([
  "atlas", "cite", "compare", "deliverables", "end", "explain", "file:line",
  "identify", "partial", "read", "reject", "relevant", "state", "trace", "unhelpful",
]);

/**
 * Collect compact exact-name evidence for the tree.scope routing shadow.
 * This is one planner operation plus one indexed SQLite operation; failures
 * intentionally degrade to unavailable diagnostics and never affect live
 * candidates.
 *
 * @param {{
 *   db: import("better-sqlite3").Database,
 *   taskText?: string | null,
 *   planner?: ((input: string) => import("./orchestrator/query-planner-types.js").QueryPlan | Promise<import("./orchestrator/query-planner-types.js").QueryPlan>) | null,
 * }} args
 */
export async function collectTreeIdentifierShadowEvidence({ db, taskText, planner = null }) {
  const plannerStarted = performance.now();
  let plan;
  try {
    plan = await (planner || planQuery)(String(taskText || ""));
  } catch {
    return emptyEvidence(performance.now() - plannerStarted, 0);
  }
  const plannerMs = performance.now() - plannerStarted;
  const identifiers = uniqueStrings(plan?.identifiers)
    .filter((identifier) => !PROSE_IDENTIFIER_WORDS.has(identifier.toLowerCase()))
    .slice(0, MAX_IDENTIFIERS);
  if (identifiers.length === 0) return emptyEvidence(plannerMs, 0);

  const lookupStarted = performance.now();
  let taskIdentifierEvidence = [];
  try {
    taskIdentifierEvidence = queryIdentifierEvidence(db, identifiers);
  } catch {
    return emptyEvidence(plannerMs, performance.now() - lookupStarted);
  }
  const identifierLookupMs = performance.now() - lookupStarted;
  return {
    taskIdentifierEvidence,
    identifierPlannerMs: plannerMs,
    identifierLookupMs,
    identifierEvidenceBytes: Buffer.byteLength(JSON.stringify(taskIdentifierEvidence), "utf8"),
  };
}

function queryIdentifierEvidence(db, identifiers) {
  const requestedValues = identifiers.map((_, index) => `(?, ${index})`).join(",");
  const rows = db.prepare(`
    WITH requested(identifier, ordinal) AS (VALUES ${requestedValues}),
    matched AS (
      SELECT r.identifier,r.ordinal,s.name,s.qualified_name,s.kind,s.content_hash,
             s.local_id,s.repo_rel_path,
             COUNT(*) OVER (PARTITION BY r.ordinal) AS indexed_match_count,
             ROW_NUMBER() OVER (PARTITION BY r.ordinal ORDER BY s.global_id ASC) AS match_rank
      FROM requested r
      JOIN symbols s ON s.name=r.identifier OR s.qualified_name=r.identifier
    )
    SELECT identifier,name,qualified_name,kind,content_hash,local_id,repo_rel_path,
           indexed_match_count
    FROM matched WHERE match_rank<=?
    ORDER BY ordinal ASC,match_rank ASC
  `).all(...identifiers, MAX_MATCHES_PER_IDENTIFIER);
  const byIdentifier = new Map(identifiers.map((identifier) => [identifier, {
    identifier,
    indexedMatchCount: 0,
    truncated: false,
    matches: [],
  }]));
  for (const row of rows) {
    const evidence = byIdentifier.get(String(row.identifier));
    if (!evidence) continue;
    evidence.indexedMatchCount = Math.max(0, Number(row.indexed_match_count) || 0);
    evidence.truncated = evidence.indexedMatchCount > MAX_MATCHES_PER_IDENTIFIER;
    evidence.matches.push({
      label: String(row.name || ""),
      qualifiedName: row.qualified_name == null ? null : String(row.qualified_name),
      kind: String(row.kind || ""),
      symbolRef: `${String(row.content_hash || "")}:${Number(row.local_id) || 0}`,
      repoRelPath: String(row.repo_rel_path || ""),
    });
  }
  return identifiers.map((identifier) => byIdentifier.get(identifier));
}

function emptyEvidence(identifierPlannerMs, identifierLookupMs) {
  return {
    taskIdentifierEvidence: [],
    identifierPlannerMs,
    identifierLookupMs,
    identifierEvidenceBytes: 2,
  };
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
