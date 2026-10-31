import os from "node:os";
import path from "node:path";

export function defaultLocalGenerationModelRoot(homeDir = os.homedir()) {
  return path.join(homeDir, ".posse", "models");
}
export function defaultLocalGenerationRuntimeRoot(homeDir = os.homedir()) {
  return path.join(homeDir, ".posse", "runtime", "onnx-genai");
}
