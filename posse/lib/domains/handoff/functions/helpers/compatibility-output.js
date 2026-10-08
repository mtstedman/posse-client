import { PLANNER_REPORT_METADATA_KEYS } from "./terminal-report-metadata.js";
import { researcherPacketToStructuredOutput } from "./researcher-output.js";
import { renderReport } from "./report-rendering.js";

export function plannerPromoteMappings(handoff) {
  const destinations = [...new Set([
    ...(handoff.report?.scope?.files_to_modify || []),
    ...(handoff.report?.scope?.files_to_create || []),
  ].map((value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim()).filter(Boolean))];
  return destinations.map((dest) => ({
    pattern: dest.split("/").filter(Boolean).at(-1) || "",
    dest,
  }));
}


function isGroundedCompatibilityEvidence(evidence) {
  return ["Tool Result", "Full Tool Call"].includes(evidence?.provenance?.kind);
}

function evidenceRefs(report) {
  const lanes = { proof: [], support: [], decoy: [] };
  const selector = (item) => ({
    ref: item.ref,
    ...(item.lines && item.selector !== item.ref ? {
      lines: {
        start: item.lines.start,
        count: item.lines.end - item.lines.start + 1,
      },
    } : {}),
  });
  for (const claim of report.claims || []) {
    const detail = claim[1] || {};
    for (const item of ["evidence", "proof", "support"].flatMap((lane) => detail[lane] || [])) {
      const lane = item?.selector_kind === "path" || item?.path
        ? "support"
        : (isGroundedCompatibilityEvidence(item) ? "proof" : "support");
      lanes[lane].push(selector(item));
    }
    for (const [item, reason] of detail.decoy || []) lanes.decoy.push({
      ...selector(item),
      why: reason,
    });
  }
  for (const lane of Object.keys(lanes)) {
    const seen = new Set();
    lanes[lane] = lanes[lane].filter((entry) => {
      const key = JSON.stringify([entry.ref, entry.lines || null]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return lanes;
}

function plannerTaskSpec(handoff) {
  const report = handoff.report || {};
  const sections = [];
  const summary = String(report.summary || handoff.intent || "").trim();
  if (summary) sections.push(summary);
  const claims = [...new Set(
    (report.claims || [])
      .map((claim) => [claim?.[0], claim?.[1]?.prose].filter(Boolean).join(" — ").trim())
      .filter(Boolean),
  )];
  if (claims.length > 0) {
    sections.push(`Material context:\n${claims.map((claim) => `- ${claim}`).join("\n")}`);
  }
  const constraints = [...new Set(
    (report.constraints || []).map((constraint) => String(constraint || "").trim()).filter(Boolean),
  )];
  if (constraints.length > 0) {
    sections.push(`Constraints:\n${constraints.map((constraint) => `- ${constraint}`).join("\n")}`);
  }
  return sections.join("\n\n") || String(handoff.intent || "").trim();
}


function boundedWords(value, maxWords = 30) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

function renderCompletionCompatibilityOutput(packet) {
  const completion = packet.completion || {};
  const status = String(completion.status || "COMPLETE").toUpperCase();
  const artificer = packet.profile === "artificer.result.v1";
  const label = artificer ? "ARTIFICER RESULT" : "DEV RESULT";
  const summary = status === "VERIFIED_NO_CHANGE"
    ? "The requested end state already exists."
    : status === "PARTIAL"
      ? "Available assigned work was completed."
      : status === "BLOCKED"
        ? "Assigned work could not be completed."
        : artificer
          ? "All assigned deliverables were produced."
          : "All assigned work was completed.";
  let notes = "none";
  if (completion.verification_unavailable) {
    notes = `VERIFICATION_UNAVAILABLE: ${completion.verification_unavailable}`;
  } else if (completion.evidence_gap) {
    notes = `EVIDENCE_GAP: ${completion.evidence_gap}`;
  } else if (status === "VERIFIED_NO_CHANGE") {
    notes = completion.no_change_rationale;
  } else if (status === "PARTIAL") {
    notes = `Remaining: ${(completion.remaining_work || []).join("; ")}`;
  } else if (status === "BLOCKED") {
    notes = completion.blocker;
  }
  const result = `--- ${label} START ---\nstatus: ${status}\nsummary: ${summary}\nnotes: ${boundedWords(notes)}\n--- ${label} END ---`;
  const fileRequests = Array.isArray(completion.file_requests) ? completion.file_requests : [];
  if (fileRequests.length === 0) return result;
  const requestBlock = [
    "FILE_REQUEST:",
    ...fileRequests.map((request) => `- ${request.path} — ${request.reason}`),
    "FILE_REQUEST_END",
  ].join("\n");
  return `${requestBlock}\n${result}`;
}

export function plannerCompatibilityTasks(packet) {
  const indexes = new Map(packet.handoffs.map((handoff, index) => [handoff.id, index]));
  return packet.handoffs.map((handoff) => {
    const taskSpec = plannerTaskSpec(handoff);
    const refs = evidenceRefs(handoff.report);
    const metadata = Object.fromEntries(
      PLANNER_REPORT_METADATA_KEYS
        .filter((key) => handoff.report[key] != null)
        .map((key) => [key, handoff.report[key]]),
    );
    const task = {
        title: handoff.intent,
        task_spec: taskSpec,
        success_criteria: handoff.report.success_criteria.length ? handoff.report.success_criteria : [handoff.intent],
        depends_on_index: handoff.depends_on.map((id) => indexes.get(id)),
        task_mode: handoff.report.scope.task_mode || "code",
        files_to_modify: handoff.report.scope.files_to_modify || [],
        files_to_create: handoff.report.scope.files_to_create || [],
        files_to_delete: handoff.report.scope.files_to_delete || [],
        create_roots: handoff.report.scope.create_roots || [],
        ...(handoff.report.scope.output_root ? { output_root: handoff.report.scope.output_root } : {}),
        ...metadata,
        job_type: handoff.target.role === "artificer" ? "artificer" : handoff.target.role,
        ...(handoff.target.role === "human_input" ? { questions: handoff.report.questions } : {}),
        dev_brief: {
          source: "hash_ref_store",
          summary: handoff.report.summary,
          key_files: handoff.report.scope.files_to_modify || [],
          related_files: [],
          planner_file_priorities: (handoff.report.scope.files_to_modify || []).map((path, index) => ({ path, rank: index + 1 })),
          ...refs,
        },
    };
    if (handoff.target.kind === "system" && handoff.target.role === "promote") {
      task.mappings = plannerPromoteMappings(handoff);
    }
    return task;
  });
}


export function renderAgentHandoffCompatibilityOutput(packet) {
  if (packet.completion && ["dev.result.v1", "artificer.result.v1"].includes(packet.profile)) {
    return renderCompletionCompatibilityOutput(packet);
  }
  if (packet.profile === "planner.plan.v1") {
    const tasks = plannerCompatibilityTasks(packet);
    return `\`\`\`json\n${JSON.stringify(tasks, null, 2)}\n\`\`\``;
  }
  const first = packet.handoffs[0];
  const report = renderReport(first.report, {
    claimCode: packet.profile === "researcher.report.v1",
  });
  if (packet.profile === "assessor.verdict.v1") {
    const reasons = [...new Set(
      [first.report.summary, ...first.report.claims.map((claim) => [claim[0], claim[1]?.prose].filter(Boolean).join(" — "))]
        .map((reason) => String(reason || "").trim())
        .filter(Boolean),
    )];
    const repair = String(first.report.payload?.repair || "").trim();
    const spawnJobs = packet.outcome === "fail" && repair
      ? [{
          job_type: "fix",
          title: "Fix assessed defect",
          payload: { instructions: repair },
        }]
      : [];
    return `\`\`\`json\n${JSON.stringify({
      verdict: packet.outcome,
      confidence: packet.confidence,
      reasons,
      spawn_jobs: spawnJobs,
      human_questions: first.report.questions,
      suggestions: [],
    }, null, 2)}\n\`\`\``;
  }
  if (packet.profile === "dev.result.v1") return `--- DEV RESULT START ---\n${report}\n--- DEV RESULT END ---`;
  if (packet.profile === "artificer.result.v1") return `--- ARTIFICER RESULT START ---\n${report}\n--- ARTIFICER RESULT END ---`;
  if (packet.profile === "researcher.pipeline.v1") {
    return `\`\`\`json\n${JSON.stringify(researcherPacketToStructuredOutput(packet), null, 2)}\n\`\`\``;
  }
  return report;
}

