// @ts-check

export const ATLAS_V2_HELP_COMMANDS = Object.freeze([
  {
    usage: "status",
    summary: "Overview of ledger, views, warmer queue, recent events",
  },
  {
    usage: "rebuild <main|wi-<id>>",
    summary: "Drop a view file and queue a rebuild warm job",
  },
  {
    usage: "ledger tail [branch] [limit]",
    summary: "Print the most recent ledger entries (default: main, 25)",
  },
  {
    usage: "view info <main|wi-<id>|path>",
    summary: "Describe one view file",
  },
  {
    usage: "warm-now <purpose> [args]",
    summary: "Enqueue a warm job synchronously (purposes: wi, main-incremental, main-full, scip-restage)",
  },
  {
    usage: "models pull [jina-v2-code]",
    summary: "Download the local ONNX embedding model for offline semantic search",
  },
  {
    usage: "purge-views [warmed|main|all]",
    summary: "Delete view files (default: warmed)",
  },
  {
    usage: "scip status",
    summary: "Inspect ingested SCIP indexes and the consume directory",
  },
  {
    usage: "scip install [--lang l|--all]",
    summary: "Install/setup Posse-managed SCIP language indexers",
  },
  {
    usage: "scip restage [--lang l] [--force]",
    summary: "Refresh staged SCIP artifacts",
  },
  {
    usage: "scip ingest [--branch b] <path>",
    summary: "One-shot ingest of a .scip file",
  },
  {
    usage: "scip reparse [--branch b] [--lang ts] [<path>]",
    summary: "Drop and re-ingest blobs covered by a .scip file",
  },
]);

export function atlasV2UsageSummary({ compact = false } = {}) {
  if (compact) {
    return "status | rebuild | ledger tail | view info | warm-now | models pull | purge-views | scip ...";
  }
  return ATLAS_V2_HELP_COMMANDS.map((command) => command.usage).join(" | ");
}
