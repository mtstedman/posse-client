import { createHash } from "node:crypto";

// Merge only source-coordinate excerpts with identical overlapping bytes.
// Materialized multi-window/annotated results retain their independent refs.
export function mergeEvidenceCatalog(evidence) {
  const groups = [];
  for (const item of evidence) {
    const sourcePath = item.path || item.provenance?.path;
    const start = item.source_start_line ?? item.lines?.start;
    const end = item.source_end_line ?? item.lines?.end;
    const lines = String(item.excerpt || "").split("\n");
    const eligible = sourcePath && item.source_content_sha256 && Number.isInteger(start) && Number.isInteger(end)
      && start > 0 && end >= start && lines.length === end - start + 1
      && (item.provenance?.line_semantics === "source" || item.source_start_line != null);
    groups.push({ item, start, end, lines, members: [item],
      key: eligible ? `${sourcePath}\0${item.source_content_sha256}` : null });
  }
  groups.sort((a, b) => (a.key || "").localeCompare(b.key || "") || a.start - b.start || b.end - a.end);
  const merged = [];
  for (const group of groups) {
    const previous = merged.at(-1);
    const overlap = previous?.key && previous.key === group.key && group.start <= previous.end;
    const matches = overlap && group.lines.slice(0, Math.min(group.end, previous.end) - group.start + 1)
      .every((line, offset) => line === previous.lines[group.start - previous.start + offset]);
    if (!matches) { merged.push(group); continue; }
    if (group.end > previous.end) previous.lines.push(...group.lines.slice(previous.end - group.start + 1));
    previous.end = Math.max(previous.end, group.end);
    previous.members.push(...group.members);
  }
  const pointers = new Map();
  const catalog = merged.map((group, id) => {
    if (group.members.length === 1) {
      pointers.set(group.item.selector, { evidence_id: id });
      return group.item;
    }
    for (const member of group.members) {
      const { excerpt: _excerpt, ...metadata } = member;
      pointers.set(member.selector, { evidence_id: id, evidence_merged_into: id, original: metadata,
        excerpt_offset: (member.source_start_line ?? member.lines.start) - group.start,
        excerpt_lines: String(member.excerpt).split("\n").length });
    }
    const excerpt = group.lines.join("\n");
    return { ...group.item, excerpt, excerpt_sha256: createHash("sha256").update(excerpt).digest("hex"),
      lines: { start: group.start, end: group.end }, source_start_line: group.start, source_end_line: group.end };
  });
  return { catalog, pointers };
}
