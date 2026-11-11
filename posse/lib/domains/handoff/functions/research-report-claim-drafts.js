import { AGENT_HANDOFF_PROFILES } from "../../../catalog/handoff.js";
// @ts-check
import { getDb } from "../../../shared/storage/functions/index.js";
import { createAgentHandoffPacketTable, createResearchReportClaimDraftTable } from "../../../shared/storage/functions/table-definitions.js";

const TABLE = "research_report_claim_drafts";
const CLAIM_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

function fail(code, message) {
  const error = /** @type {Error & { code: string }} */ (new Error(message));
  error.code = code;
  throw error;
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("RESEARCH_REPORT_DRAFT_INVALID", `${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const source = objectValue(value, label);
  const extra = Object.keys(source).find((key) => !allowed.includes(key));
  if (extra) fail("RESEARCH_REPORT_DRAFT_INVALID", `${label}.${extra} is not allowed`);
  return source;
}

function boundedString(value, label, maxLength = Infinity) {
  const text = String(value ?? "").trim();
  if (!text) fail("RESEARCH_REPORT_DRAFT_INVALID", `${label} is required`);
  if (text.length > maxLength) {
    fail("RESEARCH_REPORT_DRAFT_TOO_LARGE", `${label} exceeds ${maxLength} characters`);
  }
  return text;
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function ensureSchema(db) {
  createAgentHandoffPacketTable(db);
  createResearchReportClaimDraftTable(db);
  return db;
}

function resolveCall(context, role, db) {
  const agentCallId = positiveInt(context?.agentCallId ?? context?.agent_call_id);
  if (!agentCallId) {
    fail("RESEARCH_REPORT_DRAFT_CONTEXT_INVALID", "agent_claim requires an active agent call");
  }
  const call = db.prepare(`
    SELECT id, attempt_id, role
    FROM agent_calls
    WHERE id = ?
  `).get(agentCallId);
  if (!call) fail("RESEARCH_REPORT_DRAFT_CONTEXT_INVALID", "agent_claim agent call does not exist");
  const effectiveRole = String(call.role || role || "").trim().toLowerCase();
  if (effectiveRole !== "researcher") {
    fail("RESEARCH_REPORT_DRAFT_ROLE_INVALID", "agent_claim is available only to the researcher role");
  }
  const staged = db.prepare(`
    SELECT status FROM agent_handoff_packets WHERE agent_call_id = ?
  `).get(agentCallId);
  if (staged && ["staged", "committed"].includes(staged.status)) {
    fail("RESEARCH_REPORT_DRAFT_TERMINAL", "the terminal agent_handoff is already staged");
  }
  return {
    agentCallId,
    attemptId: positiveInt(call.attempt_id),
  };
}

function normalizeSelector(value, label) {
  const selector = boundedString(value, label);
  if (!selector.startsWith("#") && !selector.includes(":")) {
    fail("RESEARCH_REPORT_DRAFT_INVALID", `${label} must be a visible #ref or surfaced path range`);
  }
  return selector;
}

function normalizeDraftClaim(value, index) {
  const label = `claims[${index}]`;
  const source = exactKeys(value, ["id", "claim", "evidence"], label);
  const id = boundedString(source.id, `${label}.id`, 64);
  if (!CLAIM_ID_PATTERN.test(id)) {
    fail("RESEARCH_REPORT_DRAFT_INVALID", `${label}.id must match ${CLAIM_ID_PATTERN}`);
  }
  const claim = boundedString(source.claim, `${label}.claim`);
  if (!Array.isArray(source.evidence) || source.evidence.length < 1) {
    fail("RESEARCH_REPORT_DRAFT_INVALID", `${label}.evidence must contain at least one selector`);
  }
  const evidence = source.evidence.map((selector, selectorIndex) => (
    normalizeSelector(selector, `${label}.evidence[${selectorIndex}]`)
  ));
  return { id, claim, evidence: [...new Set(evidence)] };
}

function listRows(agentCallId, db) {
  return db.prepare(`
    SELECT claim_id, position, claim_json
    FROM ${TABLE}
    WHERE agent_call_id = ?
    ORDER BY position ASC, claim_id ASC
  `).all(agentCallId).map((row, rank) => ({
    id: row.claim_id,
    // One-based saved order without the gaps `position` keeps after a remove.
    // Terminal coverage numbers a saved finding as (claims in that
    // agent_handoff call) + index; see mergeResearchReportDraftClaims.
    index: rank + 1,
    position: Number(row.position),
    ...JSON.parse(row.claim_json),
  }));
}

