import { RESEARCH_CHILD_PROFILE, SUB_AGENT_LIMITS, SUB_AGENT_PROTOCOL } from "../../../catalog/sub-agent.js";

export function safeError(error) {
  const rawCode = String(error?.code || "SUB_AGENT_CHILD_FAILED").trim();
  const code = /^[A-Z0-9_]{3,80}$/.test(rawCode) ? rawCode : "SUB_AGENT_CHILD_FAILED";
  return {
    code,
    retryable: error?.retryable === true,
    stage: String(error?.stage || "child").slice(0, 40),
    message: String(error?.message || "Citation child failed").slice(0, 500),
  };
}

export function visibleManifest(entry) {
  return entry.inputs.map((input, position) => ({
    position,
    id: input.id,
    kind: input.kind,
    ...(input.kind === "call" ? { source: input.tool } : { source: "delegated_ref" }),
  }));
}

export function consumableInputs(entry) {
  return entry.maxInputs;
}

export function cursorEvidenceResponse(entry, input, position, evidence, provenance = evidence.provenance) {
  const lines = evidence.excerpt.replace(/\r\n?/g, "\n").split("\n");
  const sourceWindows = provenance?.line_semantics === "source"
    && Array.isArray(provenance?.source_windows)
    ? provenance.source_windows
    : [];
  const disjointSource = sourceWindows.length > 1;
  const sourceLineByMaterializedLine = new Map();
  for (const window of sourceWindows) {
    const materializedStart = Number(window?.materialized_start_line);
    const materializedEnd = Number(window?.materialized_end_line);
    const sourceStart = Number(window?.source_start_line);
    if (!Number.isInteger(materializedStart) || !Number.isInteger(materializedEnd)
      || !Number.isInteger(sourceStart)) continue;
    for (let line = materializedStart; line <= materializedEnd; line += 1) {
      sourceLineByMaterializedLine.set(line, sourceStart + line - materializedStart);
    }
  }
  const consumable = consumableInputs(entry);
  return {
    ok: true,
    protocol: SUB_AGENT_PROTOCOL,
    op: "next_input",
    request_id: entry.id,
    position,
    input: { id: input.id, kind: input.kind, source: evidence.provenance?.source || null },
    evidence: {
      selector: {
        ref: evidence.ref,
        ...(!disjointSource ? { lines: {
          start: evidence.lines.start,
          count: evidence.lines.end - evidence.lines.start + 1,
        } } : {}),
      },
      ...(disjointSource ? { source_windows: sourceWindows } : {}),
      provenance,
      excerpt_sha256: evidence.excerpt_sha256,
      source_content_sha256: evidence.source_content_sha256,
      lines: lines.map((text, index) => ({
        line: sourceLineByMaterializedLine.get(index + 1) ?? evidence.lines.start + index,
        text,
      })),
    },
    terminal_evidence_budget: {
      max_chars: SUB_AGENT_LIMITS.maxEvidenceChars,
      conservative_total_selected_lines: SUB_AGENT_LIMITS.targetTerminalEvidenceLines,
      action: "Narrow evidence selectors before the first terminal handoff.",
    },
    consumed: entry.cursorPosition,
    remaining: Math.max(0, consumable - entry.cursorPosition),
    next_position: entry.cursorPosition < consumable
      ? entry.cursorPosition
      : null,
  };
}

export function cursorFailureResponse(entry, input, position, error) {
  const consumable = consumableInputs(entry);
  return {
    ok: false,
    protocol: SUB_AGENT_PROTOCOL,
    op: "next_input",
    request_id: entry.id,
    position,
    input: { id: input.id, kind: input.kind, ...(input.tool ? { source: input.tool } : {}) },
    error: safeError(error),
    consumed: entry.cursorPosition,
    remaining: Math.max(0, consumable - entry.cursorPosition),
    next_position: entry.cursorPosition < consumable
      ? entry.cursorPosition
      : null,
  };
}

export function coverageForEntry(entry, selected = entry.selectedEvidenceCount) {
  const consumable = consumableInputs(entry);
  return {
    authorized: entry.inputs.length,
    consumable,
    consumed: entry.cursorPosition,
    selected,
    unconsumed: Math.max(0, consumable - entry.cursorPosition),
    inaccessible_by_budget: Math.max(0, entry.inputs.length - consumable),
    stopped_early: entry.cursorPosition < consumable,
  };
}

export function publicEntry(entry) {
  const coverage = entry.profile === RESEARCH_CHILD_PROFILE
    ? {}
    : { coverage: entry.coverage };
  if (entry.status === "completed") {
    return {
      id: entry.id,
      handle: entry.handle,
      status: "completed",
      packet: entry.packet,
      ...coverage,
      usage: entry.usage,
    };
  }
  if (["failed", "cancelled", "timed_out"].includes(entry.status)) {
    return {
      id: entry.id,
      handle: entry.handle,
      status: entry.status,
      error: entry.error,
      ...coverage,
      ...(entry.usage ? { usage: entry.usage } : {}),
    };
  }
  return { id: entry.id, handle: entry.handle, status: entry.status };
}

