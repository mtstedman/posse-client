// Caller-owned experiment capabilities, not grants for native/host tools.
export const EXPERIMENT_SKILLS = [{ id: 'image-manipulation', version: 1,
  description: 'Inspect and compare deterministic image preprocessing: geometry, denoising, contrast, edges and background masks.',
  skill: 'image-manipulation/SKILL.md' }];
export const EXPERIMENT_SKILL_ROLES = ['setup', 'idea', 'writer', 'assessor'];
export const EXPERIMENT_SKILLS_SCHEMA = { type: 'object', additionalProperties: false, properties: Object.fromEntries(EXPERIMENT_SKILL_ROLES.map(role => [role, { type: 'array', maxItems: 8, uniqueItems: true, items: { enum: EXPERIMENT_SKILLS.map(skill => skill.id) } }])) };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const point = { type: 'array', minItems: 2, maxItems: 2, items: number(0, 32768) };
const quad = { type: 'array', minItems: 4, maxItems: 4, items: point };
export const IMAGE_TOOL_LIMITS = { inputBytes: 32 * 1024 * 1024, inputPixels: 16000000, outputPixels: 2000000, maxSide: 8192,
  variants: 4, steps: 8, artifacts: 16, cacheBytes: 32 * 1024 * 1024, work: 120000000, previewSide: 768 };
export const IMAGE_OPERATIONS = [
  { name: 'crop', description: 'Crop to a pixel rectangle in the current image.', parameters: object({ x: integer(0, 8191), y: integer(0, 8191), width: integer(1, 8192), height: integer(1, 8192) }) },
  { name: 'resize', description: 'Area-resample to explicit dimensions; preserve aspect ratio unless intentionally rectifying.', parameters: object({ width: integer(1, 8192), height: integer(1, 8192) }) },
  { name: 'grayscale', description: 'Convert RGB to luminance; preserve alpha.', parameters: object({}) },
  { name: 'gaussian_blur', description: 'Separable Gaussian blur, sigma in pixels; radius is ceil(3*sigma).', parameters: object({ sigma: number(0.1, 3) }) },
  { name: 'normalize', description: 'Stretch luminance contrast to [0,255]; flat images remain flat.', parameters: object({}) },
  { name: 'threshold', description: 'Binary luminance threshold: fixed level or Otsu histogram selection.', parameters: object({ method: { enum: ['fixed', 'otsu'] }, level: integer(0, 255) }, ['method']) },
  { name: 'adaptive_threshold', description: 'Compare luminance with local mean minus bias. Useful for uneven illumination.', parameters: object({ radius: integer(1, 31), bias: number(-64, 64) }) },
  { name: 'invert', description: 'Invert RGB while preserving alpha.', parameters: object({}) },
  { name: 'morphology', description: 'Grayscale min/max square-kernel erosion, dilation, opening or closing; use small radii on binary masks.', parameters: object({ mode: { enum: ['erode', 'dilate', 'open', 'close'] }, radius: integer(1, 3) }) },
  { name: 'edges', description: 'Sobel gradient magnitude, optionally binary-thresholded. Diagnostic alternative to production Canny.', parameters: object({ threshold: integer(0, 255) }, []) },
  { name: 'perspective', description: 'Rectify a convex quad ordered top-left, top-right, bottom-right, bottom-left into the requested rectangle. Coordinates refer to the current image.', parameters: object({ corners: quad, width: integer(2, 8192), height: integer(2, 8192) }) },
  { name: 'mask', description: 'Keep pixels inside a convex quad and replace the outside with an explicit RGBA background.', parameters: object({ corners: quad, background: { type: 'array', minItems: 4, maxItems: 4, items: integer(0, 255) } }) },
];
export const IMAGE_SOURCE_SCHEMA = { oneOf: [object({ case_index: integer(0, 999), alias: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' } }), object({ artifact: { type: 'string', pattern: '^[a-f0-9]{64}$' } })] };
export const IMAGE_TOOLS = [
  { name: 'image.tools', description: 'Discover image operations and their parameter schemas. No pixel data or answers.', parameters: object({}) },
  { name: 'image.transform', description: 'Use image.tools for exact step parameters. Compare up to four recipes from one original corpus image or a session artifact. Returns immutable artifact hashes, recipes, geometry and optional pixel previews; never rewrites corpus resources or scores.', parameters: object({ source: IMAGE_SOURCE_SCHEMA,
    variants: { type: 'array', minItems: 1, maxItems: IMAGE_TOOL_LIMITS.variants, items: object({ label: { type: 'string', minLength: 1, maxLength: 80 },
      steps: { type: 'array', minItems: 0, maxItems: IMAGE_TOOL_LIMITS.steps, items: { type: 'object', required: ['op'], properties: { op: { enum: IMAGE_OPERATIONS.map(op => op.name) } }, additionalProperties: true } },
      preview: { type: 'boolean' } }, ['label', 'steps']) } }) },
];
export const EXPERIMENT_SKILL_SETUP_TOOLS = [
  { name: 'setup.skills', description: 'List built-in optional experiment skills and their attached state. Tool schemas and instructions load only after attachment.', parameters: object({}) },
  { name: 'setup.attach_skill', description: 'Attach a built-in skill to one named agent role in this test suite. setup affects only the builder; idea/writer/assessor affect only that improvement role. Preserved in reusable artifacts and the frozen setup; does not change scoring or the tested algorithm.', parameters: object({ id: { enum: EXPERIMENT_SKILLS.map(skill => skill.id) }, role: { enum: EXPERIMENT_SKILL_ROLES } }) },
];
