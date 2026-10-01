// In-process record of each job's latest successful file write. The MCP owner
// (same process as the scheduler) notes every successful write tool call; the
// runtime watchdog reads it to keep a job that is still writing alive past its
// cap, up to a hard ceiling. Live 2026-10-01: a dev job was killed at its 1200s
// cap 3s after its last edit_file, with the feature written.

import { RUNTIME_WRITE_ACTIVITY_TOOL_NAMES } from "../../../catalog/tools/filesystem-mutations.js";

const WRITE_TOOL_NAMES = new Set(RUNTIME_WRITE_ACTIVITY_TOOL_NAMES);

function jobKey(jobId) {
  const id = Number(jobId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export class JobWriteActivity {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    /** @type {Map<number, number>} */
    this._lastWriteAt = new Map();
  }

  /** Record a successful tool call; only write tools count. */
  noteToolCall(jobId, toolName, atMs = this._now()) {
    const key = jobKey(jobId);
    if (key == null || !WRITE_TOOL_NAMES.has(String(toolName || ""))) return false;
    this._lastWriteAt.set(key, atMs);
    return true;
  }

  /** @returns {number | null} epoch ms of the job's latest write, if any. */
  lastWriteAt(jobId) {
    const key = jobKey(jobId);
    return key == null ? null : (this._lastWriteAt.get(key) ?? null);
  }

  /** Forget a job's writes, e.g. when an attempt starts or ends. */
  clear(jobId) {
    const key = jobKey(jobId);
    if (key != null) this._lastWriteAt.delete(key);
  }
}

export const jobWriteActivity = new JobWriteActivity();
