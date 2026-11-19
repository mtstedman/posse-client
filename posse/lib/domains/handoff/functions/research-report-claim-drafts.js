import { AGENT_HANDOFF_ALIAS_POLICY, AGENT_HANDOFF_PROFILES } from "../../../catalog/handoff.js";
// @ts-check
import { getDb } from "../../../shared/storage/functions/index.js";
import { createAgentHandoffPacketTable, createResearchReportClaimDraftTable } from "../../../shared/storage/functions/table-definitions.js";
import { coerceList, normalizeAgentHandoffShape } from "./helpers/shape-normalizer.js";

const TABLE = "research_report_claim_drafts";
const CLAIM_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const CLAIM_NAME_ALIAS = AGENT_HANDOFF_ALIAS_POLICY.accepted.fieldAliases.claimName;
const CLAIM_EVIDENCE_LANES = Object.freeze([...new Set(
  ["researcherClaimProof", "researcherClaimSupport"].flatMap((aliasId) => {
    const { canonical, alias } = AGENT_HANDOFF_ALIAS_POLICY.accepted.fieldAliases[aliasId];
    return [canonical, alias];
  }),
)]);

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

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function carriesEvidence(claim) {
  const detail = plainObject(Array.isArray(claim) ? claim[1] : claim);
  return Boolean(detail) && CLAIM_EVIDENCE_LANES.some((lane) => (
    detail[lane] != null && !(Array.isArray(detail[lane]) && detail[lane].length === 0)
  ));
}

// The explicit claim keeps its own text and detail and takes the saved
// finding's selectors as its evidence.
function withSavedEvidence(claim, evidence) {
  if (typeof claim === "string") return { [CLAIM_NAME_ALIAS.canonical]: claim, evidence };
  if (Array.isArray(claim)) {
    if (claim[1] != null && !plainObject(claim[1])) return claim;
    return [claim[0], { ...(claim[1] || {}), evidence }, ...claim.slice(2)];
  }
  return { ...claim, evidence };
}

function mergeClaims(explicitClaims, draftClaims) {
  const merged = [];
  const indexes = new Map();
  // Merged positions of explicit claims that carry no evidence of their own.
  const evidenceless = new Set();
  // submitted[n] is the one-based merged index of the n-th entry of
  // [explicit claims..., saved findings...], or 0 for an entry with no text.
  const submitted = [];
  for (const [position, claim] of [...explicitClaims, ...draftClaims].entries()) {
    const explicit = position < explicitClaims.length;
    const text = typeof claim === "string"
      ? claim
      : Array.isArray(claim)
        ? claim[0]
        : claim?.[CLAIM_NAME_ALIAS.canonical] ?? claim?.[CLAIM_NAME_ALIAS.alias];
    const key = String(text || "").trim().replace(/\s+/g, " ").toLowerCase();
    if (!key) {
      submitted.push(0);
      continue;
    }
    if (indexes.has(key)) {
      // Explicit final claims are processed first and retain authority over an
      // exact duplicate saved earlier in the call. One that restates a saved
      // finding without evidence of its own inherits the saved evidence;
      // explicit evidence replaces the saved finding entirely.
      const index = indexes.get(key);
      if (!explicit && evidenceless.has(index)) {
        merged[index] = withSavedEvidence(merged[index], claim.evidence);
        evidenceless.delete(index);
      }
      submitted.push(index + 1);
      continue;
    }
    indexes.set(key, merged.length);
    if (explicit && !carriesEvidence(claim)) evidenceless.add(merged.length);
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

// The claims list as the agent meant it: absent is empty, and a list sent as
// JSON text or as a keyed object reads as the list (the handoff shape
// normaliser's rule). Null when no list reading exists, so the merge leaves
// the value for the validator to reject instead of replacing it.
function explicitClaimList(value) {
  if (value == null) return [];
  return coerceList(value)?.value ?? null;
}

// The report whose claims the merge extends. The merge runs before
// materialisation repairs shapes, so a handoffs list or report sent as JSON
// text is read through that same shape normaliser; a canonical envelope is
// used as it is, leaving its other repairs for materialisation to record.
function reportForMerge(copy) {
  const direct = Array.isArray(copy.handoffs) ? plainObject(copy.handoffs[0]?.report) : null;
  if (direct && (direct.claims == null || Array.isArray(direct.claims))) {
    return { envelope: copy, report: direct };
  }
  const envelope = normalizeAgentHandoffShape(copy, { role: "researcher" }).value;
  const report = Array.isArray(envelope?.handoffs) ? plainObject(envelope.handoffs[0]?.report) : null;
  return report ? { envelope, report } : null;
}

export function mergeResearchReportDraftClaims(args, agentCallId, db = getDb()) {
  const drafts = researchReportDraftClaims(agentCallId, db);
  if (drafts.length === 0 || !args || typeof args !== "object" || Array.isArray(args)) return args;
  const copy = JSON.parse(JSON.stringify(args));
  if (copy.profile !== AGENT_HANDOFF_PROFILES.RESEARCHER_REPORT) return copy;
  let merged = copy;
  let result;
  if (copy.handoffs != null) {
    const target = reportForMerge(copy);
    const explicit = target ? explicitClaimList(target.report.claims) : null;
    if (!explicit) return copy;
    result = mergeClaims(explicit, drafts);
    target.report.claims = result.merged;
    merged = target.envelope;
  } else {
    const explicit = explicitClaimList(copy.claims);
    if (!explicit) return copy;
    result = mergeClaims(explicit, drafts);
    copy.claims = result.merged;
  }
  if (Object.prototype.hasOwnProperty.call(merged, "coverage")) {
    merged.coverage = remapCoverageClaimIndexes(merged.coverage, result);
  }
  return merged;
}
