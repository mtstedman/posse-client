// ATLAS owns source retrieval when available; directory browsing stays native.
export const ATLAS_REPLACED_NATIVE_TOOLS = Object.freeze(["read_file", "search_files"]);

// Literal occurrence search complements semantic Atlas retrieval for research.
// The developer (and the fix role, which runs on the dev surface) keeps exact
// reads and literal search beside Atlas retrieval too: it edits whole files,
// Atlas windows need identifier anchors, and templates, styles and config are
// not indexed (operator decision 2026-10-19). This retains an existing Remote
// grant; it never creates one locally.
export const ATLAS_COMPLEMENTARY_NATIVE_TOOLS_BY_ROLE = Object.freeze({
  researcher: Object.freeze(["search_files", "read_file"]),
  dev: Object.freeze(["search_files", "read_file"]),
  fix: Object.freeze(["search_files", "read_file"]),
});

export function atlasNativeToolIsComplementary(name, role = "") {
  return Object.hasOwn(ATLAS_COMPLEMENTARY_NATIVE_TOOLS_BY_ROLE, role)
    && ATLAS_COMPLEMENTARY_NATIVE_TOOLS_BY_ROLE[role].includes(name);
}

export function atlasReplacesNativeTool(name, role = "") {
  return ATLAS_REPLACED_NATIVE_TOOLS.includes(name)
    && !atlasNativeToolIsComplementary(name, role);
}

// read_file size policy, in bytes.
export const READ_FILE_LIMITS = Object.freeze({
  // jsonPath/search/maxBytes reads parse or scan the whole file, so they get a
  // bounded ceiling above the plain-read limit: an 8.9 MB single-line JSON file
  // (2026-10-01) could not be read at all, by line paging or structured modes.
  structuredMaxSizeBytes: 64 * 1024 * 1024,
  largeStructuredContentBytes: 2 * 1024,
  // Bound the rendered response before observation/context accounting. File-size
  // limits alone do not bound a page of minified text or structured match output
  // (two research children each took a 1.6M-char page of one, 2026-10-01).
  maxResultBytes: 128 * 1024,
});
