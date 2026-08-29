// Short-lived settings/lock probe for doctor and update. This process is
// intentionally allowed to load better-sqlite3 because it exits before the
// maintenance parent mutates Posse's node_modules tree on Windows.

import { getAtlasIntegrationConfig } from "../../integrations/functions/atlas/config.js";
import { getLiveSchedulerBlockMessage } from "../../queue/functions/index.js";
import { closeDb } from "../../../shared/storage/functions/index.js";
import { closeAccountSettingsDb } from "../../settings/functions/account-settings.js";

let payload;
try {
  payload = {
    ok: true,
    scheduler_block: getLiveSchedulerBlockMessage("main"),
    atlas_config: getAtlasIntegrationConfig(),
  };
} catch (error) {
  payload = {
    ok: false,
    error: error?.message || String(error),
    scheduler_block: null,
    atlas_config: { enabled: false, scipMode: "off", scipLanguages: [] },
  };
} finally {
  try { closeAccountSettingsDb(); } catch { /* best effort */ }
  try { closeDb(); } catch { /* best effort */ }
}

process.stdout.write(`${JSON.stringify(payload)}\n`);
