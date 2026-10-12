// @ts-check



export function stripAtlasPrefix(name = "", { trim = true } = {}) {
  const raw = trim ? String(name || "").trim() : String(name || "");
  if (raw.startsWith("atlas.")) return raw.slice("atlas.".length);
  if (raw.startsWith("atlas_")) return raw.slice("atlas_".length).replace(/_/g, ".");
  return raw;
}

export function stripAtlasPrefixUntrimmed(name) {
  return stripAtlasPrefix(name, { trim: false });
}
