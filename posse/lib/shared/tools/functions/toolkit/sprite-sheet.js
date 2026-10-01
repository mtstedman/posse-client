// @ts-check
//
// compose_sprite_sheet: the artificer packs scoped images into one PNG atlas
// (row-major, fixed cells) plus a JSON frame map. Every input must be a
// readable PNG, JPEG, WebP, or GIF by file signature, and one bad input fails
// the whole call: a sheet with a silent gap breaks whatever indexes it.
//
// Inputs are bounded before decoding (file bytes and header dimensions) and
// the atlas before its buffer is allocated. A format the in-process PNG
// decoder cannot read is copied into a private temp directory under a fixed
// name and decoded by a converter told the exact format, so caller text never
// reaches a converter and no converter sniffs bytes into another coder. Both
// outputs land by rename through the job's create/edit scope.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SPRITE_SHEET_FIT_MODES,
  SPRITE_SHEET_INPUT_FORMATS,
  SPRITE_SHEET_LIMITS,
  SPRITE_SHEET_MAP_VERSION,
  SPRITE_SHEET_OBSERVATION_TYPE,
} from "../../../../catalog/artifact.js";
import { recordObservation } from "../../../../domains/observability/functions/observations.js";
import { guardToolWriteLock } from "../../../../domains/queue/functions/write-lock-guard.js";
import { protectedMutablePathReason, relativePathFromCwd } from "../../../../domains/runtime/functions/protected-paths.js";
import { normalizeDisplaySlashes, toDisplayPath } from "../../../format/functions/display-paths.js";
import {
  convertImageFileToPngExplicit,
  decodePngToRgba,
  detectImageFormat,
  encodeRgbaToPng,
  readImageDimensions,
  resampleRgba,
  resolveExplicitImageConverters,
} from "./image-codec.js";
import { isSensitiveEnvFileOrTargetPath, resolveDeterministicReadableFile, safePath } from "./path-policy.js";

const TOOL_NAME = "compose_sprite_sheet";
const ACCEPTED_LABEL = "PNG, JPEG, WebP, or GIF";

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/**
 * Parse the background colour: "transparent", #RRGGBB, or #RRGGBBAA.
 * @param {unknown} value
 * @returns {number[] | null} [r, g, b, a]
 */
