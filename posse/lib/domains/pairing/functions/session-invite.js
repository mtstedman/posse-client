// The host's pairing code, kept where the session screen can show it. The
// host hands the code out for as long as the session runs, and a shared run
// covers the console that printed it. It is stored in this clone's runtime
// status only (next to the relay token it is far less sensitive than), never
// sent anywhere, and counts only for the session that wrote it.

import { clearRuntimeStatus, readRuntimeStatus, RUNTIME_STATUS_KEYS, writeRuntimeStatus } from "../../queue/functions/runtime-status.js";

const CODE_PATTERN = /^[A-Za-z0-9-]{4,64}$/u;

export function writeSessionInvite({ sessionId, code } = {}) {
  const value = String(code || "").trim();
  if (!sessionId || !CODE_PATTERN.test(value)) return false;
  return writeRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_INVITE, {
    session_id: String(sessionId),
    code: value,
    recorded_at: new Date().toISOString(),
  }) !== false;
}

/** The pairing code of `state`'s session, when this clone hosts it. */
export function readSessionInviteCode(state) {
  if (state?.role !== "host" || state.phase !== "active" || !state.remote_session_id) return null;
  try {
    const row = readRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_INVITE);
    if (!row || row.session_id !== String(state.remote_session_id)) return null;
    return CODE_PATTERN.test(String(row.code || "")) ? String(row.code) : null;
  } catch {
    return null;
  }
}

export function clearSessionInvite() {
  try { clearRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_INVITE); } catch { /* advisory */ }
}
