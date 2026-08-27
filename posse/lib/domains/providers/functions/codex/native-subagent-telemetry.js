import fs from "node:fs";
import path from "node:path";
import { parseCodexRolloutUsage } from "./rollout-usage.js";

function token(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function dateDirectories(codexHome, startedAtMs) {
  const root = path.join(String(codexHome || ""), "sessions");
  const started = Number(startedAtMs);
  if (!String(codexHome || "").trim() || !Number.isFinite(started)) return [];
  return [-1, 0, 1].map((offset) => {
    const date = new Date(started + offset * 86_400_000);
    return path.join(root, String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0"));
  });
}

function parseRollout(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  let lineage = null;
  let modelName = null;
  let firstAt = null;
  let lastAt = null;
  const dispatches = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row.timestamp === "string") {
      firstAt ||= row.timestamp;
      lastAt = row.timestamp;
    }
    const payload = row?.payload || {};
    const spawn = payload?.source?.subagent?.thread_spawn;
    if (row?.type === "session_meta" && spawn && !lineage) {
      lineage = {
        // Native child rollouts retain the parent's session_id and put the
        // child's unique thread identity in id. Prefer id so sibling agents
        // do not collapse onto the parent handle.
        sessionHandle: String(payload.id || payload.session_id || "").trim() || null,
        parentSessionHandle: String(spawn.parent_thread_id || "").trim() || null,
        depth: token(spawn.depth),
        agentPath: String(spawn.agent_path || "").trim() || null,
        nickname: String(spawn.agent_nickname || "").trim() || null,
        agentRole: String(spawn.agent_role || "").trim() || null,
      };
    }
    if (row?.type === "turn_context" && payload.model) modelName = String(payload.model);
    if (row?.type === "event_msg" && payload.type === "turn_context" && payload.model) modelName = String(payload.model);
    if (row?.type === "response_item" && payload.type === "function_call" && payload.name === "spawn_agent") {
      let args = {};
      try { args = JSON.parse(payload.arguments || "{}"); } catch { /* malformed args remain empty */ }
      dispatches.push({
        callId: payload.call_id || null,
        taskName: String(args.task_name || "").trim() || null,
        forkTurns: String(args.fork_turns || "").trim() || null,
      });
    }
  }
  const usage = parseCodexRolloutUsage(text);
  return { file, lineage, modelName, firstAt, lastAt, dispatches, usage };
}

function sumChildren(children) {
  const fields = ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens"];
  return Object.fromEntries(fields.map((field) => {
    const known = children.map((child) => token(child.usage?.[field])).filter((value) => value != null);
    return [field, known.length === children.length ? known.reduce((sum, value) => sum + value, 0) : null];
  }));
}

export function recoverCodexNativeSubagentTelemetry({ codexHome, parentSessionHandle, startedAtMs } = {}) {
  const parent = String(parentSessionHandle || "").trim();
  if (!parent) return null;
  const parsed = [];
  for (const directory of [...new Set(dateDirectories(codexHome, startedAtMs))]) {
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const rollout = parseRollout(path.join(directory, entry.name));
      if (rollout?.lineage?.sessionHandle && rollout.lineage.parentSessionHandle) parsed.push(rollout);
    }
  }
  const descendants = [];
  const knownParents = new Set([parent]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const rollout of parsed) {
      if (descendants.includes(rollout) || !knownParents.has(rollout.lineage.parentSessionHandle)) continue;
      descendants.push(rollout);
      knownParents.add(rollout.lineage.sessionHandle);
      changed = true;
    }
  }
  const children = descendants.map((rollout, index) => ({
    ordinal: index + 1,
    sessionHandle: rollout.lineage.sessionHandle,
    parentSessionHandle: rollout.lineage.parentSessionHandle,
    depth: rollout.lineage.depth,
    agentPath: rollout.lineage.agentPath,
    nickname: rollout.lineage.nickname,
    agentRole: rollout.lineage.agentRole,
    modelName: rollout.modelName,
    status: rollout.usage?.complete === true ? "complete" : "incomplete",
    startedAt: rollout.firstAt,
    completedAt: rollout.lastAt,
    durationMs: rollout.firstAt && rollout.lastAt ? Math.max(0, Date.parse(rollout.lastAt) - Date.parse(rollout.firstAt)) : null,
    providerRequestCount: rollout.usage?.providerRequestCount ?? null,
    turns: rollout.usage?.numTurns ?? null,
    usage: rollout.usage?.usage || null,
    usageSegments: rollout.usage?.segments || [],
    usagePrecision: rollout.usage?.complete === true ? "recovered_exact" : "incomplete",
    rolloutFile: path.basename(rollout.file),
    dispatches: rollout.dispatches,
  }));
  const parentRollout = (() => {
    for (const directory of [...new Set(dateDirectories(codexHome, startedAtMs))]) {
      let entries = [];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
      const entry = entries.find((candidate) => candidate.isFile() && candidate.name.endsWith(`-${parent}.jsonl`));
      if (entry) return parseRollout(path.join(directory, entry.name));
    }
    return null;
  })();
  const exact = children.filter((child) => child.usagePrecision === "recovered_exact");
  const totals = sumChildren(children);
  return {
    schemaVersion: 1,
    provider: "codex",
    parentSessionHandle: parent,
    accountingMode: "additive_children_not_in_parent_rollout",
    additiveToParentTotals: true,
    dispatchCount: (parentRollout?.dispatches?.length || 0) + children.reduce((sum, child) => sum + child.dispatches.length, 0),
    childCount: children.length,
    completedCount: exact.length,
    childTokenCoverage: { known: exact.length, total: children.length },
    childUsage: totals,
    childProviderRequestCount: children.every((child) => child.providerRequestCount != null)
      ? children.reduce((sum, child) => sum + child.providerRequestCount, 0)
      : null,
    capturePrecision: exact.length === children.length ? "recovered_exact" : "partial",
    dispatches: parentRollout?.dispatches || [],
    children,
  };
}
