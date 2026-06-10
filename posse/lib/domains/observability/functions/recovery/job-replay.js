import { createHash } from "crypto";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { readRecentOutputs } from "../../../../shared/telemetry/functions/logging/output-log.js";
import { promptPreviewText, readRecentPrompts } from "../../../../shared/telemetry/functions/logging/prompt-log.js";
import { recordObservation } from "../observations.js";
import { getAgentCallById, getToolInvocationsForAgentCall } from "../../../queue/functions/agent-calls.js";
import { storeArtifact } from "../../../queue/functions/artifacts.js";

export const REPLAY_PACKET_VERSION = 1;
const CHECKPOINT_ARTIFACT_TYPE = "log";
const CHECKPOINT_KIND = "recovery_checkpoint";
const REPLAY_KIND = "agent_call_replay";
const MEMORY_TTL_MS = 2 * 60 * 60 * 1000;
const MEMORY_MAX_CALLS = 200;
const MAX_OBJECT_KEYS = 32;
const MAX_ARRAY_ITEMS = 24;
const MAX_COMPACT_TEXT = 900;
const MAX_OUTPUT_TEXT = 4000;
const MAX_TOOL_TRANSCRIPT = 200;
const PROMPT_KEY_PATTERN = /(prompt|system[_-]?prompt|instruction|secret|token|password|api[_-]?key|authorization|credential)/i;

const replayMemory = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sha256(value = "") {
  return createHash("sha256").update(String(value)).digest("hex");
}

