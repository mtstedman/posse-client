// Image codec helpers used by the image-mode toolkit: a small
// 8-bit PNG decoder/encoder, a JPEG header reader, a format
// detector, and an external-converter fallback (ImageMagick,
// ffmpeg, Windows System.Drawing) for everything else.
//
// All pixel work happens in RGBA. The PNG codec is intentionally
// minimal — it only handles the 8-bit, non-interlaced subset that
// Posse's generated/persisted images use. Anything outside that
// range routes through convertImageToPng to one of the system
// converters.

import { constants as bufferConstants } from "buffer";
import fs from "fs";
import zlib from "zlib";
import { execFile, spawnSync } from "child_process";

import { IMAGE_CONVERTER_TIMEOUT_MS } from "../../../../catalog/artifact.js";

export const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function makePngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([len, typeBuffer, data, crcBuffer]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePngToRgba(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Only PNG inputs are supported.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error("Corrupt PNG chunk layout.");
    const data = buffer.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (!width || !height) throw new Error("PNG is missing IHDR metadata.");
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}; only 8-bit PNGs are supported.`);
  if (![0, 2, 4, 6].includes(colorType)) {
    throw new Error(`Unsupported PNG color type ${colorType}; only grayscale/RGB/RGBA PNGs are supported.`);
  }
  if (interlace !== 0) throw new Error("Interlaced PNGs are not supported.");

  const bytesPerPixel = colorType === 6 ? 4
    : colorType === 4 ? 2
      : colorType === 2 ? 3
        : 1;
  const stride = width * bytesPerPixel;
  const expected = (stride + 1) * height;
  // Bound the inflate by the size the header implies so a compressed bomb
  // cannot allocate past it before the length check below.
  let inflated;
  try {
    inflated = zlib.inflateSync(Buffer.concat(idatChunks), {
      maxOutputLength: Math.min(expected, bufferConstants.MAX_LENGTH),
    });
  } catch (err) {
    if (err?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error("PNG pixel data length did not match image dimensions.");
    }
    throw err;
  }
  if (inflated.length !== expected) {
    throw new Error("PNG pixel data length did not match image dimensions.");
  }

  const raw = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) {
    const filter = inflated[row * (stride + 1)];
    const srcRow = inflated.subarray(row * (stride + 1) + 1, row * (stride + 1) + 1 + stride);
    const destOffset = row * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= bytesPerPixel ? raw[destOffset + i - bytesPerPixel] : 0;
      const up = row > 0 ? raw[destOffset - stride + i] : 0;
      const upLeft = (row > 0 && i >= bytesPerPixel) ? raw[destOffset - stride + i - bytesPerPixel] : 0;
      switch (filter) {
        case 0:
          raw[destOffset + i] = srcRow[i];
          break;
        case 1:
          raw[destOffset + i] = (srcRow[i] + left) & 0xff;
          break;
        case 2:
          raw[destOffset + i] = (srcRow[i] + up) & 0xff;
          break;
        case 3:
          raw[destOffset + i] = (srcRow[i] + Math.floor((left + up) / 2)) & 0xff;
          break;
        case 4:
          raw[destOffset + i] = (srcRow[i] + paethPredictor(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported PNG filter type ${filter}.`);
      }
    }
  }

  if (colorType === 6) {
    return { width, height, data: raw };
  }

  const rgba = Buffer.alloc(width * height * 4);
  if (colorType === 2) {
    for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
      rgba[j] = raw[i];
      rgba[j + 1] = raw[i + 1];
      rgba[j + 2] = raw[i + 2];
      rgba[j + 3] = 255;
    }
  } else if (colorType === 4) {
    for (let i = 0, j = 0; i < raw.length; i += 2, j += 4) {
      rgba[j] = raw[i];
      rgba[j + 1] = raw[i];
      rgba[j + 2] = raw[i];
      rgba[j + 3] = raw[i + 1];
    }
  } else {
    for (let i = 0, j = 0; i < raw.length; i += 1, j += 4) {
      rgba[j] = raw[i];
      rgba[j + 1] = raw[i];
      rgba[j + 2] = raw[i];
      rgba[j + 3] = 255;
    }
  }
  return { width, height, data: rgba };
}

