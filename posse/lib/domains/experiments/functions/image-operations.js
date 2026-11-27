import { IMAGE_OPERATIONS, IMAGE_TOOL_LIMITS as L } from '../../../catalog/experiment-skills.js';
import { validateToolArguments } from '../../../shared/tools/functions/schema-validation.js';
import { resampleRgba } from '../../../shared/tools/functions/toolkit/image-codec.js';

const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
const luminance = (data, i) => Math.round(.2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2]);
const gray = image => Float64Array.from({ length: image.width * image.height }, (_, i) => luminance(image.data, i * 4));
const plane = (image, values) => {
  const data = Buffer.from(image.data);
  for (let i = 0; i < values.length; i++) data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = clamp(Math.round(values[i]), 0, 255);
  return { ...image, data };
};
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > L.maxSide || height > L.maxSide || width * height > L.outputPixels) throw Error('Output exceeds image skill dimensions/pixel limit. Crop or downsize first.');
}
function cornersWithin(corners, image) {
  if (corners.some(([x, y]) => x >= image.width || y >= image.height)) throw Error('Quad is outside the current image.');
  const crosses = corners.map((a, i) => {
    const b = corners[(i + 1) % 4], c = corners[(i + 2) % 4];
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  });
  if (!crosses.every(v => v > 1e-6) && !crosses.every(v => v < -1e-6)) throw Error('Quad must be convex, nondegenerate and ordered around its perimeter.');
}
function solve(matrix) {
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    const divisor = matrix[col][col]; if (Math.abs(divisor) < 1e-10) throw Error('Perspective is singular.');
    for (let j = col; j <= 8; j++) matrix[col][j] /= divisor;
    for (let row = 0; row < 8; row++) if (row !== col) {
      const factor = matrix[row][col];
      for (let j = col; j <= 8; j++) matrix[row][j] -= factor * matrix[col][j];
    }
  }
  return matrix.map(row => row[8]);
}
function bilinear(image, x, y, out, offset) {
  x = clamp(x, 0, image.width - 1); y = clamp(y, 0, image.height - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, image.width - 1), y1 = Math.min(y0 + 1, image.height - 1), dx = x - x0, dy = y - y0;
  for (let c = 0; c < 4; c++) out[offset + c] = Math.round(
    image.data[(y0 * image.width + x0) * 4 + c] * (1 - dx) * (1 - dy) + image.data[(y0 * image.width + x1) * 4 + c] * dx * (1 - dy)
    + image.data[(y1 * image.width + x0) * 4 + c] * (1 - dx) * dy + image.data[(y1 * image.width + x1) * 4 + c] * dx * dy);
}
function otsu(values) {
  const histogram = new Uint32Array(256); for (const v of values) histogram[v]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let left = 0, leftSum = 0, best = -1, threshold = 0;
  for (let t = 0; t < 255; t++) {
    left += histogram[t]; leftSum += t * histogram[t];
    const right = values.length - left; if (!left || !right) continue;
    const separation = leftSum / left - (sum - leftSum) / right, variance = left * right * separation * separation;
    if (variance > best) { best = variance; threshold = t; }
  }
  return threshold;
}
function morphology(values, width, height, radius, dilate) {
  const out = new Float64Array(values.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = dilate ? 0 : 255;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const next = values[clamp(y + dy, 0, height - 1) * width + clamp(x + dx, 0, width - 1)];
      value = dilate ? Math.max(value, next) : Math.min(value, next);
    }
    out[y * width + x] = value;
  }
  return out;
}

