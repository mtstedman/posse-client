// @ts-check
//
// view_image: return one in-scope image as an MCP image content block so a
// vision model can inspect its pixels (scene, composition, style, legibility),
// which metadata and OCR cannot prove.
//
// The file passes the same read gate read_file uses (scope, hidden paths,
// .env, regular file), then a byte limit, a PNG/JPEG/WebP/GIF file signature,
// and header dimension limits, all before any decode. An image within the
// delivery bounds is returned byte-exact. A larger one is decoded (8-bit
// non-interlaced PNG in process; anything else through a converter told the
// exact format, under a fixed temp name) and area-downscaled to a PNG that
// fits. Nothing is written inside the workspace.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  VIEW_IMAGE_INPUT_FORMATS,
  VIEW_IMAGE_LIMITS,
  VIEW_IMAGE_MIME_TYPES,
} from "../../../../catalog/artifact.js";
import { toDisplayPath } from "../../../format/functions/display-paths.js";
import { mcpContentResult } from "../mcp-content-result.js";
import {
  convertImageFileToPngExplicit,
  decodePngToRgba,
  detectImageFormat,
  encodeRgbaToPng,
  readImageDimensions,
  resampleRgba,
  resolveExplicitImageConverters,
} from "./image-codec.js";
import { resolveDeterministicReadableFile, safePath } from "./path-policy.js";
import { converterSyntaxReason, nativePngDecodable } from "./sprite-sheet.js";

const TOOL_NAME = "view_image";
const ACCEPTED_LABEL = "PNG, JPEG, WebP, or GIF";

