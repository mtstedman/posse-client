// CLI contracts for the shipped native profiles. Native request validation
// remains authoritative; do not list features that the adapter cannot execute.
import { QWEN_LOCAL_MODEL_ID, QWEN_IMAGE_MODEL_ID, MINIMAX_H3_MODEL_ID } from "./local-model.js";

const integer = (flag, defaultValue, min, max, multiple = 1) => Object.freeze({
  flag, type: "integer", default: defaultValue, min, max, multiple,
});
const media = {
  steps: integer("steps", 20, 1, 50),
  seed: integer("seed", 42, 0, 4294967295),
  threads: integer("threads", 8, 1, 32),
  gpu: Object.freeze({ flag: "gpu", type: "string", default: "auto", choices: Object.freeze(["auto", "on", "off"]), description: "Auto uses a compatible GPU when available, otherwise CPU; on requires a GPU; off uses CPU." }),
  gpuId: Object.freeze({ flag: "gpu-id", type: "string", pattern: "^[A-Za-z0-9:_.-]{1,256}$", description: "Exact ID from posse local gpus; enables GPU execution." }),
  gpuMemoryGiB: Object.freeze({ flag: "gpu-memory-gb", type: "number", min: 0.25, max: 1024, description: "Cap VRAM in GiB; enables GPU execution and only lowers the automatic budget." }),
};

export const LOCAL_MODEL_PARAMETERS = Object.freeze({
  [QWEN_LOCAL_MODEL_ID]: Object.freeze({
    parameters: Object.freeze({
      maxOutputTokens: integer("max-tokens", 512, 1, 4096),
      system: Object.freeze({ flag: "system", type: "string", maxBytes: 262144, description: "Optional system prompt." }),
    }),
    behavior: "Text input and output; independent requests with greedy decoding. No conversation history or media inputs.",
  }),
  [QWEN_IMAGE_MODEL_ID]: Object.freeze({
    parameters: Object.freeze({
      width: integer("width", 384, 64, 1024, 16),
      height: integer("height", 384, 64, 1024, 16),
      ...media,
      cfgScale: Object.freeze({ flag: "cfg-scale", type: "number", default: 2.5, min: 1, max: 10 }),
      negativePrompt: Object.freeze({ flag: "negative-prompt", type: "string", default: "", maxBytes: 8192 }),
    }),
    behavior: "Text input to PNG; independent requests. No image/video/audio inputs or iterative editing. Sampler: Euler; flow shift: 3.",
  }),
  [MINIMAX_H3_MODEL_ID]: Object.freeze({
    parameters: Object.freeze({
      width: integer("width", 384, 64, 1024, 32),
      height: integer("height", 384, 64, 1024, 32),
      frames: Object.freeze({ flag: "frames", type: "integer", default: 56, choices: Object.freeze([5, 22, 39, 56, 73, 90]) }),
      firstFrame: Object.freeze({ flag: "first-frame", type: "string", pattern: "\\S", maxBytes: 4096, description: "Opaque PNG file to use as the first frame; inherits its dimensions. Explicit width/height must match." }),
      continueFrom: Object.freeze({ flag: "continue-from", type: "string", pattern: "\\S", maxBytes: 4096, description: "Previous Posse AVI: use its last frame, generate a segment, then stitch into one AVI. Requires ffmpeg and ffprobe; cannot combine with firstFrame." }),
      ...media,
    }),
    behavior: "Text and optional first-frame PNG input to AVI with generated 32 kHz stereo audio. continueFrom uses the prior AVI's final frame and stitches the continuation. No motion-history or audio conditioning, last-frame target or silent output. Fixed: 24 fps, CFG 1, Euler sampler, flow shift 12.",
  }),
});

export const LOCAL_PARAMETER_FLAGS = Object.freeze(Object.fromEntries(
  Object.values(LOCAL_MODEL_PARAMETERS).flatMap(profile => Object.values(profile.parameters)
    .map(parameter => [parameter.flag, parameter.type === "boolean" ? "boolean" : "string"])),
));
