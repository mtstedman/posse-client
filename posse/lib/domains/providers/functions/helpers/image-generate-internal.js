import fs from "fs";
import path from "path";
import { getArtifactProtocol, getResolvedImageProtocol } from "../../../artifacts/functions/index.js";
import { getDefaultImageModel, getDefaultImageProvider, normalizeGrokImageModelName } from "../model-catalog.js";

export { TOOL_GENERATE_IMAGE } from "../../../integrations/functions/deterministic-mcp/tool-descriptors.js";

const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 600_000;

// Each image-capable provider owns construction of its OpenAI-shaped client
// (env vars, baseURL, retry config). Import provider builders lazily so this
// shared helper can be imported by those same provider modules without a
// startup cycle.
async function _buildImageClient(providerName) {
  const provider = String(providerName || "").trim().toLowerCase();
  const mod = provider === "openai"
    ? await import("../openai.js")
    : provider === "grok"
      ? await import("../grok.js")
      : null;
  const build = mod?.buildImageClient;
  if (typeof build !== "function") {
    throw new Error(`Provider "${providerName}" does not support image generation.`);
  }
  return build();
}

function _buildOpenAiParams(model, args, ext) {
  const isGptImage = String(model || "").startsWith("gpt-image");
  const quality = isGptImage
    ? ({ hd: "high", standard: "medium", low: "low" }[args.quality] || args.quality || "medium")
    : (args.quality || "standard");
  const params = {
    model,
    prompt: args.prompt,
    n: 1,
    size: args.size || "1024x1024",
    quality,
  };
  if (isGptImage) {
    const formatMap = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp" };
    params.output_format = formatMap[ext] || "png";
  } else {
    params.response_format = "b64_json";
  }
  return { params, quality };
}

function _buildGrokParams(model, args, ext) {
  const normalizedModel = normalizeGrokImageModelName(model);
  const isOpenAiImage = String(normalizedModel).startsWith("gpt-image");
  const quality = ({ hd: "high", standard: "medium", low: "low" }[args.quality] || args.quality || "medium");
  if (isOpenAiImage) {
    const params = {
      model: normalizedModel,
      prompt: args.prompt,
      response_format: "b64_json",
      n: 1,
      size: args.size || "1024x1024",
      quality,
    };
    const formatMap = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp" };
    params.output_format = formatMap[ext] || "png";
    return { params, quality };
  }
  // xAI /v1/images/generations does not accept `quality` or `size` — use
  // `aspect_ratio` and `resolution` instead.
  const params = {
    model: normalizedModel,
    prompt: args.prompt,
    n: 1,
    response_format: "b64_json",
  };
  const aspect = _sizeToAspectRatio(args.size);
  if (aspect) params.aspect_ratio = aspect;
  const resolution = _qualityToResolution(args.quality);
  if (resolution) params.resolution = resolution;
  return { params, quality };
}

function _sizeToAspectRatio(size) {
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

function _qualityToResolution(quality) {
  const normalized = String(quality || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "hd" || normalized === "high") return "2k";
  if (normalized === "standard" || normalized === "medium" || normalized === "low" || normalized === "auto") return "1k";
  if (normalized === "1k" || normalized === "2k") return normalized;
  return null;
}

function _buildImageTimeoutError(timeoutMs) {
  const seconds = Math.ceil(Math.max(1, Number(timeoutMs) || DEFAULT_IMAGE_GENERATION_TIMEOUT_MS) / 1000);
  const err = new Error(`Image generation timed out after ${seconds}s`);
  err.imageGenerationTimeout = true;
  err.code = "ETIMEDOUT";
  return err;
}

async function _generateImageWithTimeout(client, params, { timeoutMs = DEFAULT_IMAGE_GENERATION_TIMEOUT_MS } = {}) {
  const resolvedTimeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_IMAGE_GENERATION_TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const err = _buildImageTimeoutError(resolvedTimeoutMs);
      controller.abort(err);
      reject(err);
    }, resolvedTimeoutMs);
    timer.unref?.();
  });

  try {
    const requestPromise = client.images.generate(params, { signal: controller.signal });
    return await Promise.race([requestPromise, timeoutPromise]);
  } catch (err) {
    if (timedOut && (err?.name === "AbortError" || err?.code === "ABORT_ERR")) {
      throw _buildImageTimeoutError(resolvedTimeoutMs);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function execGenerateImageInternal(args = {}, {
  cwd = process.cwd(),
  scopePredicates,
  safePathImpl,
  buildImageClient = _buildImageClient,
  imageTimeoutMs = DEFAULT_IMAGE_GENERATION_TIMEOUT_MS,
} = {}) {
  if (!args.prompt || typeof args.prompt !== "string") {
    return "Error: prompt is required and must be a string.";
  }
  if (!args.path || typeof args.path !== "string") {
    return "Error: path is required (for example: images/hero.png).";
  }

  const protocol = getArtifactProtocol("image");
  const allowedFormats = protocol?.allowed_formats || [".png"];
  const ext = path.extname(args.path).toLowerCase();
  if (!allowedFormats.includes(ext)) {
    return `Error: path must end in one of ${allowedFormats.join(", ")} - got "${ext}".`;
  }

  const outputPath = safePathImpl(cwd, args.path, scopePredicates);
  if (!scopePredicates?.canCreate(outputPath)) {
    return `Error: generate_image blocked - ${args.path} is outside the allowed creation scope.`;
  }

  const providerOverride = args.provider ? String(args.provider).trim().toLowerCase() : null;
  const resolved = getResolvedImageProtocol(providerOverride);
  const provider = String(resolved.provider || getDefaultImageProvider()).toLowerCase();
  const model = resolved.model
    || getDefaultImageModel(provider);

  try {
    const client = await buildImageClient(provider);
    const { params, quality } = provider === "grok"
      ? _buildGrokParams(model, args, ext)
      : _buildOpenAiParams(model, args, ext);

    const response = await _generateImageWithTimeout(client, params, { timeoutMs: imageTimeoutMs });
    if (!Array.isArray(response?.data) || response.data.length === 0) {
      return "Error: API returned no image data.";
    }
    const imageData = response.data[0]?.b64_json;
    if (!imageData) {
      return "Error: API returned no image data.";
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(imageData, "base64"));
    const sizeKB = (fs.statSync(outputPath).size / 1024).toFixed(1);
    return `Image saved to ${args.path} (${sizeKB} KB, provider=${provider}, model=${model}, quality=${quality || "default"}).`;
  } catch (err) {
    if (err?.imageGenerationTimeout) {
      return `Error generating image: ${err.message}.`;
    }
    const msg = err?.message || String(err);
    if (err?.status === 400 && /content.?policy|safety|moderation/i.test(msg)) {
      return `Error: Image generation rejected by content policy: ${msg.slice(0, 300)}`;
    }
    return `Error generating image (${err?.status || "unknown"}): ${msg.slice(0, 500)}`;
  }
}
