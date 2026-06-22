import { normalizeGrokImageModelName } from "../model-catalog.js";

export function buildGrokImageGenerateParams(imageModel, args = {}, ext = ".png") {
  const normalizedImageModel = normalizeGrokImageModelName(imageModel);
  const isOpenAiImage = normalizedImageModel.startsWith("gpt-image");
  const normalizedQuality = ({ hd: "high", standard: "medium", low: "low" }[args.quality] || args.quality || "medium");
  if (isOpenAiImage) {
    const params = {
      model: normalizedImageModel,
      prompt: args.prompt,
      response_format: "b64_json",
      n: 1,
      size: args.size || "1024x1024",
      quality: normalizedQuality,
    };
    const formatMap = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp" };
    params.output_format = formatMap[ext] || "png";
    return { params, quality: normalizedQuality };
  }
  const params = {
    model: normalizedImageModel,
    prompt: args.prompt,
    n: 1,
    response_format: "b64_json",
  };
  const aspect = sizeToAspectRatio(args.size);
  if (aspect) params.aspect_ratio = aspect;
  const resolution = qualityToResolution(args.quality);
  if (resolution) params.resolution = resolution;
  return { params, quality: normalizedQuality };
}

function sizeToAspectRatio(size) {
  if (!size || typeof size !== "string") return null;
  const match = size.match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!w || !h) return null;
  if (w === h) return "1:1";
  if (w > h) {
    const ratio = w / h;
    if (Math.abs(ratio - 16 / 9) < 0.05) return "16:9";
    if (Math.abs(ratio - 4 / 3) < 0.05) return "4:3";
    if (Math.abs(ratio - 3 / 2) < 0.05) return "3:2";
    return "16:9";
  }
  const ratio = h / w;
  if (Math.abs(ratio - 16 / 9) < 0.05) return "9:16";
  if (Math.abs(ratio - 4 / 3) < 0.05) return "3:4";
  if (Math.abs(ratio - 3 / 2) < 0.05) return "2:3";
  return "9:16";
}

function qualityToResolution(quality) {
  const normalized = String(quality || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "hd" || normalized === "high") return "2k";
  if (normalized === "standard" || normalized === "medium" || normalized === "low" || normalized === "auto") return "1k";
  if (normalized === "1k" || normalized === "2k") return normalized;
  return null;
}

export function supportsReasoningEffort(modelName) {
  const normalized = String(modelName || "").trim().toLowerCase();
  return normalized === "grok-3-mini";
}

export function isUnsupportedReasoningError(err) {
  const msg = String(err?.message || err || "");
  return /does not support parameter reasoning(?:effort|\.effort)?/i.test(msg)
    || /unknown parameter reasoning(?:effort|\.effort)?/i.test(msg);
}
