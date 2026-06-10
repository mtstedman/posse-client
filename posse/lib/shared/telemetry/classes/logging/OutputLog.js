import { DatedRotatingLog } from "./DatedRotatingLog.js";
import { scrubSecrets } from "./secret-scrub.js";
import { appendRunTelemetry } from "../../functions/run-telemetry.js";

export class OutputLog extends DatedRotatingLog {
  constructor({
    dir = null,
    retentionDays = 3,
    filePrefix = "outputs-",
    fileSuffix = ".log",
  } = {}) {
    super({ dir, retentionDays, filePrefix, fileSuffix });
  }

  record({
    agent_call_id = null,
    job_id = null,
    work_item_id = null,
    role = null,
    provider = null,
    model = null,
    attempt = null,
    output = "",
    activity = null,
    modelTier = null,
    status = null,
    inputTokens = null,
    outputTokens = null,
    durationMs = null,
    exitCode = null,
    errorText = null,
  } = {}) {
    const outStr = typeof output === "string" ? output : (output == null ? "" : String(output));
    const scrubbedOutput = scrubSecrets(outStr);
    const scrubbedErrorText = typeof errorText === "string" ? scrubSecrets(errorText) : errorText;
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
      model_tier: modelTier,
      status,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      duration_ms: durationMs,
      exit_code: exitCode,
      error_text: scrubbedErrorText,
      output_chars: outStr.length,
      output: scrubbedOutput,
    };
    let wrote = false;
    try { wrote = this.write(JSON.stringify(record)); } catch { wrote = false; }
    try { appendRunTelemetry("outputs", record); } catch { /* best effort */ }
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

let _defaultOutputLog = null;
let _defaultOutputLogExitHandlersRegistered = false;

function registerDefaultOutputLogExitHandlers() {
  if (_defaultOutputLogExitHandlersRegistered) return;
  _defaultOutputLogExitHandlersRegistered = true;
  const closeDefault = () => {
    try { _defaultOutputLog?.close(); } catch { /* best effort */ }
  };
  process.once("beforeExit", closeDefault);
  process.once("exit", closeDefault);
}

export function getDefaultOutputLog() {
  if (!_defaultOutputLog) {
    _defaultOutputLog = new OutputLog();
    registerDefaultOutputLogExitHandlers();
  }
  return _defaultOutputLog;
}
