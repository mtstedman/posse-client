// @ts-check
import { SETTING_DEFINITIONS } from "./setting-definitions.js";

// Every definition, including derived provider/role rows, has an identity.
// Preserve the five established public aliases.
/** @type {Readonly<Record<string, string>>} */
export const SETTING_KEYS = Object.freeze({
  ...Object.fromEntries(SETTING_DEFINITIONS.map(({ key }) => [key.toUpperCase().replaceAll("-", "_"), key])),
  ...{
  "KAIZEN_TO_ATLAS": "posse_kaizen_to_atlas",
  "LOG_SCRUB_SECRETS": "posse_log_scrub_secrets",
  "LOG_LEVEL": "posse_log_level",
  "DB_TELEMETRY_TAIL_LIMIT": "posse_db_telemetry_tail_limit",
  "RETENTION_DAYS": "posse_retention_days"
},
});
