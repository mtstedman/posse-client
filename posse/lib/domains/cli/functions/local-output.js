import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export async function readLocalPrompt(args, input, maxBytes) {
  if (args.prompt !== undefined && args.input !== undefined) throw new Error("Use --prompt or --input, not both.");
  let text;
  if (args.prompt !== undefined) text = args.prompt;
  else if (args.input && args.input !== "-") {
    const file = await fs.open(args.input, "r");
    try {
      if ((await file.stat()).size > maxBytes) throw new Error(`Prompt exceeds ${maxBytes} bytes.`);
      const bytes = Buffer.alloc(maxBytes + 1);
      let used = 0;
      while (used < bytes.length) {
        const result = await file.read(bytes, used, bytes.length - used, null);
        if (!result.bytesRead) break;
        used += result.bytesRead;
      }
      if (used > maxBytes) throw new Error(`Prompt exceeds ${maxBytes} bytes.`);
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
    } finally { await file.close(); }
  } else {
    if (input.isTTY) throw new Error("Provide --prompt TEXT, --input FILE, or pipe a prompt on stdin.");
    const chunks = []; let size = 0;
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > maxBytes) throw new Error(`Prompt exceeds ${maxBytes} bytes.`);
      chunks.push(bytes);
    }
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  }
  if (!text.trim() || text.includes("\0") || Buffer.byteLength(text) > maxBytes) throw new Error(`Prompt must be nonempty, NUL-free, and at most ${maxBytes} bytes.`);
  return text;
}

export async function checkLocalOutput(destination, format, stdout) {
  if (!destination || destination === "-") {
    if (["png", "avi"].includes(format) && stdout.isTTY) throw new Error(`${format.toUpperCase()} output needs --output FILE or redirected stdout.`);
    return;
  }
  try { await fs.lstat(destination); } catch (error) {
    if (error.code === "ENOENT") {
      const parent = await fs.stat(path.dirname(path.resolve(destination)));
      if (!parent.isDirectory()) throw new Error("Output parent is not a directory.");
      return;
    }
    throw error;
  }
  throw new Error(`Output already exists: ${destination}`);
}

export function encodeLocalOutput(result, model, format) {
  if (!result || result.modelId !== model.modelId) throw new Error("Native response model does not match the request.");
  let png, avi;
  if (model.kind === "image") {
    const image = result.image;
    if (image?.mimeType !== "image/png" || typeof image.base64 !== "string") throw new Error("Native response is missing PNG output.");
    png = Buffer.from(image.base64, "base64");
    if (png.toString("base64") !== image.base64 || png.length < 33
      || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
      || png.subarray(12, 16).toString() !== "IHDR"
      || png.readUInt32BE(16) !== image.width || png.readUInt32BE(20) !== image.height
      || png.length !== image.bytes || createHash("sha256").update(png).digest("hex") !== image.sha256) {
      throw new Error("Native PNG failed integrity validation.");
    }
  } else if (model.kind === "video") {
    const video = result.video;
    if (video?.mimeType !== "video/x-msvideo" || typeof video.base64 !== "string" || video.base64.length > Math.ceil(40 * 1024 ** 2 / 3) * 4) throw new Error("Native response is missing or exceeds bounded AVI output.");
    avi = Buffer.from(video.base64, "base64");
    if (avi.toString("base64") !== video.base64 || avi.length < 12
      || avi.subarray(0, 4).toString() !== "RIFF" || avi.subarray(8, 12).toString() !== "AVI "
      || avi.readUInt32LE(4) + 8 !== avi.length || avi.length !== video.bytes
      || video.fps !== 24 || ![5,22,39,56,73,90].includes(video.frames)
      || !Number.isInteger(video.width) || video.width < 64 || video.width > 1024 || video.width % 32
      || !Number.isInteger(video.height) || video.height < 64 || video.height > 1024 || video.height % 32
      || video.audio?.sampleRate !== 32000 || video.audio?.channels !== 2 || video.audio?.codec !== "pcm_s16le"
      || createHash("sha256").update(avi).digest("hex") !== video.sha256) {
      throw new Error("Native AVI failed integrity validation.");
    }
  } else if (typeof result.content !== "string") throw new Error("Native response is missing generated text.");
  if (format === "json") return Buffer.from(JSON.stringify(result) + "\n");
  if (format === "png") return png;
  if (format === "avi") return avi;
  return Buffer.from(result.content + (result.content.endsWith("\n") ? "" : "\n"));
}

export async function writeLocalOutput(bytes, destination, stdout) {
  if (!destination || destination === "-") {
    await new Promise((resolve, reject) => stdout.write(bytes, error => error ? reject(error) : resolve()));
    return;
  }
  const target = path.resolve(destination);
  const temporary = path.join(path.dirname(target), `.posse-output-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    // Publish only complete output, without replacing an existing file or symlink.
    await fs.link(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}
