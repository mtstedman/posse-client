import { AGENT_INPUT_IMAGES } from '../../../catalog/agent.js';
import { IMAGE_TOOL_LIMITS as L } from '../../../catalog/experiment-skills.js';
import { encodeRgbaToPngAsync, resampleRgba } from '../../../shared/tools/functions/toolkit/image-codec.js';

// Fit the actual caller-owned provider transport, not just a visual side limit.
// Full-resolution artifacts remain untouched; only the delivered preview shrinks.
export async function imageSkillPreview(image, fullPng) {
  const maxBytes = Math.floor(AGENT_INPUT_IMAGES.maxBase64Chars / 4) * 3;
  let side = Math.min(L.previewSide, Math.max(image.width, image.height));
  for (let attempt = 0; attempt < 12; attempt++) {
    const scale = Math.min(1, side / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
    const bytes = scale === 1 ? fullPng : await encodeRgbaToPngAsync(width, height, resampleRgba(image.width, image.height, image.data, width, height));
    if (bytes.length <= maxBytes) return { bytes, width, height };
    side = Math.max(1, Math.min(side - 1, Math.floor(side * Math.sqrt(maxBytes / bytes.length) * .85)));
  }
  throw Error('Image preview could not fit the provider byte limit.');
}