function parseJsonMaybe(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function truncateOneLine(value, max = 160) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}...`;
}

export function compactText(value, { max = MAX_COMPACT_TEXT } = {}) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return {
    text_preview: text.slice(0, max),
    chars: text.length,
    sha256: sha256(text),
    truncated: true,
  };
}

export function compactValue(value, { maxText = MAX_COMPACT_TEXT, depth = 0 } = {}) {
  if (value == null) return value;
  if (typeof value === "string") return compactText(value, { max: maxText });
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 4) return "[object]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((entry) => compactValue(entry, { maxText, depth: depth + 1 }));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push({ omitted_items: value.length - MAX_ARRAY_ITEMS });
    }
    return items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    const out = {};
    for (const [key, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
      out[key] = PROMPT_KEY_PATTERN.test(key)
        ? "[redacted key]"
        : compactValue(entryValue, { maxText, depth: depth + 1 });
    }
    if (entries.length > MAX_OBJECT_KEYS) out._omitted_keys = entries.length - MAX_OBJECT_KEYS;
    return out;
  }
  return truncateOneLine(value, 240);
}

function pruneReplayMemory(nowMs = Date.now()) {
  for (const [agentCallId, entry] of replayMemory) {
    if ((nowMs - Number(entry.updated_ms || 0)) > MEMORY_TTL_MS) replayMemory.delete(agentCallId);
  }
  while (replayMemory.size > MEMORY_MAX_CALLS) {
    const oldest = replayMemory.keys().next().value;
    if (oldest == null) break;
    replayMemory.delete(oldest);
  }
}

function memoryEntry(agentCallId) {
  if (agentCallId == null) return null;
  pruneReplayMemory();
  const key = Number(agentCallId);
  const existing = replayMemory.get(key) || {};
  existing.updated_ms = Date.now();
  existing.updated_at = nowIso();
  replayMemory.set(key, existing);
  return existing;
}

export function retainReplayPrompt(agentCallId, {
  prompt = "",
  systemPrompt = null,
  systemPromptFiles = null,
  meta = null,
} = {}) {
  const entry = memoryEntry(agentCallId);
  if (!entry) return false;
  const promptText = typeof prompt === "string" ? prompt : String(prompt ?? "");
  const systemPromptText = typeof systemPrompt === "string" ? systemPrompt : null;
  entry.prompt = {
    prompt: promptText,
    system_prompt: systemPromptText,
    system_prompt_files: Array.isArray(systemPromptFiles) ? systemPromptFiles.slice(0, 50) : null,
    prompt_chars: promptText.length,
    prompt_sha256: sha256(promptText),
    system_prompt_chars: systemPromptText == null ? null : systemPromptText.length,
    captured_at: nowIso(),
    meta: compactValue(meta || {}),
  };
  return true;
}

export function retainReplayOutput(agentCallId, {
  output = "",
  status = null,
  stats = null,
  errorText = null,
} = {}) {
  const entry = memoryEntry(agentCallId);
  if (!entry) return false;
  const outputText = typeof output === "string" ? output : String(output ?? "");
  entry.output = {
    output: outputText,
    output_chars: outputText.length,
    output_sha256: sha256(outputText),
    status,
    stats: compactValue(stats || {}),
    error_text: errorText ? truncateOneLine(errorText, 500) : null,
    captured_at: nowIso(),
  };
  return true;
}

export function retainReplayToolUses(agentCallId, toolUses = []) {
  const entry = memoryEntry(agentCallId);
  if (!entry) return false;
  entry.tool_uses = Array.isArray(toolUses)
    ? toolUses.slice(0, MAX_TOOL_TRANSCRIPT).map((toolUse) => compactValue(toolUse))
    : [];
  entry.tool_uses_captured_at = nowIso();
  return true;
}

export function getReplayMemory(agentCallId) {
  pruneReplayMemory();
  const entry = replayMemory.get(Number(agentCallId));
  if (!entry) return null;
  return {
    prompt: entry.prompt ? { ...entry.prompt, prompt: undefined, system_prompt: undefined } : null,
    output: entry.output ? { ...entry.output, output: undefined } : null,
    tool_uses_count: Array.isArray(entry.tool_uses) ? entry.tool_uses.length : 0,
    updated_at: entry.updated_at || null,
  };
}

export function __testClearReplayMemory(agentCallId = null) {
  if (agentCallId == null) replayMemory.clear();
  else replayMemory.delete(Number(agentCallId));
}

function sanitizeAgentCall(row) {
  if (!row) return null;
  return {
    id: row.id,
    work_item_id: row.work_item_id,
    job_id: row.job_id,
    attempt_id: row.attempt_id,
    role: row.role,
    model_tier: row.model_tier,
    model_name: row.model_name,
    provider: row.provider,
    activity: row.activity,
    status: row.status,
    prompt_chars: row.prompt_chars,
    output_chars: row.output_chars,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    duration_ms: row.duration_ms,
    exit_code: row.exit_code,
    error_text: row.error_text ? truncateOneLine(row.error_text, 1000) : null,
    reasoning_effort: row.reasoning_effort,
    atlas_method: row.atlas_method,
    atlas_prefetch_status: row.atlas_prefetch_status,
    skills: parseJsonMaybe(row.skills, row.skills || null),
    prior_session_handle: row.prior_session_handle ? "[present]" : null,
    session_handle: row.session_handle ? "[present]" : null,
    cost_estimate_usd: row.cost_estimate_usd,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
  };
}

function sanitizeJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    work_item_id: row.work_item_id,
    job_type: row.job_type,
    title: row.title,
    status: row.status,
    priority: row.priority,
    model_tier: row.model_tier,
    provider: row.provider,
    max_attempts: row.max_attempts,
    attempts: row.attempts,
    parent_job_id: row.parent_job_id,
    planner_complexity_score: row.planner_complexity_score,
    payload: compactValue(parseJsonMaybe(row.payload_json, null) || {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sanitizeWorkItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    mode: row.mode,
    branch_name: row.branch_name,
    merge_state: row.merge_state,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function lookupJob(jobId) {
  if (jobId == null) return null;
  return getDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId) || null;
}

function lookupWorkItem(workItemId) {
  if (workItemId == null) return null;
  return getDb().prepare(`SELECT * FROM work_items WHERE id = ?`).get(workItemId) || null;
}

function logRecordMatchesCall(record, call) {
  if (!record || !call) return true;
  if (record.job_id != null && call.job_id != null && Number(record.job_id) !== Number(call.job_id)) return false;
  if (record.work_item_id != null && call.work_item_id != null && Number(record.work_item_id) !== Number(call.work_item_id)) return false;
  return true;
}

function promptSnapshot(agentCallId, { exactPrompt = false, call = null } = {}) {
  const memory = replayMemory.get(Number(agentCallId)) || null;
  const promptRecords = readRecentPrompts({ limit: 20, agentCallId })
    .filter((record) => logRecordMatchesCall(record, call));
  const latestPrompt = promptRecords[0] || null;
  const persistedExact = promptRecords.find((record) => record?.prompt && !record.prompt_redacted) || null;
  const memoryPrompt = memory?.prompt || null;
  const exactPromptIncluded = !!exactPrompt && (!!memoryPrompt?.prompt || !!persistedExact?.prompt);
  const source = exactPromptIncluded && memoryPrompt?.prompt
    ? "memory"
    : exactPromptIncluded && persistedExact?.prompt
      ? "prompt_log"
      : null;
  const exact = source === "memory" ? memoryPrompt : source === "prompt_log" ? persistedExact : null;
  const promptChars = memoryPrompt?.prompt_chars ?? latestPrompt?.prompt_chars ?? null;
  const systemPromptChars = memoryPrompt?.system_prompt_chars ?? latestPrompt?.system_prompt_chars ?? null;
  const snapshot = {
    exact_prompt_requested: !!exactPrompt,
    exact_prompt_included: exactPromptIncluded,
    exact_prompt_source: source,
    exact_prompt_available_in_memory: !!memoryPrompt?.prompt,
    exact_prompt_available_in_prompt_log: !!persistedExact?.prompt,
    prompt_chars: promptChars,
    prompt_sha256: memoryPrompt?.prompt_sha256 || (persistedExact?.prompt ? sha256(persistedExact.prompt) : null),
    system_prompt_chars: systemPromptChars,
    prompt_log_preview: latestPrompt ? promptPreviewText(latestPrompt, { max: 240 }) : null,
    prompt_redacted_by_default: true,
    redaction_reason: exactPromptIncluded ? null : "prompt_content_requires_explicit_exact_replay_and_available_memory_or_persisted_prompt_log",
  };
  if (exactPromptIncluded) {
    snapshot.prompt = exact.prompt;
    snapshot.system_prompt = source === "memory" ? exact.system_prompt : exact.system_prompt;
    snapshot.system_prompt_files = source === "memory" ? exact.system_prompt_files : exact.system_prompt_files;
  }
  return snapshot;
}

function outputSnapshot(agentCallId, { includeOutput = true, outputMaxChars = MAX_OUTPUT_TEXT, call = null } = {}) {
  const memory = replayMemory.get(Number(agentCallId)) || null;
  const outputRecords = readRecentOutputs({ limit: 10, agentCallId })
    .filter((record) => logRecordMatchesCall(record, call));
  const latestOutput = outputRecords[0] || null;
  const memoryOutput = memory?.output || null;
  const outputText = memoryOutput?.output ?? latestOutput?.output ?? "";
  const snapshot = {
    status: memoryOutput?.status ?? latestOutput?.status ?? null,
    output_chars: memoryOutput?.output_chars ?? latestOutput?.output_chars ?? null,
    output_sha256: memoryOutput?.output_sha256 || (outputText ? sha256(outputText) : null),
    input_tokens: latestOutput?.input_tokens ?? null,
    output_tokens: latestOutput?.output_tokens ?? null,
    duration_ms: latestOutput?.duration_ms ?? null,
    exit_code: latestOutput?.exit_code ?? null,
    error_text: memoryOutput?.error_text ?? latestOutput?.error_text ?? null,
    output_available_in_memory: !!memoryOutput?.output,
    output_available_in_log: !!latestOutput?.output,
  };
  if (includeOutput && outputText) {
    snapshot.output = compactText(outputText, { max: outputMaxChars });
  }
  return snapshot;
}

function compactToolDetail(detailJson) {
  const parsed = parseJsonMaybe(detailJson, null);
  if (!parsed || typeof parsed !== "object") return null;
  const preferred = {};
  for (const key of [
    "kind",
    "tool_name",
    "catalog_name",
    "action",
    "status",
    "ok",
    "cwd",
    "path",
    "file_path",
    "source",
    "destination",
    "output_path",
    "command",
    "pattern",
    "query",
    "url",
    "error",
  ]) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) preferred[key] = parsed[key];
  }
  if (parsed.input && typeof parsed.input === "object") preferred.input = compactValue(parsed.input);
  if (parsed.args && typeof parsed.args === "object") preferred.args = compactValue(parsed.args);
  const compact = compactValue({ ...preferred, ...Object.fromEntries(Object.entries(parsed).filter(([key]) => !(key in preferred)).slice(0, 8)) });
  return compact;
}

export function buildCompressedToolTranscript(agentCallId, { limit = MAX_TOOL_TRANSCRIPT } = {}) {
  const rows = getToolInvocationsForAgentCall(agentCallId).slice(0, limit);
  return rows.map((row) => ({
    id: row.id,
    type: row.observation_type,
    summary: row.summary,
    created_at: row.created_at,
    detail: compactToolDetail(row.detail_json),
  }));
}

function latestRecoveryCheckpoints(agentCallId, { limit = 8 } = {}) {
  if (agentCallId == null) return [];
  const rows = getDb().prepare(`
    SELECT id, content_json, content_long, created_at
    FROM artifacts
    WHERE artifact_type = ?
      AND content_json IS NOT NULL
      AND json_valid(content_json) = 1
      AND json_extract(content_json, '$.kind') = ?
      AND json_extract(content_json, '$.agent_call_id') = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(CHECKPOINT_ARTIFACT_TYPE, CHECKPOINT_KIND, Number(agentCallId), limit);
  return rows.map((row) => {
    const content = parseJsonMaybe(row.content_json, {}) || {};
    return {
      id: row.id,
      phase: content.phase || null,
      reason: content.reason || null,
      summary: row.content_long || null,
      created_at: row.created_at,
    };
  }).reverse();
}