export function encodeRgbaToPng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    const rowOffset = row * (stride + 1);
    raw[rowOffset] = 0;
    rgba.copy(raw, rowOffset + 1, row * stride, row * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", zlib.deflateSync(raw)),
    makePngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return "unknown";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") return "gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return "bmp";
  return "unknown";
}

export function readJpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    const isSof = (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker));
    if (isSof && length >= 7) {
      return {
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3),
      };
    }
    offset += length;
  }
  return { width: null, height: null };
}

function runSharpConvert({ srcPath, destPath, outputFormat, quality = 90 }) {
  const script = `
import { createRequire } from "module";
import fs from "fs";
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const require = createRequire(input.moduleUrl);
const sharp = require("sharp");
let image = sharp(input.srcPath, { failOn: "none" }).rotate();
if (input.outputFormat === "jpeg") {
  image = image.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({
    quality: input.quality,
    chromaSubsampling: "4:4:4",
  });
} else if (input.outputFormat === "png") {
  image = image.png();
} else {
  throw new Error("unsupported output format");
}
await image.toFile(input.destPath);
const meta = await sharp(input.destPath).metadata();
process.stdout.write(JSON.stringify({
  ok: true,
  format: meta.format || input.outputFormat,
  width: meta.width ?? null,
  height: meta.height ?? null,
}));
`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    input: JSON.stringify({
      moduleUrl: import.meta.url,
      srcPath,
      destPath,
      outputFormat,
      quality: Math.max(1, Math.min(100, Math.round(Number(quality) || 90))),
    }),
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: IMAGE_CONVERTER_TIMEOUT_MS,
    windowsHide: true,
  });
}

function commandExists(command) {
  const probe = process.platform === "win32"
    ? spawnSync("where.exe", [command], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: IMAGE_CONVERTER_TIMEOUT_MS })
    : spawnSync("sh", ["-c", `command -v ${JSON.stringify(command)}`], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: IMAGE_CONVERTER_TIMEOUT_MS });
  return probe.status === 0;
}

export function convertImageToPng(_inputBuffer, srcPath, destPath) {
  const attempts = [];
  const sharp = runSharpConvert({ srcPath, destPath, outputFormat: "png" });
  attempts.push({
    converter: "sharp",
    status: sharp.status,
    error: sharp.error?.code || null,
    stderr: String(sharp.stderr || "").trim().slice(0, 300),
  });
  if (sharp.status === 0 && fs.existsSync(destPath)) return { ok: true, converter: "sharp" };

  const run = (converter, command, args) => {
    const result = spawnSync(command, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: IMAGE_CONVERTER_TIMEOUT_MS,
      windowsHide: true,
    });
    attempts.push({
      converter,
      status: result.status,
      error: result.error?.code || null,
      stderr: String(result.stderr || "").trim().slice(0, 300),
    });
    if (result.status === 0 && fs.existsSync(destPath)) return { ok: true, converter };
    return null;
  };

  if (commandExists("magick")) {
    const ok = run("magick", "magick", [srcPath, "PNG32:" + destPath]);
    if (ok) return ok;
  }
  if (process.platform !== "win32" && commandExists("convert")) {
    const ok = run("convert", "convert", [srcPath, "PNG32:" + destPath]);
    if (ok) return ok;
  }
  if (commandExists("ffmpeg")) {
    const ok = run("ffmpeg", "ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", srcPath, destPath]);
    if (ok) return ok;
  }
  if (process.platform === "win32" && commandExists("powershell.exe")) {
    const ps = [
      "Add-Type -AssemblyName System.Drawing;",
      `$src = [System.Drawing.Image]::FromFile(${JSON.stringify(srcPath)});`,
      "try {",
      `$src.Save(${JSON.stringify(destPath)}, [System.Drawing.Imaging.ImageFormat]::Png);`,
      "} finally { $src.Dispose(); }",
    ].join(" ");
    const ok = run("powershell-system-drawing", "powershell.exe", ["-NoProfile", "-Command", ps]);
    if (ok) return ok;
  }

  const details = attempts.length > 0
    ? attempts.map((a) => `${a.converter}:${a.status}${a.error ? ` ${a.error}` : ""}${a.stderr ? ` ${a.stderr}` : ""}`).join("; ")
    : "no converter found";
  return {
    ok: false,
    error: `Error: reencode_image needs sharp, ImageMagick, ffmpeg, or Windows System.Drawing for non-PNG input (${details}).`,
  };
}