function refusal(message) {
  return `Error: ${TOOL_NAME} refused: ${message}`;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Largest size with the same aspect ratio whose long edge is at most maxSide.
 * @param {number} width
 * @param {number} height
 * @param {number} maxSide
 */
export function viewImageTargetSize(width, height, maxSide) {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxSide) return { width, height };
  const scale = maxSide / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Decode checked image bytes to RGBA, converting non-native formats in a
 * private temp directory.
 * @returns {Promise<{ width: number, height: number, data: Buffer } | { error: string }>}
 */
async function decodeToRgba(bytes, format, { converters, tempRoot, deadline, now }) {
  let png = bytes;
  let tempDir = null;
  try {
    if (!(format === "png" && nativePngDecodable(bytes))) {
      const available = converters ?? resolveExplicitImageConverters();
      tempDir = fs.mkdtempSync(path.join(tempRoot, "posse-view-image-"));
      const source = path.join(tempDir, `in.${format}`);
      const target = path.join(tempDir, "out.png");
      fs.writeFileSync(source, bytes, { flag: "wx" });
      const converted = await convertImageFileToPngExplicit(source, target, format, {
        converters: available,
        cwd: tempDir,
        timeoutMs: Math.max(1, deadline - now()),
      });
      if (!converted.ok) return { error: String(converted.error || "conversion failed").split(tempDir).join("<temp>") };
      png = fs.readFileSync(target);
      const dims = readImageDimensions(png, "png");
      if (!dims || dims.width > VIEW_IMAGE_LIMITS.maxInputSide || dims.height > VIEW_IMAGE_LIMITS.maxInputSide
        || dims.width * dims.height > VIEW_IMAGE_LIMITS.maxInputPixels) {
        return { error: "the converter produced an unreadable or oversized PNG" };
      }
    }
    const decoded = decodePngToRgba(png);
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  } catch (error) {
    return { error: `could not decode the image: ${String(error?.message || error).slice(0, 160)}` };
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Downscale RGBA pixels to a PNG within the delivery limits.
 * @returns {{ png: Buffer, width: number, height: number } | { error: string }}
 */
function downscaleToPng(rgba, maxSide) {
  let side = maxSide;
  for (let attempt = 0; attempt < VIEW_IMAGE_LIMITS.maxDownscaleAttempts; attempt += 1) {
    const size = viewImageTargetSize(rgba.width, rgba.height, side);
    const pixels = size.width === rgba.width && size.height === rgba.height
      ? rgba.data
      : resampleRgba(rgba.width, rgba.height, rgba.data, size.width, size.height);
    const png = encodeRgbaToPng(size.width, size.height, pixels);
    if (png.length <= VIEW_IMAGE_LIMITS.maxOutputBytes) return { png, width: size.width, height: size.height };
    // PNG bytes scale roughly with pixel count; shrink the long edge by the
    // square root of the overshoot, with headroom.
    const ratio = Math.sqrt(VIEW_IMAGE_LIMITS.maxOutputBytes / png.length) * 0.9;
    side = Math.max(1, Math.floor(Math.max(size.width, size.height) * ratio));
  }
  return { error: `the image could not be reduced below ${VIEW_IMAGE_LIMITS.maxOutputBytes} bytes` };
}

/**
 * @param {any} args
 * @param {{
 *   cwd: string,
 *   scopePredicates?: any,
 *   converters?: string[] | null,
 *   tempRoot?: string,
 *   now?: () => number,
 * }} options
 * @returns {Promise<string | ReturnType<typeof mcpContentResult>>}
 */
export async function viewImageWithinScope(args, {
  cwd,
  scopePredicates = null,
  converters = null,
  tempRoot = os.tmpdir(),
  now = Date.now,
}) {
  const startedAt = now();
  const rawPath = typeof args?.path === "string" ? args.path.trim()
    : (typeof args?.file_path === "string" ? args.file_path.trim() : "");
  if (!rawPath) return refusal("path is required");
  if (rawPath.length > VIEW_IMAGE_LIMITS.maxPathChars) {
    return refusal(`path exceeds ${VIEW_IMAGE_LIMITS.maxPathChars} characters`);
  }
  const syntax = converterSyntaxReason(rawPath);
  if (syntax) return refusal(syntax);
  const readable = resolveDeterministicReadableFile(cwd, rawPath, scopePredicates, {
    maxSizeBytes: Number.POSITIVE_INFINITY,
    safePathImpl: safePath,
  });
  if (!readable.ok) return `Error: ${readable.error}`;
  const display = toDisplayPath(cwd, readable.path);
  if (readable.stat.size > VIEW_IMAGE_LIMITS.maxInputBytes) {
    return refusal(`${display} is ${readable.stat.size} bytes; images are limited to ${VIEW_IMAGE_LIMITS.maxInputBytes} bytes`);
  }
  let bytes;
  try {
    bytes = fs.readFileSync(readable.path);
  } catch (error) {
    return refusal(`could not read ${display}: ${String(error?.message || error).slice(0, 160)}`);
  }
  const format = detectImageFormat(bytes);
  if (!VIEW_IMAGE_INPUT_FORMATS.includes(format)) {
    return refusal(`${display} is not a ${ACCEPTED_LABEL} image by file signature${format === "bmp" ? " (BMP is not accepted)" : ""}`);
  }
  const dims = readImageDimensions(bytes, format);
  if (!dims) return refusal(`${display}: ${format.toUpperCase()} header is unreadable`);
  if (dims.width > VIEW_IMAGE_LIMITS.maxInputSide || dims.height > VIEW_IMAGE_LIMITS.maxInputSide
    || dims.width * dims.height > VIEW_IMAGE_LIMITS.maxInputPixels) {
    return refusal(`${display} is ${dims.width}x${dims.height}; images are limited to ${VIEW_IMAGE_LIMITS.maxInputSide} px per side and ${VIEW_IMAGE_LIMITS.maxInputPixels} pixels`);
  }
  const digest = sha256(bytes);

  let delivered;
  if (Math.max(dims.width, dims.height) <= VIEW_IMAGE_LIMITS.maxOutputSide
    && bytes.length <= VIEW_IMAGE_LIMITS.maxOutputBytes) {
    delivered = {
      bytes,
      mimeType: VIEW_IMAGE_MIME_TYPES[format],
      width: dims.width,
      height: dims.height,
      downscaled: false,
    };
  } else {
    const rgba = await decodeToRgba(bytes, format, {
      converters,
      tempRoot,
      deadline: startedAt + VIEW_IMAGE_LIMITS.callTimeoutMs,
      now,
    });
    if ("error" in rgba) return refusal(`${display}: ${rgba.error}`);
    const reduced = downscaleToPng(rgba, VIEW_IMAGE_LIMITS.maxOutputSide);
    if ("error" in reduced) return refusal(`${display}: ${reduced.error}`);
    delivered = {
      bytes: reduced.png,
      mimeType: "image/png",
      width: reduced.width,
      height: reduced.height,
      downscaled: true,
    };
  }

  const summary = {
    ok: true,
    path: display,
    format,
    width: dims.width,
    height: dims.height,
    bytes: bytes.length,
    sha256: digest,
    delivered: {
      mime_type: delivered.mimeType,
      width: delivered.width,
      height: delivered.height,
      bytes: delivered.bytes.length,
      downscaled: delivered.downscaled,
    },
  };
  return mcpContentResult(JSON.stringify(summary), [{
    type: "image",
    data: delivered.bytes.toString("base64"),
    mimeType: delivered.mimeType,
  }]);
}
