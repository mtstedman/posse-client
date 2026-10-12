// @ts-check



export function orderedUniquePaths(paths) {
  const seen = new Set();
  const values = [];
  for (const rawPath of Array.isArray(paths) ? paths : []) {
    const repoRelPath = String(rawPath || "");
    if (!repoRelPath || seen.has(repoRelPath)) continue;
    seen.add(repoRelPath);
    values.push(repoRelPath);
  }
  return values.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
}
