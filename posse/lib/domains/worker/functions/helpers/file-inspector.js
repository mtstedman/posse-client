import fs from "fs";
import path from "path";

import { isSensitiveEnvFileOrTargetPath } from "../../../runtime/functions/sensitive-paths.js";
import { agentHiddenReadablePathReason } from "../../../../shared/scope/functions/agent-hidden-paths.js";
import { sanitizeAbsolutePathsInText, toDisplayPath } from "../../../../shared/format/functions/display-paths.js";

export const TOOL_INSPECT_FILE = {
  type: "function",
  name: "inspect_file",
  description:
    "Structured metadata for one file path or an array of paths, including existence, size, " +
    "extension, timestamps, and basic PNG, JPEG, or WebP dimensions. A string returns one flat " +
    "result; an array returns ordered results whose loc fields identify their inputs.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: ["string", "array"],
        description: "One file path or an array of file paths, absolute or relative to the working directory.",
        minLength: 1,
        minItems: 1,
        items: { type: "string", minLength: 1 },
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

function inspectJpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xFF) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xD8 || marker === 0xD9) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    const isSof = (marker >= 0xC0 && marker <= 0xC3)
      || (marker >= 0xC5 && marker <= 0xC7)
      || (marker >= 0xC9 && marker <= 0xCB)
      || (marker >= 0xCD && marker <= 0xCF);
    if (isSof && offset + 7 < buffer.length) {
      return {
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function inspectWebpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3FFF,
      height: buffer.readUInt16LE(28) & 0x3FFF,
    };
  }
  if (chunk === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3FFF) + 1,
      height: ((bits >> 14) & 0x3FFF) + 1,
    };
  }
  return null;
}

function inspectImageMetadata(filePath, ext) {
  const buffer = fs.readFileSync(filePath);
  if (ext === ".png" && buffer.length >= 24 && buffer.toString("hex", 0, 8) === "89504e470d0a1a0a") {
    return {
      kind: "image",
      format: "png",
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if ((ext === ".jpg" || ext === ".jpeg") && buffer.length >= 4 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
    const dims = inspectJpegDimensions(buffer);
    return { kind: "image", format: "jpeg", ...(dims || {}) };
  }
  if (ext === ".webp") {
    const dims = inspectWebpDimensions(buffer);
    return { kind: "image", format: "webp", ...(dims || {}) };
  }
  return null;
}

function inspectOne(inputLoc, cwd, scopePredicates, safePath, { includeLoc }) {
  let filePath;
  try {
    filePath = safePath(cwd, inputLoc, scopePredicates);
  } catch (err) {
    const payload = { exists: false, error: err.message };
    if (includeLoc) payload.loc = inputLoc;
    return payload;
  }
  const hiddenReason = agentHiddenReadablePathReason(path.relative(cwd, filePath));
  if (hiddenReason) {
    const payload = { exists: false, error: `Access to hidden workspace path is blocked: ${inputLoc} (${hiddenReason}).` };
    if (includeLoc) payload.loc = inputLoc;
    return payload;
  }
  if (isSensitiveEnvFileOrTargetPath(filePath)) {
    const payload = { exists: false, error: "Access to .env files is blocked. Use documented config examples or code paths instead." };
    if (includeLoc) payload.loc = inputLoc;
    return payload;
  }
  if (!fs.existsSync(filePath)) {
    const payload = { path: toDisplayPath(cwd, filePath), exists: false };
    if (includeLoc) payload.loc = inputLoc;
    return payload;
  }
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const payload = {
    path: toDisplayPath(cwd, filePath),
    exists: true,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    size: stat.size,
    ext,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
  if (includeLoc) payload.loc = inputLoc;
  if (stat.isFile()) {
    try {
      const image = inspectImageMetadata(filePath, ext);
      if (image) Object.assign(payload, image);
    } catch (err) {
      payload.inspect_error = sanitizeAbsolutePathsInText(err.message, cwd);
    }
  }
  return payload;
}

export function createInspectFileExecutor(safePath) {
  return function execInspectFile(args, cwd, scopePredicates) {
    // Normalize the retired trusted-caller alias before applying the public
    // contract. It is intentionally absent from the advertised schema.
    const batchPaths = Array.isArray(args?.path)
      ? args.path
      : (Array.isArray(args?.paths) ? args.paths : null);
    if (batchPaths) {
      if (batchPaths.length === 0 || batchPaths.some((value) => typeof value !== "string" || !value.trim())) {
        return "Error: inspect_file `path` arrays must contain at least one non-empty string.";
      }
      const results = batchPaths.map((p) => inspectOne(p, cwd, scopePredicates, safePath, { includeLoc: true }));
      return JSON.stringify({ results }, null, 2);
    }
    if (typeof args?.path !== "string" || !args.path.trim()) {
      return "Error: inspect_file requires `path` as a string or an array of strings.";
    }
    const payload = inspectOne(args.path, cwd, scopePredicates, safePath, { includeLoc: false });
    return JSON.stringify(payload, null, 2);
  };
}
