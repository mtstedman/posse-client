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

export function fileExcerpt(files, { path, start_line = 1, line_count = 120 }, maxBytes = L.contextBytes) {
  if (!Object.hasOwn(files, path)) throw new Error("File is outside the declared payload.");
  const lines = files[path].split("\n"); const content = lines.slice(start_line - 1, start_line - 1 + line_count).join("\n");
  const result = { path, sha256: fileDigest(files[path]), start_line, total_lines: lines.length, content, content_bytes: Buffer.byteLength(content), truncated: false };
  return actionSummary({ action: "test.read", result: sourceContent(result, content) }, maxBytes).result;
}

// Prefer complete lines when fitting a read. A huge first line may only fit
// partially: report that line as the continuation, never silently skip its tail.
function sourceContent(result, prefix) {
  const cut = prefix.length < result.content.length;
  const ranged = Number.isInteger(result.start_line) && Number.isInteger(result.total_lines);
  let partial = result.partial_line || false;
  if (cut) {
    if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
    if (ranged) {
      const newline = prefix.lastIndexOf("\n");
      partial = newline < 0 && prefix.length > 0;
      if (newline >= 0) prefix = prefix.slice(0, newline);
    }
  }
  const value = { ...result, content: prefix, returned_bytes: Buffer.byteLength(prefix), truncated: !!result.truncated || cut };
  if (ranged) {
    const count = prefix.length || (!value.truncated && result.start_line <= result.total_lines) ? prefix.split("\n").length : 0;
    value.end_line = count ? result.start_line + count - 1 : null;
    value.partial_line = partial;
    const next = count ? (partial ? value.end_line : value.end_line + 1) : result.start_line;
    value.next_line = next <= result.total_lines ? next : null;
  }
  return value;
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
  if (previous.action === "test.lookup_batch" && result) summary.result = boundedLookupBatch(result.items, Math.min(L.contextBytes, maxBytes - 200));
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
      const original = { ...result, content_bytes: result.content_bytes ?? Buffer.byteLength(result.content || "") };
      let low = 0, high = (result.content || "").length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        summary.result = sourceContent(original, result.content.slice(0, middle));
        if (Buffer.byteLength(JSON.stringify(summary)) <= maxBytes) low = middle; else high = middle - 1;
      }
      summary.result = sourceContent(original, result.content.slice(0, low));
    }
  }
  return summary;
}

// Complete small results release their unused allowance to larger results.
// Nothing is clipped when the full packet fits; framing counts toward the cap.
function fitPacket(items, maxBytes, wrap, bound) {
  const full = wrap(items);
  if (Buffer.byteLength(JSON.stringify(full)) <= maxBytes) return full;
  let remaining = maxBytes - Buffer.byteLength(JSON.stringify(wrap([]))) - Math.max(0, items.length - 1);
  const ordered = items.map((item, index) => ({ index, bytes: Buffer.byteLength(JSON.stringify(item)) })).sort((a, b) => a.bytes - b.bytes);
  const allowances = [];
  for (const [position, item] of ordered.entries()) {
    const allowance = Math.min(item.bytes, Math.floor(remaining / (items.length - position)));
    allowances[item.index] = allowance; remaining -= allowance;
  }
  const fitted = wrap(items.map((item, index) => {
    if (Buffer.byteLength(JSON.stringify(item)) <= allowances[index]) return item;
    const result = bound(item, allowances[index]);
    if (Buffer.byteLength(JSON.stringify(result)) <= allowances[index]) return result;
    const omitted = { index: item.index ?? item.batch_index ?? index, truncated: true, error: "Metadata omitted; request this lookup individually." };
    if (Buffer.byteLength(JSON.stringify(omitted)) > allowances[index]) throw new Error("Source packet metadata exceeds its byte budget.");
    return omitted;
  }));
  if (Buffer.byteLength(JSON.stringify(fitted)) > maxBytes) throw new Error("Source packet exceeds its byte budget.");
  return fitted;
}

