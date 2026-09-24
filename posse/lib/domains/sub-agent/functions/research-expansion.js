import { SUB_AGENT_LIMITS } from "../../../catalog/sub-agent.js";
import {
  materializeAgentHandoffEvidenceSelector,
  parseAgentHandoffEvidenceSelector,
} from "../../handoff/functions/agent-handoff.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { surfaceHashRefForContext } from "../../queue/functions/hash-refs.js";
import { hashRefModelVisibility } from "../../../shared/tools/functions/fetch-ref-policy.js";
import { normalizedEvidenceSourceWindows } from "../../../shared/tools/functions/source-evidence.js";

const MAX_EXPANDED_FILES = 12;

function claimDetail(claim) {
  return Array.isArray(claim) ? claim[1] : claim;
}

function lineOffsets(text) {
  const offsets = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") offsets.push(index + 1);
  }
  return offsets;
}

function lineCharRange(text, startLine, endLine) {
  const offsets = lineOffsets(text);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)
    || startLine < 1 || endLine < startLine || startLine > offsets.length) return null;
  const start = offsets[startLine - 1];
  const nextLine = offsets[endLine];
  let end = nextLine == null ? text.length : Math.max(start, nextLine - 1);
  if (end > start && text[end - 1] === "\r") end -= 1;
  return { start, end };
}

function visiblePayloadRange(entry, materialized) {
  const payload = String(entry?.payload_text ?? "");
  const excerpt = String(materialized?.excerpt ?? "");
  if (!payload || !excerpt) return null;
  if (payload === excerpt) return { start: 0, end: payload.length };

  const direct = payload.indexOf(excerpt);
  if (direct >= 0 && payload.indexOf(excerpt, direct + 1) < 0) {
    return { start: direct, end: direct + excerpt.length };
  }

  let materializedStart = null;
  let materializedEnd = null;
  if (entry?.metadata?.line_semantics === "source") {
    const sourcePath = materialized.path || materialized.provenance?.path || null;
    const windows = normalizedEvidenceSourceWindows(entry.metadata.source_windows);
    const window = windows.find((candidate) => (
      candidate.materialized_start_line != null
      && candidate.materialized_end_line != null
      && (!sourcePath || candidate.path === sourcePath)
      && materialized.lines.start >= candidate.source_start_line
      && materialized.lines.end <= candidate.source_end_line
    ));
    if (window) {
      materializedStart = window.materialized_start_line
        + materialized.lines.start - window.source_start_line;
      materializedEnd = window.materialized_start_line
        + materialized.lines.end - window.source_start_line;
    }
  } else {
    materializedStart = materialized.lines?.start;
    materializedEnd = materialized.lines?.end;
  }
  const range = lineCharRange(payload, materializedStart, materializedEnd);
  if (!range) return null;
  const selected = payload.slice(range.start, range.end).replace(/\r\n?/g, "\n");
  return selected === excerpt ? range : null;
}

function boundedSelector(evidence, entry) {
  const value = evidence?.selector ?? evidence;
  const selector = parseAgentHandoffEvidenceSelector(value);
  if (selector.start != null) return value;
  const windows = normalizedEvidenceSourceWindows(entry?.metadata?.source_windows);
  const window = windows[0];
  if (window) {
    return {
      ref: selector.ref,
      path: window.path,
      lines: {
        start: window.source_start_line,
        end: Math.min(window.source_end_line, window.source_start_line + SUB_AGENT_LIMITS.targetTerminalEvidenceLines - 1),
      },
    };
  }
  const lines = String(entry?.payload_text ?? "").replace(/\r\n?/g, "\n").split("\n");
  return {
    ref: selector.ref,
    lines: { start: 1, end: Math.min(lines.length, SUB_AGENT_LIMITS.targetTerminalEvidenceLines) },
  };
}

function renderHunk(candidate) {
  const lines = candidate.excerpt.replace(/\r\n?/g, "\n").split("\n");
  const width = String(candidate.end).length;
  return [
    `@@ ${candidate.start}-${candidate.end} @@  claims: ${[...candidate.claims].join(", ")}`,
    ...lines.map((line, index) => `${String(candidate.start + index).padStart(width, " ")} | ${line}`),
  ].join("\n");
}

function groupCandidates(candidates) {
  const groups = new Map();
  for (const candidate of candidates.filter((item) => item.selected)) {
    const key = `${candidate.path}\0${candidate.sourceHash}`;
    if (!groups.has(key)) groups.set(key, { path: candidate.path, sourceHash: candidate.sourceHash, candidates: [] });
    groups.get(key).candidates.push(candidate);
  }
  return [...groups.values()];
}

