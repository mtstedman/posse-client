import { parseArgs } from "node:util";
import { LOCAL_PARAMETER_FLAGS } from "../../../catalog/local-model-parameters.js";

export const LOCAL_USAGE = `Usage:
  posse local list [--json] [--model-root DIR]
  posse local gpus [--json] [--model qwen-image]
  posse local install <slug> [--source DIR] [--model-root DIR]
  posse local (--model <slug> | --kind text|code|image|video) [--prompt TEXT | --input FILE | stdin]
              [--parameters JSON]
              [--format text|json|png|avi] [--output FILE|-] [--quiet]
              [--model-root DIR] [--runtime-root DIR]

Image options: --steps 20 --width 384 --height 384 --seed 42 --threads 8 --cfg-scale 2.5
               --negative-prompt TEXT --gpu auto|on|off [--gpu-id ID] [--gpu-memory-gb GiB]
Video options: --steps 20 --width 384 --height 384 --frames 56 --seed 42 --threads 8
               --gpu auto|on|off [--gpu-id ID] [--gpu-memory-gb GiB]
               H3: 24 fps, dimensions divisible by 32; frames 5, 22, 39, 56, 73 or 90.
               --first-frame IMAGE.png | --continue-from PREVIOUS.avi
               continueFrom generates from the last frame and stitches the clips (FFmpeg required).
Text options:  --max-tokens 512 --system TEXT
               Writing models also take --temperature --top-p --top-k --seed.

--kind uses the default model for that kind of work, set in Admin: Local models
(automatic: the best one installed).
Model parameters: posse local --model <slug> --help
Pass model-specific settings as strict JSON: --parameters '{"width":384,"height":384}'
Existing flags also work; supplying a setting in both places is an error.

Slugs: qwen-code, gemma-12b, mistral-small, gemma-31b (text), qwen-image (image), minimax-h3 (video + audio); full model IDs also work.
--format json writes the complete native response (including media base64).
--format png writes PNG bytes; avi writes MJPEG video with PCM stereo audio. Use --output FILE or pipe stdout.
Output files must not already exist. Progress goes to stderr; --quiet suppresses it.
Network model installs require interactive size confirmation. --source installs
already-downloaded image/video files without a download. Generation never installs models.
GPU mode defaults to auto: use a compatible GPU if available, otherwise CPU.
Auto chooses the GPU with the most free VRAM. --gpu on requires a compatible GPU;
--gpu off forces CPU. Bare --gpu is an alias for --gpu on.
--gpu-id and --gpu-memory-gb require GPU execution and conflict with --gpu off.
With multiple GPUs, on opens a selector in a terminal; scripts need --gpu-id.
GPU selection uses one device with automatic GPU/RAM offloading and VRAM headroom.
--gpu-memory-gb caps VRAM use (GiB) and implies --gpu; it never raises the automatic budget.
Ctrl+C cancels generation and retires the native worker.`;

const stringFlags = ["model", "kind", "prompt", "input", "format", "output", "model-root", "runtime-root", "source", "parameters",
  ...Object.keys(LOCAL_PARAMETER_FLAGS)];
const booleanFlags = ["help", "json", "quiet", "non-interactive"];
export function parseLocalOptions(argv) {
  // Preserve the existing bare --gpu spelling without rewriting flag values.
  const normalized = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--") { normalized.push(...argv.slice(index)); break; }
    if (token === "--gpu" && (argv[index + 1] === undefined || argv[index + 1].startsWith("-"))) {
      normalized.push("--gpu=on");
    } else {
      normalized.push(token);
      if (stringFlags.includes(token.slice(2)) && token.startsWith("--") && argv[index + 1] !== undefined) normalized.push(argv[++index]);
    }
  }
  const { values, positionals, tokens } = parseArgs({ args: normalized, strict: true, allowPositionals: true, tokens: true,
    options: Object.fromEntries([
      ...stringFlags.map(key => [key, { type: "string" }]),
      ...booleanFlags.map(key => [key, { type: "boolean", ...(key === "help" ? { short: "h" } : {}) }]),
    ]) });
  // parseArgs intentionally permits repeated flags; the bridge rejects ambiguity.
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    const key = `--${token.name}`;
    if (seen.has(key)) throw new Error(`Repeated option: ${key}`);
    seen.add(key);
  }
  const action = positionals[0] || "generate";
  if (!["generate", "list", "install", "gpus"].includes(action)) throw new Error(`Unknown local action: ${action}`);
  if (positionals.length > (action === "install" ? 2 : 1)) throw new Error("Unexpected positional arguments; use --prompt TEXT.");
  const common = ["help", "quiet", "model-root", "non-interactive"];
  const allowed = new Set([...common, ...(action === "list" ? ["json", "format"] : action === "gpus" ? ["json", "format", "model", "runtime-root"] : action === "install" ? ["model", "source", "runtime-root"] : stringFlags.filter(x => x !== "source"))]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`--${key} is not valid for ${action}`);
  if (["list", "gpus"].includes(action) && values.format && values.format !== "json") throw new Error("List format must be json (or omit it for a table).");
  if (action === "install" && positionals[1] && values.model) throw new Error("Choose either an install slug or --model.");
  return { action, ...values, model: values.model || positionals[1] };
}
