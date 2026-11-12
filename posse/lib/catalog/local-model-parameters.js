// CLI contracts for the shipped native profiles. Native request validation
// remains authoritative; do not list features that the adapter cannot execute.
import { LOCAL_BRIDGE_MODELS, LOCAL_DEFAULT_MODELS, LOCAL_MODEL_IDS, LOCAL_MODEL_PROFILES, QWEN_LOCAL_MODEL_ID, QWEN_IMAGE_MODEL_ID, MINIMAX_H3_MODEL_ID } from "./local-model.js";

const integer = (flag, defaultValue, min, max, multiple = 1) => Object.freeze({
  flag, type: "integer", default: defaultValue, min, max, multiple,
});
const STEPS = Object.freeze({ default: 20, min: 1, max: 50 });
// Admin replaces this default for a model kind; --steps still wins for one run.
const steps = defaultSetting => Object.freeze({
  ...integer("steps", STEPS.default, STEPS.min, STEPS.max),
  defaultSetting,
  description: "Sampling iterations. Change the default in Admin: Providers > Local Models.",
});
const stepSetting = (key, kind) => Object.freeze({
  key, default: String(STEPS.default),
  numeric: Object.freeze({ integer: true, min: STEPS.min, max: STEPS.max }),
  description: `Default sampling steps for posse local ${kind} generation; --steps overrides it for one run.`,
});
const IMAGE_STEPS_SETTING = "posse_local_image_steps";
const VIDEO_STEPS_SETTING = "posse_local_video_steps";

const STEP_SETTINGS = [stepSetting(IMAGE_STEPS_SETTING, "image"), stepSetting(VIDEO_STEPS_SETTING, "video")];

const media = {
  seed: integer("seed", 42, 0, 4294967295),
  threads: integer("threads", 8, 1, 32),
  gpu: Object.freeze({ flag: "gpu", type: "string", default: "auto", choices: Object.freeze(["auto", "on", "off"]), description: "Auto uses a compatible GPU when available, otherwise CPU; on requires a GPU; off uses CPU." }),
  gpuId: Object.freeze({ flag: "gpu-id", type: "string", pattern: "^[A-Za-z0-9:_.-]{1,256}$", description: "Exact ID from posse local gpus; enables GPU execution." }),
  gpuMemoryGiB: Object.freeze({ flag: "gpu-memory-gb", type: "number", min: 0.25, max: 1024, description: "Cap VRAM in GiB; enables GPU execution and only lowers the automatic budget." }),
};

const number = (flag, defaultValue, min, max, description) => Object.freeze({
  flag, type: "number", default: defaultValue, min, max, description,
});
// Writing profiles sample by default, using each model's recommended settings.
const writingProfile = modelId => {
  const { maxOutputTokens, sampling } = LOCAL_MODEL_PROFILES[modelId];
  return Object.freeze({
    parameters: Object.freeze({
      maxOutputTokens: integer("max-tokens", 1024, 1, maxOutputTokens),
      system: Object.freeze({ flag: "system", type: "string", maxBytes: 262144, description: "Optional system prompt." }),
      temperature: number("temperature", sampling.temperature, 0.01, 2, "Sampling temperature; lower is more literal."),
      topP: number("top-p", sampling.topP, 0.01, 1, "Nucleus sampling cutoff."),
      topK: integer("top-k", sampling.topK, 1, 1000),
      seed: Object.freeze({ flag: "seed", type: "integer", min: 0, max: 4294967295, description: "Optional; repeat a sampled result." }),
    }),
    behavior: "Text input and output; independent requests with sampled decoding. No conversation history or media inputs.",
  });
};

const MODEL_PARAMETER_TABLE = Object.freeze({
  ...Object.fromEntries(LOCAL_MODEL_IDS.filter(modelId => LOCAL_MODEL_PROFILES[modelId].sampling)
    .map(modelId => [modelId, writingProfile(modelId)])),
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
      steps: steps(IMAGE_STEPS_SETTING),
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
      steps: steps(VIDEO_STEPS_SETTING),
      ...media,
    }),
    behavior: "Text and optional first-frame PNG input to AVI with generated 32 kHz stereo audio. continueFrom uses the prior AVI's final frame and stitches the continuation. No motion-history or audio conditioning, last-frame target or silent output. Fixed: 24 fps, CFG 1, Euler sampler, flow shift 12.",
  }),
});

