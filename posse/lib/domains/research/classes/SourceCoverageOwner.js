import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getDb } from "../../../shared/storage/functions/index.js";
import { fetchHashRefForContext, surfaceHashRefForContext } from "../../queue/functions/hash-refs.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { hashRefModelVisibility } from "../../../shared/tools/functions/fetch-ref-policy.js";
import { evidenceRefSurface } from "../../../shared/tools/functions/ref-surface.js";
import { splitEditableLines } from "../../../shared/tools/functions/toolkit/structured-read.js";
import { normalizeAtlasIdentifierList } from "../../atlas/functions/v2/contracts/identifiers.js";

const COVERAGE_OBSERVATION = "source.coverage";
const activeReservations = new Map();
const RESERVATION_WAIT_MS = 1_500;
const RESERVATION_LEASE_MS = 5_000;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? "").replace(/\r\n/g, "\n")).digest("hex");
}

function stable(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

// SC-1: `maxTokens` is an independent output cap, so it is part of partial
// selector identity. Without it a truncated request at maxTokens 200 and an
// otherwise identical retry at 1200 shared a fingerprint, and the wider retry
// was answered with the narrower stored region instead of being executed.
// Cross-window-size reuse remains available, but only through the separate
// verified complete-symbol fingerprint below.
export function normalizedSelectorMaxTokens(value) {
  const maxTokens = Number(value);
  return Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : null;
}

export function sourceSelectorFingerprint(args = {}) {
  return sha256(stable({
    symbolId: args.symbolId || null,
    file: args.file ? String(args.file).replace(/\\/g, "/") : null,
    identifiersToFind: Array.isArray(args.identifiersToFind)
      ? [...new Set(args.identifiersToFind.map(String))].sort()
      : [],
    expectedLines: Number(args.expectedLines) || null,
    // code.window's public default is symbol granularity. Canonicalize the
    // omitted form so a model does not miss delivered coverage merely because
    // it relied on that default.
    granularity: args.granularity || "symbol",
    maxTokens: normalizedSelectorMaxTokens(args.maxTokens),
    sliceContext: args.sliceContext || null,
  }));
}

// A verified full-symbol body can satisfy a later request for the same symbol
// even when the caller chooses a different output window size. Keep this key
// deliberately narrower than sourceSelectorFingerprint: multi-symbol,
// slice-context, symbolId-overridden, and non-symbol requests still require an
// exact selector match.
export function completeSymbolSelectorFingerprint(args = {}) {
  const identifiers = Array.isArray(args.identifiersToFind) ? args.identifiersToFind : [];
  const normalizedIdentifiers = normalizeAtlasIdentifierList(identifiers, 2);
  const file = normalizePath(args.file);
  const granularity = String(args.granularity || "symbol").trim().toLowerCase();
  if (
    !file
    || args.symbolId
    || args.sliceContext != null
    || granularity !== "symbol"
    || identifiers.length !== 1
    || normalizedIdentifiers.length !== 1
  ) return null;
  return sha256(stable({
    file,
    identifier: normalizedIdentifiers[0],
    granularity,
  }));
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function rowDetail(row) {
  try { return JSON.parse(String(row?.detail_json || "{}")); } catch { return null; }
}

function contextFor(owner) {
  return {
    work_item_id: owner.workItemId,
    job_id: owner.jobId,
    attempt_id: owner.attemptId,
    agent_call_id: owner.agentCallId,
  };
}

function isCompleteSourceDelivery(data = {}) {
  if (data.truncated === true || data.selectionBounded === true || data.outputTruncated === true) return false;
  if (Array.isArray(data.additionalWindows) && data.additionalWindows.length > 0) return false;
  if (Number(data.returnedFunctionAnchorsOmitted) > 0) return false;
  if (String(data.traversal_ref?.ref || data.traversal_ref || data.continuationRef || "").trim()) return false;
  if (Number(data.continuationWindows) > 0) return false;
  if (Array.isArray(data._continuationWindows) && data._continuationWindows.length > 0) return false;
  return true;
}

function releaseReservation(reservation, outcome) {
  if (!reservation?.key || activeReservations.get(reservation.key) !== reservation) return false;
  activeReservations.delete(reservation.key);
  clearTimeout(reservation.expiryTimer);
  reservation.settle?.(outcome);
  return true;
}

export class SourceCoverageOwner {
  /** @param {{cwd?: string, workItemId?: number | null, jobId?: number | null, attemptId?: number | null, agentCallId?: number | null, repositoryIdentity?: string | null, db?: any}} [options] */
  constructor({ cwd, workItemId, jobId, attemptId, agentCallId, repositoryIdentity = null, db = getDb() } = {}) {
    this.cwd = path.resolve(cwd || process.cwd());
    this.workItemId = Number(workItemId) || null;
    this.jobId = Number(jobId) || null;
    this.attemptId = Number(attemptId) || null;
    this.agentCallId = Number(agentCallId) || null;
    this.repositoryIdentity = String(repositoryIdentity || this.cwd);
    this.db = db;
  }

  #freshSource(repoRelativePath) {
    const relative = normalizePath(repoRelativePath);
    const absolute = path.resolve(this.cwd, relative);
    const prefix = `${this.cwd}${path.sep}`;
    if (absolute !== this.cwd && !absolute.startsWith(prefix)) return null;
    try {
      const source = fs.readFileSync(absolute, "utf8").replace(/\r\n/g, "\n");
      return { relative, source, sourceVersion: sha256(source) };
    } catch {
      return null;
    }
  }

  #rows() {
    if (!this.jobId || !this.attemptId) return [];
    return this.db.prepare(`
      SELECT id, detail_json
      FROM job_observations
      WHERE job_id = ? AND attempt_id = ? AND observation_type = ?
      ORDER BY id DESC
    `).all(this.jobId, this.attemptId, COVERAGE_OBSERVATION);
  }

  #authorization(coverage) {
    const token = crypto.randomBytes(24).toString("base64url");
    this.db.prepare(`
      INSERT INTO source_reaccess_authorizations (
        token_hash, work_item_id, job_id, attempt_id, agent_call_id,
        evidence_ref, coverage_observation_id, max_uses, uses
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)
    `).run(
      sha256(token), this.workItemId, this.jobId, this.attemptId,
      this.agentCallId, coverage.evidence_ref, coverage.observationId,
    );
    return token;
  }

  #coveredResult(row, coverage, reason) {
    const stored = fetchHashRefForContext(
      contextFor(this),
      coverage.evidence_ref,
      { db: this.db },
    );
    if (!stored?.ok || !stored?.found) return null;
    const authorization = this.#authorization({ ...coverage, observationId: row.id });
    return {
      covered: true,
      reason,
      result: {
        status: "covered",
        executed: false,
        repo_rel_path: coverage.repo_rel_path,
        startLine: coverage.start_line,
        endLine: coverage.end_line,
        contentSha256: coverage.content_sha256,
        evidence_ref: evidenceRefSurface(coverage.evidence_ref),
        reaccess: {
          ref: coverage.evidence_ref,
          authorization,
          maxUses: 1,
        },
      },
    };
  }

  admit(args = {}) {
    if (!this.attemptId) return { covered: false, reason: "missing_attempt" };
    const requestedFile = args.symbolId ? "" : normalizePath(args.file);
    if (requestedFile) {
      for (const row of this.#rows()) {
        const coverage = rowDetail(row);
        if (!coverage || coverage.delivery_state !== "delivered" || coverage.complete_file !== true) continue;
        if (coverage.repository_identity !== this.repositoryIdentity) continue;
        if (normalizePath(coverage.repo_rel_path) !== requestedFile) continue;
        const fresh = this.#freshSource(requestedFile);
        if (!fresh || fresh.sourceVersion !== coverage.source_version) continue;
        const result = this.#coveredResult(row, coverage, "complete_file");
        if (result) return result;
      }
    }
    const fingerprint = sourceSelectorFingerprint(args);
    const completeSymbolFingerprint = completeSymbolSelectorFingerprint(args);
    const current = [];
    for (const row of this.#rows()) {
      const coverage = rowDetail(row);
      if (!coverage) continue;
      if (coverage.repository_identity !== this.repositoryIdentity) continue;
      const selectorMatch = coverage.selector_fingerprint === fingerprint
        ? "exact_selector"
        : (completeSymbolFingerprint && coverage.complete_symbol_selector_fingerprint === completeSymbolFingerprint
          ? "complete_symbol"
          : null);
      if (!selectorMatch) continue;
      const fresh = this.#freshSource(coverage.repo_rel_path);
      if (!fresh || fresh.sourceVersion !== coverage.source_version) continue;
      current.push({ row, coverage, selectorMatch });
    }
    const latestByRegion = new Map();
    for (const entry of current) {
      const key = [
        entry.coverage.repo_rel_path,
        entry.coverage.start_line,
        entry.coverage.end_line,
        entry.coverage.content_sha256,
        entry.coverage.evidence_ref,
      ].join(":");
      if (!latestByRegion.has(key)) latestByRegion.set(key, entry);
    }
    const latest = [...latestByRegion.values()];
    if (latest.some(({ coverage }) => coverage.delivery_state === "available_unseen")) {
      return { covered: false, reason: "continuation_unseen" };
    }
    const delivered = new Map();
    for (const entry of latest) {
      if (entry.coverage.delivery_state !== "delivered") continue;
      delivered.set([
        entry.coverage.repo_rel_path,
        entry.coverage.start_line,
        entry.coverage.end_line,
        entry.coverage.content_sha256,
        entry.coverage.evidence_ref,
      ].join(":"), entry);
    }
    // One covered response carries one canonical evidence ref. Multiple
    // disjoint regions remain reachable but cannot safely stand in for the
    // selector as a whole, so exact-selector admission fails open.
    if (delivered.size === 1) {
      const [{ row, coverage, selectorMatch }] = delivered.values();
      const result = this.#coveredResult(row, coverage, selectorMatch);
      if (result) return result;
    }
    if (delivered.size > 1) return { covered: false, reason: "multiple_regions_fail_open" };
    return { covered: false, reason: "uncovered" };
  }

  admitResolvedInterval({ repoRelativePath, startLine, endLine } = {}) {
    if (!this.attemptId) return { covered: false, reason: "missing_attempt" };
    const relative = normalizePath(repoRelativePath);
    const rawStart = Number(startLine);
    const rawEnd = Number(endLine);
    if (!relative || !Number.isInteger(rawStart) || rawStart < 1 || !Number.isInteger(rawEnd) || rawEnd < rawStart) {
      return { covered: false, reason: "invalid_interval" };
    }
    const requestedStart = rawStart;
    const requestedEnd = rawEnd;
    for (const row of this.#rows()) {
      const coverage = rowDetail(row);
      if (!coverage || coverage.delivery_state !== "delivered") continue;
      if (coverage.repository_identity !== this.repositoryIdentity) continue;
      if (normalizePath(coverage.repo_rel_path) !== relative) continue;
      if (Number(coverage.start_line) > requestedStart || Number(coverage.end_line) < requestedEnd) continue;
      const fresh = this.#freshSource(relative);
      if (!fresh || fresh.sourceVersion !== coverage.source_version) continue;
      const result = this.#coveredResult(row, coverage, "contained_interval");
      if (result) return result;
    }
    return { covered: false, reason: "uncovered" };
  }

  hasDeliveredCoverageForPath(repoRelativePath) {
    if (!this.attemptId) return false;
    const relative = normalizePath(repoRelativePath);
    if (!relative) return false;
    const fresh = this.#freshSource(relative);
    if (!fresh) return false;
    return this.#rows().some((row) => {
      const coverage = rowDetail(row);
      return coverage?.delivery_state === "delivered"
        && coverage.repository_identity === this.repositoryIdentity
        && normalizePath(coverage.repo_rel_path) === relative
        && coverage.source_version === fresh.sourceVersion;
    });
  }

  async admitOrReserve(args = {}) {
    const admitted = this.admit(args);
    if (admitted.covered || !this.attemptId) return admitted;
    const key = `${this.jobId}:${this.attemptId}:${this.repositoryIdentity}:${sourceSelectorFingerprint(args)}`;
    let active = activeReservations.get(key);
    if (active && active.expiresAt <= Date.now()) {
      releaseReservation(active, "lease_expired");
      active = null;
    }
    if (active) {
      let timedOut = false;
      await Promise.race([
        active.promise,
        new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(); }, RESERVATION_WAIT_MS)),
      ]);
      const joined = this.admit(args);
      if (joined.covered) return { ...joined, reservation: "joined" };
      return { covered: false, reason: timedOut ? "reservation_timeout_fail_open" : "reservation_failed_fail_open" };
    }
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    const reservation = {
      key,
      promise,
      settle,
      expiresAt: Date.now() + RESERVATION_LEASE_MS,
      expiryTimer: null,
    };
    activeReservations.set(key, reservation);
    reservation.expiryTimer = setTimeout(() => {
      releaseReservation(reservation, "lease_expired");
    }, RESERVATION_LEASE_MS);
    reservation.expiryTimer.unref?.();
    return { covered: false, reason: "reserved", reservation };
  }

  settleReservation(reservation, outcome = "released") {
    releaseReservation(reservation, outcome);
  }

  prepareData(data, args = {}) {
    if (!this.attemptId || !data || typeof data !== "object" || typeof data.content !== "string" || !data.content) {
      return null;
    }
    const fresh = this.#freshSource(data.repo_rel_path);
    if (!fresh) return null;
    const startLine = Math.max(1, Math.floor(Number(data.startLine) || 1));
    const requestedEndLine = Math.max(startLine, Math.floor(Number(data.endLine) || startLine));
    const sourceLines = splitEditableLines(fresh.source).lines;
    if (startLine > sourceLines.length) return null;
    const endLine = Math.min(requestedEndLine, sourceLines.length);
    const content = data.content.replace(/\r\n/g, "\n");
    const contentSha256 = sha256(content);
    const sourceSlice = sourceLines.slice(startLine - 1, endLine).join("\n");
    const sourceSliceWithFinalEol = endLine === sourceLines.length && fresh.source.endsWith("\n")
      ? `${sourceSlice}\n`
      : null;
    if (sourceSlice !== content && sourceSliceWithFinalEol !== content) return null;
    const selectorFingerprint = sourceSelectorFingerprint(args);
    const completeFile = !args.symbolId
      && normalizePath(args.file) === fresh.relative
      && startLine === 1
      && endLine === sourceLines.length
      && isCompleteSourceDelivery(data);
    data.startLine = startLine;
    data.endLine = endLine;
    data.contentSha256 = contentSha256;
    data.sourceVersion = fresh.sourceVersion;
    data.repositoryIdentity = this.repositoryIdentity;
    return { fresh, startLine, endLine, content, contentSha256, selectorFingerprint, completeFile };
  }

  materializeData(data, args = {}, {
    origin = "primary",
    deliveryState = "delivered",
    completeSymbolSelector = null,
    tool = "code.window",
  } = {}) {
    const prepared = this.prepareData(data, args);
    if (!prepared) return null;
    const { fresh, startLine, endLine, content, contentSha256, selectorFingerprint } = prepared;
    const completeFile = origin === "primary" && prepared.completeFile;
    const completeSymbolFingerprint = completeSymbolSelectorFingerprint(completeSymbolSelector || {});
    const existing = this.#rows().find((row) => {
      const coverage = rowDetail(row);
      return coverage?.delivery_state === deliveryState
        && coverage.repository_identity === this.repositoryIdentity
        && coverage.source_version === fresh.sourceVersion
        && normalizePath(coverage.repo_rel_path) === fresh.relative
        && Number(coverage.start_line) === startLine
        && Number(coverage.end_line) === endLine
        && coverage.content_sha256 === contentSha256
        && coverage.selector_fingerprint === selectorFingerprint
        && coverage.complete_file === completeFile
        && (coverage.complete_symbol_selector_fingerprint || null) === completeSymbolFingerprint;
    });
    const existingCoverage = rowDetail(existing);
    if (existingCoverage?.evidence_ref) {
      const stored = fetchHashRefForContext(contextFor(this), existingCoverage.evidence_ref, { db: this.db });
      if (stored?.ok && stored?.found) {
        data.contentSha256 = contentSha256;
        data.evidence_ref = evidenceRefSurface(existingCoverage.evidence_ref, {
          exactField: "content",
          chars: content.length,
        });
        delete data.sourceVersion;
        delete data.repositoryIdentity;
        return { ref: existingCoverage.evidence_ref, contentSha256, storedChars: content.length, reused: true };
      }
    }
    let surfaced;
    try {
      surfaced = surfaceHashRefForContext(contextFor(this), {
        entryKind: "materialized",
        payloadText: content,
        descriptor: {
          kind: "source_coverage",
          tool,
          args,
          repo_rel_path: fresh.relative,
          start_line: startLine,
          end_line: endLine,
        },
        objectType: `atlas.${tool}.source_region`,
        source: `tool:${tool}`,
        note: `${fresh.relative}:${startLine}-${endLine}`,
        sizeChars: content.length,
        recomputable: true,
        metadata: {
          surfaced_by: "source_coverage_owner",
          fetch_class: "source_reaccess",
          repository_identity: this.repositoryIdentity,
          source_version: fresh.sourceVersion,
          repo_rel_path: fresh.relative,
          path: fresh.relative,
          start_line: startLine,
          end_line: endLine,
          line_semantics: "source",
          source_payload_encoding: "raw_source_lines",
          source_windows: [{
            path: fresh.relative,
            source_start_line: startLine,
            source_end_line: endLine,
            materialized_start_line: 1,
            materialized_end_line: endLine - startLine + 1,
          }],
          content_sha256: contentSha256,
          ...hashRefModelVisibility(contextFor(this), {
            visibility: deliveryState === "delivered" ? "full" : "hidden",
            ranges: deliveryState === "delivered" ? [{ start: 0, end: content.length }] : [],
            issuedAs: deliveryState === "delivered" ? "evidence" : "traversal",
          }),
        },
      }, { ownerScope: "job", db: this.db });
    } catch (error) {
      try {
        recordObservation({
          work_item_id: this.workItemId,
          job_id: this.jobId,
          attempt_id: this.attemptId,
          observation_type: "hash_ref.surface_failed",
          summary: `Failed to surface ${tool} source coverage as hash ref`,
          detail: {
            tool,
            path: fresh.relative,
            start_line: startLine,
            end_line: endLine,
            size_chars: content.length,
            error: String(error?.message || error).slice(0, 500),
            agent_call_id: this.agentCallId,
          },
        });
      } catch {
        // Evidence surfacing already failed; telemetry must not fail the read.
      }
      delete data.sourceVersion;
      delete data.repositoryIdentity;
      return null;
    }
    if (!surfaced?.ok || !surfaced?.entry?.ref) {
      delete data.sourceVersion;
      delete data.repositoryIdentity;
      return null;
    }
    data.contentSha256 = contentSha256;
    data.evidence_ref = evidenceRefSurface(surfaced.entry.ref, {
      exactField: "content",
      chars: content.length,
    });
    recordObservation({
      work_item_id: this.workItemId,
      job_id: this.jobId,
      attempt_id: this.attemptId,
      observation_type: COVERAGE_OBSERVATION,
      summary: `${deliveryState} source coverage ${fresh.relative}:${startLine}-${endLine}`,
      detail: {
        repository_identity: this.repositoryIdentity,
        source_version: fresh.sourceVersion,
        repo_rel_path: fresh.relative,
        start_line: startLine,
        end_line: endLine,
        content_sha256: contentSha256,
        selector_fingerprint: selectorFingerprint,
        complete_file: completeFile,
        complete_symbol_selector_fingerprint: completeSymbolFingerprint,
        evidence_ref: surfaced.entry.ref,
        delivery_state: deliveryState,
        tool,
        origin,
        agent_call_id: this.agentCallId,
        stored_chars: content.length,
        returned_chars: deliveryState === "delivered" ? content.length : 0,
      },
    });
    delete data.sourceVersion;
    delete data.repositoryIdentity;
    return { ref: surfaced.entry.ref, contentSha256, storedChars: content.length };
  }
}

export function consumeSourceReaccessAuthorization({ authorization, ref, context = {}, db = getDb() } = {}) {
  const tokenHash = sha256(String(authorization || ""));
  const attemptId = Number(context.attempt_id ?? context.attemptId) || null;
  const agentCallId = Number(context.agent_call_id ?? context.agentCallId) || null;
  if (!authorization || !attemptId || !agentCallId) return { allowed: false, reason: "invalid_scope" };
  const transaction = db.transaction(() => {
    const update = db.prepare(`
      UPDATE source_reaccess_authorizations
      SET uses = uses + 1,
          consumed_at = CASE WHEN uses + 1 >= max_uses THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE consumed_at END
      WHERE token_hash = ? AND attempt_id = ? AND agent_call_id = ?
        AND evidence_ref = ? AND uses < max_uses
    `).run(tokenHash, attemptId, agentCallId, String(ref || ""));
    if (update.changes !== 1) return null;
    return db.prepare(`SELECT * FROM source_reaccess_authorizations WHERE token_hash = ?`).get(tokenHash);
  });
  const row = transaction.immediate();
  return row ? { allowed: true, row } : { allowed: false, reason: "invalid_or_consumed" };
}