export function boundedLookupBatch(items, maxBytes = L.contextBytes) {
  const complete = items.map((item, index) => ({ index, action: item.action, ...(item.request ? { request: item.request } : {}),
    ...(item.error ? { error: brief(item.error, 200) } : { result: item.result }),
    ...(item.request_omitted ? { request_omitted: true } : {}), ...(item.truncated ? { truncated: true } : {}) }));
  return fitPacket(complete, maxBytes, rows => ({ items: rows, byte_limit: maxBytes }), (item, allowance) => {
    const result = actionSummary({ action: item.action, arguments: item.request, result: item.result, error: item.error }, allowance - 64);
    return Buffer.byteLength(JSON.stringify(result)) <= allowance - 64 ? { index: item.index, ...result, ...(item.request_omitted ? { request_omitted: true } : {}), ...(item.truncated ? { truncated: true } : {}) }
      : { index: item.index, action: item.action, request: { version: item.request?.version }, request_omitted: true,
        error: "Request/result metadata exceeds the shared allowance; request this item individually.", truncated: true };
  });
}

// Retain useful reads, not a transcript. The latest action and the small working
// window share one serialized byte allowance, including JSON escaping/UTF-8.
export function coordinatorActions(previous, reads, inventory, overview) {
  const recent = reads.filter(item => item !== previous).slice(-3);
  const context = { ...(inventory ? { inventory } : {}), ...(overview ? { source_overview: overview } : {}), last_action: null, recent_reads: [], omitted_reads: 0 };
  const bytes = () => Buffer.byteLength(JSON.stringify(context));
  // Spend the available window on the latest lookup before older prefetch.
  // There is no second fixed 8 KiB cap on a freshly returned batch.
  context.last_action = actionSummary(previous, L.contextBytes - bytes() - 32);
  for (const item of recent.reverse()) {
    const spare = L.contextBytes - bytes() - 32;
    if (spare < 512) { context.omitted_reads++; continue; }
    const summary = actionSummary(item, spare);
    if (Buffer.byteLength(JSON.stringify(summary)) <= spare) context.recent_reads.unshift(summary);
    else context.omitted_reads++;
  }
  if (bytes() > L.contextBytes) throw new Error("Coordinator source packet exceeds its byte budget.");
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
  // Deduplication must use the bytes the next decision can actually see, not
  // the larger raw read that sourcePacket would otherwise trim afterwards.
  const bounded = value => value.tool === "test.read" && typeof value.content === "string" ? sourcePacket({ entries: [value], omitted: 0 }).requested_source[0] : value;
  entry = bounded(entry);
  history.entries = history.entries.map(bounded);
  const key = value => JSON.stringify([value.tool, value.request, value.request_omitted ? value.batch_index : null]);
  let retained = entry;
  history.entries = history.entries.filter(value => {
    const sameSource = retained.tool === "test.read" && value.tool === "test.read" && retained.sha256 && value.sha256 === retained.sha256 && value.path === retained.path && value.version === retained.version;
    if (sameSource) {
      const covers = (outer, inner) => outer.start_line <= inner.start_line && inner.start_line <= outer.start_line + outer.content.split("\n").length - 1
        && outer.content.split("\n").slice(inner.start_line - outer.start_line).join("\n").startsWith(inner.content);
      if (covers(value, retained)) { retained = value; return false; }
      if (covers(retained, value)) return false;
      // Partial overlap does not imply replacement. Keep both useful tails;
      // the shared byte window explicitly reports any actual eviction.
      return true;
    }
    return key(value) !== key(entry);
  });
  history.entries.push(retained);
  history.fresh = Math.min(history.entries.length, (history.fresh || 0) + 1);
  if (history.entries.length > L.history) { history.entries.shift(); history.omitted++; }
}