export function convertImageToJpeg(_inputBuffer, srcPath, destPath, { quality = 90 } = {}) {
  const attempts = [];
  const sharp = runSharpConvert({ srcPath, destPath, outputFormat: "jpeg", quality });
  attempts.push({
    converter: "sharp",
    status: sharp.status,
    error: sharp.error?.code || null,
    stderr: String(sharp.stderr || "").trim().slice(0, 300),
  });
  if (sharp.status === 0 && fs.existsSync(destPath)) return { ok: true, converter: "sharp" };

  const run = (converter, command, args) => {
    const result = spawnSync(command, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: IMAGE_CONVERTER_TIMEOUT_MS,
      windowsHide: true,
    });
    attempts.push({
      converter,
      status: result.status,
      error: result.error?.code || null,
      stderr: String(result.stderr || "").trim().slice(0, 300),
    });
    if (result.status === 0 && fs.existsSync(destPath)) return { ok: true, converter };
    return null;
  };

  if (commandExists("magick")) {
    const ok = run("magick", "magick", [srcPath, "-background", "white", "-alpha", "remove", "-alpha", "off", "-quality", String(quality), "JPEG:" + destPath]);
    if (ok) return ok;
  }
  if (process.platform !== "win32" && commandExists("convert")) {
    const ok = run("convert", "convert", [srcPath, "-background", "white", "-alpha", "remove", "-alpha", "off", "-quality", String(quality), "JPEG:" + destPath]);
    if (ok) return ok;
  }
  if (commandExists("ffmpeg")) {
    const ok = run("ffmpeg", "ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", srcPath, "-frames:v", "1", "-q:v", "2", destPath]);
    if (ok) return ok;
  }
  if (process.platform === "win32" && commandExists("powershell.exe")) {
    const ps = [
      "Add-Type -AssemblyName System.Drawing;",
      `$src = [System.Drawing.Image]::FromFile(${JSON.stringify(srcPath)});`,
      "$bmp = New-Object System.Drawing.Bitmap $src.Width, $src.Height;",
      "$g = [System.Drawing.Graphics]::FromImage($bmp);",
      "try {",
      "$g.Clear([System.Drawing.Color]::White);",
      "$g.DrawImage($src, 0, 0, $src.Width, $src.Height);",
      `$bmp.Save(${JSON.stringify(destPath)}, [System.Drawing.Imaging.ImageFormat]::Jpeg);`,
      "} finally { $g.Dispose(); $bmp.Dispose(); $src.Dispose(); }",
    ].join(" ");
    const ok = run("powershell-system-drawing", "powershell.exe", ["-NoProfile", "-Command", ps]);
    if (ok) return ok;
  }

  const details = attempts.length > 0
    ? attempts.map((a) => `${a.converter}:${a.status}${a.error ? ` ${a.error}` : ""}${a.stderr ? ` ${a.stderr}` : ""}`).join("; ")
    : "no converter found";
  return {
    ok: false,
    error: `Error: reencode_image needs sharp, ImageMagick, ffmpeg, or Windows System.Drawing for JPEG output (${details}).`,
  };
}

