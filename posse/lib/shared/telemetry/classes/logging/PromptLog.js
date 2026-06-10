import { DatedRotatingLog } from "./DatedRotatingLog.js";
import { scrubSecrets } from "./secret-scrub.js";
import { appendRunTelemetry } from "../../functions/run-telemetry.js";

export function promptPreviewText(recordOrText, { max = 160 } = {}) {
  if (typeof recordOrText === "object" && recordOrText?.prompt_redacted) {
    const preview = String(recordOrText.preview || "PROMPT CONTENT NOT PERSISTED");
    return preview.length > max ? preview.slice(0, Math.max(0, max - 1)) + "..." : preview;
  }
  const prompt = typeof recordOrText === "string"
    ? recordOrText
    : String(recordOrText?.prompt || "");
  const systemPrompt = typeof recordOrText === "object" ? String(recordOrText?.system_prompt || "") : "";
  const inlineSystemDuplicate = !!systemPrompt
    && prompt.trimStart().startsWith(`SYSTEM INSTRUCTIONS:\n${systemPrompt}`);
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let selected = lines.find((line) => !/^\[(?:ultra)?think\]/i.test(line));
  if (!selected) selected = lines[0] || "";

  // The execution contract is important, but it is boilerplate in every call.
  // For list previews, skip ahead to the first role/task/context line when
  // possible so deepthink + contract wrappers do not look like missing prompt
  // content.
  const firstContextLine = lines.find((line) =>
    /^(SYSTEM INSTRUCTIONS|Research the following|WORK ITEM:|DESCRIPTION:|=== |TASK|FILES YOU MUST|ATLAS |CURRENT CONTENTS:|You are the)/i.test(line)
  );
  if (firstContextLine) selected = firstContextLine;

  const suffix = typeof recordOrText === "object" && !inlineSystemDuplicate && Number(recordOrText?.system_prompt_chars || 0) > 0
    ? ` [system:${recordOrText.system_prompt_chars} chars]`
    : "";
  const normalized = `${selected.replace(/\s+/g, " ")}${suffix}`.trim();
  return normalized.length > max ? normalized.slice(0, Math.max(0, max - 1)) + "..." : normalized;
}

export class PromptLog extends DatedRotatingLog {
  constructor({
    dir = null,
    retentionDays = 3,
    filePrefix = "prompts-",
    fileSuffix = ".log",
    persistContent = true,
  } = {}) {
    super({ dir, retentionDays, filePrefix, fileSuffix });
    this.persistContent = persistContent;
  }

  record({
    agent_call_id = null,
    job_id = null,
    work_item_id = null,
    role = null,
    provider = null,
    model = null,
    attempt = null,
    prompt = "",
    activity = null,
    reasoningEffort = null,
    modelTier = null,
    systemPrompt = null,
    systemPromptFiles = null,
  } = {}) {
    const promptText = typeof prompt === "string" ? prompt : String(prompt ?? "");
    const systemPromptText = typeof systemPrompt === "string" ? systemPrompt : null;
    const scrubbedPrompt = this.persistContent ? scrubSecrets(promptText) : null;
    const scrubbedSystemPrompt = this.persistContent && typeof systemPromptText === "string"
      ? scrubSecrets(systemPromptText)
      : null;
    const metadataPreview = [
      "PROMPT CONTENT NOT PERSISTED",
      role ? `role=${role}` : null,
      provider ? `provider=${provider}` : null,
      `prompt_chars=${promptText.length}`,
      typeof systemPromptText === "string" ? `system_prompt_chars=${systemPromptText.length}` : null,
    ].filter(Boolean).join(" ");
    const record = {
      ts: new Date().toISOString(),
      agent_call_id,
      job_id,
      work_item_id,
      role,
      provider,
      model,
      attempt,
      activity,
      reasoning_effort: reasoningEffort,
      model_tier: modelTier,
      prompt_chars: promptText.length,
      preview: this.persistContent
        ? promptPreviewText(
          { prompt: scrubbedPrompt, system_prompt_chars: typeof systemPromptText === "string" ? systemPromptText.length : null },
          { max: 240 },
        )
        : metadataPreview,
      prompt: scrubbedPrompt,
      prompt_redacted: !this.persistContent,
      prompt_redaction_reason: this.persistContent ? null : "prompt_and_skill_content_are_remote_owned",
      system_prompt_chars: typeof systemPromptText === "string" ? systemPromptText.length : null,
      system_prompt: scrubbedSystemPrompt,
      system_prompt_files: this.persistContent && Array.isArray(systemPromptFiles) && systemPromptFiles.length > 0 ? systemPromptFiles : null,
    };
    let wrote = false;
    try { wrote = this.write(JSON.stringify(record)); } catch { wrote = false; }
    try { appendRunTelemetry("prompts", record); } catch { /* best effort */ }
    return wrote;
  }

  readRecent({ limit = 50, jobId = null, role = null, agentCallId = null } = {}) {
    return this.readRecentEntries({
      limit,
      parseLine: JSON.parse,
      predicate: (rec) => {
        if (agentCallId != null && rec.agent_call_id !== agentCallId) return false;
        if (jobId != null && rec.job_id !== jobId) return false;
        if (role && rec.role !== role) return false;
        return true;
      },
    });
  }

  tail(count = 50) {
    return this.readRecent({ limit: count });
  }

}

let _defaultPromptLog = null;
let _defaultPromptLogExitHandlersRegistered = false;

function registerDefaultPromptLogExitHandlers() {
  if (_defaultPromptLogExitHandlersRegistered) return;
  _defaultPromptLogExitHandlersRegistered = true;
  const closeDefault = () => {
    try { _defaultPromptLog?.close(); } catch { /* best effort */ }
  };
  process.once("beforeExit", closeDefault);
  process.once("exit", closeDefault);
}

export function getDefaultPromptLog() {
  if (!_defaultPromptLog) {
    _defaultPromptLog = new PromptLog({ persistContent: false });
    registerDefaultPromptLogExitHandlers();
  }
  return _defaultPromptLog;
}
