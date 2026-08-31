const MAX_COMMAND_CHARS = 1200;
const MAX_SCOPED_FILES = 250;

function parseResult(resultText) {
  if (typeof resultText !== "string" || !resultText.trimStart().startsWith("{")) return null;
  try {
    const value = JSON.parse(resultText);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function scopedCheckToolResultObservation({ tool, resultText = "" } = {}) {
  const name = String(tool || "").trim().toLowerCase().replace(/^tools[._-]/, "");
  if (name !== "run_scoped_checks") return null;
  const payload = parseResult(resultText);
  if (!payload) return null;
  const status = String(payload.status || (payload.ok === true ? "passed" : "unavailable"));
  const checks = (Array.isArray(payload.checks) ? payload.checks : []).map((check) => ({
    name: String(check?.name || "check").slice(0, 80),
    status: String(check?.status || "unknown").slice(0, 40),
    command: check?.command == null ? null : String(check.command).slice(0, MAX_COMMAND_CHARS),
    duration_ms: Number.isFinite(Number(check?.duration_ms)) ? Number(check.duration_ms) : null,
  }));
  const executedCommitHash = /^[0-9a-f]{40,64}$/i.test(String(payload.executed_commit_hash || ""))
    ? String(payload.executed_commit_hash).toLowerCase()
    : null;
  return {
    summary: `ScopedChecks: ${status.toUpperCase()}${checks.length > 0 ? ` (${checks.map((check) => check.name).join(", ")})` : ""}`,
    detail: {
      status,
      ok: payload.ok === true && status === "passed",
      executed_commit_hash: executedCommitHash,
      scoped_files: (Array.isArray(payload.scoped_files) ? payload.scoped_files : [])
        .slice(0, MAX_SCOPED_FILES)
        .map((file) => String(file).slice(0, 500)),
      checks,
    },
  };
}
