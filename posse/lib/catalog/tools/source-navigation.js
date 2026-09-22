// ATLAS owns source retrieval when available; directory browsing stays native.
export const ATLAS_REPLACED_NATIVE_TOOLS = Object.freeze(["read_file", "search_files"]);

// Literal occurrence search complements semantic Atlas retrieval for research.
// This retains an existing Remote grant; it never creates one locally.
export const ATLAS_COMPLEMENTARY_NATIVE_TOOLS_BY_ROLE = Object.freeze({
  researcher: Object.freeze(["search_files", "read_file"]),
});

export function atlasNativeToolIsComplementary(name, role = "") {
  return Object.hasOwn(ATLAS_COMPLEMENTARY_NATIVE_TOOLS_BY_ROLE, role)
    && ATLAS_COMPLEMENTARY_NATIVE_TOOLS_BY_ROLE[role].includes(name);
}

export function atlasReplacesNativeTool(name, role = "") {
  return ATLAS_REPLACED_NATIVE_TOOLS.includes(name)
    && !atlasNativeToolIsComplementary(name, role);
}
