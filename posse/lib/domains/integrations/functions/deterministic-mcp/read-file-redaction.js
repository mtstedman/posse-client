import fs from "node:fs";

import { redactSecrets } from "../../../atlas/functions/v2/retrieval/redaction.js";
import { scrubSecretText } from "../../../../shared/telemetry/functions/logging/scrub-secret-text.js";
import { DETERMINISTIC_READ_FILE_MAX_SIZE_BYTES } from "../../../../shared/tools/functions/toolkit/path-policy.js";
import {
  formatNumberedLines,
  splitEditableLines,
} from "../../../../shared/tools/functions/toolkit/structured-read.js";

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function redactComplementaryReadResult({
  result,
  args = {},
  stat = null,
  defaultLimit,
  onFallback = null,
  redact = redactSecrets,
  scrub = scrubSecretText,
} = {}) {
  const text = String(result ?? "");
  const repoRelPath = String(args.path || "").replace(/\\/g, "/");
  const startLine = positiveInt(args.offset, 1);
  const limit = positiveInt(args.limit, defaultLimit);

  try {
    // Source-aware redaction must receive the unformatted source projection.
    // The read tool returns numbered display text, which cannot be used as its
    // own provenance without invalidating the native source-context contract.
    if (stat?.fullPath && stat.size <= DETERMINISTIC_READ_FILE_MAX_SIZE_BYTES) {
      const source = fs.readFileSync(stat.fullPath, "utf8");
      const { lines } = splitEditableLines(source);
      const selected = lines.slice(startLine - 1, startLine - 1 + limit);
      const remaining = lines.length - (startLine - 1) - limit;
      const expected = selected.length > 0
        ? formatNumberedLines(selected, startLine) + (remaining > 0 ? `\n... (${remaining} more lines)` : "")
        : null;
      // If the file changed between the deterministic read and this snapshot,
      // redact the exact returned bytes through the generic native path.
      if (expected === text) {
        const redacted = await redact(selected.join("\n"), {
          repoRelPath,
          source,
          startLine,
        });
        const redactedLines = String(redacted).split("\n");
        if (redactedLines.length !== selected.length) {
          throw new Error("Source redaction changed the selected line count");
        }
        return formatNumberedLines(redactedLines, startLine)
          + (remaining > 0 ? `\n... (${remaining} more lines)` : "");
      }
    }
    return await redact(text);
  } catch (err) {
    // Native redaction is preferred, but its availability or provenance
    // failure must not turn an otherwise valid bounded read into a dead tool.
    // The established pure scrubber conservatively redacts the exact response.
    onFallback?.(scrub(String(err?.message || err || "unknown redaction error")).slice(0, 500));
    return scrub(text);
  }
}
