import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { MAX_CONTINUATION_BYTES, MAX_CONTINUATION_FRAMES, MAX_FIRST_FRAME_BYTES,
  readBoundedMedia, firstFrameDimensions, inspectContinuation, runVideoTool } from "../functions/local-video-media.js";

// Owns private input snapshots and intermediate media for one generation call.
export class LocalVideoContinuation {
  constructor(root, signal) { this.root = root; this.signal = signal; }

  static async prepare(parameters, args, signal) {
    const context = new LocalVideoContinuation(await fs.mkdtemp(path.join(os.tmpdir(), "posse-video-")), signal);
    try {
      let png, dimensions;
      if (parameters.continueFrom !== undefined) {
        const bytes = await readBoundedMedia(parameters.continueFrom, MAX_CONTINUATION_BYTES);
        context.source = path.join(context.root, "previous.avi");
        await fs.writeFile(context.source, bytes, { flag: "wx", mode: 0o600 });
        context.previous = await inspectContinuation(context.source, signal);
        if (context.previous.frames + parameters.frames - 1 > MAX_CONTINUATION_FRAMES) throw new Error("Stitched video would exceed ten minutes.");
        dimensions = context.previous;
        const frame = path.join(context.root, "first.png");
        await runVideoTool("ffmpeg", ["-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-f", "avi", "-i", context.source,
          "-map", "0:v:0", "-vf", `select=eq(n\\,${dimensions.frames - 1}),format=rgb24`, "-frames:v", "1", "-threads", "1", frame], signal);
        png = await readBoundedMedia(frame, MAX_FIRST_FRAME_BYTES);
      } else {
        png = await readBoundedMedia(parameters.firstFrame, MAX_FIRST_FRAME_BYTES);
        dimensions = firstFrameDimensions(png);
      }
      for (const axis of ["width", "height"]) {
        if (args[axis] !== undefined && parameters[axis] !== dimensions[axis]) throw new Error(`${axis} must match the input frame (${dimensions[axis]}). Omit it to inherit the input dimensions.`);
      }
      context.width = dimensions.width;
      context.height = dimensions.height;
      const decoded = firstFrameDimensions(png);
      if (decoded.width !== context.width || decoded.height !== context.height) throw new Error("Extracted frame dimensions do not match the video.");
      context.firstFrame = { mimeType: "image/png", base64: png.toString("base64") };
      signal?.throwIfAborted();
      return context;
    } catch (error) { await context.dispose(); throw error; }
  }

  async stitch(result, generatedAvi, format) {
    this.signal?.throwIfAborted();
    const next = path.join(this.root, "next.avi"), output = path.join(this.root, "stitched.avi");
    await fs.writeFile(next, generatedAvi, { flag: "wx", mode: 0o600 });
    const generated = await inspectContinuation(next, this.signal);
    if (generated.width !== this.width || generated.height !== this.height || generated.frames !== result.video.frames) throw new Error("Generated segment does not match the continuation request.");
    const priorFrames = this.previous.frames, addedFrames = generated.frames - 1, totalFrames = priorFrames + addedFrames;
    const priorSamples = Math.floor(priorFrames * 32000 / 24), nextSamples = Math.floor(addedFrames * 32000 / 24);
    // Remove the repeated boundary frame and its audio interval. Bound/pad each
    // soundtrack to its video duration so an H3 audio tail cannot shift the join.
    const filter = `[0:v]setpts=N/(24*TB)[v0];[1:v]trim=start_frame=1,setpts=N/(24*TB)[v1];`
      + `[0:a]apad=whole_len=${priorSamples},atrim=end_sample=${priorSamples},asetpts=PTS-STARTPTS[a0];`
      + `[1:a]atrim=start_sample=1333,apad=whole_len=${nextSamples},atrim=end_sample=${nextSamples},asetpts=PTS-STARTPTS[a1];`
      + "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]";
    await runVideoTool("ffmpeg", ["-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-f", "avi", "-i", this.source,
      "-protocol_whitelist", "file,pipe", "-f", "avi", "-i", next, "-filter_complex_threads", "1", "-filter_complex", filter,
      "-map", "[v]", "-map", "[a]", "-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj420p", "-r", "24", "-threads", "1",
      "-c:a", "pcm_s16le", "-ar", "32000", "-ac", "2", "-fs", String(MAX_CONTINUATION_BYTES), output], this.signal);
    const bytes = await readBoundedMedia(output, MAX_CONTINUATION_BYTES);
    const stitched = await inspectContinuation(output, this.signal);
    if (stitched.frames !== totalFrames || stitched.width !== this.width || stitched.height !== this.height) throw new Error("Stitched output is incomplete or has unexpected dimensions.");
    this.signal?.throwIfAborted();
    if (format === "avi") return bytes;
    return Buffer.from(JSON.stringify({ ...result,
      video: { ...result.video, frames: totalFrames, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") },
      continuation: { sourceFrames: priorFrames, generatedFrames: generated.frames, appendedFrames: addedFrames, droppedBoundaryFrames: 1 },
    }) + "\n");
  }

  async dispose() { await fs.rm(this.root, { recursive: true, force: true }); }
}