export function parseSpriteSheetBackground(value) {
  if (value == null) return [0, 0, 0, 0];
  const text = String(value).trim().toLowerCase();
  if (text === "" || text === "transparent") return [0, 0, 0, 0];
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(text);
  if (!match) return null;
  const hex = match[1] + (match[2] || "ff");
  return [0, 2, 4, 6].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

/**
 * Row-major cell layout with `padding` pixels around and between cells.
 * @param {{ count: number, columns: number, cellWidth: number, cellHeight: number, padding: number }} options
 */
export function spriteSheetLayout({ count, columns, cellWidth, cellHeight, padding }) {
  const rows = Math.ceil(count / columns);
  return {
    columns,
    rows,
    width: columns * cellWidth + (columns + 1) * padding,
    height: rows * cellHeight + (rows + 1) * padding,
    /** @param {number} index */
    cell(index) {
      return {
        x: padding + (index % columns) * (cellWidth + padding),
        y: padding + Math.floor(index / columns) * (cellHeight + padding),
      };
    },
  };
}

/**
 * Where an image lands inside its cell and which source region it samples.
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {number} cellWidth
 * @param {number} cellHeight
 * @param {string} fit
 * @returns {{ region: Rect | null, x: number, y: number, width: number, height: number }}
 */
export function spriteSheetPlacement(srcWidth, srcHeight, cellWidth, cellHeight, fit) {
  if (fit === "stretch") return { region: null, x: 0, y: 0, width: cellWidth, height: cellHeight };
  if (fit === "cover") {
    const scale = Math.max(cellWidth / srcWidth, cellHeight / srcHeight);
    const width = Math.min(srcWidth, cellWidth / scale);
    const height = Math.min(srcHeight, cellHeight / scale);
    return {
      region: { x: Math.floor((srcWidth - width) / 2), y: Math.floor((srcHeight - height) / 2), width, height },
      x: 0,
      y: 0,
      width: cellWidth,
      height: cellHeight,
    };
  }
  const scale = Math.min(cellWidth / srcWidth, cellHeight / srcHeight);
  const width = Math.min(cellWidth, Math.max(1, Math.round(srcWidth * scale)));
  const height = Math.min(cellHeight, Math.max(1, Math.round(srcHeight * scale)));
  return {
    region: null,
    x: Math.floor((cellWidth - width) / 2),
    y: Math.floor((cellHeight - height) / 2),
    width,
    height,
  };
}

// ImageMagick and ffmpeg read a leading `@`, `|`, or `-`, a `coder:` or
// `protocol:` prefix, and `[...]` selectors as syntax. Converters only ever see
// harness-chosen temp names, but such a path is refused outright as well.
export function converterSyntaxReason(displayPath) {
  if (/[\0\r\n]/.test(displayPath)) return "path contains control characters";
  if (/^[@|-]/.test(displayPath)) return "path starts with converter syntax (@, |, or -)";
  if (/[[\]]/.test(displayPath)) return "path contains [ or ], which converters read as a frame selector";
  if (/^[A-Za-z0-9_+.-]{2,}:/.test(displayPath)) return "path starts with a coder or protocol prefix";
  return null;
}

/**
 * @param {any} args
 * @param {string} key
 * @param {{ min: number, max: number, fallback?: number }} bounds
 * @returns {{ value: number, error: string | null }}
 */
function integerArg(args, key, { min, max, fallback = undefined }) {
  const raw = args?.[key];
  if (raw == null && fallback !== undefined) return { value: fallback, error: null };
  const value = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (!Number.isInteger(value) || value < min || value > max) {
    return { value: 0, error: `${key} must be an integer from ${min} to ${max}` };
  }
  return { value, error: null };
}

/**
 * @param {any} args
 * @param {string} key
 * @returns {{ value: string, error: string | null }}
 */
function pathArg(args, key) {
  const raw = args?.[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { value, error: `${key} is required` };
  if (value.length > SPRITE_SHEET_LIMITS.maxPathChars) {
    return { value, error: `${key} exceeds ${SPRITE_SHEET_LIMITS.maxPathChars} characters` };
  }
  if (/[\0\r\n]/.test(value)) return { value, error: `${key} contains control characters` };
  return { value, error: null };
}

/**
 * @param {any} args
 * @returns {{ error: string, spec?: undefined } | { error: null, spec: {
 *   inputs: string[], outputPath: string, mapPath: string, cellWidth: number, cellHeight: number,
 *   columns: number, padding: number, fit: string, background: number[],
 * } }}
 */
function parseArgs(args) {
  const inputs = Array.isArray(args?.inputs) ? args.inputs : null;
  if (!inputs || inputs.length === 0) return { error: "inputs must be a non-empty array of image paths" };
  if (inputs.length > SPRITE_SHEET_LIMITS.maxInputs) {
    return { error: `inputs accepts at most ${SPRITE_SHEET_LIMITS.maxInputs} images; split them across sheets` };
  }
  const output = pathArg(args, "output_path");
  if (output.error) return { error: output.error };
  if (path.extname(output.value).toLowerCase() !== ".png") return { error: "output_path must end in .png" };
  const mapDefault = `${output.value.slice(0, -path.extname(output.value).length)}.json`;
  const map = args?.map_path == null ? { value: mapDefault, error: null } : pathArg(args, "map_path");
  if (map.error) return { error: map.error };
  if (path.extname(map.value).toLowerCase() !== ".json") return { error: "map_path must end in .json" };
  const numbers = {
    cellWidth: integerArg(args, "cell_width", { min: 1, max: SPRITE_SHEET_LIMITS.maxCellSide }),
    cellHeight: integerArg(args, "cell_height", { min: 1, max: SPRITE_SHEET_LIMITS.maxCellSide }),
    columns: integerArg(args, "columns", { min: 1, max: SPRITE_SHEET_LIMITS.maxInputs }),
    padding: integerArg(args, "padding", { min: 0, max: SPRITE_SHEET_LIMITS.maxPadding, fallback: 0 }),
  };
  const numberError = Object.values(numbers).find((entry) => entry.error);
  if (numberError) return { error: numberError.error };
  const fit = args?.fit == null ? "contain" : String(args.fit).trim().toLowerCase();
  if (!SPRITE_SHEET_FIT_MODES.includes(fit)) return { error: `fit must be one of ${SPRITE_SHEET_FIT_MODES.join(", ")}` };
  const background = parseSpriteSheetBackground(args?.background);
  if (!background) return { error: "background must be transparent, #RRGGBB, or #RRGGBBAA" };
  return {
    error: null,
    spec: {
      inputs: inputs.map((entry) => (typeof entry === "string" ? entry.trim() : "")),
      outputPath: output.value,
      mapPath: map.value,
      cellWidth: numbers.cellWidth.value,
      cellHeight: numbers.cellHeight.value,
      columns: numbers.columns.value,
      padding: numbers.padding.value,
      fit,
      background,
    },
  };
}

// The destination rule download_file and write_file share: create scope, plus
// the edit grant to replace an existing file, never .env or protected paths.
function prepareDestination(cwd, displayPath, key, { scopePredicates, writeGuard }) {
  let absolute;
  try {
    absolute = safePath(cwd, displayPath, scopePredicates);
  } catch (error) {
    return { error: `${key} blocked - ${error?.message || error}` };
  }
  if (isSensitiveEnvFileOrTargetPath(absolute)) return { error: `${key} blocked - .env files cannot be written` };
  const protectedReason = protectedMutablePathReason(relativePathFromCwd(cwd, absolute));
  if (protectedReason) return { error: `${key} blocked - ${displayPath} is protected: ${protectedReason}` };
  let existing = null;
  try {
    existing = fs.lstatSync(absolute);
  } catch {
    existing = null;
  }
  if (existing && !existing.isFile() && !existing.isSymbolicLink()) {
    return { error: `${key} blocked - ${displayPath} exists and is not a file` };
  }
  if (!scopePredicates?.canCreate?.(absolute) || (existing && !scopePredicates?.canEdit?.(absolute))) {
    return { error: `${key} blocked - ${displayPath} is outside the allowed creation scope` };
  }
  const guardError = writeGuard(absolute, displayPath);
  if (guardError) return { error: String(guardError).replace(/^Error:\s*/, "") };
  return { absolute, display: toDisplayPath(cwd, absolute) };
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function oversizeReason(width, height) {
  if (width > SPRITE_SHEET_LIMITS.maxInputSide || height > SPRITE_SHEET_LIMITS.maxInputSide
    || width * height > SPRITE_SHEET_LIMITS.maxInputPixels) {
    return `image is ${width}x${height}; inputs are limited to ${SPRITE_SHEET_LIMITS.maxInputSide} px per side and ${SPRITE_SHEET_LIMITS.maxInputPixels} pixels`;
  }
  return null;
}

// Check one input without decoding pixels: scope, size, signature, header.
function inspectInput(cwd, displayPath, scopePredicates) {
  if (!displayPath) return { error: "path is empty" };
  if (displayPath.length > SPRITE_SHEET_LIMITS.maxPathChars) {
    return { error: `path exceeds ${SPRITE_SHEET_LIMITS.maxPathChars} characters` };
  }
  const syntax = converterSyntaxReason(displayPath);
  if (syntax) return { error: syntax };
  const readable = resolveDeterministicReadableFile(cwd, displayPath, scopePredicates, {
    maxSizeBytes: Number.POSITIVE_INFINITY,
    safePathImpl: safePath,
  });
  if (!readable.ok) return { error: readable.error };
  if (readable.stat.size > SPRITE_SHEET_LIMITS.maxInputBytes) {
    return { error: `file is ${readable.stat.size} bytes; inputs are limited to ${SPRITE_SHEET_LIMITS.maxInputBytes}` };
  }
  let bytes;
  try {
    bytes = fs.readFileSync(readable.path);
  } catch (error) {
    return { error: `could not read the file: ${String(error?.message || error).slice(0, 160)}` };
  }
  const format = detectImageFormat(bytes);
  if (!SPRITE_SHEET_INPUT_FORMATS.includes(format)) {
    return { error: `bytes are not a ${ACCEPTED_LABEL} image${format === "bmp" ? " (BMP is not accepted)" : ""}` };
  }
  const dims = readImageDimensions(bytes, format);
  if (!dims) return { error: `${format.toUpperCase()} header is unreadable` };
  const oversize = oversizeReason(dims.width, dims.height);
  if (oversize) return { error: oversize };
  return {
    absolute: readable.path,
    display: toDisplayPath(cwd, readable.path),
    format,
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

function compositeOver(atlas, atlasWidth, pixels, x0, y0, width, height) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const sa = pixels[s + 3];
      if (sa === 0) continue;
      const d = ((y0 + y) * atlasWidth + x0 + x) * 4;
      const da = atlas[d + 3];
      if (sa === 255 || da === 0) {
        atlas[d] = pixels[s];
        atlas[d + 1] = pixels[s + 1];
        atlas[d + 2] = pixels[s + 2];
        atlas[d + 3] = sa;
        continue;
      }
      const srcA = sa / 255;
      const keep = (da / 255) * (1 - srcA);
      const outA = srcA + keep;
      for (let c = 0; c < 3; c++) {
        atlas[d + c] = Math.round((pixels[s + c] * srcA + atlas[d + c] * keep) / outA);
      }
      atlas[d + 3] = Math.round(outA * 255);
    }
  }
}

/**
 * @param {Buffer} atlas
 * @param {number[]} background [r, g, b, a]
 */
function fillBackground(atlas, background) {
  const [r, g, b, a] = background;
  if (a === 0) return;
  for (let i = 0; i < atlas.length; i += 4) {
    atlas[i] = r;
    atlas[i + 1] = g;
    atlas[i + 2] = b;
    atlas[i + 3] = a;
  }
}

function firstMissingAncestor(directory) {
  let missing = null;
  let cursor = directory;
  while (!fs.existsSync(cursor)) {
    missing = cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return missing;
}

function removeEmptyDirectories(directory, stopAt) {
  if (!stopAt) return;
  let cursor = directory;
  for (;;) {
    try {
      fs.rmdirSync(cursor);
    } catch {
      return;
    }
    if (cursor === stopAt) return;
    cursor = path.dirname(cursor);
  }
}

// Write every output to a temp file beside it, then rename them all into
// place. On failure nothing new is left: temps are removed, an output already
// renamed in this call is removed, and directories this call created go too.
function writeOutputsAtomically(outputs) {
  const staged = [];
  const landed = [];
  try {
    for (const output of outputs) {
      const directory = path.dirname(output.absolute);
      const createdRoot = firstMissingAncestor(directory);
      fs.mkdirSync(directory, { recursive: true });
      const temp = path.join(directory, `.${path.basename(output.absolute)}.${process.pid}.${crypto.randomUUID()}.part`);
      staged.push({ ...output, directory, createdRoot, temp });
      fs.writeFileSync(temp, output.bytes, { flag: "wx" });
    }
    for (const entry of staged) {
      fs.renameSync(entry.temp, entry.absolute);
      landed.push(entry);
    }
  } catch (error) {
    for (const entry of staged) {
      try { fs.rmSync(entry.temp, { force: true }); } catch { /* best effort */ }
    }
    for (const entry of landed) {
      try { fs.rmSync(entry.absolute, { force: true }); } catch { /* best effort */ }
    }
    for (const entry of [...staged].reverse()) removeEmptyDirectories(entry.directory, entry.createdRoot);
    throw error;
  }
}

function failure(message, problems = []) {
  const lines = problems.map((problem) => `- ${problem.path || "(empty)"}: ${problem.error}`);
  return [`Error: ${TOOL_NAME} wrote nothing: ${message}`, ...lines].join("\n");
}

// The in-process decoder reads 8-bit, non-interlaced grey/RGB/RGBA PNGs.
export function nativePngDecodable(bytes) {
  return bytes.length >= 29 && bytes[24] === 8 && [0, 2, 4, 6].includes(bytes[25]) && bytes[28] === 0;
}

/**
 * Re-read one checked input and return PNG bytes the in-process decoder can
 * read, converting other formats in the call's private temp directory.
 * @returns {Promise<{ png: Buffer, error?: undefined } | { error: string, png?: undefined }>}
 */
async function loadInputPng(input, index, decoder) {
  let bytes;
  try {
    bytes = fs.readFileSync(input.absolute);
  } catch (error) {
    return { error: `could not read the file: ${String(error?.message || error).slice(0, 160)}` };
  }
  if (sha256(bytes) !== input.sha256) return { error: "the file changed while the sheet was being composed" };
  if (input.format === "png" && nativePngDecodable(bytes)) return { png: bytes };

  if (!decoder.tempDir) decoder.tempDir = fs.mkdtempSync(path.join(decoder.tempRoot, "posse-sprite-"));
  if (!decoder.converters) decoder.converters = resolveExplicitImageConverters();
  const source = path.join(decoder.tempDir, `frame-${index}-in.${input.format}`);
  const target = path.join(decoder.tempDir, `frame-${index}-out.png`);
  try {
    fs.writeFileSync(source, bytes, { flag: "wx" });
    const result = await convertImageFileToPngExplicit(source, target, input.format, {
      converters: decoder.converters,
      cwd: decoder.tempDir,
      timeoutMs: Math.max(1, decoder.deadline - decoder.now()),
    });
    if (!result.ok) return { error: result.error.split(decoder.tempDir).join("<temp>") };
    const png = fs.readFileSync(target);
    const dims = readImageDimensions(png, "png");
    const oversize = dims ? oversizeReason(dims.width, dims.height) : "the converter produced an unreadable PNG";
    if (oversize) return { error: oversize };
    decoder.converted += 1;
    return { png };
  } catch (error) {
    return { error: `could not decode the image: ${String(error?.message || error).slice(0, 160)}` };
  } finally {
    fs.rmSync(source, { force: true });
    fs.rmSync(target, { force: true });
  }
}

function timeBudgetMessage(done, total) {
  return `the ${SPRITE_SHEET_LIMITS.callTimeoutMs / 1000} s time budget ran out after ${done} of ${total} inputs; `
    + "split the sheet or use smaller inputs.";
}

function recordProvenance(record, context, receipt) {
  try {
    record({
      work_item_id: context?.work_item_id ?? null,
      job_id: context?.job_id ?? null,
      attempt_id: context?.attempt_id ?? null,
      observation_type: SPRITE_SHEET_OBSERVATION_TYPE,
      summary: `Composed ${receipt.image.path} from ${receipt.frames.length} images (${receipt.image.width}x${receipt.image.height})`,
      detail: { tool: TOOL_NAME, agent_call_id: context?.agent_call_id ?? null, ...receipt },
    });
  } catch {
    // Provenance is telemetry; it must not change the tool result.
  }
}

/**
 * Execute one compose_sprite_sheet call.
 * @param {any} args
 * @param {{
 *   cwd: string,
 *   scopePredicates: any,
 *   context?: Record<string, any>,
 *   writeGuard?: (absPath: string, displayPath: string) => string | null,
 *   record?: (observation: any) => unknown,
 *   converters?: string[] | null,
 *   tempRoot?: string,
 *   now?: () => number,
 * }} options
 * @returns {Promise<string>}
 */
export async function composeSpriteSheetWithinScope(args, {
  cwd,
  scopePredicates,
  context = {},
  writeGuard = (_absolute, displayPath) => guardToolWriteLock(TOOL_NAME, displayPath, cwd),
  record = recordObservation,
  converters = null,
  tempRoot = os.tmpdir(),
  now = () => Date.now(),
}) {
  const deadline = now() + SPRITE_SHEET_LIMITS.callTimeoutMs;
  const parsed = parseArgs(args);
  if (parsed.error) return `Error: ${TOOL_NAME} ${parsed.error}.`;
  const spec = parsed.spec;

  const layout = spriteSheetLayout({
    count: spec.inputs.length,
    columns: spec.columns,
    cellWidth: spec.cellWidth,
    cellHeight: spec.cellHeight,
    padding: spec.padding,
  });
  if (layout.width > SPRITE_SHEET_LIMITS.maxAtlasSide || layout.height > SPRITE_SHEET_LIMITS.maxAtlasSide
    || layout.width * layout.height > SPRITE_SHEET_LIMITS.maxAtlasPixels) {
    return `Error: ${TOOL_NAME} sheet would be ${layout.width}x${layout.height}; sheets are limited to `
      + `${SPRITE_SHEET_LIMITS.maxAtlasSide} px per side and ${SPRITE_SHEET_LIMITS.maxAtlasPixels} pixels. `
      + "Use smaller cells, a different column count, or several sheets.";
  }

  const output = prepareDestination(cwd, spec.outputPath, "output_path", { scopePredicates, writeGuard });
  if (output.error) return `Error: ${TOOL_NAME} ${output.error}.`;
  const map = prepareDestination(cwd, spec.mapPath, "map_path", { scopePredicates, writeGuard });
  if (map.error) return `Error: ${TOOL_NAME} ${map.error}.`;
  if (map.absolute === output.absolute) return `Error: ${TOOL_NAME} map_path must differ from output_path.`;

  // Pass 1: every input is checked without decoding, so one call reports
  // every bad input before any converter runs or the atlas is allocated.
  const inputs = [];
  let totalBytes = 0;
  for (const displayPath of spec.inputs) {
    if (now() > deadline) return failure(timeBudgetMessage(inputs.length, spec.inputs.length));
    const input = { path: displayPath, ...inspectInput(cwd, displayPath, scopePredicates) };
    if (!input.error && (input.absolute === output.absolute || input.absolute === map.absolute)) {
      input.error = "an input cannot also be an output";
    }
    totalBytes += input.error ? 0 : input.bytes;
    inputs.push(input);
  }
  const invalid = inputs.filter((input) => input.error);
  if (invalid.length > 0) {
    return failure(`${invalid.length} of ${inputs.length} inputs are not usable ${ACCEPTED_LABEL} images in scope.`, invalid);
  }
  if (totalBytes > SPRITE_SHEET_LIMITS.maxTotalInputBytes) {
    return failure(`the inputs total ${totalBytes} bytes; one sheet reads at most ${SPRITE_SHEET_LIMITS.maxTotalInputBytes}. Split them across sheets.`);
  }

  // Pass 2: decode, fit, and composite. Converter runs overlap, which cannot
  // change the result because every cell is independent; each image is
  // decoded and composited without yielding, so one decoded image is held at
  // a time.
  const atlas = Buffer.alloc(layout.width * layout.height * 4);
  fillBackground(atlas, spec.background);
  const frames = new Array(inputs.length);
  const problems = [];
  const decoder = { tempRoot, tempDir: null, converters, converted: 0, deadline, now };
  let next = 0;
  let finished = 0;
  let timedOut = false;
  const worker = async () => {
    while (next < inputs.length && !timedOut) {
      if (now() > deadline) {
        timedOut = true;
        return;
      }
      const index = next;
      next += 1;
      const input = inputs[index];
      const loaded = await loadInputPng(input, index, decoder);
      let image = null;
      try {
        if (loaded.error) throw new Error(loaded.error);
        image = decodePngToRgba(loaded.png);
      } catch (error) {
        problems.push({ index, path: input.path, error: String(error?.message || error).slice(0, 240) });
      }
      if (image) {
        const cell = layout.cell(index);
        const place = spriteSheetPlacement(image.width, image.height, spec.cellWidth, spec.cellHeight, spec.fit);
        const pixels = resampleRgba(image.width, image.height, image.data, place.width, place.height, place.region);
        compositeOver(atlas, layout.width, pixels, cell.x + place.x, cell.y + place.y, place.width, place.height);
        frames[index] = { index, source: input.display, x: cell.x, y: cell.y, w: spec.cellWidth, h: spec.cellHeight };
      }
      finished += 1;
      // Yield between frames so one large sheet does not starve other calls.
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  try {
    await Promise.all(Array.from(
      { length: Math.min(SPRITE_SHEET_LIMITS.converterConcurrency, inputs.length) },
      () => worker(),
    ));
  } finally {
    if (decoder.tempDir) fs.rmSync(decoder.tempDir, { recursive: true, force: true });
  }
  if (timedOut) return failure(timeBudgetMessage(finished, inputs.length));
  if (problems.length > 0) {
    problems.sort((a, b) => a.index - b.index);
    return failure(`${problems.length} of ${inputs.length} inputs could not be decoded.`, problems);
  }

  const imageBytes = encodeRgbaToPng(layout.width, layout.height, atlas);
  const frameMap = {
    version: SPRITE_SHEET_MAP_VERSION,
    image: normalizeDisplaySlashes(path.relative(path.dirname(map.absolute), output.absolute)),
    width: layout.width,
    height: layout.height,
    cell_width: spec.cellWidth,
    cell_height: spec.cellHeight,
    columns: layout.columns,
    rows: layout.rows,
    padding: spec.padding,
    fit: spec.fit,
    frames,
  };
  const mapBytes = Buffer.from(`${JSON.stringify(frameMap, null, 2)}\n`, "utf8");
  try {
    writeOutputsAtomically([
      { absolute: output.absolute, bytes: imageBytes },
      { absolute: map.absolute, bytes: mapBytes },
    ]);
  } catch (error) {
    return failure(`could not write the outputs: ${String(error?.message || error).split(cwd).join(".").slice(0, 200)}`);
  }

  const imageReceipt = {
    path: output.display,
    width: layout.width,
    height: layout.height,
    bytes: imageBytes.length,
    sha256: sha256(imageBytes),
  };
  const mapReceipt = { path: map.display, bytes: mapBytes.length, sha256: sha256(mapBytes) };
  recordProvenance(record, context, {
    image: imageReceipt,
    map: mapReceipt,
    fit: spec.fit,
    frames: inputs.map((input, index) => ({ index, source: input.display, sha256: input.sha256 })),
  });
  return JSON.stringify({
    ok: true,
    image: imageReceipt,
    map: mapReceipt,
    frames: frames.length,
    columns: layout.columns,
    rows: layout.rows,
    cell_width: spec.cellWidth,
    cell_height: spec.cellHeight,
    padding: spec.padding,
    fit: spec.fit,
    converted_inputs: decoder.converted,
  });
}
