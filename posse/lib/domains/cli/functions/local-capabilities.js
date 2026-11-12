import { OS_BY_NODE_PLATFORM } from "../../../catalog/binary.js";

export function requireLocalModelCapability(model, capabilities, { version = "unknown", platform = process.platform, arch = process.arch } = {}) {
  const capability = model.kind === "video" ? capabilities?.videoGeneration : model.kind === "image" ? capabilities?.imageGeneration : capabilities?.generation;
  const runtime = `posse-ml ${version}`;
  const entry = capability?.models?.find(candidate => candidate.id === model.modelId);
  if (!entry) {
    throw new Error(`${model.slug} is unavailable in this native runtime (${runtime}). Update posse-ml to an artifact that includes this model.`);
  }
  // Text profiles run on different engines, so each reports its own support;
  // runtimes that predate per-model support report it for the ONNX engine.
  if (model.kind !== "text" ? capability.supported : entry.supported ?? capability.runtime?.supported) return capability;

  const current = `${OS_BY_NODE_PLATFORM[platform] || platform}-${arch}`;
  let reason = capability.unsupportedReason;
  if (!reason && capability.platforms?.length && !capability.platforms.includes(current)) {
    reason = `this artifact includes the ${model.kind} engine for ${capability.platforms.join(", ")}; this machine is ${current}`;
  }
  if (!reason && capability.requiredCpuFeatures?.length) {
    reason = `this CPU must expose ${capability.requiredCpuFeatures.join(", ")}`;
  }
  throw new Error(`${model.slug} cannot run with ${runtime} on ${current}: ${reason || "the runtime reports generation is unsupported on this platform"}.`);
}
