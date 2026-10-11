import { getDb } from "../../../shared/storage/functions/index.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { positiveInt } from "./helpers/rejection-store.js";
import { canonicalSourcePath } from "./evidence-source-path.js";

export function recordAtlasTrunkHitRate(packet, context) {
  const database = context?.db || getDb();
  const jobId = positiveInt(context?.jobId ?? context?.job_id);
  const attemptId = positiveInt(context?.attemptId ?? context?.attempt_id);
  if (!jobId) return false;
  try {
    const row = database.prepare(`
      SELECT detail_json
      FROM job_observations
      WHERE job_id = ?
        AND observation_type = 'atlas.prefetch.trunk'
        AND (? IS NULL OR attempt_id = ?)
      ORDER BY id DESC
      LIMIT 1
    `).get(jobId, attemptId, attemptId);
    if (!row?.detail_json) return false;
    const trunk = JSON.parse(row.detail_json);
    const rankedFiles = canonicalPathList(trunk?.ranked_files);
    const surveyFiles = canonicalPathList(trunk?.survey_files);
    const pointedFiles = canonicalPathList(
      Array.isArray(trunk?.pointed_files)
        ? trunk.pointed_files
        : [...rankedFiles, ...surveyFiles],
    );
    const citedFiles = citedSourcePaths(packet);
    const pointed = new Set(pointedFiles);
    const hitFiles = citedFiles.filter((file) => pointed.has(file));
    // Prefetch fetches, redacts and ledgers real source. Whether that work is
    // reaching the reader, or being paid for twice, is only visible by asking
    // which prefetched files were read again from the agent's own budget.
    const prefetchYield = atlasPrefetchReadYield(database, jobId, attemptId);
    const hitRate = citedFiles.length > 0 ? hitFiles.length / citedFiles.length : null;
    const pointedPrecision = pointedFiles.length > 0 ? hitFiles.length / pointedFiles.length : null;
    return recordObservation({
      db: database,
      work_item_id: positiveInt(context?.workItemId ?? context?.work_item_id),
      job_id: jobId,
      attempt_id: attemptId,
      observation_type: "atlas.prefetch.trunk_hit_rate",
      summary: `ATLAS trunk covered ${hitFiles.length}/${citedFiles.length} terminally cited file(s)`,
      detail: {
        kind: "atlas_prefetch_trunk_hit_rate",
        ranked_files: rankedFiles,
        survey_files: surveyFiles,
        pointed_files: pointedFiles,
        cited_files: citedFiles,
        hit_files: hitFiles,
        pointed_file_count: pointedFiles.length,
        cited_file_count: citedFiles.length,
        hit_file_count: hitFiles.length,
        hit_rate: hitRate,
        pointed_precision: pointedPrecision,
        ...prefetchYield,
      },
    });
  } catch {
    return false;
  }
}

/**
 * How much of what prefetch delivered the agent then paid to read again.
 * Read-only telemetry: a prefetched window the agent re-reads is work stored
 * twice, and a prefetched file it never touches is work with no reader.
 *
 * @param {any} database
 * @param {number} jobId
 * @param {number|null} attemptId
 * @returns {Record<string, unknown>}
 */
function atlasPrefetchReadYield(database, jobId, attemptId) {
  try {
    const rows = database.prepare(`
      SELECT detail_json
      FROM job_observations
      WHERE job_id = ?
        AND (? IS NULL OR attempt_id = ?)
        AND observation_type = 'source.coverage'
      ORDER BY id ASC
    `).all(jobId, attemptId, attemptId);
    const prefetched = new Set();
    const readAgain = new Set();
    let rereadCalls = 0;
    for (const row of rows) {
      let detail = {};
      try { detail = JSON.parse(String(row.detail_json || "{}")); } catch { continue; }
      const coverage = detail?.coverage && typeof detail.coverage === "object" ? detail.coverage : detail;
      const sourcePath = canonicalSourcePath(coverage?.repo_rel_path);
      if (!sourcePath) continue;
      const origin = String(detail?.origin || coverage?.origin || "");
      if (origin === "prefetch") { prefetched.add(sourcePath); continue; }
      if (!prefetched.has(sourcePath)) continue;
      readAgain.add(sourcePath);
      rereadCalls += 1;
    }
    return {
      prefetched_file_count: prefetched.size,
      prefetched_files_read_again: readAgain.size,
      prefetched_reread_calls: rereadCalls,
    };
  } catch {
    return {};
  }
}

function citedSourcePaths(packet) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const sourcePath = canonicalSourcePath(value);
    if (!sourcePath || seen.has(sourcePath)) return;
    seen.add(sourcePath);
    out.push(sourcePath);
  };
  for (const handoff of Array.isArray(packet?.handoffs) ? packet.handoffs : []) {
    for (const claim of Array.isArray(handoff?.report?.claims) ? handoff.report.claims : []) {
      const detail = claim?.[1];
      for (const lane of ["evidence", "proof", "support"]) {
        for (const evidence of Array.isArray(detail?.[lane]) ? detail[lane] : []) {
          push(evidence?.path);
          for (const window of Array.isArray(evidence?.provenance?.source_windows)
            ? evidence.provenance.source_windows
            : []) {
            push(window?.path);
          }
        }
      }
    }
  }
  return out.sort();
}

function canonicalPathList(value) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    const sourcePath = canonicalSourcePath(entry);
    if (!sourcePath || seen.has(sourcePath)) continue;
    seen.add(sourcePath);
    out.push(sourcePath);
  }
  return out;
}
