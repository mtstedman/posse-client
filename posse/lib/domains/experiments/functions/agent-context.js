import { fileDigest } from "./snapshots.js";

const brief = (value, limit) => String(value || "").replace(/\s+/g, " ").slice(0, limit);

// Column names occur once per table; raw evidence remains in the owner store.
export function decisionTables(campaign, limit = 8) {
  const metrics = campaign.plan.metrics.map(metric => metric.id);
  const table = (decision, reason) => {
    const all = campaign.iterations.filter(row => row.decision?.value === decision);
    const selected = all.slice(-limit);
    return { columns: ["iteration", "change", ...metrics, ...(reason ? ["reason"] : [])],
      rows: selected.map(row => [row.number, brief(row.hypothesis, 240), ...metrics.map(id => row.metrics?.[id] ?? null),
        ...(reason ? [brief(row.decision.reason || row.assessment?.reason, 240)] : [])]), omitted: all.length - selected.length };
  };
  return { accepted: table("accept", false), rejected: table("reject", true) };
}

export function fileInventory(plan, files) {
  return { columns: ["path", "mode", "bytes", "sha256"], rows: plan.files.map(file => [file.path, file.mode, Buffer.byteLength(files[file.path]), fileDigest(files[file.path])]) };
}

export function editableFiles(plan, files, maxBytes = 24000) {
  const result = {}; let bytes = 0;
  for (const file of plan.files.filter(file => file.mode !== "read")) {
    const size = Buffer.byteLength(files[file.path]);
    if (bytes + size <= maxBytes) { result[file.path] = files[file.path]; bytes += size; }
  }
  return result;
}

// A linear, bounded replacement span avoids sending two complete file copies.
// Multiple distant edits can share a span; readers can request exact ranges.
export function changeSummary(before, changes, maxCharacters = 16000) {
  let remaining = maxCharacters;
  return Object.entries(changes).filter(([file, after]) => before[file] !== after).map(([file, after]) => {
    const old = (before[file] || "").split("\n"), next = after.split("\n");
    let start = 0, end = 0;
    while (start < Math.min(old.length, next.length) && old[start] === next[start]) start++;
    while (end < Math.min(old.length, next.length) - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++;
    const removed = old.slice(start, old.length - end).join("\n"), added = next.slice(start, next.length - end).join("\n");
    const allowance = Math.max(0, Math.floor(remaining / 2));
    const result = { path: file, before_sha256: fileDigest(before[file] || ""), after_sha256: fileDigest(after), start_line: start + 1,
      removed_lines: old.length - start - end, added_lines: next.length - start - end,
      removed: removed.slice(0, allowance), added: added.slice(0, allowance), truncated: removed.length > allowance || added.length > allowance };
    remaining -= result.removed.length + result.added.length; return result;
  });
}

export function fileExcerpt(files, { path, start_line = 1, line_count = 120 }) {
  if (!Object.hasOwn(files, path)) throw new Error("File is outside the declared payload.");
  const lines = files[path].split("\n"); const content = lines.slice(start_line - 1, start_line - 1 + line_count).join("\n");
  return { path, sha256: fileDigest(files[path]), start_line, total_lines: lines.length, content: content.slice(0, 12000), truncated: content.length > 12000 };
}

export function checkSummary(verification) {
  if (!verification) return null;
  return { ok: verification.ok, digest: verification.digest, tree_changed: verification.tree_changed,
    results: verification.results.map((result, index) => ({ check: index, ok: result.ok, code: result.code, stopped: result.stopped,
      ...(!result.ok ? { diagnostic: result.output.slice(-2000) } : {}) })) };
}

export function recordContextUsage(record, role, request) {
  record.context_usage ||= {};
  const usage = record.context_usage[role] ||= { calls: 0, request_bytes: 0, peak_request_bytes: 0, input_tokens: 0, output_tokens: 0 };
  const bytes = Buffer.byteLength(JSON.stringify(request)); usage.calls++; usage.request_bytes += bytes; usage.peak_request_bytes = Math.max(usage.peak_request_bytes, bytes);
}

export function recordContextTokens(record, role, stats) {
  const usage = record.context_usage?.[role]; if (!usage) return;
  usage.input_tokens += stats.inputTokens; usage.output_tokens += stats.outputTokens;
}

// Runtime bookkeeping and source digests remain with the owner. Agents get
// the constraints that affect their edit, plus compact measured findings.
export function agentPlan(plan) {
  return { objective: plan.objective, entrypoint: plan.entrypoint, runtime: plan.runtime,
    files: plan.files.map(({ path, mode, instructions }) => ({ path, mode, instructions })),
    metrics: plan.metrics, acceptance: plan.acceptance };
}
export function actionSummary(previous, maxBytes = 12000) {
  if (!previous) return null;
  const result = previous.result;
  const summary = { action: previous.action, ...(previous.error ? { error: brief(previous.error, 1000) } : {}),
    ...(previous.arguments && previous.action === "test.read" ? { request: previous.arguments } : {}),
    ...(result && Object.hasOwn(result, 'staged') ? { staged: result.staged, reason: brief(result.reason || result.review, 600) } : {}),
    ...(result?.advice ? { advice: brief(result.advice, 2000) } : {}) };
  if (previous.action === "test.files" && result?.rows) {
    summary.result = { columns: result.columns, rows: [...result.rows], omitted: 0, truncated: false };
    while (Buffer.byteLength(JSON.stringify(summary)) > maxBytes && summary.result.rows.length) {
      summary.result.rows.pop(); summary.result.omitted++; summary.result.truncated = true;
    }
  } else if (previous.action === "test.read" && result) {
    summary.result = { ...result };
    if (Buffer.byteLength(JSON.stringify(summary)) > maxBytes) {
      summary.result.truncated = true;
      summary.result.content_bytes = Buffer.byteLength(result.content || "");
      let low = 0, high = (result.content || "").length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        summary.result.content = result.content.slice(0, middle);
        if (Buffer.byteLength(JSON.stringify(summary)) <= maxBytes) low = middle; else high = middle - 1;
      }
      summary.result.content = result.content.slice(0, low);
    }
  }
  return summary;
}

// Retain useful reads, not a transcript. The latest action and the small working
// window share one serialized byte allowance, including JSON escaping/UTF-8.
export function coordinatorActions(previous, reads, inventory) {
  const context = { ...(inventory ? { inventory } : {}), last_action: actionSummary(previous), recent_reads: reads.filter(item => item !== previous).slice(-3).map(item => actionSummary(item)), omitted_reads: 0 };
  while (Buffer.byteLength(JSON.stringify(context)) > 16384 && context.recent_reads.length) {
    context.recent_reads.shift(); context.omitted_reads++;
  }
  return context;
}
