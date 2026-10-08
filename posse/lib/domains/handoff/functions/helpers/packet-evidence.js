import { AGENT_HANDOFF_LIMITS } from "../../../../catalog/handoff.js";

export function packetEvidence(packet) {
  const bySelector = new Map();
  const add = (evidence) => {
    if (!evidence?.selector || bySelector.has(evidence.selector)) return;
    bySelector.set(evidence.selector, evidence);
  };
  for (const handoff of packet.handoffs || []) {
    for (const claim of handoff.report?.claims || []) {
      const detail = claim[1] || {};
      for (const lane of ["evidence", "proof", "support"]) {
        for (const evidence of detail[lane] || []) add(evidence);
      }
      for (const [evidence] of detail.decoy || []) add(evidence);
    }
  }
  return [...bySelector.values()];
}

export function packetEvidenceMetrics(packet) {
  const evidence = packetEvidence(packet);
  const selectedLineCount = (item) => {
    const windows = item?.selector === item?.ref
      && Array.isArray(item?.provenance?.source_windows)
      ? item.provenance.source_windows
      : [];
    if (windows.length > 0) {
      const materializedLines = new Set();
      for (const window of windows) {
        for (let line = Number(window.materialized_start_line);
          line <= Number(window.materialized_end_line);
          line += 1) {
          if (Number.isInteger(line) && line > 0) materializedLines.add(line);
        }
      }
      if (materializedLines.size > 0) return materializedLines.size;
    }
    return Number(item?.lines?.end) - Number(item?.lines?.start) + 1;
  };
  const lineCounts = evidence.map(selectedLineCount)
    .filter((count) => Number.isInteger(count) && count > 0);
  const charCounts = evidence.map((item) => String(item?.excerpt || "").length);
  return {
    selectorCount: evidence.length,
    selectorLinesMax: lineCounts.length > 0 ? Math.max(...lineCounts) : 0,
    selectorCharsMax: charCounts.length > 0 ? Math.max(...charCounts) : 0,
    selectorsOverRecommendedCount: evidence.filter((item) => {
      const lines = selectedLineCount(item);
      const chars = String(item?.excerpt || "").length;
      return lines > AGENT_HANDOFF_LIMITS.recommendedSelectorLines
        || chars > AGENT_HANDOFF_LIMITS.recommendedSelectorChars;
    }).length,
  };
}

export function verifyStagedPacketEvidence(packet, context, materializeEvidenceSelector, failChanged) {
  for (const evidence of packetEvidence(packet)) {
    const expectedLineSemantics = evidence.provenance?.line_semantics
      ?? evidence.line_semantics;
    const stagedSourcePath = evidence.path ?? evidence.provenance?.path;
    const stagedSourceWindow = Array.isArray(evidence.provenance?.source_windows)
      ? evidence.provenance.source_windows[0] || null
      : null;
    const verified = materializeEvidenceSelector(
      evidence.selector,
      context,
      {
        expectedLineSemantics,
        stagedSourcePath,
        stagedSourceWindow,
      },
    );
    if (verified.source_content_sha256 !== evidence.source_content_sha256
      || verified.excerpt_sha256 !== evidence.excerpt_sha256
      || verified.excerpt !== evidence.excerpt
      || verified.provenance?.line_semantics !== expectedLineSemantics) {
      failChanged(`Evidence ${evidence.selector} changed after the report was staged`);
    }
  }
}