export function buildAgentCallReplayPacket({
  agentCallId,
  exactPrompt = false,
  includeOutput = true,
  outputMaxChars = MAX_OUTPUT_TEXT,
  includeRecoveryCheckpoints = true,
} = {}) {
  const id = Number(agentCallId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("agentCallId must be a positive integer");
  }
  pruneReplayMemory();
  const call = getAgentCallById(id);
  if (!call) throw new Error(`No agent_call found for id ${id}`);
  const prompt = promptSnapshot(id, { exactPrompt, call });
  const replayMode = prompt.exact_prompt_included ? "exact_prompt" : "reconstruct_from_packet_version";
  return {
    packet_version: REPLAY_PACKET_VERSION,
    kind: REPLAY_KIND,
    replay_mode: replayMode,
    generated_at: nowIso(),
    agent_call: sanitizeAgentCall(call),
    job: sanitizeJob(lookupJob(call.job_id)),
    work_item: sanitizeWorkItem(lookupWorkItem(call.work_item_id)),
    prompt,
    output: outputSnapshot(id, { includeOutput, outputMaxChars, call }),
    tool_transcript: buildCompressedToolTranscript(id),
    recovery_checkpoints: includeRecoveryCheckpoints ? latestRecoveryCheckpoints(id) : [],
    restart_semantics: {
      default: "restart_from_durable_queue_state_and_reconstruct_prompt_from_packet_version",
      exact_prompt_replay: "requires explicit exactPrompt plus live in-memory retention or a prompt log configured to persist prompt content",
      tool_calls: "compressed_transcript_only_no_tool_reexecution",
    },
  };
}

