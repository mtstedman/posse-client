// @ts-check



export function parsePorcelainZ(raw = "") {
  const parts = String(raw || "").split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index];
    const status = item.slice(0, 2);
    const filePath = item.slice(3);
    let oldPath = null;
    if ((status.includes("R") || status.includes("C")) && index + 1 < parts.length) {
      oldPath = parts[++index];
    }
    entries.push({ status, path: filePath, old_path: oldPath });
  }
  return entries;
}

export function porcelainEntryKey(entry) {
  return `${entry.status}\0${entry.path || ""}\0${entry.old_path || ""}`;
}

export function diffPorcelainEntries(beforeRaw, afterRaw) {
  const beforeKeys = new Set(parsePorcelainZ(beforeRaw).map(porcelainEntryKey));
  return parsePorcelainZ(afterRaw).filter((entry) => !beforeKeys.has(porcelainEntryKey(entry)));
}
