import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getSetting } from "../../../../domains/queue/functions/settings.js";
import { SECRET_PATTERNS } from "../../functions/logging/secret-patterns.js";
import { redactString } from "../../../../domains/bridge/functions/redaction.js";

// scrubSecrets runs on every log line; cache the synchronous SQLite setting
// read briefly so logging doesn't pay a DB round-trip per line. A settings
// flip takes effect within the TTL.
const SCRUB_SETTING_TTL_MS = 5000;
let _scrubEnabledCache = null;
let _scrubEnabledCacheAt = 0;

export function logScrubbingEnabled() {
  const now = Date.now();
  if (_scrubEnabledCache != null && now - _scrubEnabledCacheAt < SCRUB_SETTING_TTL_MS) {
    return _scrubEnabledCache;
  }
  let enabled = true;
  try {
    const value = getSetting(SETTING_KEYS.LOG_SCRUB_SECRETS);
    const normalized = String(value ?? "").trim().toLowerCase();
    enabled = !normalized || ["1", "true", "yes", "on"].includes(normalized);
  } catch {
    enabled = true;
  }
  _scrubEnabledCache = enabled;
  _scrubEnabledCacheAt = now;
  return enabled;
}

export function invalidateLogScrubCache() {
  _scrubEnabledCache = null;
  _scrubEnabledCacheAt = 0;
}

export function scrubSecrets(text) {
  if (!logScrubbingEnabled()) return text;
  let scrubbed = String(text ?? "");
  for (const { re, label } of SECRET_PATTERNS) {
    const flags = [...new Set(`${re.flags}gm`)].join("");
    scrubbed = scrubbed.replace(new RegExp(re.source, flags), `[REDACTED:${label}]`);
  }
  // SECRET_PATTERNS targets provider keys committed to files; the bridge
  // patterns additionally catch transport-shaped tokens (Bearer/Basic auth,
  // JWTs, GitHub PATs, Google AIza keys, URL userinfo credentials).
  return redactString(scrubbed);
}
