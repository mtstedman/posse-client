import fs from "fs";
import path from "path";
import { getArtifactProtocol, getResolvedImageProtocol } from "../../../artifacts/functions/index.js";
import { getDefaultImageModel, getDefaultImageProvider, normalizeGrokImageModelName } from "../model-catalog.js";
import {
  convertImageToJpeg,
  convertImageToPng,
  detectImageFormat,
} from "../../../../shared/tools/functions/toolkit/image-codec.js";

export { TOOL_GENERATE_IMAGE } from "../../../integrations/functions/deterministic-mcp/tool-descriptors.js";

const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 600_000;
const MAX_DOWNLOADED_IMAGE_BYTES = 64 * 1024 * 1024;
const NO_IMAGE_PROVIDERS_AVAILABLE = "No image providers available";

// Each image-capable provider owns construction of its OpenAI-shaped client
// (env vars, baseURL, retry config). Import provider builders lazily so this
// shared helper can be imported by those same provider modules without a
// startup cycle.
async function _buildImageClient(providerName) {
  const provider = String(providerName || "").trim().toLowerCase();
  const mod = provider === "openai"
    ? await import("../openai/index.js")
    : provider === "grok"
      ? await import("../grok/index.js")
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
    // xAI's inline base64 responses are large enough to be truncated by the
    // upstream transport. Request a short-lived URL and download it below.
    response_format: "url",
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

async function _downloadImageWithTimeout(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_IMAGE_GENERATION_TIMEOUT_MS,
  maxBytes = MAX_DOWNLOADED_IMAGE_BYTES,
} = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    throw new Error("Image API returned an invalid download URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Image API returned a non-HTTPS download URL.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Image download transport is unavailable.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(_buildImageTimeoutError(timeoutMs)), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(parsed.href, { signal: controller.signal, redirect: "follow" });
    if (!response?.ok) {
      throw new Error(`Image download failed with HTTP ${response?.status || "unknown"}.`);
    }
    const declaredLength = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`Downloaded image exceeds the ${maxBytes}-byte limit.`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error("Downloaded image was empty.");
    if (bytes.length > maxBytes) throw new Error(`Downloaded image exceeds the ${maxBytes}-byte limit.`);
    return bytes;
  } catch (err) {
    if (controller.signal.aborted && (err?.name === "AbortError" || err?.code === "ABORT_ERR")) {
      throw _buildImageTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function _writeImageInRequestedFormat(outputPath, imageBytes, ext) {
  const detected = detectImageFormat(imageBytes);
  const requested = ext === ".jpg" ? "jpeg" : ext.slice(1);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (detected === requested) {
    fs.writeFileSync(outputPath, imageBytes);
    return;
  }

  if (!["png", "jpeg"].includes(requested)) {
    throw new Error(`Image API returned ${detected} bytes for requested ${requested} output.`);
  }
  const tempPath = `${outputPath}.download-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, imageBytes);
    const converted = requested === "png"
      ? convertImageToPng(imageBytes, tempPath, outputPath)
      : convertImageToJpeg(imageBytes, tempPath, outputPath);
    if (!converted?.ok || !fs.existsSync(outputPath)) {
      throw new Error(`Could not convert generated ${detected} image to ${requested}.`);
    }
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

async function _resolveImageExecutionProvider(payload) {
  const { resolveImageExecutionProvider } = await import("../execution-routing.js");
  return resolveImageExecutionProvider(payload);
}

async function _isProviderReady(provider, capability) {
  const { isProviderReady } = await import("../provider.js");
  return isProviderReady(provider, capability);
}

export async function execGenerateImageInternal(args = {}, {
  cwd = process.cwd(),
  scopePredicates,
  buildImageClient = _buildImageClient,
  fetchImpl = globalThis.fetch,
  imageTimeoutMs = DEFAULT_IMAGE_GENERATION_TIMEOUT_MS,
  enforceProviderAvailability = buildImageClient === _buildImageClient,
} = {}) {
  if (!args.prompt || typeof args.prompt !== "string") {
    return "Error: prompt is required and must be a string.";
  }
  if (!args.filename || typeof args.filename !== "string") {
    return "Error: filename is required (for example: hero.png).";
  }

  const filename = args.filename.trim();
  if (
    !filename
    || filename === "."
    || filename === ".."
    || /[\\/]/.test(filename)
    || /[\u0000-\u001f<>:"|?*]/.test(filename)
    || path.isAbsolute(filename)
    || path.win32.parse(filename).dir
    || path.posix.parse(filename).dir
  ) {
    return `Error: filename must be a file name only, without a directory path - got "${args.filename}".`;
  }

  const protocol = getArtifactProtocol("image");
  const allowedFormats = protocol?.allowed_formats || [".png"];
  const ext = path.extname(filename).toLowerCase();
  if (!allowedFormats.includes(ext)) {
    return `Error: filename must end in one of ${allowedFormats.join(", ")} - got "${ext}".`;
  }

  const outputPath = path.join(path.resolve(cwd), filename);
  if (!scopePredicates?.canCreate(outputPath)) {
    return `Error: generate_image blocked - ${filename} is outside the allowed creation scope.`;
  }

  const providerOverride = args.provider ? String(args.provider).trim().toLowerCase() : null;
  if (enforceProviderAvailability && !providerOverride) {
    const imageRoute = await _resolveImageExecutionProvider({ needs_image_generation: true });
    if (!imageRoute.readiness.ready) {
      return `Error: ${NO_IMAGE_PROVIDERS_AVAILABLE}`;
    }
    const provider = imageRoute.provider;
    const model = imageRoute.model || getDefaultImageModel(provider);
    return await _executeGenerateImageWithRoute({
      args,
      ext,
      filename,
      outputPath,
      provider,
      model,
      buildImageClient,
      fetchImpl,
      imageTimeoutMs,
    });
  }

  const resolved = getResolvedImageProtocol(providerOverride);
  const provider = String(resolved.provider || getDefaultImageProvider()).toLowerCase();
  const model = resolved.model
    || getDefaultImageModel(provider);

  if (enforceProviderAvailability) {
    const readiness = await _isProviderReady(provider, "images");
    if (!readiness.ready) {
      return `Error: ${NO_IMAGE_PROVIDERS_AVAILABLE}`;
    }
  }

  return await _executeGenerateImageWithRoute({
    args,
    ext,
    filename,
    outputPath,
    provider,
    model,
    buildImageClient,
    fetchImpl,
    imageTimeoutMs,
  });
}

async function _executeGenerateImageWithRoute({
  args,
  ext,
  filename,
  outputPath,
  provider,
  model,
  buildImageClient,
  fetchImpl,
  imageTimeoutMs,
}) {
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
    const imageUrl = response.data[0]?.url;
    if (!imageData && !imageUrl) {
      return "Error: API returned no image data.";
    }

    const imageBytes = imageData
      ? Buffer.from(imageData, "base64")
      : await _downloadImageWithTimeout(imageUrl, { fetchImpl, timeoutMs: imageTimeoutMs });

    _writeImageInRequestedFormat(outputPath, imageBytes, ext);
    const sizeKB = (fs.statSync(outputPath).size / 1024).toFixed(1);
    return `Image saved to ${filename} (${sizeKB} KB, provider=${provider}, model=${model}, quality=${quality || "default"}).`;
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