function renderedGroups(candidates) {
  return groupCandidates(candidates).map((group) => {
    const children = [...new Set(group.candidates.flatMap((candidate) => [...candidate.children]))];
    const body = [
      `=== ${group.path}  (${group.candidates.length} hunk${group.candidates.length === 1 ? "" : "s"}; children ${children.join(", ")}) ===`,
      ...group.candidates.map(renderHunk),
    ].join("\n");
    return { ...group, children, body };
  });
}

function markFailure(occurrence, reason) {
  occurrence.evidence.expanded = false;
  occurrence.evidence.expansion_reason = reason;
}

function sourceBriefMetadata(group, parentContext, payloadLength, visible = false) {
  return {
    line_semantics: "materialized",
    source_provenance: group.candidates.map((candidate) => ({
      path: candidate.path,
      start: candidate.start,
      end: candidate.end,
      source_ref: candidate.sourceRef,
      source_content_hash: candidate.sourceHash,
    })),
    ...hashRefModelVisibility(parentContext, {
      visibility: visible ? "full" : "hidden",
      ranges: visible ? [{ start: 0, end: payloadLength }] : [],
      issuedAs: visible ? "evidence" : null,
    }),
  };
}

export function expandResearchBatchEvidence(batch, {
  resolveEvidenceSource,
  expandChars = 0,
} = {}) {
  const cap = Math.max(0, Number(expandChars) || 0);
  const candidates = [];
  const byIdentity = new Map();
  const occurrences = [];

  for (const entry of batch.entries || []) {
    if (entry.status !== "completed" || entry.profile !== "research_investigation.v1"
      || entry.agentType !== "code" || !entry.sourceContext) continue;
    let claimNumber = 0;
    for (const handoff of entry.packet?.handoffs || []) {
      for (const claim of handoff?.report?.claims || []) {
        claimNumber += 1;
        const detail = claimDetail(claim);
        for (const evidence of detail?.evidence || []) {
          const occurrence = { entry, evidence, claimId: `${entry.id}#${claimNumber}` };
          occurrences.push(occurrence);
          if (!cap) {
            markFailure(occurrence, "expansion_disabled");
            continue;
          }
          try {
            const parsed = parseAgentHandoffEvidenceSelector(evidence?.selector ?? evidence);
            const sourceRef = parsed.ref;
            const source = resolveEvidenceSource(entry.sourceContext, sourceRef);
            if (!source?.payload_text) throw new Error("source_unavailable");
            const materialized = materializeAgentHandoffEvidenceSelector(
              boundedSelector(evidence, source),
              entry.sourceContext,
              { allowDisjointSource: true },
            );
            const excerpt = String(materialized.excerpt || "");
            const excerptLines = excerpt.replace(/\r\n?/g, "\n").split("\n");
            if (excerptLines.length > SUB_AGENT_LIMITS.maxEvidenceLines || excerpt.length > SUB_AGENT_LIMITS.maxEvidenceChars) {
              throw new Error("hunk_limit");
            }
            const visibleRange = visiblePayloadRange(source, materialized);
            if (!visibleRange) throw new Error("visibility_range_unresolved");
            const path = materialized.path || materialized.provenance?.path || evidence.path || source.metadata?.path;
            if (!path) throw new Error("path_unresolved");
            const start = Number(materialized.source_start_line ?? materialized.lines?.start);
            const end = Number(materialized.source_end_line ?? materialized.lines?.end);
            if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) throw new Error("line_range_unresolved");
            const identity = `${path}\0${source.content_hash}\0${start}\0${end}\0${excerpt}`;
            let candidate = byIdentity.get(identity);
            if (!candidate) {
              candidate = {
                path, start, end, excerpt, sourceRef, sourceHash: source.content_hash,
                source, visibleRange, selected: false, claims: new Set(), children: new Set(), occurrences: [],
              };
              byIdentity.set(identity, candidate);
              candidates.push(candidate);
            }
            candidate.claims.add(occurrence.claimId);
            candidate.children.add(entry.id);
            candidate.occurrences.push(occurrence);
            occurrence.candidate = candidate;
          } catch (error) {
            markFailure(occurrence, String(error?.message || "source_unavailable").slice(0, 80));
          }
        }
      }
    }
  }

  for (const candidate of candidates) {
    candidate.selected = true;
    const groups = renderedGroups(candidates);
    const chars = groups.map((group) => group.body).join("\n\n").length;
    if (groups.length > MAX_EXPANDED_FILES || chars > cap) candidate.selected = false;
  }

  const parentContext = batch.entries?.[0]?.parentContext || {};
  const groups = renderedGroups(candidates);
  const files = [];
  const briefParts = [];
  const stamped = new Map();
  for (const group of groups) {
    const draft = group.body;
    const surfaced = surfaceHashRefForContext(parentContext, {
      payloadText: draft,
      objectType: "source_brief",
      source: "tool:dispatch_agent.expand",
      note: group.path,
      metadata: sourceBriefMetadata(group, parentContext, draft.length),
    }, { ownerScope: "work_item" });
    if (!surfaced?.ok || !surfaced.entry?.ref) {
      for (const candidate of group.candidates) candidate.selected = false;
      continue;
    }
    const ref = surfaced.entry.ref;
    const visibleBrief = surfaceHashRefForContext(parentContext, {
      ref,
      payloadText: draft,
      contentHash: surfaced.entry.content_hash,
      objectType: "source_brief",
      source: "tool:dispatch_agent.expand",
      note: group.path,
      metadata: sourceBriefMetadata(group, parentContext, draft.length, true),
    }, { ownerScope: "work_item" });
    let sourceStamped = visibleBrief?.ok === true;
    const groupStamps = new Map();
    for (const candidate of group.candidates) {
      const stampKey = `${candidate.sourceRef}\0${candidate.sourceHash}`;
      const current = groupStamps.get(stampKey) || { candidate, ranges: [] };
      current.ranges.push(candidate.visibleRange);
      groupStamps.set(stampKey, current);
    }
    for (const { candidate, ranges } of groupStamps.values()) {
      const full = ranges.some((range) => range.start === 0 && range.end === candidate.source.payload_text.length);
      const surfacedEntry = {
        ref: candidate.sourceRef,
        payloadText: candidate.source.payload_text,
        contentHash: candidate.source.content_hash,
        objectType: candidate.source.object_type,
        source: candidate.source.source,
        note: candidate.source.note,
        versionId: candidate.source.version_id,
        metadata: {
          ...(candidate.source.metadata || {}),
          ...hashRefModelVisibility(parentContext, {
            visibility: full ? "full" : "partial",
            ranges,
            issuedAs: "evidence",
          }),
        },
      };
      const attemptStamp = surfaceHashRefForContext(parentContext, surfacedEntry);
      const durableStamp = surfaceHashRefForContext(parentContext, surfacedEntry, { ownerScope: "work_item" });
      if (!attemptStamp?.ok || !durableStamp?.ok) sourceStamped = false;
    }
    if (!sourceStamped) {
      for (const candidate of group.candidates) candidate.selected = false;
      continue;
    }
    briefParts.push(draft);
    const hunks = group.candidates.map((candidate) => ({
      start: candidate.start,
      end: candidate.end,
      claims: [...candidate.claims],
      source_ref: candidate.sourceRef,
    }));
    files.push({
      path: group.path,
      ref,
      source_refs: [...new Set(group.candidates.map((candidate) => candidate.sourceRef))],
      hunks,
      expanded_chars: draft.length,
    });
    for (const candidate of group.candidates) {
      for (const occurrence of candidate.occurrences) {
        occurrence.evidence.expanded = true;
        occurrence.evidence.expanded_ref = ref;
        occurrence.evidence.source_ref = candidate.sourceRef;
        delete occurrence.evidence.expansion_reason;
      }
    }
    for (const [stampKey, value] of groupStamps) {
      const current = stamped.get(stampKey) || { candidate: value.candidate, ranges: [] };
      current.ranges.push(...value.ranges);
      stamped.set(stampKey, current);
    }
  }

  for (const candidate of candidates.filter((item) => !item.selected)) {
    for (const occurrence of candidate.occurrences) markFailure(occurrence, "expansion_budget_exhausted");
  }

  const brief = briefParts.join("\n\n");
  const result = {
    files,
    brief,
    expanded_chars: brief.length,
    expanded_hunks: files.reduce((sum, file) => sum + file.hunks.length, 0),
    omitted: occurrences.filter((occurrence) => occurrence.evidence.expanded !== true).length,
  };
  try {
    recordObservation({
      work_item_id: parentContext.work_item_id ?? parentContext.workItemId ?? null,
      job_id: parentContext.job_id ?? parentContext.jobId ?? null,
      attempt_id: parentContext.attempt_id ?? parentContext.attemptId ?? null,
      observation_type: "sub_agent.research_expand",
      summary: `Expanded ${result.expanded_hunks} research hunk(s) across ${files.length} file brief(s)`,
      detail: {
        files: files.length,
        hunks: result.expanded_hunks,
        chars: result.expanded_chars,
        refs_minted: files.length,
        source_refs_stamped: stamped.size,
        omitted: result.omitted,
      },
    });
  } catch {
    // Expansion telemetry must not affect a completed research result.
  }
  return result;
}