export function resizeRgbaNearest(srcWidth, srcHeight, srcData, dstWidth, dstHeight, mode = "fit") {
  const dst = Buffer.alloc(dstWidth * dstHeight * 4);
  let scaleX = dstWidth / srcWidth;
  let scaleY = dstHeight / srcHeight;
  let drawWidth = dstWidth;
  let drawHeight = dstHeight;
  let offsetX = 0;
  let offsetY = 0;

  if (mode === "fit" || mode === "fill") {
    const scale = mode === "fit"
      ? Math.min(dstWidth / srcWidth, dstHeight / srcHeight)
      : Math.max(dstWidth / srcWidth, dstHeight / srcHeight);
    drawWidth = Math.max(1, Math.round(srcWidth * scale));
    drawHeight = Math.max(1, Math.round(srcHeight * scale));
    offsetX = Math.floor((dstWidth - drawWidth) / 2);
    offsetY = Math.floor((dstHeight - drawHeight) / 2);
    scaleX = drawWidth / srcWidth;
    scaleY = drawHeight / srcHeight;
  }

  for (let y = 0; y < dstHeight; y++) {
    for (let x = 0; x < dstWidth; x++) {
      if (mode !== "stretch") {
        if (x < offsetX || y < offsetY || x >= offsetX + drawWidth || y >= offsetY + drawHeight) {
          continue;
        }
      }
      const localX = mode === "stretch" ? x : (x - offsetX);
      const localY = mode === "stretch" ? y : (y - offsetY);
      const srcX = Math.min(srcWidth - 1, Math.max(0, Math.floor(localX / scaleX)));
      const srcY = Math.min(srcHeight - 1, Math.max(0, Math.floor(localY / scaleY)));
      const srcIdx = (srcY * srcWidth + srcX) * 4;
      const dstIdx = (y * dstWidth + x) * 4;
      dst[dstIdx] = srcData[srcIdx];
      dst[dstIdx + 1] = srcData[srcIdx + 1];
      dst[dstIdx + 2] = srcData[srcIdx + 2];
      dst[dstIdx + 3] = srcData[srcIdx + 3];
    }
  }

  return dst;
}

/**
 * Read an image's pixel dimensions from its header without decoding pixels,
 * so callers can refuse oversized inputs before allocating a buffer. Returns
 * null when the header is missing or unreadable.
 * @param {Buffer} buffer
 * @param {string} [format] detectImageFormat(buffer) when already known
 * @returns {{ width: number, height: number } | null}
 */
