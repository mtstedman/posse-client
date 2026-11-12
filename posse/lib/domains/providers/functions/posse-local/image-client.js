// The local image provider's client: the same shape as the API providers'
// image clients, backed by a local model run through `posse local`.
import fs from "node:fs";
import { LOCAL_BRIDGE_MODELS } from "../../../../catalog/local-model.js";
import { LOCAL_MODEL_PARAMETERS } from "../../../../catalog/local-model-parameters.js";
import { IMAGE_MODEL_CHOICES_INTERNAL } from "../../../../catalog/provider-model-defaults.js";
import { runLocalGenerationInScratch } from "../../../../shared/native/functions/local-generation-child.js";

/** Local models that make an image from a prompt alone, in preference order. */
export function localImageProviderModels() {
  const ids = IMAGE_MODEL_CHOICES_INTERNAL["posse-local"] || [];
  return ids.map(id => LOCAL_BRIDGE_MODELS.find(model => model.modelId === id && model.kind === "image")).filter(Boolean);
}

/**
 * Width and height for a requested "WIDTHxHEIGHT" size, fitted to what the
 * model accepts: scaled down to its largest side and rounded to its multiple.
 * An absent or unreadable size yields nothing, so the saved defaults apply.
 */
export function localImageSize(size, model) {
  const match = /^\s*(\d{2,5})\s*x\s*(\d{2,5})\s*$/iu.exec(String(size || ""));
  if (!match) return {};
  const { width, height } = LOCAL_MODEL_PARAMETERS[model.modelId].parameters;
  const requested = [Number(match[1]), Number(match[2])];
  const scale = Math.min(1, width.max / requested[0], height.max / requested[1]);
  const fit = (value, limit) => Math.min(limit.max, Math.max(limit.min, Math.round(value * scale / limit.multiple) * limit.multiple));
  return { width: fit(requested[0], width), height: fit(requested[1], height) };
}

export function buildImageClient({ generate = runLocalGenerationInScratch } = {}) {
  return {
    images: {
      async generate(params = {}, { signal = null, timeoutMs } = {}) {
        const wanted = String(params.model || "").trim().toLowerCase();
        const model = localImageProviderModels().find(candidate => candidate.modelId === wanted || candidate.slug === wanted);
        if (!model) throw new Error(`${params.model || "(no model)"} is not a local image model`);
        if (params.format && params.format !== "png") throw new Error(`Local image models produce png, not ${params.format}`);
        let bytes = null;
        const outcome = await generate({
          slug: model.slug, format: "png", prompt: String(params.prompt || ""),
          parameters: localImageSize(params.size, model), timeoutMs, signal,
        }, (produced) => { bytes = fs.readFileSync(produced); });
        if (outcome.timedOut) throw Object.assign(new Error(`Local image generation timed out after ${Math.ceil(timeoutMs / 1000)}s`), { imageGenerationTimeout: true, code: "ETIMEDOUT" });
        if (!outcome.ok) throw new Error(outcome.detail || `posse local exited with code ${outcome.exitCode}`);
        if (!bytes?.length) throw new Error("the local image model reported success but wrote no image");
        return { data: [{ b64_json: bytes.toString("base64") }] };
      },
    },
  };
}
