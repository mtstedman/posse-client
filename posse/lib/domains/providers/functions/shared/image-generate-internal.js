import fs from "fs";
import path from "path";
import { IMAGE_GENERATION_TIMEOUT_MS } from "../../../../catalog/artifact.js";
import { getArtifactProtocol, getResolvedImageProtocol } from "../../../artifacts/functions/index.js";
import { getDefaultImageModel, getDefaultImageProvider, normalizeGrokImageModelName } from "../model-catalog.js";
import {
  convertImageToJpeg,
  convertImageToPng,
  detectImageFormat,
} from "../../../../shared/tools/functions/toolkit/image-codec.js";

export { TOOL_GENERATE_IMAGE } from "../../../integrations/functions/deterministic-mcp/tool-descriptors.js";

const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = IMAGE_GENERATION_TIMEOUT_MS;
const MAX_DOWNLOADED_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_DOWNLOAD_REDIRECTS = 3;
const NO_IMAGE_PROVIDERS_AVAILABLE = "No image providers available";
// A provider can be unready for a moment (a credential or catalog reload), so
// readiness is checked once more after this pause before the tool says no
// image provider is ready.
const IMAGE_PROVIDER_READINESS_RECHECK_MS = 2000;

function _assertTrustedImageDownloadUrl(url, provider) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    throw new Error("Image API returned an invalid download URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Image API returned a non-HTTPS download URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Image API returned a download URL containing credentials.");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const trusted = provider === "grok" && (hostname === "x.ai" || hostname.endsWith(".x.ai"));
  if (!trusted) {
    throw new Error(`Image API returned an untrusted download host for provider ${provider || "unknown"}.`);
  }
  return parsed;
}

