// The one route that puts a local model on this machine. `posse local install`
// and Admin differ only in how they ask for size confirmation and show
// progress; no transfer starts until `confirm` resolves true.
import path from "node:path";
import {
  ML_CAPABILITIES_METHOD,
  ML_INSTALL_IMAGE_MODEL_METHOD,
  ML_INSTALL_VIDEO_MODEL_METHOD,
  ML_MODEL_PACKAGE_INSTALL_METHOD,
} from "../../../catalog/binary.js";
import { LOCAL_MODEL_IDS } from "../../../catalog/local-model.js";
import { requireLocalModelCapability } from "./local-capabilities.js";

const LONG_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export async function openLocalRuntime({ manager, invoke, modelRoot, runtimeRoot, signal, onProgress }) {
  const run = invoke || (await import("../../../shared/native/functions/ml-invoke.js")).runMlNativeMethodAsync;
  const available = await manager.ensureAvailable("ml", { refresh: true });
  if (available?.available !== true) throw new Error(`Native ML runtime unavailable: ${available?.reason || "unknown"}`);
  signal?.throwIfAborted();
  const options = { manager, modelRoot, runtimeRoot, signal, timeoutMs: LONG_TIMEOUT_MS, idempotent: false, onProgress };
  const capabilities = (await run(ML_CAPABILITIES_METHOD, {}, options))?.capabilities;
  return { manager, invoke: run, options, capabilities, version: available.version };
}

// `confirm` receives { label, bytes, artifact? } and must resolve true before
// any model bytes are requested. Resolves { installed: false } when declined.
export async function installLocalModel(model, runtime, { confirm, source, onStage = () => {}, artifacts = {} }) {
  const capability = requireLocalModelCapability(model, runtime.capabilities, { version: runtime.version });
  return model.kind === "text"
    ? installSignedPackage(model, runtime, { confirm, onStage, artifacts })
    : installPinnedFiles(model, capability, runtime, { confirm, source, onStage });
}

async function installPinnedFiles(model, capability, runtime, { confirm, source, onStage }) {
  let request = { modelId: model.modelId, sourceDirectory: source ? path.resolve(source) : undefined };
  if (!source) {
    if (!capability.installation?.includes("pinned-download")) {
      throw new Error("This native runtime supports local-file installation only; update posse-ml or use --source DIR.");
    }
    const bytes = capability.models.find(candidate => candidate.id === model.modelId)?.bytes;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("Native model download size is missing.");
    if (!await confirm({ label: model.slug, bytes })) return { installed: false };
    request = { modelId: model.modelId, download: true };
  }
  runtime.options.signal?.throwIfAborted();
  onStage(source ? "Installing model files" : "Downloading model files");
  await runtime.invoke(model.kind === "video" ? ML_INSTALL_VIDEO_MODEL_METHOD : ML_INSTALL_IMAGE_MODEL_METHOD, request, runtime.options);
  return { installed: true };
}

async function installSignedPackage(model, runtime, { confirm, onStage, artifacts }) {
  const remote = await import("../../remote/functions/local-model-artifacts.js");
  const { terminalText } = await import("./local-models-command.js");
  const {
    prepareClient = remote.prepareLocalModelArtifactClient,
    fetchCatalog = remote.fetchLocalModelArtifactCatalog,
    downloadModel = remote.downloadLocalModelPackage,
  } = artifacts;
  const { signal } = runtime.options;
  const client = await prepareClient({ manager: runtime.manager });
  const catalog = await fetchCatalog(client);
  const artifact = catalog.artifacts.find(candidate => candidate.shorthand === model.slug
    && LOCAL_MODEL_IDS.includes(candidate.artifactId));
  if (!artifact) throw new Error(`Local model shorthand is not present in the signed catalog: ${model.slug}`);
  if (!await confirm({ label: terminalText(artifact.displayName), bytes: artifact.bytes, artifact })) return { installed: false };
  signal?.throwIfAborted();
  onStage("Downloading signed model package");
  const result = await downloadModel(client, artifact.artifactId, {
    expectedProfileId: `${artifact.artifactId}-int4-cpu`,
    expectedVersion: artifact.version,
    expectedArchiveFormat: artifact.archiveFormat,
    expectedArchiveRoot: artifact.family,
    expectedBytes: artifact.bytes,
    expectedSha256: artifact.sha256,
    signal,
  });
  assertSelectedPackage(result, artifact);
  signal?.throwIfAborted();
  onStage("Installing verified model package");
  await runtime.invoke(ML_MODEL_PACKAGE_INSTALL_METHOD, result, runtime.options);
  return { installed: true };
}

function assertSelectedPackage(result, artifact) {
  const expectedProfileId = `${artifact.artifactId}-int4-cpu`;
  if (result?.modelId !== artifact.artifactId
    || result?.profileId !== expectedProfileId
    || result?.version !== artifact.version
    || result?.archiveFormat !== artifact.archiveFormat
    || result?.archiveRoot !== artifact.family
    || result?.bytes !== artifact.bytes
    || result?.sha256 !== artifact.sha256) {
    throw new Error("The downloaded model package does not match the signed selection.");
  }
}
