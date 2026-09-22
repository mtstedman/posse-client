// @ts-check

/**
 * Remove cache validators from the delivered Atlas result, after caching and
 * source custody have consumed the original. Strings are opaque: source and
 * control notices must not be rewritten even when they mention an ETag.
 * @param {any} result
 * @returns {any}
 */
export function omitAtlasCacheMetadata(result) {
  const visit = (value) => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const items = value.map(visit);
      return items.some((item, index) => item !== value[index]) ? items : value;
    }
    const projected = { ...value };
    let changed = false;
    for (const [key, child] of Object.entries(value)) {
      if (key === "etag") { delete projected[key]; changed = true; continue; }
      // Embedded follow-up calls must retain their original input contract.
      const next = key === "args" ? child : visit(child);
      if ((key === "meta" || key === "_meta") && next !== child
        && next && typeof next === "object" && Object.keys(next).length === 0) {
        changed = true;
        delete projected[key];
        continue;
      }
      projected[key] = next;
      changed ||= next !== child;
    }
    return changed ? projected : value;
  };
  if (!result || typeof result !== "object") return result;
  let projected = result;
  const first = result.content?.[0];
  if (first?.type === "text" && typeof first.text === "string") {
    const suffixAt = first.text.indexOf("\n\n[");
    const json = suffixAt >= 0 ? first.text.slice(0, suffixAt) : first.text;
    const suffix = suffixAt >= 0 ? first.text.slice(suffixAt) : "";
    try {
      const parsed = JSON.parse(json);
      const cleaned = visit(parsed);
      if (cleaned !== parsed) {
        projected = {
          ...result,
          content: [{ ...first, text: `${JSON.stringify(cleaned)}${suffix}` }, ...result.content.slice(1)],
        };
      }
    } catch {
      // Plain text and exact-source blocks are not metadata envelopes.
    }
  }
  // Some MCP clients consume structuredContent directly. Keep both delivery
  // channels consistent without changing the cached/executor-owned objects.
  for (const key of ["structuredContent", "_meta"]) {
    const cleaned = visit(result[key]);
    if (cleaned === result[key]) continue;
    projected = { ...projected, [key]: cleaned };
    if (key === "_meta" && Object.keys(cleaned).length === 0) delete projected[key];
  }
  return projected;
}