export function buildRecoveryCheckpoint({
  work_item_id = null,
  job_id = null,
  attempt_id = null,
  agent_call_id = null,
  phase = "checkpoint",
  reason = null,
  status = null,
  extra = null,
} = {}) {
  const call = agent_call_id == null ? null : getAgentCallById(agent_call_id);
  const resolvedJobId = job_id ?? call?.job_id ?? null;
  const resolvedWorkItemId = work_item_id ?? call?.work_item_id ?? null;
  return {
    packet_version: REPLAY_PACKET_VERSION,
    kind: CHECKPOINT_KIND,
    recorded_at: nowIso(),
    phase,
    reason,
    status: status || call?.status || null,
    work_item_id: resolvedWorkItemId,
    job_id: resolvedJobId,
    attempt_id: attempt_id ?? call?.attempt_id ?? null,
    agent_call_id: agent_call_id ?? null,
    agent_call: sanitizeAgentCall(call),
    job: sanitizeJob(lookupJob(resolvedJobId)),
    work_item: sanitizeWorkItem(lookupWorkItem(resolvedWorkItemId)),
    prompt: agent_call_id == null ? null : promptSnapshot(agent_call_id, { exactPrompt: false, call }),
    output: agent_call_id == null ? null : outputSnapshot(agent_call_id, { includeOutput: false, call }),
    tool_transcript: agent_call_id == null ? [] : buildCompressedToolTranscript(agent_call_id, { limit: 32 }),
    replay_memory: agent_call_id == null ? null : getReplayMemory(agent_call_id),
    extra: compactValue(extra || {}),
  };
}