export function sourcePacket(history, extra = {}, maxBytes = L.contextBytes) {
  if (Buffer.byteLength(JSON.stringify(extra)) > maxBytes / 4) extra = { metadata_truncated: true,
    last_source_batch: (extra.last_source_batch || []).slice(0, L.batchItems).map((item, index) => ({ index, action: brief(item.action, 32), ok: !!item.ok,
      ...(item.error ? { error: "Error details omitted to fit source budget." } : {}) })) };
  const bounded = (entry, allowance) => {
    if (typeof entry.content === "string") {
      const result = actionSummary({ action: "test.read", result: entry }, allowance).result;
      if (Buffer.byteLength(JSON.stringify(result)) <= allowance) return result;
    }
    if (Array.isArray(entry.rows)) {
      const result = { ...entry, rows: [...entry.rows] };
      while (Buffer.byteLength(JSON.stringify(result)) > allowance && result.rows.length) {
        result.rows.pop(); result.omitted = (result.omitted || 0) + 1; result.truncated = true;
        result.next_offset = (entry.request?.offset || 0) + result.rows.length;
      }
      if (Buffer.byteLength(JSON.stringify(result)) <= allowance) return result;
    }
    return { tool: entry.tool, request: { version: entry.request?.version }, request_omitted: true, batch_index: entry.batch_index,
      truncated: true, error: "Result metadata exceeds the shared allowance; request this item individually." };
  };
  const wrap = entries => ({ ...extra, requested_source: entries, omitted_source_reads: history.omitted });
  let packet;
  const freshCount = Math.min(history.fresh || 0, history.entries.length);
  if (freshCount && freshCount < history.entries.length && Buffer.byteLength(JSON.stringify(wrap(history.entries))) > maxBytes) {
    const fresh = history.entries.slice(-freshCount), older = history.entries.slice(0, -freshCount);
    const freshPacket = fitPacket(fresh, maxBytes - 32, wrap, bounded);
    // Older source may use spare room, but cannot shorten a newly requested span.
    const spare = maxBytes - Buffer.byteLength(JSON.stringify(freshPacket));
    while (older.length && spare < older.length * 512) { older.shift(); history.omitted++; }
    if (older.length) {
      packet = fitPacket(older, maxBytes, entries => wrap([...entries, ...freshPacket.requested_source]), bounded);
    } else packet = wrap(freshPacket.requested_source);
  } else packet = fitPacket(history.entries, maxBytes, wrap, bounded);
  if (Buffer.byteLength(JSON.stringify(packet)) > maxBytes) throw new Error("Source packet exceeds its byte budget.");
  history.fresh = 0;
  // Future containment decisions must use the spans actually delivered under
  // this aggregate budget, including receipt/wrapper overhead.
  history.entries = packet.requested_source;
  return packet;
}

export function prefetchSource(plan, files, targets, overview, version = "accepted") {
  const selected = targets.length ? targets : overview.files.filter(file => file.mode !== "read" && file.anchors.length).slice(0, 3)
    .map(file => ({ path: file.path, start_line: file.anchors[0][2], line_count: Math.max(20, file.anchors[0][3]) }));
  const history = { entries: [], omitted: 0 };
  for (const target of selected.slice(0, L.targets)) {
    const tiny = Buffer.byteLength(files[target.path]) <= 1000;
    const enclosing = (overview.files.find(file => file.path === target.path)?.anchors || [])
      .filter(row => ["function", "method", "constructor"].includes(row[1]) && row[2] <= target.start_line
        && row[4] >= target.start_line + target.line_count - 1 && row[4] - row[2] < 200)
      .sort((a, b) => (a[4] - a[2]) - (b[4] - b[2]))[0];
    const request = { path: target.path, version, start_line: tiny ? 1 : enclosing?.[2] ?? target.start_line,
      line_count: tiny ? 200 : enclosing ? enclosing[4] - enclosing[2] + 1 : Math.min(200, target.line_count) };
    const result = fileExcerpt(files, request, L.contextBytes);
    history.entries.push({ tool: "test.read", request, version, ...result, prefetched: true });
  }
  // Prefetch gets at most half the source window, leaving room for requested
  // reads. Exact source remains available through the scoped test.read tool.
  sourcePacket(history, {}, L.contextBytes / 2);
  return history;
}

export function lookupDiagnostic(role, used, limit, call, result) {
  const calls = call.name === "test.lookup_batch" ? call.arguments.requests : [call];
  const items = calls.map((item, index) => {
    const value = call.name === "test.lookup_batch" ? result?.items?.[index] : { result, error: result?.error };
    return { index, action: item.name, path: item.arguments.path, version: item.arguments.version,
      start_line: item.arguments.start_line, line_count: item.arguments.line_count,
      end_line: value?.result?.end_line, next_line: value?.result?.next_line, partial_line: value?.result?.partial_line,
      truncated: value?.result?.truncated ?? value?.truncated ?? false,
      ...(value?.error ? { error: brief(value.error, 160) } : {}) };
  });
  const diagnostic = { role, turns_used: used, turns_remaining: limit - used, limit, action: call.name, operations: calls.length, pending: result === undefined, items, omitted: 0 };
  while (Buffer.byteLength(JSON.stringify(diagnostic)) > 4096 && items.length) { items.pop(); diagnostic.omitted++; }
  return diagnostic;
}