export function readImageDimensions(buffer, format = detectImageFormat(buffer)) {
  if (!Buffer.isBuffer(buffer)) return null;
  let dims = null;
  if (format === "png") {
    if (buffer.length >= 24 && buffer.toString("ascii", 12, 16) === "IHDR") {
      dims = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
  } else if (format === "jpeg") {
    dims = readJpegDimensions(buffer);
  } else if (format === "gif") {
    if (buffer.length >= 10) dims = { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  } else if (format === "webp") {
    const chunk = buffer.length >= 16 ? buffer.toString("ascii", 12, 16) : "";
    if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      dims = { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    } else if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      dims = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (chunk === "VP8X" && buffer.length >= 30) {
      dims = { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
    }
  }
  if (!dims || !Number.isInteger(dims.width) || !Number.isInteger(dims.height) || dims.width <= 0 || dims.height <= 0) {
    return null;
  }
  return { width: dims.width, height: dims.height };
}

// Per-output-pixel source taps along one axis. Shrinking averages every
// source pixel under the output pixel's footprint, weighted by coverage (a
// box filter); enlarging interpolates the two nearest source pixels.
function resampleAxis(srcSize, start, length, dstSize) {
  const shrinking = dstSize <= length;
  const first = new Int32Array(dstSize);
  const count = new Int32Array(dstSize);
  const taps = [];
  for (let o = 0; o < dstSize; o++) {
    const weights = [];
    let lo;
    if (shrinking) {
      const begin = Math.max(0, start + (o * length) / dstSize);
      const end = Math.min(srcSize, start + ((o + 1) * length) / dstSize);
      lo = Math.floor(begin);
      for (let s = lo; s < end; s++) {
        const overlap = Math.min(end, s + 1) - Math.max(begin, s);
        weights.push(overlap > 0 ? overlap : 0);
      }
      if (weights.length === 0) {
        lo = Math.min(srcSize - 1, Math.max(0, lo));
        weights.push(1);
      }
    } else {
      const center = start + ((o + 0.5) * length) / dstSize - 0.5;
      const base = Math.floor(center);
      const t = center - base;
      const a = Math.min(srcSize - 1, Math.max(0, base));
      const b = Math.min(srcSize - 1, Math.max(0, base + 1));
      lo = a;
      if (a === b) weights.push(1);
      else weights.push(1 - t, t);
    }
    const sum = weights.reduce((total, w) => total + w, 0) || 1;
    first[o] = lo;
    count[o] = weights.length;
    taps.push(Float64Array.from(weights, (w) => w / sum));
  }
  return { first, count, taps };
}

/**
 * Resample a region of a straight-alpha RGBA image to dstWidth x dstHeight.
 * Shrinking uses area averaging and enlarging uses bilinear interpolation.
 * Colour is filtered premultiplied by alpha, so transparent neighbours never
 * darken or tint an edge. Same input, same output: the arithmetic is fixed.
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {Buffer} srcData
 * @param {number} dstWidth
 * @param {number} dstHeight
 * @param {{ x: number, y: number, width: number, height: number } | null} [region]
 *   source rectangle in pixels (fractional allowed); defaults to the whole image
 * @returns {Buffer}
 */
export function resampleRgba(srcWidth, srcHeight, srcData, dstWidth, dstHeight, region = null) {
  const rx = region ? region.x : 0;
  const ry = region ? region.y : 0;
  const rw = region ? region.width : srcWidth;
  const rh = region ? region.height : srcHeight;
  const xs = resampleAxis(srcWidth, rx, rw, dstWidth);
  const ys = resampleAxis(srcHeight, ry, rh, dstHeight);

  let rowMin = srcHeight;
  let rowMax = -1;
  for (let o = 0; o < dstHeight; o++) {
    rowMin = Math.min(rowMin, ys.first[o]);
    rowMax = Math.max(rowMax, ys.first[o] + ys.count[o] - 1);
  }
  const rows = rowMax - rowMin + 1;

  // Horizontal pass into premultiplied floats, only for the source rows the
  // vertical pass reads.
  const mid = new Float32Array(rows * dstWidth * 4);
  for (let r = 0; r < rows; r++) {
    const srcRow = (rowMin + r) * srcWidth;
    const midRow = r * dstWidth * 4;
    for (let o = 0; o < dstWidth; o++) {
      const taps = xs.taps[o];
      const first = xs.first[o];
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (let k = 0; k < taps.length; k++) {
        const idx = (srcRow + first + k) * 4;
        const w = taps[k] * srcData[idx + 3];
        pr += w * srcData[idx];
        pg += w * srcData[idx + 1];
        pb += w * srcData[idx + 2];
        pa += w;
      }
      const m = midRow + o * 4;
      mid[m] = pr;
      mid[m + 1] = pg;
      mid[m + 2] = pb;
      mid[m + 3] = pa;
    }
  }

  const out = Buffer.alloc(dstWidth * dstHeight * 4);
  for (let oy = 0; oy < dstHeight; oy++) {
    const taps = ys.taps[oy];
    const firstRow = ys.first[oy] - rowMin;
    for (let ox = 0; ox < dstWidth; ox++) {
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (let k = 0; k < taps.length; k++) {
        const m = ((firstRow + k) * dstWidth + ox) * 4;
        const w = taps[k];
        pr += w * mid[m];
        pg += w * mid[m + 1];
        pb += w * mid[m + 2];
        pa += w * mid[m + 3];
      }
      const d = (oy * dstWidth + ox) * 4;
      const alpha = Math.round(pa);
      if (alpha <= 0) continue;
      out[d] = Math.min(255, Math.max(0, Math.round(pr / pa)));
      out[d + 1] = Math.min(255, Math.max(0, Math.round(pg / pa)));
      out[d + 2] = Math.min(255, Math.max(0, Math.round(pb / pa)));
      out[d + 3] = Math.min(255, alpha);
    }
  }
  return out;
}

// Explicit decoders for each accepted input format. A converter is always told
// the format, so it never sniffs the bytes into another coder (SVG, MVG, text,
// or a URL/pipe pseudo-format).
const IMAGEMAGICK_INPUT_CODERS = Object.freeze({ png: "png", jpeg: "jpeg", webp: "webp", gif: "gif" });
const FFMPEG_INPUT_DEMUXERS = Object.freeze({ png: "png_pipe", jpeg: "jpeg_pipe", webp: "webp_pipe", gif: "gif" });

/**
 * Converters that accept an explicit input format, in preference order. sharp
 * is not listed: it chooses a loader by sniffing and cannot be pinned to one.
 * @returns {string[]}
 */
export function resolveExplicitImageConverters() {
  const found = [];
  if (commandExists("magick")) found.push("magick");
  if (process.platform !== "win32" && commandExists("convert")) found.push("convert");
  if (commandExists("ffmpeg")) found.push("ffmpeg");
  return found;
}

function explicitConverterArgs(converter, format, srcPath, destPath) {
  // Both run strict: a truncated or corrupt image fails instead of landing in
  // the output half grey.
  if (converter === "magick" || converter === "convert") {
    // `coder:path[0]` pins the decoder and reads only the first frame.
    return ["-regard-warnings", `${IMAGEMAGICK_INPUT_CODERS[format]}:${srcPath}[0]`, "-interlace", "none", `PNG32:${destPath}`];
  }
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-xerror",
    "-err_detect", "explode", "-f", FFMPEG_INPUT_DEMUXERS[format], "-i", `file:${srcPath}`,
    "-frames:v", "1", "-an", "-f", "image2", "-update", "1", "-c:v", "png", "-pix_fmt", "rgba",
    "-y", `file:${destPath}`,
  ];
}

function runConverter(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd,
      timeout: Math.max(1, timeoutMs),
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }, (error, _stdout, stderr) => {
      resolve({
        ok: !error,
        detail: error
          ? `${error.killed ? "timed out" : `exit ${error.code ?? "?"}`}${stderr ? ` ${String(stderr).trim().slice(0, 200)}` : ""}`
          : "",
      });
    });
  });
}

