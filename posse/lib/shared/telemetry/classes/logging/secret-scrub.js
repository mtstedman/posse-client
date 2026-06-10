import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getSetting } from "../../../../domains/queue/functions/settings.js";
import { SECRET_PATTERNS } from "../../../../domains/worker/functions/helpers/hooks.js";
import { redactString } from "../../../../domains/bridge/functions/redaction.js";

export function logScrubbingEnabled() {
  let value = null;
  try {
    value = getSetting(SETTING_KEYS.LOG_SCRUB_SECRETS);
  } catch {
    return true;
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return ["1", "true", "yes", "on"].includes(normalized);
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