async function _readImageBytesWithLimit(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Downloaded image exceeds the ${maxBytes}-byte limit.`);
  }
  const chunks = [];
  let total = 0;
  const append = (value) => {
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) throw new Error(`Downloaded image exceeds the ${maxBytes}-byte limit.`);
    chunks.push(chunk);
  };
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        append(value);
      }
    } catch (err) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw err;
    } finally {
      try { reader.releaseLock?.(); } catch { /* best effort */ }
    }
  } else if (response?.body && typeof response.body[Symbol.asyncIterator] === "function") {
    try {
      for await (const value of response.body) append(value);
    } catch (err) {
      try { response.body.destroy?.(); } catch { /* best effort */ }
      throw err;
    }
  } else {
    append(await response.arrayBuffer());
  }
  return Buffer.concat(chunks, total);
}

function _nonNegativeFiniteOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

async function _recordImageGenerationTelemetry({
  provider,
  model,
  args,
  status,
  startedAt,
  outputBytes = null,
  usage = null,
  error = null,
} = {}) {
  try {
    const { getObservationContext, recordObservation } = await import("../../../observability/functions/observations.js");
    const context = getObservationContext() || {};
    const durationMs = Math.max(0, Date.now() - Number(startedAt || Date.now()));
    const normalizedUsage = usage && typeof usage === "object" ? {
      input_tokens: _nonNegativeFiniteOrNull(usage.input_tokens),
      output_tokens: _nonNegativeFiniteOrNull(usage.output_tokens),
      total_tokens: _nonNegativeFiniteOrNull(usage.total_tokens),
    } : null;
    recordObservation({
      work_item_id: context.work_item_id ?? null,
      job_id: context.job_id ?? null,
      attempt_id: context.attempt_id ?? null,
      observation_type: "image.generation",
      summary: `Image generation ${status}: ${provider}/${model}`,
      detail: {
        agent_call_id: context.agent_call_id ?? null,
        provider,
        model,
        status,
        duration_ms: durationMs,
        size: args?.size || "1024x1024",
        quality: args?.quality || "default",
        output_bytes: _nonNegativeFiniteOrNull(outputBytes),
        usage: normalizedUsage,
        cost_estimate_usd: null,
        cost_status: "unknown",
        error: error ? String(error).slice(0, 500) : null,
      },
    });
  } catch {
    // Image generation must never fail because best-effort telemetry is unavailable.
  }
}

// Native dispatch owns provider HTTP. Lazy imports avoid a startup cycle.
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
    const requestPromise = client.images.generate(params, { signal: controller.signal, timeoutMs: resolvedTimeoutMs });
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
  provider,
} = {}) {
  let parsed = _assertTrustedImageDownloadUrl(url, provider);
  if (typeof fetchImpl !== "function") {
    throw new Error("Image download transport is unavailable.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(_buildImageTimeoutError(timeoutMs)), timeoutMs);
  timer.unref?.();
  try {
    let response;
    for (let redirects = 0; ; redirects += 1) {
      response = await fetchImpl(parsed.href, { signal: controller.signal, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(Number(response?.status))) break;
      if (redirects >= MAX_IMAGE_DOWNLOAD_REDIRECTS) {
        throw new Error(`Image download exceeded ${MAX_IMAGE_DOWNLOAD_REDIRECTS} redirects.`);
      }
      const location = response.headers?.get?.("location");
      if (!location) throw new Error("Image download redirect omitted its location.");
      try { await response.body?.cancel?.(); } catch { /* best effort */ }
      parsed = _assertTrustedImageDownloadUrl(new URL(location, parsed).href, provider);
    }
    if (!response?.ok) {
      throw new Error(`Image download failed with HTTP ${response?.status || "unknown"}.`);
    }
    if (response.url) _assertTrustedImageDownloadUrl(response.url, provider);
    const bytes = await _readImageBytesWithLimit(response, maxBytes);
    if (bytes.length === 0) throw new Error("Downloaded image was empty.");
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

// Name each provider's readiness failure so the agent, the tool observation
// and any BLOCKED handoff carry the cause, not only that nothing was ready.
function _noImageProvidersError(failures) {
  const reasons = new Map();
  for (const failure of Array.isArray(failures) ? failures : []) {
    const provider = String(failure?.provider || "").trim();
    if (!provider || reasons.has(provider)) continue;
    const reason = String(failure?.reason || "").split("\n")[0].trim().slice(0, 200);
    reasons.set(provider, `${provider}: ${reason || "not ready"}`);
  }
  const detail = reasons.size ? ` (${[...reasons.values()].join("; ")})` : "";
  return `Error: ${NO_IMAGE_PROVIDERS_AVAILABLE}${detail}`;
}

function _waitBeforeReadinessRecheck() {
  return new Promise((resolve) => setTimeout(resolve, IMAGE_PROVIDER_READINESS_RECHECK_MS));
}

async function _checkReadinessWithOneRecheck(check, isReady, waitBeforeRecheck) {
  const first = await check();
  if (isReady(first)) return first;
  await waitBeforeRecheck();
  return await check();
}

export async function execGenerateImageInternal(args = {}, {
  cwd = process.cwd(),
  scopePredicates,
  buildImageClient = _buildImageClient,
  fetchImpl = globalThis.fetch,
  imageTimeoutMs = DEFAULT_IMAGE_GENERATION_TIMEOUT_MS,
  imageDownloadMaxBytes = MAX_DOWNLOADED_IMAGE_BYTES,
  enforceProviderAvailability = buildImageClient === _buildImageClient,
  waitBeforeReadinessRecheck = _waitBeforeReadinessRecheck,
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
    const imageRoute = await _checkReadinessWithOneRecheck(
      () => _resolveImageExecutionProvider({ needs_image_generation: true }),
      (route) => route.readiness.ready,
      waitBeforeReadinessRecheck,
    );
    if (!imageRoute.readiness.ready) {
      return _noImageProvidersError(imageRoute.readiness.failures);
    }
    const provider = imageRoute.provider;
    const model = imageRoute.model || getDefaultImageModel(provider);
    return await _executeGenerateImageWithRoute({
      args,
      ext,
      filename,
      outputPath,
      scopePredicates,
      provider,
      model,
      buildImageClient,
      fetchImpl,
      imageTimeoutMs,
      imageDownloadMaxBytes,
    });
  }

  const resolved = getResolvedImageProtocol(providerOverride);
  const provider = String(resolved.provider || getDefaultImageProvider()).toLowerCase();
  const model = resolved.model
    || getDefaultImageModel(provider);

  if (enforceProviderAvailability) {
    const readiness = await _checkReadinessWithOneRecheck(
      () => _isProviderReady(provider, "images"),
      (result) => result.ready,
      waitBeforeReadinessRecheck,
    );
    if (!readiness.ready) {
      return _noImageProvidersError([{ provider, reason: readiness.reason }]);
    }
  }

  return await _executeGenerateImageWithRoute({
    args,
    ext,
    filename,
    outputPath,
    scopePredicates,
    provider,
    model,
    buildImageClient,
    fetchImpl,
    imageTimeoutMs,
    imageDownloadMaxBytes,
  });
}

async function _executeGenerateImageWithRoute({
  args,
  ext,
  filename,
  outputPath,
  scopePredicates,
  provider,
  model,
  buildImageClient,
  fetchImpl,
  imageTimeoutMs,
  imageDownloadMaxBytes,
}) {
  const startedAt = Date.now();
  try {
    const client = await buildImageClient(provider);
    const quality = args.quality;
    const params = {
      model: provider === "grok" ? normalizeGrokImageModelName(model) : model,
      prompt: args.prompt,
      format: ext === ".jpg" ? "jpeg" : ext.slice(1),
      size: args.size,
      quality,
      cwd: path.dirname(outputPath),
    };

    const response = await _generateImageWithTimeout(client, params, { timeoutMs: imageTimeoutMs });
    if (!Array.isArray(response?.data) || response.data.length === 0) {
      await _recordImageGenerationTelemetry({
        provider, model, args, status: "failed", startedAt, usage: response?.usage,
        error: "API returned no image data",
      });
      return "Error: API returned no image data.";
    }
    const imageData = response.data[0]?.b64_json;
    const imageUrl = response.data[0]?.url;
    if (!imageData && !imageUrl) {
      await _recordImageGenerationTelemetry({
        provider, model, args, status: "failed", startedAt, usage: response?.usage,
        error: "API returned no image data",
      });
      return "Error: API returned no image data.";
    }

    const compactImageData = imageData ? String(imageData).replace(/\s/g, "") : "";
    const base64Padding = compactImageData.endsWith("==") ? 2 : compactImageData.endsWith("=") ? 1 : 0;
    const estimatedImageBytes = compactImageData
      ? Math.max(0, Math.floor(compactImageData.length * 3 / 4) - base64Padding)
      : 0;
    if (estimatedImageBytes > imageDownloadMaxBytes) {
      throw new Error(`Generated image exceeds the ${imageDownloadMaxBytes}-byte limit.`);
    }
    const imageBytes = imageData
      ? Buffer.from(compactImageData, "base64")
      : await _downloadImageWithTimeout(imageUrl, {
          fetchImpl,
          timeoutMs: imageTimeoutMs,
          maxBytes: imageDownloadMaxBytes,
          provider,
        });
    if (imageBytes.length > imageDownloadMaxBytes) {
      throw new Error(`Generated image exceeds the ${imageDownloadMaxBytes}-byte limit.`);
    }

    if (!scopePredicates?.canCreate(outputPath)) {
      throw new Error("Image creation scope was revoked during generation.");
    }
    _writeImageInRequestedFormat(outputPath, imageBytes, ext);
    const outputBytes = fs.statSync(outputPath).size;
    const sizeKB = (outputBytes / 1024).toFixed(1);
    await _recordImageGenerationTelemetry({
      provider,
      model,
      args,
      status: "succeeded",
      startedAt,
      outputBytes,
      usage: response?.usage,
    });
    return `Image saved to ${filename} (${sizeKB} KB, provider=${provider}, model=${model}, quality=${quality || "default"}).`;
  } catch (err) {
    await _recordImageGenerationTelemetry({
      provider,
      model,
      args,
      status: "failed",
      startedAt,
      error: err?.message || String(err),
    });
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