export function applyImageOperation(image, step, budget = { remaining: L.work }) {
  const { op, ...args } = step;
  const definition = IMAGE_OPERATIONS.find(item => item.name === op);
  if (!definition || !validateToolArguments({ name: op, parameters: definition.parameters }, args).ok) throw Error('Invalid image operation or parameters. Use image.tools.');
  const width = args.width ?? image.width, height = args.height ?? image.height;
  dimensions(width, height);
  const kernel = op === 'gaussian_blur' ? 8 * (Math.ceil(3 * args.sigma) * 2 + 1)
    : op === 'morphology' ? (args.radius * 2 + 1) ** 2 * (['open', 'close'].includes(args.mode) ? 2 : 1) : 1;
  const cost = Math.max(width * height, op === 'crop' ? 0 : image.width * image.height) * kernel;
  if (cost > budget.remaining) throw Error('Image operation work budget exhausted. Use smaller crops or resize.');
  budget.remaining -= cost;
  if (op === 'resize') return { width, height, data: resampleRgba(image.width, image.height, image.data, width, height) };
  if (op === 'crop') {
    if (args.x + width > image.width || args.y + height > image.height) throw Error('Crop is outside the current image.');
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) image.data.copy(data, y * width * 4, ((y + args.y) * image.width + args.x) * 4, ((y + args.y) * image.width + args.x + width) * 4);
    return { width, height, data };
  }
  if (op === 'perspective') {
    cornersWithin(args.corners, image);
    const rectangle = [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], matrix = [];
    rectangle.forEach(([u, v], i) => { const [x, y] = args.corners[i]; matrix.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x], [0, 0, 0, u, v, 1, -u * y, -v * y, y]); });
    const h = solve(matrix), data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const z = h[6] * x + h[7] * y + 1;
      if (Math.abs(z) < 1e-10) throw Error('Perspective crosses infinity.');
      bilinear(image, (h[0] * x + h[1] * y + h[2]) / z, (h[3] * x + h[4] * y + h[5]) / z, data, (y * width + x) * 4);
    }
    return { width, height, data };
  }
  if (op === 'mask') {
    cornersWithin(args.corners, image); const data = Buffer.from(image.data);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sides = args.corners.map((a, i) => { const b = args.corners[(i + 1) % 4]; return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]); });
      if (!sides.every(v => v >= 0) && !sides.every(v => v <= 0)) for (let c = 0; c < 4; c++) data[(y * width + x) * 4 + c] = args.background[c];
    }
    return { width, height, data };
  }
  if (op === 'invert') { const data = Buffer.from(image.data); for (let i = 0; i < data.length; i++) if (i % 4 !== 3) data[i] = 255 - data[i]; return { ...image, data }; }
  if (op === 'gaussian_blur') {
    const radius = Math.ceil(3 * args.sigma), kernel = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * args.sigma ** 2)));
    const sum = kernel.reduce((a, b) => a + b); for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    const temp = new Float64Array(image.data.length), data = Buffer.from(image.data);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
      let value = 0; for (let k = -radius; k <= radius; k++) value += image.data[(y * width + clamp(x + k, 0, width - 1)) * 4 + c] * kernel[k + radius];
      temp[(y * width + x) * 4 + c] = value;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
      let value = 0; for (let k = -radius; k <= radius; k++) value += temp[(clamp(y + k, 0, height - 1) * width + x) * 4 + c] * kernel[k + radius];
      data[(y * width + x) * 4 + c] = Math.round(value);
    }
    return { ...image, data };
  }
  const values = gray(image);
  if (op === 'normalize') {
    let low = 255, high = 0; for (const v of values) { low = Math.min(low, v); high = Math.max(high, v); }
    if (high > low) for (let i = 0; i < values.length; i++) values[i] = (values[i] - low) * 255 / (high - low);
  } else if (op === 'threshold') {
    if (args.method === 'fixed' && args.level === undefined) throw Error('Fixed threshold needs level.');
    if (args.method === 'otsu' && args.level !== undefined) throw Error('Otsu chooses its own level.');
    const level = args.method === 'otsu' ? otsu(values) : args.level;
    for (let i = 0; i < values.length; i++) values[i] = values[i] > level ? 255 : 0;
  } else if (op === 'adaptive_threshold') {
    const sums = new Float64Array((width + 1) * (height + 1));
    for (let y = 0; y < height; y++) { let sum = 0; for (let x = 0; x < width; x++) { sum += values[y * width + x]; sums[(y + 1) * (width + 1) + x + 1] = sum + sums[y * (width + 1) + x + 1]; } }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - args.radius), x1 = Math.min(width, x + args.radius + 1), y0 = Math.max(0, y - args.radius), y1 = Math.min(height, y + args.radius + 1), stride = width + 1;
      const mean = (sums[y1 * stride + x1] - sums[y0 * stride + x1] - sums[y1 * stride + x0] + sums[y0 * stride + x0]) / ((x1 - x0) * (y1 - y0));
      values[y * width + x] = values[y * width + x] > mean - args.bias ? 255 : 0;
    }
  } else if (op === 'morphology') {
    const first = morphology(values, width, height, args.radius, ['dilate', 'close'].includes(args.mode));
    return plane(image, ['open', 'close'].includes(args.mode) ? morphology(first, width, height, args.radius, args.mode === 'open') : first);
  } else if (op === 'edges') {
    const out = new Float64Array(values.length), at = (x, y) => values[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const gx = -at(x - 1, y - 1) + at(x + 1, y - 1) - 2 * at(x - 1, y) + 2 * at(x + 1, y) - at(x - 1, y + 1) + at(x + 1, y + 1);
      const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      const magnitude = Math.min(255, Math.hypot(gx, gy)); out[y * width + x] = args.threshold === undefined ? magnitude : magnitude > args.threshold ? 255 : 0;
    }
    return plane(image, out);
  }
  return plane(image, values);
}
