import fs from "node:fs";
import path from "node:path";
import { automationDataDir } from "../../automation/functions/paths.js";
import { ExperimentSandbox } from "../classes/ExperimentSandbox.js";
import { EXPERIMENT_RUNTIME_SCHEMA } from "../../../catalog/experiments.js";

// This file is installed by the operator, never through an experiment request.
// Unsupported/missing configuration disables execution, not campaign review.
export function experimentRuntimeConfig() {
  if (process.platform !== "linux") return {};
  const filename = path.join(automationDataDir(), "experiment-runtime.json");
  try {
    const info = fs.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 4194304) return {};
    const config = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (config.schema !== EXPERIMENT_RUNTIME_SCHEMA || !config.images || !config.evaluations) return {};
    return { backend: new ExperimentSandbox({ images: config.images }), evaluations: config.evaluations };
  } catch { return {}; }
}