// Every knob with a built-in default gets a saved default the operator can
// change in Admin (Local models). Free-text inputs and device selection stay
// per-run. A flag still wins for one run.
const settingName = (slug, key) => `posse_local_${slug.replace(/-/g, "_")}_${key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`;
const knobLabel = key => key.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`).replace(/^./, letter => letter.toUpperCase());
const constraint = parameter => parameter.choices ? `one of ${parameter.choices.join(", ")}`
  : `${parameter.min} to ${parameter.max}${parameter.multiple > 1 ? `, a multiple of ${parameter.multiple}` : ""}`;

function knobSetting(model, key, parameter) {
  const numeric = !parameter.choices && ["integer", "number"].includes(parameter.type);
  return Object.freeze({
    key: settingName(model.slug, key), default: String(parameter.default), label: knobLabel(key),
    ...(numeric ? { numeric: Object.freeze({ integer: parameter.type === "integer", min: parameter.min, max: parameter.max }) }
      : { options: Object.freeze(parameter.choices.map(String)) }),
    description: `Default ${knobLabel(key).toLowerCase()} for ${model.slug} (${constraint(parameter)}); --${parameter.flag} overrides it for one run.${parameter.description ? ` ${parameter.description}` : ""}`,
  });
}

const knobSettings = [];
export const LOCAL_MODEL_PARAMETERS = Object.freeze(Object.fromEntries(LOCAL_BRIDGE_MODELS.map((model) => {
  const profile = MODEL_PARAMETER_TABLE[model.modelId];
  const parameters = Object.fromEntries(Object.entries(profile.parameters).map(([key, parameter]) => {
    const tunable = parameter.default !== undefined && !parameter.defaultSetting
      && (parameter.choices || ["integer", "number"].includes(parameter.type));
    if (!tunable) return [key, parameter];
    const setting = knobSetting(model, key, parameter);
    knobSettings.push(setting);
    return [key, Object.freeze({ ...parameter, defaultSetting: setting.key })];
  }));
  return [model.modelId, Object.freeze({ ...profile, parameters: Object.freeze(parameters) })];
})));

// Limits a text model works within when it runs as an agent or provider. The
// built-in value is also the ceiling: the native runtime refuses more.
const agentLimit = (model, key, label, min, max, description) => Object.freeze({
  key: settingName(model.slug, key), default: String(max), label,
  numeric: Object.freeze({ integer: true, min, max }),
  description: `${description} for ${model.slug} (${min} to ${max}).`,
  modelId: model.modelId, limit: key,
});
export const LOCAL_AGENT_LIMIT_SETTINGS = Object.freeze(LOCAL_BRIDGE_MODELS.filter(model => model.kind === "text").flatMap((model) => {
  const profile = LOCAL_MODEL_PROFILES[model.modelId];
  return [
    agentLimit(model, "agentMaxOutputTokens", "Agent reply length (tokens)", 64, profile.maxOutputTokens, "Longest single reply or tool call an agent turn may produce"),
    agentLimit(model, "agentMaxToolTurns", "Agent tool turns", 1, profile.maxToolTurns, "Tool turns one job dispatch may take"),
    agentLimit(model, "agentMaxToolResultChars", "Tool result size (characters)", 1000, profile.maxToolResultChars, "Most characters of one tool result shown to the model"),
  ];
}));

export const LOCAL_DEFAULT_MODEL_SETTINGS = Object.freeze(LOCAL_DEFAULT_MODELS.map(entry => Object.freeze({
  key: entry.key, default: "", label: entry.label, options: Object.freeze(["", ...entry.candidates]),
  description: `Local ${entry.kind} model to use when a request does not name one. Automatic picks the first installed of: ${entry.candidates.join(", ")}; none when nothing is installed.`,
})));

/** Saved defaults for one model, in the order Admin lists them. */
export function localModelSettingKeys(model) {
  const parameters = LOCAL_MODEL_PARAMETERS[model.modelId].parameters;
  return [
    ...Object.values(parameters).map(parameter => parameter.defaultSetting).filter(Boolean),
    ...LOCAL_AGENT_LIMIT_SETTINGS.filter(setting => setting.modelId === model.modelId).map(setting => setting.key),
  ];
}

export const LOCAL_MODEL_SETTINGS = Object.freeze([
  ...STEP_SETTINGS, ...knobSettings, ...LOCAL_AGENT_LIMIT_SETTINGS, ...LOCAL_DEFAULT_MODEL_SETTINGS,
]);

export const LOCAL_PARAMETER_FLAGS = Object.freeze(Object.fromEntries(
  Object.values(LOCAL_MODEL_PARAMETERS).flatMap(profile => Object.values(profile.parameters)
    .map(parameter => [parameter.flag, parameter.type === "boolean" ? "boolean" : "string"])),
));
