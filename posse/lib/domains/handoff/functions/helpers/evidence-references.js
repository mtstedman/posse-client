function sourceRange(evidence) {
  const provenance = evidence?.provenance;
  if (provenance?.line_semantics !== "source"
    || provenance.source_windows?.length !== 1) return null;
  const window = provenance.source_windows[0];
  const path = evidence.path || window.path;
  const start = evidence.source_start_line ?? window.source_start_line;
  const end = evidence.source_end_line ?? window.source_end_line;
  const version = provenance.source_version || window.source_version || evidence.source_content_sha256;
  const repository = provenance.repository_identity || window.repository_identity || "";
  if (!path || !version || !Number.isInteger(start) || !Number.isInteger(end)) return null;
  const lines = String(evidence.excerpt ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (lines.length !== end - start + 1) return null;
  return { key: JSON.stringify([repository, version, path]), start, end, lines };
}

// Shorten only a byte-verified repeat whose earlier claim identifies one source.
// Unique evidence and partial overlaps keep their complete source citation.
export function renderClaimEvidenceReferences(report, renderSelector) {
  const previous = new Map();
  return (report.claims || []).map((claim, claimIndex) => {
    const detail = claim[1] || {};
    const evidence = ["evidence", "proof", "support"].flatMap((lane) => detail[lane] || []);
    const sources = evidence.map(sourceRange);
    const oneSource = sources.length > 0 && sources.every((source) => source?.key === sources[0]?.key)
      && sources[0] != null;
    const additions = [];
    const rendered = evidence.map((item, index) => {
      const full = renderSelector(item);
      const source = sources[index];
      if (!source) return full;
      const earlier = (previous.get(source.key) || []).find((candidate) => (
        candidate.start <= source.start && candidate.end >= source.end
        && source.lines.every((line, offset) => line === candidate.lines[source.start - candidate.start + offset])
      ));
      if (earlier) {
        const short = `L${source.start}-${source.end} (see E${earlier.claimIndex + 1} above)`;
        if (short.length < full.length) return short;
      }
      if (oneSource) additions.push({ ...source, claimIndex });
      return full;
    });
    for (const addition of additions) {
      if (!previous.has(addition.key)) previous.set(addition.key, []);
      previous.get(addition.key).push(addition);
    }
    return [...new Set(rendered.filter(Boolean))];
  });
}
