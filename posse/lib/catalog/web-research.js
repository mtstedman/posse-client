// @ts-check

export const WEB_RESEARCH_PROTOCOL = "posse.web_research.v1";
export const WEB_RESEARCH_HANDOFF_OVERSIZED_OBSERVATION_TYPE = "web_research.handoff_oversized";
export const WEB_RESEARCH_QUESTION_OVERSIZED_OBSERVATION_TYPE = "web_research.question_oversized";

// The question, summary, finding, gap and packet sizes below are soft caps:
// a model that exceeds one is accepted and the overage is recorded, never
// rejected. A rejection saves a few hundred input tokens at the tail of the
// conversation by making the model regenerate its whole call — the expensive
// output tokens — plus another turn of cached input.
export const WEB_RESEARCH_LIMITS = Object.freeze({
  maxQuestionChars: 2_000,
  maxFindings: 12,
  maxSummaryChars: 2_000,
  maxClaimChars: 800,
  maxTitleChars: 300,
  maxPublishedAtChars: 80,
  maxGapChars: 500,
  maxGaps: 6,
  maxPacketBytes: 16 * 1024,
  timeoutMs: 60_000,
  maxActiveChildren: 8,
  maxSources: 4,
  maxSourceLabelChars: 200,
});

// Durable web research. Findings, the whole report, and nominated raw sources
// become work-item hash refs, so the planner cites them instead of restating
// web content and downstream agents read them on request.
export const WEB_RESEARCH_FINDING_OBJECT_TYPE = "web.research.finding";
export const WEB_SOURCE_SNAPSHOT_OBJECT_TYPE = "web.source.snapshot";
export const WEB_RESEARCH_REPORT_KIND = "web_research_report";

// A nominated source is downloaded byte-exact by the harness, never
// transcribed by a model. Text-like media only: the snapshot is read through
// fetch_ref/traverse_ref windows.
export const WEB_SOURCE_SNAPSHOT_LIMITS = Object.freeze({
  maxBytes: 1_000_000,
  maxTotalBytesPerDispatch: 2_000_000,
  fetchTimeoutMs: 30_000,
  maxRedirects: 5,
  allowedMediaTypes: Object.freeze([
    "application/json",
    "application/ld+json",
    "application/x-ndjson",
    "application/xml",
    "application/csv",
    "application/yaml",
    "application/x-yaml",
    "application/toml",
  ]),
  allowedMediaTypePrefixes: Object.freeze(["text/"]),
  allowedMediaTypeSuffixes: Object.freeze(["+json", "+xml"]),
});

export const WEB_SOURCE_SNAPSHOT_STATUSES = Object.freeze({
  CAPTURED: "captured",
  REJECTED: "rejected",
  FAILED: "failed",
  SKIPPED: "skipped",
});

export const WEB_RESEARCH_OBSERVATION_TYPES = Object.freeze({
  SOURCE_SNAPSHOT: "web_research.source_snapshot",
  REPORT_SALVAGED: "web_research.report_salvaged",
});

// download_file: the artificer's only external fetch lane. The harness, not
// the model, downloads public HTTPS files byte-exact into the job's create
// scope. Per-job bytes are counted on the job's gateway scope, like the
// artificer's image-generation call cap. The call deadline stays inside the
// default MCP request watchdog, so no extra deadline class is needed.
export const DOWNLOAD_FILE_LIMITS = Object.freeze({
  maxItemsPerCall: 100,
  maxBytesPerItem: 20 * 1024 * 1024,
  maxBytesPerCall: 100 * 1024 * 1024,
  maxBytesPerJob: 500 * 1024 * 1024,
  maxRedirects: 3,
  itemTimeoutMs: 30_000,
  callTimeoutMs: 150_000,
  concurrency: 4,
  maxUrlChars: 2_000,
  maxPathChars: 1_024,
});

export const DOWNLOAD_FILE_USER_AGENT = "posse-artificer-download/1";

// Accepted response media types and the destination extensions each may be
// saved under. Images must also carry the matching file signature. No SVG,
// archives, or executables.
export const DOWNLOAD_FILE_MEDIA_TYPES = Object.freeze({
  "image/png": Object.freeze({ extensions: Object.freeze([".png"]), imageFormat: "png" }),
  "image/jpeg": Object.freeze({ extensions: Object.freeze([".jpg", ".jpeg"]), imageFormat: "jpeg" }),
  "image/webp": Object.freeze({ extensions: Object.freeze([".webp"]), imageFormat: "webp" }),
  "image/gif": Object.freeze({ extensions: Object.freeze([".gif"]), imageFormat: "gif" }),
  "application/json": Object.freeze({ extensions: Object.freeze([".json"]) }),
  // Raw file hosts serve data files as text/plain.
  "text/plain": Object.freeze({ extensions: Object.freeze([".txt", ".json", ".csv", ".tsv", ".md"]) }),
  "text/csv": Object.freeze({ extensions: Object.freeze([".csv"]) }),
  // Listing pages are downloaded to read their links.
  "text/html": Object.freeze({ extensions: Object.freeze([".html", ".htm"]) }),
});

// Non-canonical labels some servers send for an accepted type.
export const DOWNLOAD_FILE_MEDIA_TYPE_ALIASES = Object.freeze({
  "image/jpg": "image/jpeg",
});

export const DOWNLOAD_FILE_OBSERVATION_TYPE = "web.download_file";
