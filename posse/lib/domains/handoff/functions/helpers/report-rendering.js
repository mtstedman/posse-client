import { AGENT_HANDOFF_LIMITS, RESEARCHER_REPORT_BRIEF_POLICY } from "../../../../catalog/handoff.js";
import { claimEvidenceReferences } from "./evidence-references.js";

function renderedEvidenceSelector(evidence) {
  if (evidence?.path && Number.isInteger(evidence.source_start_line)
    && Number.isInteger(evidence.source_end_line)) {
    return `${evidence.path}:${evidence.source_start_line}-${evidence.source_end_line}`;
  }
  if (evidence?.provenance?.line_semantics === "source"
    && Array.isArray(evidence.provenance.source_windows)
    && evidence.provenance.source_windows.length > 0) {
    return evidence.provenance.source_windows.map((window) => (
      `${window.path}:${window.source_start_line}-${window.source_end_line}`
    )).join(", ");
  }
  return evidence?.selector || evidence?.ref || "unavailable";
}

// An excerpt's lines with their source line numbers ("41\tcode"); a
// multi-file window prefixes the path. Lines outside any source window keep
// no gutter.
function numberedEvidenceLines(evidence) {
  const provenance = evidence?.provenance || {};
  const sourceWindows = provenance.line_semantics === "source"
    && Array.isArray(provenance.source_windows)
    ? provenance.source_windows
    : [];
  const sourcePaths = new Set(sourceWindows.map((window) => window.path));
  return String(evidence?.excerpt ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line, index) => {
      if (evidence.path && Number.isInteger(evidence.source_start_line)) {
        return `${evidence.source_start_line + index}\t${line}`;
      }
      const materializedLine = index + 1;
      const window = sourceWindows.find((candidate) => (
        materializedLine >= candidate.materialized_start_line
        && materializedLine <= candidate.materialized_end_line
      ));
      if (!window) return line;
      const sourceLine = window.source_start_line
        + materializedLine - window.materialized_start_line;
      const gutter = sourcePaths.size > 1 ? `${window.path}:${sourceLine}` : sourceLine;
      return `${gutter}\t${line}`;
    });
}

