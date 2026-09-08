// Preserve the association and snapshot identity without duplicating source bodies.
export function projectResearchClaimEvidence(report = {}) {
  return (Array.isArray(report.claims) ? report.claims : []).map(([claim, detail], index) => ({
    claim_id: index + 1,
    claim,
    ...(Array.isArray(detail?.unverified_evidence) && detail.unverified_evidence.length > 0 ? {
      unverified_evidence: detail.unverified_evidence.map(({ selector, code }) => ({ selector, code })),
    } : {}),
    evidence: ["evidence", "proof", "support"].flatMap(lane => (
      Array.isArray(detail?.[lane]) ? detail[lane] : []
    ).map(item => ({
      lane,
      selector: item.selector,
      ref: item.ref,
      path: item.path ?? item.provenance?.path,
      lines: item.lines,
      source_content_sha256: item.source_content_sha256,
      excerpt_sha256: item.excerpt_sha256,
      line_semantics: item.line_semantics ?? item.provenance?.line_semantics,
      source_windows: item.provenance?.source_windows,
    }))),
  }));
}
