// Only this short-lived child opens account settings. Its parent remains free
// of native addons, and no repository queue/database is opened for this read.
import { getAccountSetting, closeAccountSettingsDb } from "../../settings/functions/account-settings.js";
import { SETTING_KEYS, DEFAULT_STARTUP_UPDATE_MODE } from "../../../catalog/settings.js";

let payload;
try {
  payload = { ok: true, mode: getAccountSetting(SETTING_KEYS.STARTUP_UPDATE_MODE) ?? DEFAULT_STARTUP_UPDATE_MODE };
} catch (error) {
  payload = { ok: false, error: error?.message || String(error) };
  process.exitCode = 1;
} finally {
  try { closeAccountSettingsDb(); } catch { /* best effort */ }
}
process.stdout.write(`${JSON.stringify(payload)}\n`);
