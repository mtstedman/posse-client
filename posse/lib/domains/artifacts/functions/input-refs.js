// @ts-check
//
// Operator-provided inputs for a work item (.posse/resources/inputs/wi-N) are
// outside every job's worktree and under the blocked .posse tree, so a dev
// cannot open them by path. Text inputs are ingested as pinned work-item hash
// refs instead; the research refs index lists them for each later job.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { WORK_ITEM_INPUT_LIMITS, WORK_ITEM_INPUT_OBJECT_TYPE } from "../../../catalog/artifact.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { logEvent } from "../../queue/functions/events.js";
import { surfaceHashRefForContext } from "../../queue/functions/hash-refs.js";
import { inputsDir, wiScopeId } from "./index.js";

function listInputFiles(root) {
  const files = [];
  const walk = (dir, depth) => {
    if (files.length >= WORK_ITEM_INPUT_LIMITS.maxFiles || depth > WORK_ITEM_INPUT_LIMITS.maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= WORK_ITEM_INPUT_LIMITS.maxFiles) return;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(root, 0);
  return files;
}

function readTextInput(filePath, onReadError) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    onReadError(error);
    return null;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > WORK_ITEM_INPUT_LIMITS.maxBytesPerFile) return null;
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    onReadError(error);
    return null;
  }
  try {
    return { bytes, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return null;
  }
}

/**
 * Surface every readable text input of a work item as a pinned hash ref.
 * Idempotent: the hash-ref store dedupes by content within the work item.
 * @param {number} workItemId
 * @param {{ projectDir?: string | null }} [options]
 * @returns {Array<{ ref: string, relativePath: string, bytes: number }>}
 */
export function surfaceWorkItemInputs(workItemId, { projectDir = null } = {}) {
  const id = Number(workItemId);
  if (!Number.isInteger(id) || id <= 0) return [];
  let root;
  try {
    root = inputsDir(wiScopeId(id), projectDir);
  } catch {
    return [];
  }
  if (!fs.existsSync(root)) return [];
  const surfaced = [];
  let readErrorCount = 0;
  const readErrorSamples = [];
  for (const filePath of listInputFiles(root)) {
    const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
    const input = readTextInput(filePath, (error) => {
      readErrorCount += 1;
      if (readErrorSamples.length < 3) readErrorSamples.push({
        path: relativePath.slice(0, 160),
        code: String(error?.code || "READ_FAILED").slice(0, 40),
      });
    });
    if (!input) continue;
    const sha256 = crypto.createHash("sha256").update(input.bytes).digest("hex");
    try {
      const result = surfaceHashRefForContext({ work_item_id: id }, {
        payloadText: input.text,
        objectType: WORK_ITEM_INPUT_OBJECT_TYPE,
        source: "operator:inputs",
        note: `inputs/${relativePath}`,
        descriptor: { kind: "work_item_input", path: relativePath, bytes: input.bytes.length, sha256 },
        sizeChars: input.text.length,
        recomputable: false,
        metadata: {
          line_semantics: "materialized",
          label: relativePath,
          bytes: input.bytes.length,
          sha256,
          file_path: filePath,
          handoff_evidence_pinned: true,
        },
      }, { ownerScope: "work_item" });
      if (result?.ok && result.entry?.ref) surfaced.push({ ref: result.entry.ref, relativePath, bytes: input.bytes.length });
    } catch {
      // One unreadable input must not hide the others.
    }
  }
  if (readErrorCount > 0) {
    try {
      logEvent({
        work_item_id: id,
        event_type: EVENT_TYPES.WORK_ITEM_INPUT_READ_FAILED,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: `${readErrorCount} operator input file(s) could not be read`,
        event_json: JSON.stringify({ count: readErrorCount, samples: readErrorSamples }),
      });
    } catch { /* diagnostics must not block readable inputs */ }
  }
  return surfaced;
}
