import { pngHeaderDimensions, readBoundedMedia } from "./local-video-media.js";
import { MAX_REFERENCE_IMAGES } from "../../../catalog/local-model-parameters.js";

const MAX_INPUT_IMAGE_BYTES = 4 * 1024 ** 2;

export async function prepareImageInput(capability, parameters, args, signal) {
  const input = capability?.inputs?.initImage;
  if (!Array.isArray(input?.mimeTypes) || !input.mimeTypes.includes("image/png") || input.dimensionPolicy !== "match-output"
    || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < MAX_INPUT_IMAGE_BYTES
    || input.strength?.min !== 0 || input.strength?.max !== 1 || input.strength?.default !== 0.75) {
    throw new Error("This native runtime does not support Qwen image-to-image input. Update posse-ml before using initImage (--init-image).");
  }
  signal?.throwIfAborted();
  const bytes = await readBoundedMedia(parameters.initImage, MAX_INPUT_IMAGE_BYTES);
  signal?.throwIfAborted();
  const { width, height } = pngHeaderDimensions(bytes, "initImage");
  if (![width, height].every(value => value >= 64 && value <= 1024 && value % 16 === 0)) {
    throw new Error("initImage dimensions must be multiples of 16 from 64 to 1024.");
  }
  for (const [key, value] of Object.entries({ width, height })) {
    if (args[key] !== undefined && Number(args[key]) !== value) throw new Error(`Explicit ${key} must match initImage (${value}).`);
  }
  // Full PNG decoding, opacity, CRC and allocation checks belong to the native boundary.
  return { width, height, initImage: { mimeType: "image/png", base64: bytes.toString("base64") } };
}

/** Output size for an edit: the first reference's size, scaled to fit the limit and rounded to the multiple. */
export function referenceOutputSize({ width, height }, { max = 1024, min = 64, multiple = 16 } = {}) {
  const scale = Math.min(1, max / Math.max(width, height));
  const fit = value => Math.min(max, Math.max(min, Math.round(value * scale / multiple) * multiple));
  return { width: fit(width), height: fit(height) };
}

/** Read the comma-separated reference PNGs of an edit request, in prompt order. */
export async function prepareReferenceImages(capability, parameters, args, signal) {
  const input = capability?.inputs?.refImages;
  if (!Array.isArray(input?.mimeTypes) || !input.mimeTypes.includes("image/png")
    || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < MAX_INPUT_IMAGE_BYTES
    || !Number.isSafeInteger(input.maxCount) || input.maxCount < 1
    || !Number.isSafeInteger(input.minDimension) || !Number.isSafeInteger(input.maxDimension)) {
    throw new Error("This native runtime does not support reference images. Update posse-ml before using refImages (--ref-images).");
  }
  const files = parameters.refImages.split(",").map(file => file.trim());
  const most = Math.min(MAX_REFERENCE_IMAGES, input.maxCount);
  if (files.some(file => !file) || files.length > most) {
    throw new Error(`refImages (--ref-images) takes 1 to ${most} comma-separated PNG files, e.g. --ref-images a.png,b.png.`);
  }
  const refImages = [];
  let first;
  for (const [index, file] of files.entries()) {
    signal?.throwIfAborted();
    const label = `refImages[${index + 1}] (${file})`;
    let bytes;
    try { bytes = await readBoundedMedia(file, MAX_INPUT_IMAGE_BYTES); }
    catch (error) { throw new Error(`${label}: ${error?.message || error}`, { cause: error }); }
    const size = pngHeaderDimensions(bytes, label);
    if (![size.width, size.height].every(value => value >= input.minDimension && value <= input.maxDimension)) {
      throw new Error(`${label} sides must be ${input.minDimension} to ${input.maxDimension} pixels.`);
    }
    first ||= size;
    // Full PNG decoding, opacity, CRC and allocation checks belong to the native boundary.
    refImages.push({ mimeType: "image/png", base64: bytes.toString("base64") });
  }
  const explicit = args.width !== undefined || args.height !== undefined;
  return { refImages, ...(explicit ? {} : referenceOutputSize(first)) };
}
