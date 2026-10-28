import { listSettings } from "../../../domains/settings/functions/repository-settings.js";
import { getAccountSetting } from "../../../domains/settings/functions/account-settings.js";
import { heartbeatAuthManager } from "../classes/HeartbeatAuthManager.js";

// Only the parent resolves settings. This policy is transport between trusted
// Node threads, separate from the untrusted native capability envelope.
export function nativeWorkerSettings(projectDir) {
  return {
    settingsSnapshot: Object.fromEntries(listSettings({ projectDir }).map(row => [row.setting_key, row.setting_value])),
    nativeTrustedPolicy: heartbeatAuthManager.getTrustedAuthPolicy(),
    posse_log_level: getAccountSetting("posse_log_level") || "info",
  };
}
