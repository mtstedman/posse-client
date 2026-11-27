import { experimentDigest } from '../functions/snapshots.js';
import { imageSkillPreview } from '../functions/image-preview.js';
import { createHash } from 'node:crypto';
import { IMAGE_TOOLS, IMAGE_OPERATIONS, IMAGE_TOOL_LIMITS as L } from '../../../catalog/experiment-skills.js';
import { validateToolArguments } from '../../../shared/tools/functions/schema-validation.js';
import { encodeRgbaToPngAsync, resolveExplicitImageConverters } from '../../../shared/tools/functions/toolkit/image-codec.js';
import { readCorpusResource, validResourceBinding } from '../functions/corpus-inputs.js';
import { decodeSkillImage } from '../functions/image-decode.js';
import { applyImageOperation } from '../functions/image-operations.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const dimensions = image => ({ width: image.width, height: image.height });

// Volatile derived images, scoped to one agent and its pinned corpus. No host
// path tool, no answer lookup, no corpus mutation and no sandbox-input injection.
export class ExperimentImageTools {
  constructor(evaluation, { decode = decodeSkillImage, load = readCorpusResource } = {}) {
    this.evaluation = evaluation; this.decode = decode; this.load = load;
    this.artifacts = new Map(); this.bytes = 0; this.inspections = new Map(); this.previewDigest = null;
  }
  clear() { this.artifacts.clear(); this.bytes = 0; this.inspections.clear(); this.previewDigest = null; }
  releasePreview() { this.previewDigest = null; }
  context() {
    return this.inspections.size ? { retained_image_request: this.previewDigest, inspected_images: [...this.inspections.values()],
      image_reuse_rule: 'These recipes already succeeded. Keep visual findings in notes before replacing a preview. Do not repeat inspection to reconstruct history; proceed to the supported edit/proposal. Revisit only for a specific unresolved visual question when those pixels are no longer retained.' } : {};
  }
  async source(source, signal) {
    if (source.artifact) {
      const artifact = this.artifacts.get(source.artifact);
      if (!artifact) throw Error('Unknown or expired artifact; regenerate from the original resource.');
      return { bytes: artifact.bytes, id: hash(artifact.bytes), root: artifact.root };
    }
    const item = this.evaluation?.cases?.[source.case_index];
    const binding = item?.resources && Object.hasOwn(item.resources, source.alias) && item.resources[source.alias];
    if (!validResourceBinding(binding)) throw Error('Unknown corpus image alias. Select an in-scope corpus case.');
    const resource = this.evaluation.resources[binding.resource_id];
    if (!resource || resource.manifest?.resource_id !== binding.resource_id) throw Error('Missing corpus resource binding.');
    let bytes;
    try { bytes = await this.load(resource); } catch { throw Error('Corpus image is unavailable or failed integrity checks.'); }
    signal?.throwIfAborted();
    return { bytes, id: hash(bytes), root: { case_index: source.case_index, alias: source.alias, sha256: hash(bytes) } };
  }
  async execute(call, signal) {
    const tool = IMAGE_TOOLS.find(tool => tool.name === call.name);
    if (!tool || !validateToolArguments(tool, call.arguments).ok) throw Error('Invalid image tool request.');
    signal?.throwIfAborted();
    if (call.name === 'image.tools') return { result: { suite: 'image-manipulation', version: 1, limits: L, decoding: { png: 'native 8-bit non-interlaced PNG', jpeg_webp_available: resolveExplicitImageConverters().length > 0 }, operations: IMAGE_OPERATIONS }, images: [] };
    for (const variant of call.arguments.variants) for (const { op, ...args } of variant.steps) {
      const operation = IMAGE_OPERATIONS.find(item => item.name === op);
      if (!operation || !validateToolArguments({ name: op, parameters: operation.parameters }, args).ok) throw Error('Invalid image step parameters; use image.tools for the schema.');
    }
    const requestDigest = experimentDigest({ source: call.arguments.source,
      variants: call.arguments.variants.map(variant => ({ steps: variant.steps, preview: variant.preview !== false })) });
    const prior = this.inspections.get(requestDigest);
    if (prior && (!call.arguments.revisit_reason || this.previewDigest === requestDigest)) {
      return { result: { image_reuse: { blocked: true, request_digest: requestDigest,
        reason: this.previewDigest === requestDigest ? 'This preview is already attached. Use it and proceed.' : 'This recipe was already inspected. Use saved notes, or supply a specific revisit_reason if its absent pixels are still needed.' } }, images: [] };
    }
    const source = await this.source(call.arguments.source, signal), decoded = await this.decode(source.bytes, signal);
    const budget = { remaining: L.work }, rows = [], images = [], pending = [];
    // Stage the complete batch before retaining any artifacts. A bad recipe
    // cannot leave half a batch committed to the session cache.
    for (const variant of call.arguments.variants) {
      let current = decoded; const trace = [];
      for (const step of variant.steps) {
        signal?.throwIfAborted(); const before = dimensions(current);
        current = applyImageOperation(current, step, budget);
        trace.push({ ...step, input: before, output: dimensions(current) });
      }
      if (current.width * current.height > L.outputPixels) throw Error('Artifact exceeds output pixel limit; resize or crop first.');
      const png = await encodeRgbaToPngAsync(current.width, current.height, current.data); signal?.throwIfAborted();
      const pixelHash = hash(png), recipe = { suite: 'image-manipulation', version: 1, source_sha256: source.id, steps: variant.steps };
      const id = hash(JSON.stringify({ pixels: pixelHash, parent: source.id, root: source.root, recipe }));
      const row = { label: variant.label, artifact: id, sha256: pixelHash, bytes: png.length, source: source.root, parent_sha256: source.id, ...dimensions(current), recipe, recipe_sha256: hash(JSON.stringify(recipe)), trace };
      if (variant.preview !== false) {
        const { bytes: preview, width, height } = await imageSkillPreview(current, png);
        row.preview = { image_index: images.length, width, height, sha256: hash(preview) };
        images.push({ data: preview.toString('base64'), mimeType: 'image/png' });
      }
      rows.push(row); pending.push({ id, bytes: png, root: source.root });
    }
    if (pending.reduce((sum, item) => sum + item.bytes.length, 0) > L.cacheBytes) throw Error('Batch artifact bytes exceed session cache limit.');
    signal?.throwIfAborted();
    for (const item of pending) {
      if (this.artifacts.has(item.id)) { this.bytes -= this.artifacts.get(item.id).bytes.length; this.artifacts.delete(item.id); }
      while (this.artifacts.size && (this.artifacts.size >= L.artifacts || this.bytes + item.bytes.length > L.cacheBytes)) {
        const id = this.artifacts.keys().next().value; this.bytes -= this.artifacts.get(id).bytes.length; this.artifacts.delete(id);
      }
      this.artifacts.set(item.id, item); this.bytes += item.bytes.length;
    }
    this.inspections.delete(requestDigest);
    this.inspections.set(requestDigest, { request_digest: requestDigest, source: source.root, previewed: images.length > 0,
      variants: call.arguments.variants.map(variant => ({ label: variant.label, operations: variant.steps.map(step => step.op) })) });
    while (this.inspections.size > L.inspections || Buffer.byteLength(JSON.stringify([...this.inspections.values()])) > L.inspectionBytes) this.inspections.delete(this.inspections.keys().next().value);
    if (images.length) this.previewDigest = requestDigest;
    return { result: { suite: 'image-manipulation', version: 1, original: { sha256: source.id, decoder: decoded.decoder || 'provided', rgba_sha256: hash(decoded.data), ...dimensions(decoded) }, variants: rows, ephemeral: true }, images };
  }
}