export function formatRecoveryCheckpointSummary(checkpoint = {}) {
  const bits = [
    `recovery_checkpoint:${checkpoint.phase || "checkpoint"}`,
    checkpoint.agent_call_id != null ? `call#${checkpoint.agent_call_id}` : null,
    checkpoint.job_id != null ? `job#${checkpoint.job_id}` : null,
    checkpoint.status ? `status=${checkpoint.status}` : null,
    checkpoint.reason ? `reason=${truncateOneLine(checkpoint.reason, 80)}` : null,
  ].filter(Boolean);
  return bits.join(" ");
}

export function recordRecoveryCheckpoint({
  work_item_id = null,
  job_id = null,
  attempt_id = null,
  agent_call_id = null,
  phase = "checkpoint",
  reason = null,
  status = null,
  extra = null,
} = {}) {
  try {
    const checkpoint = buildRecoveryCheckpoint({
      work_item_id,
      job_id,
      attempt_id,
      agent_call_id,
      phase,
      reason,
      status,
      extra,
    });
    const artifact = storeArtifact({
      work_item_id: checkpoint.work_item_id,
      job_id: checkpoint.job_id,
      attempt_id: checkpoint.attempt_id,
      artifact_type: CHECKPOINT_ARTIFACT_TYPE,
      mime_type: "application/vnd.posse.recovery-checkpoint+json",
      content_long: formatRecoveryCheckpointSummary(checkpoint),
      content_json: checkpoint,
    });
    recordObservation({
      work_item_id: checkpoint.work_item_id,
      job_id: checkpoint.job_id,
      attempt_id: checkpoint.attempt_id,
      observation_type: "system.recovery_checkpoint",
      summary: formatRecoveryCheckpointSummary(checkpoint),
      detail: {
        artifact_id: artifact?.id ?? null,
        phase: checkpoint.phase,
        reason: checkpoint.reason,
        agent_call_id: checkpoint.agent_call_id,
        packet_version: REPLAY_PACKET_VERSION,
      },
    });
    return artifact;
  } catch {
    return null;
  }
}

export function formatReplayPacket(packet = {}) {
  const call = packet.agent_call || {};
  const prompt = packet.prompt || {};
  const output = packet.output || {};
  const lines = [];
  lines.push(`Replay packet for agent_call #${call.id ?? "?"}`);
  lines.push(`mode: ${packet.replay_mode || "?"}`);
  lines.push(`role/provider/model: ${call.role || "?"}/${call.provider || "?"}/${call.model_name || call.model_tier || "?"}`);
  lines.push(`status: ${call.status || "?"} job: #${call.job_id ?? "?"} WI: #${call.work_item_id ?? "?"}`);
  lines.push(`prompt: ${prompt.prompt_chars ?? "?"} chars exact_included=${prompt.exact_prompt_included ? "yes" : "no"} memory=${prompt.exact_prompt_available_in_memory ? "yes" : "no"}`);
  lines.push(`output: ${output.output_chars ?? "?"} chars${output.error_text ? ` error=${truncateOneLine(output.error_text, 120)}` : ""}`);
  const tools = Array.isArray(packet.tool_transcript) ? packet.tool_transcript : [];
  lines.push(`tools: ${tools.length}`);
  for (const tool of tools.slice(0, 12)) {
    lines.push(`- ${tool.type}: ${truncateOneLine(tool.summary, 140)}`);
  }
  if (tools.length > 12) lines.push(`- ... ${tools.length - 12} more`);
  if (output.output && typeof output.output === "string") {
    lines.push("");
    lines.push("output_preview:");
    lines.push(compactText(output.output, { max: 1200 }));
  }
  return `${lines.join("\n")}\n`;
}
