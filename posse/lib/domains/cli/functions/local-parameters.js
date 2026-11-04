import { LOCAL_BRIDGE_MODELS } from "../../../catalog/local-model.js";
import { LOCAL_MODEL_PARAMETERS, LOCAL_PARAMETER_FLAGS } from "../../../catalog/local-model-parameters.js";

export function resolveLocalModel(name) {
  const model = LOCAL_BRIDGE_MODELS.find(candidate => candidate.slug === name || candidate.modelId === name);
  if (!model) throw new Error(`Choose a supported model with --model <slug>. Available: ${LOCAL_BRIDGE_MODELS.map(candidate => candidate.slug).join(", ")}. Run posse local list.`);
  return model;
}

function parameterConstraints(parameter) {
  const parts = [parameter.type];
  if (parameter.choices) parts.push(`choices: ${parameter.choices.join(", ")}`);
  if (parameter.min !== undefined) parts.push(`${parameter.min}..${parameter.max}`);
  if (parameter.multiple > 1) parts.push(`multiple of ${parameter.multiple}`);
  if (parameter.maxBytes) parts.push(`at most ${parameter.maxBytes} UTF-8 bytes`);
  if (parameter.pattern) parts.push(`pattern: ${parameter.pattern}`);
  if (parameter.type === "string") parts.push("NUL-free");
  return parts.join("; ");
}

function validateParameter(key, value, parameter) {
  const number = parameter.type === "integer" || parameter.type === "number";
  const validType = number ? typeof value === "number" && Number.isFinite(value)
    && (parameter.type !== "integer" || Number.isInteger(value)) : typeof value === parameter.type;
  if (!validType
    || (parameter.min !== undefined && (value < parameter.min || value > parameter.max))
    || (parameter.multiple && value % parameter.multiple !== 0)
    || (parameter.choices && !parameter.choices.includes(value))
    || (typeof value === "string" && (value.includes("\0")
      || (parameter.maxBytes && Buffer.byteLength(value) > parameter.maxBytes)
      || (parameter.pattern && !new RegExp(parameter.pattern).test(value))))) {
    throw new Error(`Parameter ${key} (--${parameter.flag}) must be ${parameterConstraints(parameter)}.`);
  }
}

// Resolve JSON and legacy flags together, before reading stdin or loading ML.
export function resolveLocalParameters(model, args) {
  const schema = LOCAL_MODEL_PARAMETERS[model.modelId].parameters;
  let supplied = {};
  if (args.parameters !== undefined) {
    try { supplied = JSON.parse(args.parameters); }
    catch { throw new Error('--parameters must be a JSON object with double-quoted keys, e.g. \'{"width":384,"height":384}\'.'); }
    if (supplied === null || typeof supplied !== "object" || Array.isArray(supplied)) {
      throw new Error("--parameters must be a JSON object.");
    }
  }
  for (const key of Object.keys(supplied)) {
    if (!Object.hasOwn(schema, key)) throw new Error(`Unsupported parameter ${JSON.stringify(key)} for ${model.slug}. Run posse local --model ${model.slug} --help.`);
  }
  const allowedFlags = new Set(Object.values(schema).map(parameter => parameter.flag));
  for (const flag of Object.keys(LOCAL_PARAMETER_FLAGS)) {
    if (args[flag] !== undefined && !allowedFlags.has(flag)) throw new Error(`--${flag} does not apply to ${model.slug}.`);
  }
  const parameters = {}, resolvedArgs = { ...args };
  for (const [key, parameter] of Object.entries(schema)) {
    const fromJson = Object.hasOwn(supplied, key), fromFlag = args[parameter.flag] !== undefined;
    if (fromJson && fromFlag) throw new Error(`Parameter ${key} was supplied in both --parameters and --${parameter.flag}; choose one.`);
    let value = fromJson ? supplied[key] : fromFlag ? args[parameter.flag] : parameter.default;
    if (fromFlag && ["integer", "number"].includes(parameter.type)) {
      value = String(value).trim() === "" ? NaN : Number(value);
    }
    if (value === undefined) continue;
    validateParameter(key, value, parameter);
    parameters[key] = value;
    if (fromJson || fromFlag) resolvedArgs[parameter.flag] = value;
  }
  if (parameters.gpu === "off" && (parameters.gpuId !== undefined || parameters.gpuMemoryGiB !== undefined)) {
    throw new Error("--gpu off conflicts with gpuId (--gpu-id) and gpuMemoryGiB (--gpu-memory-gb).");
  }
  if (parameters.firstFrame !== undefined && parameters.continueFrom !== undefined) {
    throw new Error("Use firstFrame (--first-frame) or continueFrom (--continue-from), not both.");
  }
  return { parameters, args: resolvedArgs };
}

export function localModelHelp(model) {
  const profile = LOCAL_MODEL_PARAMETERS[model.modelId];
  const lines = [
    `Usage: posse local --model ${model.slug} [--prompt TEXT | --input FILE | stdin]`,
    "             [--parameters JSON] [--format FORMAT] [--output FILE|-] [--quiet]",
    "             [--model-root DIR] [--runtime-root DIR] [--non-interactive]",
    "", `Model: ${model.modelId}`, profile.behavior,
    `Formats: ${model.formats.join(", ")}; default: ${model.formats[0]}.`,
    "", "Supported parameters (JSON keys are case-sensitive):",
  ];
  for (const [key, parameter] of Object.entries(profile.parameters)) {
    lines.push(`  ${key}: ${parameterConstraints(parameter)}${parameter.default !== undefined ? `; default: ${JSON.stringify(parameter.default)}` : "; optional"}`,
      `    --${parameter.flag}${parameter.description ? ` — ${parameter.description}` : ""}`);
  }
  lines.push("", "Use strict JSON, with double-quoted keys and string values. Existing flags also work;",
    "do not supply the same parameter through both JSON and a flag.",
    "Prompt text is supplied separately with --prompt, --input or stdin.",
    "Steps are sampling iterations, not conversation turns. Run posse local --help for shared options.");
  return lines.join("\n");
}
