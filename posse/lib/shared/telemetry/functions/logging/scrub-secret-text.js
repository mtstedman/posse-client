import { SECRET_PATTERNS } from "./secret-patterns.js";
import { redactString } from "../../../../domains/bridge/functions/redaction.js";

// Pure redaction for early boot, where loading settings/SQLite would prevent
// recovery from missing npm dependencies. No account DB or native addon imports.
export function scrubSecretText(text) {
  let scrubbed = String(text ?? "");
  for (const { re, label } of SECRET_PATTERNS) {
    const flags = [...new Set(`${re.flags}gm`)].join("");
    scrubbed = scrubbed.replace(new RegExp(re.source, flags), `[REDACTED:${label}]`);
  }
  return redactString(scrubbed);
}