function fencedCode(lines) {
  const text = lines.join("\n");
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

// The report brief reads [Summary] then, per claim, [Claim N] [Claim N code].
// A range already quoted under an earlier claim is pointed to, not repeated.
// Inline code is budgeted (RESEARCHER_REPORT_BRIEF_POLICY): each claim's first excerpt
// is placed first so no claim loses all of its code, later excerpts fill in
// claim order, and the remainder is listed by location.
function renderClaimCodeSections(report) {
  const claims = report.claims || [];
  const excerptLimit = RESEARCHER_REPORT_BRIEF_POLICY.inlineExcerptLines;
  const items = claimEvidenceReferences(report, renderedEvidenceSelector).map((records) => {
    const seen = new Set();
    return records.filter(({ location }) => !seen.has(location) && seen.add(location)).map((record) => {
      const lines = record.repeatOf == null && record.evidence?.excerpt != null
        ? numberedEvidenceLines(record.evidence)
        : [];
      const clipped = lines.length > excerptLimit;
      const block = lines.length > 0
        ? `${fencedCode(clipped ? lines.slice(0, excerptLimit) : lines)}${clipped ? `\n(${lines.length - excerptLimit} more lines at ${record.location})` : ""}`
        : null;
      return { ...record, block, inline: false, first: false };
    });
  });
  let budget = RESEARCHER_REPORT_BRIEF_POLICY.inlineCodeChars;
  const place = (item) => {
    if (!item.block || item.inline || (item.block.length > budget && !item.first)) return;
    item.inline = true;
    budget -= item.block.length;
  };
  for (const list of items) {
    const first = list.find((item) => item.block);
    if (first) { first.first = true; place(first); }
  }
  for (const list of items) for (const item of list) place(item);
  return claims.map((claim, claimIndex) => {
    const marker = `[E${claimIndex + 1}]`;
    const raw = String(claim[0] || "").replace(/\s+/g, " ").trim();
    const label = raw === marker ? "" : raw.startsWith(`${marker} `) ? raw.slice(marker.length + 1) : raw;
    const parts = [`${marker} ${label}`.trim()];
    for (const item of items[claimIndex]) {
      if (item.repeatOf != null) parts.push(`Code: ${item.location} (quoted under [E${item.repeatOf + 1}] above)`);
      else if (item.inline) parts.push(`Code: ${item.location}\n${item.block}`);
      else if (item.block) parts.push(`Code: ${item.location} (not inlined: report code budget reached)`);
      else parts.push(`Code: ${item.location}`);
    }
    for (const [evidence, reason] of claim[1]?.decoy || []) {
      parts.push(`Decoy: ${renderedEvidenceSelector(evidence)} — ${reason}`);
    }
    return parts.join("\n");
  }).join("\n\n");
}

function renderExpandedEvidence(report, maxChars = AGENT_HANDOFF_LIMITS.recommendedEvidenceChars) {
  const bySelector = new Map();
  const add = (evidence, lane, reason = null) => {
    if (!evidence?.selector || !evidence?.excerpt) return;
    const existing = bySelector.get(evidence.selector);
    if (existing) {
      existing.lanes.add(lane);
      if (reason) existing.reasons.add(reason);
      return;
    }
    bySelector.set(evidence.selector, {
      evidence,
      lanes: new Set([lane]),
      reasons: new Set(reason ? [reason] : []),
    });
  };
  for (const claim of report.claims || []) {
    const detail = claim[1] || {};
    for (const lane of ["evidence", "proof", "support"]) {
      for (const evidence of detail[lane] || []) add(evidence, lane);
    }
    for (const [evidence, reason] of detail.decoy || []) add(evidence, "decoy", reason);
  }
  if (bySelector.size === 0) return "";
  const sections = [];
  for (const { evidence, lanes, reasons } of bySelector.values()) {
    const provenance = evidence.provenance || {};
    const sourceWindows = provenance.line_semantics === "source"
      && Array.isArray(provenance.source_windows)
      ? provenance.source_windows
      : [];
    const sourceCoordinates = evidence.path
      ? `${evidence.path}:${evidence.source_start_line}-${evidence.source_end_line}`
      : sourceWindows.length > 0
        ? sourceWindows.map((window) => (
            `${window.path}:${window.source_start_line}-${window.source_end_line}`
          )).join(", ")
        : null;
    const sourceOwner = provenance.source || provenance.kind || "materialized evidence";
    const source = sourceCoordinates
      ? `${sourceCoordinates} (${sourceOwner})`
      : [provenance.source, provenance.object_type].filter(Boolean).join(" · ")
        || provenance.kind
        || "materialized evidence";
    const quoted = numberedEvidenceLines(evidence).map((line) => `> ${line}`).join("\n");
    sections.push([
      `### ${evidence.selector}`,
      `Lanes: ${[...lanes].join(", ")}  `,
      `Source: ${source}`,
      ...(reasons.size > 0 ? [`Excluded because: ${[...reasons].join("; ")}`] : []),
      quoted,
    ].join("\n\n"));
  }
  const expanded = sections.join("\n\n");
  if (expanded.length <= maxChars) return `## Expanded evidence\n\n${expanded}`;
  const omitted = expanded.length - maxChars;
  return `## Expanded evidence\n\n${expanded.slice(0, maxChars).trimEnd()}\n\n[Expanded evidence truncated: ${omitted} additional characters remain available through the cited evidence selectors.]`;
}

export function renderReport(report, { expandEvidence = false, claimCode = false } = {}) {
  const parts = [];
  if (report.summary) parts.push(`Summary: ${report.summary}`);
  if (claimCode) {
    const sections = renderClaimCodeSections(report);
    if (sections) parts.push(sections);
  } else {
    for (const claim of report.claims) {
      parts.push(`Claim: ${claim[0]}`);
      const detail = claim[1] || {};
      for (const evidence of ["evidence", "proof", "support"]
        .flatMap((lane) => detail[lane] || [])) {
        parts.push(`Evidence: ${renderedEvidenceSelector(evidence)}`);
      }
      for (const [evidence, reason] of detail.decoy || []) {
        parts.push(`Decoy: ${renderedEvidenceSelector(evidence)} — ${reason}`);
      }
      if (detail.prose) parts.push(`Agent synthesis: ${detail.prose}`);
    }
  }
  if (report.constraints.length) parts.push(`Constraints:\n${report.constraints.map((entry) => `- ${entry}`).join("\n")}`);
  if (report.success_criteria.length) parts.push(`Success criteria:\n${report.success_criteria.map((entry) => `- ${entry}`).join("\n")}`);
  if (report.questions.length) parts.push(`Questions:\n${report.questions.map((entry) => `- ${entry}`).join("\n")}`);
  if (expandEvidence) {
    const evidence = renderExpandedEvidence(report);
    if (evidence) parts.push(evidence);
  }
  return parts.join("\n\n");
}

