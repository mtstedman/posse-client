import { parseArgs } from "node:util";

export const LOCAL_USAGE = `Usage:
  posse local list [--json] [--model-root DIR]
  posse local gpus [--json] [--model qwen-image]
  posse local install <slug> [--source DIR] [--model-root DIR]
  posse local --model <slug> [--prompt TEXT | --input FILE | stdin]
              [--format text|json|png|avi] [--output FILE|-] [--quiet]
              [--model-root DIR] [--runtime-root DIR]

Image options: --steps 20 --width 384 --height 384 --seed 42 --threads 8 --cfg-scale 2.5
               --negative-prompt TEXT --gpu [--gpu-id ID] [--gpu-memory-gb GiB]
Video options: --steps 20 --width 384 --height 384 --frames 56 --seed 42 --threads 8
               --gpu [--gpu-id ID] [--gpu-memory-gb GiB]
               H3: 24 fps, dimensions divisible by 32; frames 5, 22, 39, 56, 73 or 90.
Text options:  --max-tokens 512 --system TEXT

Slugs: qwen-code (text), qwen-image (image), minimax-h3 (video + audio); full model IDs also work.
--format json writes the complete native response (including media base64).
--format png writes PNG bytes; avi writes MJPEG video with PCM stereo audio. Use --output FILE or pipe stdout.
Output files must not already exist. Progress goes to stderr; --quiet suppresses it.
Network model installs require interactive size confirmation. --source installs
already-downloaded image/video files without a download. Generation never installs models.
CPU is the default. --gpu-id also enables GPU execution. Run gpus to copy an ID.
With multiple GPUs, --gpu opens a selector in a terminal; scripts need --gpu-id.
GPU selection uses one device with automatic GPU/RAM offloading and VRAM headroom.
--gpu-memory-gb caps VRAM use (GiB) and implies --gpu; it never raises the automatic budget.
Ctrl+C cancels generation and retires the native worker.`;

const stringFlags = ["model", "prompt", "input", "format", "output", "model-root", "runtime-root", "source",
  "frames", "steps", "width", "height", "seed", "threads", "cfg-scale", "negative-prompt", "max-tokens", "system", "gpu-id", "gpu-memory-gb"];
const booleanFlags = ["help", "json", "quiet", "non-interactive", "gpu"];
export function parseLocalOptions(argv) {
  const { values, positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true,
    options: Object.fromEntries([
      ...stringFlags.map(key => [key, { type: "string" }]),
      ...booleanFlags.map(key => [key, { type: "boolean", ...(key === "help" ? { short: "h" } : {}) }]),
    ]) });
  // parseArgs intentionally permits repeated flags; the bridge rejects ambiguity.
  const seen = new Set();
  for (const token of argv) {
    if (token === "--") break;
    if (!token.startsWith("--")) continue;
    const key = token.split("=")[0];
    if (seen.has(key)) throw new Error(`Repeated option: ${key}`);
    seen.add(key);
  }
  const action = positionals[0] || "generate";
  if (!["generate", "list", "install", "gpus"].includes(action)) throw new Error(`Unknown local action: ${action}`);
  if (positionals.length > (action === "install" ? 2 : 1)) throw new Error("Unexpected positional arguments; use --prompt TEXT.");
  const common = ["help", "quiet", "model-root", "non-interactive"];
  const allowed = new Set([...common, ...(action === "list" ? ["json", "format"] : action === "gpus" ? ["json", "format", "model", "runtime-root"] : action === "install" ? ["model", "source", "runtime-root"] : [...stringFlags.filter(x => x !== "source"), "gpu"])]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`--${key} is not valid for ${action}`);
  if (["list", "gpus"].includes(action) && values.format && values.format !== "json") throw new Error("List format must be json (or omit it for a table).");
  if (action === "install" && positionals[1] && values.model) throw new Error("Choose either an install slug or --model.");
  return { action, ...values, model: values.model || positionals[1] };
}

export function numericOption(args, key, fallback, min, max, multiple = 1) {
  const value = args[key] === undefined ? fallback : Number(args[key]);
  if (!Number.isFinite(value) || value < min || value > max || (multiple && (!Number.isInteger(value) || value % multiple))) {
    throw new Error(`--${key} must be ${multiple ? 'an integer' : 'a number'} from ${min} to ${max}${multiple > 1 ? ` in multiples of ${multiple}` : ''}`);
  }
  return value;
}
