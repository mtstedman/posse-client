import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IMAGE_TOOL_LIMITS as L } from '../../../catalog/experiment-skills.js';
import { detectImageFormat, readImageDimensions, decodePngToRgba, convertImageFileToPngExplicit, resolveExplicitImageConverters } from '../../../shared/tools/functions/toolkit/image-codec.js';
import { nativePngDecodable } from '../../../shared/tools/functions/toolkit/sprite-sheet.js';

export async function decodeSkillImage(bytes, signal) {
  signal?.throwIfAborted();
  if (!Buffer.isBuffer(bytes) || bytes.length > L.inputBytes) throw Error('Image input exceeds byte limit.');
  const format = detectImageFormat(bytes), dims = readImageDimensions(bytes, format);
  if (!['png', 'jpeg', 'webp'].includes(format) || !dims || dims.width > L.maxSide || dims.height > L.maxSide || dims.width * dims.height > L.inputPixels) throw Error('Unsupported or oversized image; use PNG, JPEG or WebP within image.tools limits.');
  if (format === 'png' && nativePngDecodable(bytes)) return { ...decodePngToRgba(bytes), decoder: 'native-png-v1' };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'posse-image-skill-'));
  try {
    const input = path.join(directory, `input.${format}`), output = path.join(directory, 'output.png');
    await fs.writeFile(input, bytes, { flag: 'wx', mode: 0o600 });
    const converted = await convertImageFileToPngExplicit(input, output, format, { converters: resolveExplicitImageConverters(), cwd: directory, timeoutMs: 10000 });
    signal?.throwIfAborted();
    if (!converted.ok) throw Error('Image decoding unavailable. PNG works natively; JPEG/WebP need a supported local converter.');
    const info = await fs.stat(output);
    if (info.size > L.inputBytes * 3) throw Error('Decoded image exceeds byte limit.');
    const png = await fs.readFile(output), decodedDims = readImageDimensions(png, 'png');
    if (!decodedDims || decodedDims.width !== dims.width || decodedDims.height !== dims.height) throw Error('Decoder changed image dimensions.');
    return { ...decodePngToRgba(png), decoder: converted.converter };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