export function executeResearchReportClaims(args = {}, {
  context = {},
  role = "",
  db = getDb(),
} = {}) {
  const database = ensureSchema(db);
  const call = resolveCall(context, role, database);
  const source = exactKeys(args, ["op", "claims", "ids"], "agent_claim");
  const op = boundedString(source.op, "agent_claim.op", 12);
  if (!new Set(["put", "remove", "list"]).has(op)) {
    fail("RESEARCH_REPORT_DRAFT_INVALID", "agent_claim.op must be put, remove, or list");
  }

  if (op === "list") {
    if (source.claims != null || source.ids != null) {
      fail("RESEARCH_REPORT_DRAFT_INVALID", "agent_claim list accepts no claims or ids");
    }
    const drafts = listRows(call.agentCallId, database);
    return { ok: true, op, count: drafts.length, drafts };
  }

  if (op === "remove") {
    if (source.claims != null || !Array.isArray(source.ids) || source.ids.length < 1 || source.ids.length > 12) {
      fail("RESEARCH_REPORT_DRAFT_INVALID", "agent_claim remove requires 1 to 12 ids and no claims");
    }
    const ids = [...new Set(source.ids.map((value, index) => {
      const id = boundedString(value, `agent_claim.ids[${index}]`, 64);
      if (!CLAIM_ID_PATTERN.test(id)) {
        fail("RESEARCH_REPORT_DRAFT_INVALID", `agent_claim.ids[${index}] is invalid`);
      }
      return id;
    }))];
    const remove = database.prepare(`DELETE FROM ${TABLE} WHERE agent_call_id = ? AND claim_id = ?`);
    const removed = database.transaction(() => ids.reduce(
      (count, id) => count + Number(remove.run(call.agentCallId, id).changes || 0),
      0,
    ))();
    return { ok: true, op, removed, count: listRows(call.agentCallId, database).length };
  }

  if (source.ids != null || !Array.isArray(source.claims) || source.claims.length < 1) {
    fail("RESEARCH_REPORT_DRAFT_INVALID", "agent_claim put requires at least one claim and no ids");
  }
  const claims = source.claims.map(normalizeDraftClaim);
  if (new Set(claims.map((claim) => claim.id)).size !== claims.length) {
    fail("RESEARCH_REPORT_DRAFT_INVALID", "agent_claim put contains duplicate ids");
  }
  const upsert = database.prepare(`
    INSERT INTO ${TABLE} (agent_call_id, claim_id, attempt_id, position, claim_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(agent_call_id, claim_id) DO UPDATE SET
      claim_json = excluded.claim_json,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);
  database.transaction(() => {
    const existingIds = new Set(database.prepare(`
      SELECT claim_id FROM ${TABLE} WHERE agent_call_id = ?
    `).all(call.agentCallId).map((row) => row.claim_id));
    let position = Number(database.prepare(`
      SELECT COALESCE(MAX(position), 0) + 1 AS position FROM ${TABLE} WHERE agent_call_id = ?
    `).get(call.agentCallId)?.position || 1);
    for (const claim of claims) {
      upsert.run(
        call.agentCallId,
        claim.id,
        call.attemptId,
        position,
        JSON.stringify({ claim: claim.claim, evidence: claim.evidence }),
      );
      if (!existingIds.has(claim.id)) position += 1;
    }
  })();
  return {
    ok: true,
    op,
    saved: claims.map((claim) => claim.id),
    count: listRows(call.agentCallId, database).length,
  };
}

export function researchReportDraftClaims(agentCallId, db = getDb()) {
  const id = positiveInt(agentCallId);
  if (!id) return [];
  return listRows(id, ensureSchema(db)).map(({ id: _id, index: _index, position: _position, ...claim }) => claim);
}

function mergeClaims(explicitClaims, draftClaims) {
  const merged = [];
  const indexes = new Map();
  // submitted[n] is the one-based merged index of the n-th entry of
  // [explicit claims..., saved findings...], or 0 for an entry with no text.
  const submitted = [];
  for (const claim of [...explicitClaims, ...draftClaims]) {
    const text = typeof claim === "string"
      ? claim
      : Array.isArray(claim)
        ? claim[0]
        : claim?.claim;
    const key = String(text || "").trim().replace(/\s+/g, " ").toLowerCase();
    if (!key) {
      submitted.push(0);
      continue;
    }
    if (indexes.has(key)) {
      // Explicit final claims are processed first and retain authority over an
      // exact duplicate saved earlier in the call.
      submitted.push(indexes.get(key) + 1);
      continue;
    }
    indexes.set(key, merged.length);
    merged.push(claim);
    submitted.push(merged.length);
  }
  return { merged, submitted };
}

// The model numbers coverage claim_indexes as it can see them: the claims of
// this call first (1..N, in order), then its saved findings in saved order
// (N + agent_claim list `index`). Dropping duplicates shifts the merged order
// away from that numbering, so translate each index to the merged claim it
// names. Malformed coverage is left for the coverage validator; an index that
// names no claim maps past the merged list so it is still reported as unknown.
function remapCoverageClaimIndexes(coverage, { merged, submitted }) {
  if (!Array.isArray(coverage)) return coverage;
  return coverage.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const claimIndexes = entry.claim_indexes;
    if (!Array.isArray(claimIndexes)
      || !claimIndexes.every((value) => Number.isInteger(value) && value >= 1)
      || new Set(claimIndexes).size !== claimIndexes.length) {
      return entry;
    }
    const mapped = claimIndexes.map((value) => submitted[value - 1] || merged.length + value);
    return { ...entry, claim_indexes: [...new Set(mapped)] };
  });
}

export function mergeResearchReportDraftClaims(args, agentCallId, db = getDb()) {
  const drafts = researchReportDraftClaims(agentCallId, db);
  if (drafts.length === 0 || !args || typeof args !== "object" || Array.isArray(args)) return args;
  const copy = JSON.parse(JSON.stringify(args));
  if (copy.profile !== AGENT_HANDOFF_PROFILES.RESEARCHER_REPORT) return copy;
  let result;
  if (Array.isArray(copy.handoffs)) {
    const report = copy.handoffs[0]?.report;
    if (!report || typeof report !== "object") return copy;
    result = mergeClaims(Array.isArray(report.claims) ? report.claims : [], drafts);
    report.claims = result.merged;
  } else {
    result = mergeClaims(Array.isArray(copy.claims) ? copy.claims : [], drafts);
    copy.claims = result.merged;
  }
  if (Object.prototype.hasOwnProperty.call(copy, "coverage")) {
    copy.coverage = remapCoverageClaimIndexes(copy.coverage, result);
  }
  return copy;
}
