import { getAccountSetting } from "../../../domains/settings/functions/account-settings.js";

export function advancedLoggingEnabled() {
  if (process.env.POSSE_ADVANCED_LOGGING === "true") return true;
  const args = process.argv.slice(2);
  const end = args.indexOf("--");
  if ((end < 0 ? args : args.slice(0, end)).includes("--advanced-logging")) {
    // Native/MCP children inherit the per-run override, never a saved setting.
    process.env.POSSE_ADVANCED_LOGGING = "true";
    return true;
  }
  try { return getAccountSetting("advanced_logging") === "true"; } catch { return false; }
}

export function emitDiagnostic(worker, jobId, message) {
  if (advancedLoggingEnabled()) worker.emit(jobId, message);
}
