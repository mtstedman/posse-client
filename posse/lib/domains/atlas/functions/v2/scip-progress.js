// @ts-check
//
// ATLAS v2 SCIP progress helpers — render SCIP-ingest events into the
// line-oriented progress channel and normalize SCIP file paths. Pure string
// transforms lifted out of ParseEngine so the warm pipeline depends on a leaf
// module rather than the class file.

import path from "path";

/**
 * Compact a SCIP-ingest event into a single-line progress string the
 * existing system stream can render. The Warmer's progress channel is
 * line-oriented; the event payload stays available in result_json via
 * the per-purpose handlers' own counters.
 *
 * @param {{ kind: string, [k: string]: any }} event
 * @param {string} scipPath
 * @returns {string}
 */
export function scipEventToProgressText(event, scipPath) {
  const base = path.basename(scipPath);
  switch (event.kind) {
    case "atlas.scip.ingest.started":
      return `scip ingest ${base}: ${event.documents || 0} documents`;
    case "atlas.scip.ingest.completed": {
      const ingested = Number(event.documents_ingested || 0);
      const failed = Number(event.documents_failed || 0);
      const skipped = Number(event.documents_skipped || 0);
      const externals = Number(event.external_symbols || 0);
      const reused = Number(event.blobs_reused || 0);
      const reusedText = reused > 0 ? `, ${reused} reused` : "";
      const skippedText = skipped > 0 ? `, ${skipped} skipped` : "";
      return `scip ingest ${base}: ${ingested} ingested${reusedText}${skippedText}, ${failed} failed, ${externals} externals`;
    }
    case "atlas.scip.ingest.reading":
      return `scip ingest ${base}: reading index`;
    case "atlas.scip.ingest.progress": {
      const phase = String(event.phase || "");
      if (phase === "decode") return `scip ingest ${base}: decoding index`;
      if (phase === "hydrate") {
        return `scip ingest ${base}: hydrating ${event.current || 0}/${event.total || 0} documents`;
      }
      if (phase === "convert") return `scip ingest ${base}: converting rows (native)`;
      return `scip ingest ${base}: writing ${event.current || 0}/${event.total || 0} documents`;
    }
    case "atlas.scip.ingest.skipped":
      return `scip ingest ${base}: already up-to-date`;
    case "atlas.scip.ingest.failed":
      return `scip ingest ${base}: ${event.repo_rel_path || ""} ${event.message || ""}`.trim();
    case "atlas.scip.ingest.warning":
      return `scip ingest ${base}: warning ${event.reason || ""} ${event.message || ""}`.trim();
    default:
      return `scip event ${event.kind} (${base})`;
  }
}

export function normalizedScipPath(scipPath) {
  const value = String(scipPath || "").trim();
  if (!value) return "";
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function scipBasenameSourceLanguages(scipPath) {
  const base = path.basename(String(scipPath || ""), ".scip").toLowerCase();
  if (base === "typescript") return ["ts", "js"];
  if (base === "python") return ["py"];
  if (base === "php") return ["php"];
  if (base === "go") return ["go"];
  if (base === "rust") return ["rs"];
  if (["ts", "js", "py", "php", "go", "rs"].includes(base)) return [base];
  return [];
}
