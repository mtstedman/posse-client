import { fileDigest } from "./snapshots.js";
import { EXPERIMENT_SOURCE_LIMITS as L } from "../../../catalog/experiment-runner.js";

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
  if (Number.isFinite(stats.cachedInputTokens) && stats.cachedInputTokens >= 0) usage.cached_input_tokens = (usage.cached_input_tokens || 0) + stats.cachedInputTokens;
}

// Runtime bookkeeping and source digests remain with the owner. Agents get
// the constraints that affect their edit, plus compact measured findings.
export function agentPlan(plan, targets = []) {
  return { objective: plan.objective, entrypoint: plan.entrypoint, runtime: plan.runtime,
    files: plan.files.filter(file => file.mode !== "read" || targets.some(target => target.path === file.path) || file.path === plan.entrypoint).map(({ path, mode, instructions }) => ({ path, mode, instructions })),
    metrics: plan.metrics, acceptance: plan.acceptance };
}
export function actionSummary(previous, maxBytes = 12000) {
  if (!previous) return null;
  const result = previous.result;
  const summary = { action: previous.action, ...(previous.error ? { error: brief(previous.error, 1000) } : {}),
    ...(previous.arguments && ["test.read", "test.search"].includes(previous.action) ? { request: previous.arguments } : {}),
    ...(previous.action === "test.lookup_batch" ? { request: { operations: previous.arguments?.requests?.length || 0 } } : {}),
    ...(result && Object.hasOwn(result, 'staged') ? { staged: result.staged, reason: brief(result.reason || result.review, 600) } : {}),
    ...(result?.advice ? { advice: brief(result.advice, 2000) } : {}) };
  if (previous.action === "test.lookup_batch" && result) summary.result = boundedLookupBatch(result.items, Math.min(L.batchBytes, maxBytes - 200));
  else if (previous.action === "test.files" && result?.rows) {
    summary.result = { columns: result.columns, rows: [...result.rows], omitted: 0, truncated: false };
    while (Buffer.byteLength(JSON.stringify(summary)) > maxBytes && summary.result.rows.length) {
      summary.result.rows.pop(); summary.result.omitted++; summary.result.truncated = true;
    }
  } else if (previous.action === "test.search" && result) {
    summary.result = { ...result, rows: [...result.rows] };
    while (Buffer.byteLength(JSON.stringify(summary)) > maxBytes && summary.result.rows.length) {
      summary.result.rows.pop(); summary.result.omitted++; summary.result.truncated = true;
      summary.result.next_offset = (previous.arguments?.offset || 0) + summary.result.rows.length;
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

export function boundedLookupBatch(items, maxBytes = L.batchBytes) {
  const allowance = Math.floor((maxBytes - 512) / items.length);
  return { items: items.map((item, index) => {
    const result = actionSummary({ action: item.action, arguments: item.request, result: item.result, error: item.error ? brief(item.error, 200) : undefined }, allowance - 64);
    return Buffer.byteLength(JSON.stringify(result)) <= allowance - 64 ? { index, ...result, ...(item.request_omitted ? { request_omitted: true } : {}), ...(item.truncated ? { truncated: true } : {}) }
      : { index, action: item.action, request: { version: item.request?.version }, request_omitted: true,
        error: "Request/result metadata exceeds the batch allowance; request this item individually.", truncated: true };
  }), byte_limit: maxBytes };
}

// Retain useful reads, not a transcript. The latest action and the small working
// window share one serialized byte allowance, including JSON escaping/UTF-8.
export function coordinatorActions(previous, reads, inventory, overview) {
  const context = { ...(inventory ? { inventory } : {}), ...(overview ? { source_overview: overview } : {}), last_action: actionSummary(previous, overview ? 8000 : 12000), recent_reads: reads.filter(item => item !== previous).slice(-3).map(item => actionSummary(item)), omitted_reads: 0 };
  while (Buffer.byteLength(JSON.stringify(context)) > 16384 && context.recent_reads.length) {
    context.recent_reads.shift(); context.omitted_reads++;
  }
  return context;
}

export function validateEditTargets(plan, files, targets = []) {
  for (const target of targets) {
    const file = plan.files.find(file => file.path === target.path);
    if (!file || file.mode === "read") throw new Error("Edit targets must reference declared editable files.");
    if (fileDigest(files[target.path]) !== target.sha256) throw new Error("Edit target digest is stale; search or read the accepted snapshot again.");
    if (target.start_line > files[target.path].split("\n").length) throw new Error("Edit target range is outside the accepted file.");
  }
  return targets;
}

// Current state for an edit/review, without polling bookkeeping or unrelated
// hypotheses. Only the coordinator gets the experiment decision history.
export function agentFindings(c, role = "coordinator") {
  const metrics = { columns: ["id", "target", "accepted", ...(role === "coordinator" ? ["starting", "latest"] : [])],
    rows: c.plan.metrics.map(m => [m.id, m.target ?? null, c.current_baseline.metrics?.[m.id] ?? null,
      ...(role === "coordinator" ? [c.starting_baseline.metrics?.[m.id] ?? null, c.iterations.at(-1)?.metrics?.[m.id] ?? null] : [])]) };
  if (role !== "coordinator") return { metrics };
  const latest = c.iterations.at(-1);
  return { state: c.state, iterations_remaining: c.plan.max_iterations - c.iterations.length, metrics,
    latest_decision: latest ? { iteration: latest.number, decision: latest.decision?.value ?? null, reason: latest.assessment?.reason ?? latest.failure_reason ?? null,
      utility_gain: latest.assessment?.tradeoff?.utility_gain ?? null } : null };
}

export function rememberSourceRead(history, entry) {
  const key = value => JSON.stringify([value.tool, value.request, value.request_omitted ? value.batch_index : null]);
  history.entries = history.entries.filter(value => {
    if (key(value) === key(entry)) return false;
    if (entry.tool !== "test.read" || value.tool !== "test.read" || !entry.sha256 || value.sha256 !== entry.sha256 || value.path !== entry.path || value.version !== entry.version) return true;
    const end = item => item.start_line + item.content.split("\n").length - 1;
    return end(value) < entry.start_line || end(entry) < value.start_line;
  });
  history.entries.push(entry);
  if (history.entries.length > L.history) { history.entries.shift(); history.omitted++; }
}

export function sourcePacket(history, extra = {}) {
  const bounded = entry => {
    if (typeof entry.content === "string") return actionSummary({ action: "test.read", result: entry }, 8000).result;
    if (Array.isArray(entry.rows)) {
      const result = { ...entry, rows: [...entry.rows] };
      while (Buffer.byteLength(JSON.stringify(result)) > 8000 && result.rows.length) {
        result.rows.pop(); result.omitted = (result.omitted || 0) + 1; result.truncated = true;
        result.next_offset = (entry.request?.offset || 0) + result.rows.length;
      }
      return result;
    }
    return Buffer.byteLength(JSON.stringify(entry)) <= 8000 ? entry
      : { tool: entry.tool, request: entry.request, truncated: true, error: "Result exceeds the context budget; request a narrower resource or range." };
  };
  const packet = { ...extra, requested_source: history.entries.map(bounded), omitted_source_reads: history.omitted };
  while (Buffer.byteLength(JSON.stringify(packet)) > L.contextBytes && packet.requested_source.length) {
    packet.requested_source.shift(); packet.omitted_source_reads++;
  }
  return packet;
}

export function prefetchSource(plan, files, targets, overview, version = "accepted") {
  const selected = targets.length ? targets : overview.files.filter(file => file.mode !== "read" && file.anchors.length).slice(0, 3)
    .map(file => ({ path: file.path, start_line: file.anchors[0][2], line_count: Math.max(20, file.anchors[0][3]) }));
  const history = { entries: [], omitted: 0 };
  for (const target of selected.slice(0, L.targets)) {
    const tiny = Buffer.byteLength(files[target.path]) <= 1000;
    const request = { path: target.path, version, start_line: tiny ? 1 : target.start_line, line_count: tiny ? 200 : Math.min(40, target.line_count) };
    const result = fileExcerpt(files, request);
    const entry = actionSummary({ action: "test.read", result: { tool: "test.read", request, version, ...result, prefetched: true } }, 2500).result;
    const lines = entry.content.split("\n").length;
    entry.next_line = entry.start_line + lines - (entry.truncated ? 1 : 0);
    if (entry.next_line > entry.total_lines) entry.next_line = null;
    history.entries.push(entry);
  }
  // Prefetch gets at most half the source window, leaving room for requested
  // reads. Exact source remains available through the scoped test.read tool.
  while (Buffer.byteLength(JSON.stringify(history.entries)) > L.contextBytes / 2) { history.entries.pop(); history.omitted++; }
  return history;
}