/**
 * Convert one image file of a known, signature-checked format to an 8-bit
 * RGBA PNG without blocking the event loop. srcPath and destPath must be
 * harness-chosen paths (never caller text): ImageMagick reads `[` and a
 * `coder:` prefix as syntax.
 * @param {string} srcPath
 * @param {string} destPath
 * @param {"png"|"jpeg"|"webp"|"gif"} format
 * @param {{ converters: string[], cwd: string, timeoutMs?: number }} options
 *   timeoutMs bounds the whole converter chain; each run also stops at
 *   IMAGE_CONVERTER_TIMEOUT_MS.
 * @returns {Promise<{ ok: boolean, converter?: string, error?: string }>}
 */
export async function convertImageFileToPngExplicit(srcPath, destPath, format, {
  converters,
  cwd,
  timeoutMs = IMAGE_CONVERTER_TIMEOUT_MS,
}) {
  if (!IMAGEMAGICK_INPUT_CODERS[format]) return { ok: false, error: `unsupported input format ${format}` };
  if (!Array.isArray(converters) || converters.length === 0) {
    return { ok: false, error: "no image converter (ImageMagick or ffmpeg) is installed" };
  }
  const startedAt = Date.now();
  const attempts = [];
  for (const converter of converters) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      attempts.push(`${converter}: not run, time budget exhausted`);
      break;
    }
    try { fs.rmSync(destPath, { force: true }); } catch { /* best effort */ }
    const result = await runConverter(converter, explicitConverterArgs(converter, format, srcPath, destPath), {
      cwd,
      timeoutMs: Math.min(remaining, IMAGE_CONVERTER_TIMEOUT_MS),
    });
    let produced = false;
    try {
      const head = Buffer.alloc(8);
      const fd = fs.openSync(destPath, "r");
      try { produced = fs.readSync(fd, head, 0, 8, 0) === 8 && head.equals(PNG_SIGNATURE); } finally { fs.closeSync(fd); }
    } catch {
      produced = false;
    }
    if (result.ok && produced) return { ok: true, converter };
    attempts.push(`${converter}: ${result.ok ? "no PNG output" : result.detail}`);
  }
  return { ok: false, error: `could not decode the ${format.toUpperCase()} image (${attempts.join("; ")})` };
}
