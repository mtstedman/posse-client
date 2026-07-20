// @ts-check

import { ATLAS_JINA_MODEL } from "../../../../../catalog/atlas.js";
import { TEXT_SHAPE_VERSION } from "./build-symbol-text.js";

/**
 * @param {{ modelId: string, dim: number, dtype: string }} modelConfig
 */
export function atlasEmbeddingModelVersion(modelConfig = ATLAS_JINA_MODEL) {
  return `onnx-${modelConfig.modelId}-${modelConfig.dim}-${modelConfig.dtype}-text${TEXT_SHAPE_VERSION}`;
}
