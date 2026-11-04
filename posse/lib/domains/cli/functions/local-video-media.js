import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const MAX_CONTINUATION_BYTES = 256 * 1024 ** 2;
export const MAX_FIRST_FRAME_BYTES = 4 * 1024 ** 2;
export const MAX_CONTINUATION_FRAMES = 14400;

export async function runVideoTool(tool, args, signal) {
  signal?.throwIfAborted();
  const operation = execute(tool, args, { signal, timeout: 120000, maxBuffer: 1024 ** 2,
    encoding: "utf8", windowsHide: true, killSignal: "SIGKILL" });
  // Abort can reject execFile before the process closes. Wait for closure
  // before callers remove its temporary output files (especially on Windows).
  const closed = new Promise(resolve => operation.child.once("close", resolve));
  try {
    return (await operation).stdout;
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === "ENOENT") throw new Error("Video continuation requires ffmpeg and ffprobe on PATH. Install FFmpeg, then retry.", { cause: error });
    throw new Error(`${tool} failed: ${String(error.stderr || error.message).slice(-4000)}`, { cause: error });
  } finally { await closed; }
}

export async function readBoundedMedia(file, maxBytes) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error(`Media input must be a regular file of at most ${maxBytes} bytes.`);
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== stat.size) throw new Error("Media input changed while being read.");
    return bytes.subarray(0, used);
  } finally { await handle.close(); }
}

export function firstFrameDimensions(bytes) {
  if (bytes.length < 33 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString() !== "IHDR") throw new Error("firstFrame must be a PNG file.");
  return validateDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function validateDimensions(width, height) {
  if (![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 1024 && value % 32 === 0)) {
    throw new Error("Video input dimensions must be multiples of 32 from 64 to 1024.");
  }
  return { width, height };
}

export async function inspectContinuation(file, signal) {
  const probe = JSON.parse(await runVideoTool("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-f", "avi", "-count_frames",
    "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames,sample_rate,channels", "-of", "json", file], signal));
  const streams = probe.streams || [];
  const video = streams.find(stream => stream.codec_type === "video"), audio = streams.find(stream => stream.codec_type === "audio");
  if (streams.length !== 2 || video?.codec_name !== "mjpeg" || video.r_frame_rate !== "24/1"
    || audio?.codec_name !== "pcm_s16le" || audio.sample_rate !== "32000" || audio.channels !== 2) {
    throw new Error("continueFrom requires a Posse AVI with 24 fps MJPEG video and 32 kHz stereo PCM audio.");
  }
  const frames = Number(video.nb_read_frames);
  if (!Number.isSafeInteger(frames) || frames < 2 || frames > MAX_CONTINUATION_FRAMES) throw new Error("Continuation video must have 2..14400 decodable frames (at most ten minutes).");
  return { ...validateDimensions(video.width, video.height), frames };
}

export function requireFirstFrameCapability(capability) {
  const input = capability?.inputs?.firstFrame;
  if (!Array.isArray(input?.mimeTypes) || !input.mimeTypes.includes("image/png") || input.dimensionPolicy !== "match-output"
    || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < MAX_FIRST_FRAME_BYTES) {
    throw new Error("This native runtime does not support H3 first-frame conditioning. Update posse-ml before using firstFrame or continueFrom.");
  }
}
