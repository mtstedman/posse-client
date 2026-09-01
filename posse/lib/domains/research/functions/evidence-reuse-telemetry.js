// Shadow-only accounting for research evidence continuity and retrieval reuse.
// The helpers in this module never choose a route: `shadow` observes the route
// that the existing handoff code took, while `off` returns before reading
// custody rows, hashing payloads, or recording an observation.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { gitCurrentHash } from "../../git/functions/utils.js";
import { jobAncestorRows } from "../../queue/functions/hash-refs.js";
import { getSetting } from "../../settings/functions/repository-settings.js";

export const RESEARCH_EVIDENCE_REUSE_OBSERVATIONS = Object.freeze({
  context: "research.evidence_reuse.context",
  coverage: "research.evidence_reuse.coverage",
  prefetch: "research.evidence_reuse.prefetch",
});

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function jsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function canonicalValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.replace(/\r\n/g, "\n");
  if (Array.isArray(value)) return value.map(canonicalValue).filter((item) => item !== undefined);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]));
  }
  return String(value);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function normalizeResearchEvidenceReuseMode(value, fallback = "shadow") {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  return normalized === "off" ? "off" : "shadow";
}

export function resolveResearchEvidenceReuseMode({ projectDir = null, getSettingFn = getSetting } = {}) {
  try {
    return normalizeResearchEvidenceReuseMode(getSettingFn(
      SETTING_KEYS.RESEARCH_EVIDENCE_REUSE,
      projectDir ? { projectDir } : {},
    ));
  } catch {
    return "shadow";
  }
}

export function atlasReuseFingerprints(action, payload, atlasVersion) {
  const normalizedAction = String(action || "").trim().toLowerCase();
  const normalizedPayload = canonicalValue(payload && typeof payload === "object" ? payload : {});
  const payloadFingerprint = sha256(canonicalJson(normalizedPayload));
  return {
    action: normalizedAction,
    normalizedPayload,
    payloadFingerprint,
    invocationFingerprint: sha256(canonicalJson({
      action: normalizedAction,
      atlas_version: atlasVersion || "unknown",
      payload: normalizedPayload,
    })),
  };
}

function normalizedRef(value) {
  const candidate = value && typeof value === "object"
    ? (value.ref ?? value.hash ?? value.ref_hash)
    : value;
  const ref = String(candidate || "").trim().toLowerCase();
  return /^#[a-z0-9._:-]+$/u.test(ref) ? ref : null;
}

