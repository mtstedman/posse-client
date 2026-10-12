// @ts-check

import { exactKeys, fail } from "./report-schema.js";
import { AGENT_HANDOFF_LIMITS } from "../../../../catalog/handoff.js";
import { HASH_REF_ALIAS_PATTERN, normalizeHashRefAlias } from "../../../../catalog/hash-store.js";
import { evidenceSourcePathSyntaxError } from "../evidence-source-path.js";

export function parseAgentHandoffEvidenceSelector(value) {
  let ref = null;
  let sourcePath = null;
  let qualifiedPath = null;
  let start = null;
  let end = null;
  if (typeof value === "string") {
    const raw = value.trim();
    const refMatch = raw.toLowerCase().match(/^(#[0-9a-z]{4,12})(?::(?:l)?(\d+)(?:-(?:l)?(\d+))?)?$/);
    const pathMatch = refMatch
      ? null
      : raw.match(/^(.+):(?:l)?(\d+)(?:-(?:l)?(\d+))?$/i);
    if (refMatch) {
      [, ref] = refMatch;
      if (refMatch[2]) {
        start = Number(refMatch[2]);
        end = Number(refMatch[3] || refMatch[2]);
      }
    } else if (pathMatch) {
      sourcePath = String(pathMatch[1] || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
      start = Number(pathMatch[2]);
      end = Number(pathMatch[3] || pathMatch[2]);
    } else {
      // Bare paths are useful for inspected binary artifacts, which have no
      // meaningful source line coordinates. Materialization still requires a
      // successful current-call artifact inspection and normal path policy.
      sourcePath = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    }
  } else {
    const selector = exactKeys(value, ["ref", "path", "lines"], "evidence selector");
    if (selector.ref == null && selector.path == null) {
      fail("AGENT_HANDOFF_SELECTOR_INVALID", "Evidence selector must contain ref or path");
    }
    if (selector.ref != null) {
      ref = normalizeHashRefAlias(selector.ref);
      if (selector.path != null) {
        qualifiedPath = String(selector.path || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
      }
    } else {
      sourcePath = String(selector.path || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    }
    if (selector.lines != null) {
      const lines = exactKeys(selector.lines, ["start", "end", "count"], "evidence selector.lines");
      start = Number(lines.start);
      if (lines.count != null && lines.end != null) {
        fail("AGENT_HANDOFF_SELECTOR_INVALID", `Evidence line range for ${ref} must use count or end, not both`);
      }
      const count = lines.count == null ? null : Number(lines.count);
      end = count == null ? Number(lines.end) : start + count - 1;
      if (count != null && (!Number.isInteger(count) || count < 1 || count > AGENT_HANDOFF_LIMITS.maxSelectorLines)) {
        fail(
          "AGENT_HANDOFF_SELECTOR_INVALID",
          `Evidence line count for ${ref || sourcePath} must be an integer from 1 through ${AGENT_HANDOFF_LIMITS.maxSelectorLines}`,
        );
      }
    }
  }
  if (ref != null && !HASH_REF_ALIAS_PATTERN.test(ref)) {
    fail("AGENT_HANDOFF_SELECTOR_INVALID", `Invalid evidence ref: ${String(ref || "")}`);
  }
  if (sourcePath != null) {
    const pathError = evidenceSourcePathSyntaxError(sourcePath);
    if (pathError) fail("AGENT_HANDOFF_SELECTOR_INVALID", pathError);
  }
  if (qualifiedPath != null) {
    const pathError = evidenceSourcePathSyntaxError(qualifiedPath);
    if (pathError) fail("AGENT_HANDOFF_SELECTOR_INVALID", pathError);
    if (start == null) {
      fail("AGENT_HANDOFF_SELECTOR_INVALID", `Path-qualified evidence selector ${ref} requires a line range`);
    }
  }
  if ((start == null) !== (end == null)) {
    fail("AGENT_HANDOFF_SELECTOR_INVALID", `Evidence line range must include start and end for ${ref || sourcePath}`);
  }
  if (start != null && (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start)) {
    fail("AGENT_HANDOFF_SELECTOR_INVALID", `Invalid 1-based inclusive line range for ${ref || sourcePath}`);
  }
  return sourcePath == null
    ? { ref, ...(qualifiedPath == null ? {} : { path: qualifiedPath }), start, end }
    : { path: sourcePath, start, end };
}

export function normalizedLines(payload) {
  const text = String(payload ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}
