import { redactSearchContentRows } from "../../../atlas/functions/v2/retrieval/search-lines.js";
import { scrubSecretText } from "../../../../shared/telemetry/functions/logging/scrub-secret-text.js";

// Complementary search_files output for Atlas researchers must be redacted like
// read_file. Source-aware native redaction is preferred; when it is unavailable
// or the source moved, the established pure scrubber masks the returned rows so
// a valid bounded search does not become a dead tool.
export async function redactComplementarySearchRows(rows, context, {
  redact,
  scrub = scrubSecretText,
  onFallback = null,
} = {}) {
  try {
    return await redactSearchContentRows(rows, context, ...(redact ? [redact] : []));
  } catch (err) {
    onFallback?.(scrub(String(err?.message || err || "unknown redaction error")).slice(0, 500));
    const clean = (line) => ({ ...line, text: scrub(String(line.text ?? "")) });
    return rows.map((row) => ({ ...clean(row), before: row.before.map(clean), after: row.after.map(clean) }));
  }
}