export function researchEvidenceRefs(structuredData = null) {
  const data = structuredData && typeof structuredData === "object" ? structuredData : {};
  const refs = [];
  for (const lane of ["proof", "support", "decoy"]) {
    for (const entry of Array.isArray(data[lane]) ? data[lane] : []) {
      const ref = normalizedRef(entry);
      if (ref) refs.push({ lane, ref });
    }
  }
  const seen = new Set();
  return refs.filter(({ lane, ref }) => {
    const key = `${lane}:${ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function packetResearchInputs(packet) {
  const raw = packet?._raw_payload && typeof packet._raw_payload === "object"
    ? packet._raw_payload
    : {};
  return {
    continuity: raw.research_continuity && typeof raw.research_continuity === "object"
      ? raw.research_continuity
      : null,
    evidence: raw.research_evidence && typeof raw.research_evidence === "object"
      ? raw.research_evidence
      : null,
  };
}

function packetRepositoryIdentities(packet) {
  return new Set([
    packet?.atlas?.repo?.repoId,
    packet?.atlas?.repo?.repoPath,
    packet?.cwd,
  ].map((value) => String(value || "").trim()).filter(Boolean));
}

function currentSourceVersion(cwd, repoRelativePath) {
  const relative = String(repoRelativePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!cwd || !relative) return null;
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return null;
  try {
    const source = fs.readFileSync(absolute, "utf8").replace(/\r\n/g, "\n");
    return { chars: source.length, version: sha256(source) };
  } catch {
    return null;
  }
}

function coverageRowsForPacket(packet, db) {
  const workItemId = positiveInt(packet?.work_item_id);
  const jobId = positiveInt(packet?.job_id);
  if (!workItemId || !jobId) return [];
  const ancestry = jobAncestorRows(db, jobId, workItemId);
  if (ancestry.length === 0) return [];
  const placeholders = ancestry.map(() => "?").join(", ");
  return db.prepare(`
    SELECT id, job_id, attempt_id, detail_json
    FROM job_observations
    WHERE work_item_id = ?
      AND job_id IN (${placeholders})
      AND observation_type = 'source.coverage'
    ORDER BY id DESC
  `).all(workItemId, ...ancestry.map((row) => row.id));
}

function sourceRefsForOfferedRef(db, ref) {
  const refs = new Set([ref]);
  try {
    for (const row of db.prepare(`
      SELECT source_ref
      FROM hash_ref_evidence_refs
      WHERE lower(ref) = lower(?)
    `).all(ref)) {
      const sourceRef = normalizedRef(row.source_ref);
      if (sourceRef) refs.add(sourceRef);
    }
  } catch { /* compatibility database without capability rows */ }
  return refs;
}

function materializedRefChars(db, refs) {
  for (const ref of refs) {
    for (const table of ["agent_run_hash_refs", "job_hash_refs", "work_item_hash_refs"]) {
      try {
        const row = db.prepare(`
          SELECT payload_text
          FROM ${table}
          WHERE lower(ref) = lower(?) AND entry_kind = 'materialized' AND payload_text IS NOT NULL
          ORDER BY id DESC
          LIMIT 1
        `).get(ref);
        if (row?.payload_text != null) return { ref, chars: String(row.payload_text).length };
      } catch { /* continue across compatibility owner tables */ }
    }
  }
  return null;
}

function inheritedEvidenceStatus(packet, db) {
  const { continuity, evidence } = packetResearchInputs(packet);
  const offered = researchEvidenceRefs(evidence);
  const rows = coverageRowsForPacket(packet, db).map((row) => ({ row, detail: jsonObject(row.detail_json) }));
  const identities = packetRepositoryIdentities(packet);
  const statuses = offered.map(({ lane, ref }) => {
    const sourceRefs = sourceRefsForOfferedRef(db, ref);
    const materialized = materializedRefChars(db, sourceRefs);
    const candidates = rows.filter(({ detail }) => sourceRefs.has(String(detail.evidence_ref || "").toLowerCase()));
    let staleCandidate = null;
    for (const candidate of candidates) {
      const detail = candidate.detail;
      if (!["delivered", "reused"].includes(String(detail.delivery_state || ""))) continue;
      const current = currentSourceVersion(packet.cwd, detail.repo_rel_path);
      const identityCurrent = identities.has(String(detail.repository_identity || ""));
      const sourceCurrent = current?.version === detail.source_version;
      if (identityCurrent && sourceCurrent && materialized) {
        return {
          lane,
          ref,
          source_ref: materialized.ref,
          status: "materialized",
          repo_rel_path: detail.repo_rel_path || null,
          source_version: detail.source_version || null,
          start_line: Number(detail.start_line) || null,
          end_line: Number(detail.end_line) || null,
          receipt_chars: detail.returned_chars == null ? null : Number(detail.returned_chars),
          reference_chars: materialized.chars,
          current_source_chars: current?.chars ?? null,
        };
      }
      staleCandidate ||= { detail, current, identityCurrent, sourceCurrent };
    }
    if (staleCandidate) {
      return {
        lane,
        ref,
        status: "stale",
        repo_rel_path: staleCandidate.detail.repo_rel_path || null,
        source_version: staleCandidate.detail.source_version || null,
        current_source_version: staleCandidate.current?.version || null,
        stale_reason: staleCandidate.identityCurrent ? "source_version_changed" : "repository_identity_changed",
      };
    }
    return {
      lane,
      ref,
      status: "missing",
      missing_reason: candidates.length > 0 ? "reference_not_materialized" : "coverage_not_found",
    };
  });
  const materialized = statuses.filter((entry) => entry.status === "materialized").length;
  const missing = statuses.filter((entry) => entry.status === "missing").length;
  const stale = statuses.filter((entry) => entry.status === "stale").length;
  const materialRefs = statuses.filter((entry) => entry.lane !== "decoy");
  const keyFiles = [...new Set([
    ...(Array.isArray(evidence?.key_files) ? evidence.key_files : []),
    ...(Array.isArray(evidence?.planner_file_priorities)
      ? evidence.planner_file_priorities.map((entry) => entry?.path)
      : []),
  ].map((value) => String(value || "").trim()).filter(Boolean))];
  const closedCandidate = continuity?.source === "terminal_packet"
    && continuity?.profile === "researcher.pipeline.v1"
    && continuity?.freshness === "fresh"
    && !continuity?.fallback_reason
    && keyFiles.length > 0
    && materialRefs.length > 0
    && materialRefs.every((entry) => entry.status === "materialized");
  return {
    continuity,
    keyFiles,
    statuses,
    counts: { offered: offered.length, materialized, missing, stale },
    closedCandidate,
  };
}

export function recordPlannerEvidenceReuseContext(packet, {
  mode = null,
  db = getDb(),
  recordObservationFn = recordObservation,
} = {}) {
  const resolvedMode = normalizeResearchEvidenceReuseMode(
    mode ?? resolveResearchEvidenceReuseMode({ projectDir: packet?.cwd }),
  );
  if (resolvedMode === "off" || packet?.recipient !== "planner") return null;
  try {
    const snapshot = inheritedEvidenceStatus(packet, db);
    Object.defineProperty(packet, "_researchEvidenceReuseShadow", {
      value: snapshot,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    recordObservationFn({
      work_item_id: packet.work_item_id ?? null,
      job_id: packet.job_id ?? null,
      observation_type: RESEARCH_EVIDENCE_REUSE_OBSERVATIONS.context,
      summary: `Research evidence shadow: ${snapshot.counts.materialized}/${snapshot.counts.offered} refs current`,
      detail: {
        version: 1,
        mode: "shadow",
        source: snapshot.continuity?.source || null,
        profile: snapshot.continuity?.profile || null,
        freshness: snapshot.continuity?.freshness || null,
        fallback_reason: snapshot.continuity?.fallback_reason || null,
        inherited_refs: snapshot.counts,
        key_file_count: snapshot.keyFiles.length,
        closed_candidate: snapshot.closedCandidate,
        refs: snapshot.statuses.slice(0, 48),
      },
      db,
    });
    return snapshot;
  } catch {
    // Shadow accounting cannot affect the handoff route.
    return null;
  }
}

function atlasVersionForPacket(packet) {
  if (packet?._researchEvidenceReuseAtlasVersion) return packet._researchEvidenceReuseAtlasVersion;
  const indexVersion = packet?.atlas?.repo?.indexVersion
    || packet?.atlas?.repo?.versionId
    || packet?.atlas_slice_context?.ledgerVersion
    || null;
  let head = null;
  try {
    head = String(gitCurrentHash(packet?.cwd || process.cwd()) || "").trim() || null;
  } catch { /* unknown remains explicit */ }
  const version = indexVersion ? `index:${indexVersion}|head:${head || "unknown"}` : `head:${head || "unknown"}`;
  try {
    Object.defineProperty(packet, "_researchEvidenceReuseAtlasVersion", {
      value: version,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  } catch { /* a frozen packet simply recomputes */ }
  return version;
}

function priorAtlasInvocation(db, workItemId, invocationFingerprint) {
  if (!positiveInt(workItemId) || !invocationFingerprint) return false;
  try {
    return !!db.prepare(`
      SELECT 1
      FROM job_observations
      WHERE work_item_id = ?
        AND observation_type = ?
        AND json_extract(detail_json, '$.invocation_fingerprint') = ?
      LIMIT 1
    `).get(workItemId, RESEARCH_EVIDENCE_REUSE_OBSERVATIONS.prefetch, invocationFingerprint);
  } catch {
    return false;
  }
}

function collectResultSignals(value, state, key = "") {
  if (state.visited > 2_000) return;
  state.visited += 1;
  if (typeof value === "string") {
    const ref = normalizedRef(value);
    if (ref) state.refs.add(ref);
    if (/^(?:repo_rel_path|file|file_path|path|files|filepaths|candidatefiles|paths|fp|cf)$/i.test(key)) {
      const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
      if (normalized && !normalized.startsWith("/") && !normalized.includes("..")) state.files.add(normalized);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectResultSignals(item, state, key);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, child] of Object.entries(value)) collectResultSignals(child, state, childKey);
}

function resultSignals(raw, inherited = null) {
  const state = { files: new Set(), refs: new Set(), visited: 0 };
  try { collectResultSignals(JSON.parse(String(raw || "")), state); } catch { /* non-JSON failure */ }
  const inheritedFiles = new Set((inherited?.keyFiles || []).map((value) => String(value).toLowerCase()));
  const inheritedRefs = new Set((inherited?.statuses || []).map((entry) => entry.ref));
  return {
    files: state.files.size,
    evidence: state.refs.size,
    newFiles: [...state.files].filter((value) => !inheritedFiles.has(value.toLowerCase())).length,
    newEvidence: [...state.refs].filter((value) => !inheritedRefs.has(value)).length,
  };
}

export async function executeResearchEvidenceReusePrefetch(packet, action, payload, options, {
  retrievalClass = "broad",
  gapReason = null,
  execute = null,
  mode = null,
  db = getDb(),
  recordObservationFn = recordObservation,
} = {}) {
  const run = typeof execute === "function" ? execute : null;
  if (!run) throw new TypeError("executeResearchEvidenceReusePrefetch requires an executor");
  const resolvedMode = normalizeResearchEvidenceReuseMode(
    mode ?? resolveResearchEvidenceReuseMode({ projectDir: packet?.cwd }),
  );
  if (resolvedMode === "off") return run(action, payload, options);

  const atlasVersion = atlasVersionForPacket(packet);
  const fingerprints = atlasReuseFingerprints(action, payload, atlasVersion);
  const exactDuplicate = priorAtlasInvocation(db, packet?.work_item_id, fingerprints.invocationFingerprint);
  const startedAt = Date.now();
  let raw;
  let thrown = null;
  try {
    raw = await run(action, payload, options);
    return raw;
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    try {
      const inherited = packet?._researchEvidenceReuseShadow || null;
      const signals = resultSignals(raw, inherited);
      const planner = packet?.recipient === "planner";
      const wouldSuppress = planner && retrievalClass === "broad" && inherited?.closedCandidate === true;
      recordObservationFn({
        work_item_id: packet?.work_item_id ?? null,
        job_id: packet?.job_id ?? null,
        observation_type: RESEARCH_EVIDENCE_REUSE_OBSERVATIONS.prefetch,
        summary: `${packet?.recipient || "unknown"} ${retrievalClass} ${fingerprints.action} shadow observation`,
        detail: {
          version: 1,
          mode: "shadow",
          role: packet?.recipient || null,
          action: fingerprints.action,
          payload_fingerprint: fingerprints.payloadFingerprint,
          invocation_fingerprint: fingerprints.invocationFingerprint,
          atlas_version: atlasVersion,
          retrieval_class: retrievalClass,
          gap_lookup_reason: gapReason,
          exact_duplicate: exactDuplicate,
          would_suppress: wouldSuppress,
          suppression_reason: wouldSuppress ? "closed_inherited_evidence" : null,
          ok: !thrown && !String(raw || "").startsWith("Error:"),
          duration_ms: Date.now() - startedAt,
          result_files: signals.files,
          result_evidence_refs: signals.evidence,
          new_files: signals.newFiles,
          new_evidence_refs: signals.newEvidence,
        },
        db,
      });
    } catch {
      // The original result/error is authoritative; shadow telemetry is inert.
    }
  }
}

export function recordSourceCoverageReuseShadow({
  owner,
  coverage,
  stored,
  fresh,
  reason,
  requestedStartLine = null,
  requestedEndLine = null,
  coverageScope = null,
  mode = null,
  recordObservationFn = recordObservation,
} = {}) {
  const resolvedMode = normalizeResearchEvidenceReuseMode(
    mode ?? resolveResearchEvidenceReuseMode({ projectDir: owner?.cwd }),
  );
  if (resolvedMode === "off" || !owner || !coverage) return false;
  try {
    const referenceChars = stored?.entry?.payload_text == null
      ? (coverage.stored_chars == null ? null : Number(coverage.stored_chars))
      : String(stored.entry.payload_text).length;
    recordObservationFn({
      work_item_id: owner.workItemId,
      job_id: owner.jobId,
      attempt_id: owner.attemptId,
      observation_type: RESEARCH_EVIDENCE_REUSE_OBSERVATIONS.coverage,
      summary: `Strict source coverage reuse: ${reason}`,
      detail: {
        version: 1,
        mode: "shadow",
        match_kind: reason,
        coverage_scope: coverageScope,
        repository_identity: coverage.repository_identity || null,
        source_version: coverage.source_version || null,
        repo_rel_path: coverage.repo_rel_path || null,
        selector_fingerprint: coverage.selector_fingerprint || null,
        covered_start_line: Number(coverage.start_line) || null,
        covered_end_line: Number(coverage.end_line) || null,
        requested_start_line: requestedStartLine == null ? null : Number(requestedStartLine),
        requested_end_line: requestedEndLine == null ? null : Number(requestedEndLine),
        evidence_ref: coverage.evidence_ref || null,
        current_source_chars: fresh?.source == null ? null : String(fresh.source).length,
        receipt_chars: coverage.returned_chars == null ? null : Number(coverage.returned_chars),
        reference_chars: referenceChars,
        agent_call_id: owner.agentCallId,
      },
      db: owner.db,
    });
    return true;
  } catch {
    return false;
  }
}
