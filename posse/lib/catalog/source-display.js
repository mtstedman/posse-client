// Presentation only; source hashes and selectors identify the unprefixed bytes.
export const SOURCE_LINE_DISPLAY_FORMAT = "source_number_tab";
export const RAW_SOURCE_LINES_ENCODING = "raw_source_lines";

// Mirrored by the native retrieval catalog. Missing legacy provenance is
// unknown, never implicit proof that generated content is original source.
export const CODE_CONTENT_KINDS = Object.freeze({
  SOURCE: "source",
  SUMMARY: "summary",
  INDEXED_SIGNATURES: "indexed_signatures",
  UNKNOWN: "unknown",
});
