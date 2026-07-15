// @ts-check

import os from "node:os";
import path from "node:path";

import { nativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";
import {
  REMOTE_ARTIFACT_CATALOG_METHOD,
  REMOTE_ARTIFACT_DOWNLOAD_METHOD,
  REMOTE_ARTIFACT_STATUS_METHOD,
  REMOTE_MODEL_PACKAGE_DOWNLOAD_METHOD,
  runRemoteNativeArtifactJson,
} from "./native-client.js";

const CATALOG_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const STATUS_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const NATIVE_PROCESS_TIMEOUT_GRACE_MS = 60_000;

export function defaultLocalModelArtifactRoot(homeDir = os.homedir()) {
  return path.join(homeDir, ".posse", "artifacts");
}

export async function prepareLocalModelArtifactClient({
  manager = nativeBinaries,
  refresh = true,
  destinationRoot = defaultLocalModelArtifactRoot(),
} = {}) {
  if (manager.nativeAuthManager?.hasLaunchKey?.() !== true) {
    throw new Error("Local model downloads require a configured Posse key.");
  }
  const available = await manager.ensureAvailable("remote", { refresh });
  if (available?.available !== true) {
    throw new Error(`The native Remote client is unavailable (${available?.reason || "unknown"}).`);
  }
  const policy = manager.nativeAuthManager.getTrustedAuthPolicy?.();
  const baseUrl = String(policy?.origin || "").trim();
  if (!baseUrl) {
    throw new Error("The trusted Remote artifact origin is unavailable.");
  }
  return Object.freeze({ manager, baseUrl, destinationRoot: path.resolve(destinationRoot) });
}

export async function fetchLocalModelArtifactCatalog(client) {
  const value = await runRemoteNativeArtifactJson(
    REMOTE_ARTIFACT_CATALOG_METHOD,
    {
      baseUrl: client.baseUrl,
      timeoutMs: CATALOG_TIMEOUT_MS,
      maxRetries: 2,
      retryDelayMs: 1_000,
    },
    { manager: client.manager, timeoutMs: CATALOG_TIMEOUT_MS * 4 },
  );
  return validateLocalModelCatalog(value);
}

export async function downloadLocalModelArtifact(client, artifact, {
  onProgress = null,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  const payload = buildLocalModelDownloadPayload(client, artifact);
  const downloadId = payload.downloadId;

  const interval = Math.max(100, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
  for (let invocation = 0; invocation < 2; invocation += 1) {
    let settled = false;
    const tracked = runRemoteNativeArtifactJson(
      REMOTE_ARTIFACT_DOWNLOAD_METHOD,
      payload,
      { manager: client.manager, timeoutMs: nativeProcessTimeoutMs(payload.timeoutMs) },
    ).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    ).finally(() => {
      settled = true;
    });

    while (!settled) {
      await Promise.race([tracked, delay(interval)]);
      if (settled) break;
      try {
        const status = await runRemoteNativeArtifactJson(
          REMOTE_ARTIFACT_STATUS_METHOD,
          {
            destinationRoot: client.destinationRoot,
            downloadId,
          },
          { manager: client.manager, timeoutMs: STATUS_TIMEOUT_MS },
        );
        if (status && typeof status === "object" && !Array.isArray(status)) {
          onProgress?.(status);
        }
      } catch {
        // The downloader may not have atomically published its first status yet.
        // The authoritative download result below still fails closed.
      }
    }

    const outcome = await tracked;
    if (outcome.ok) return outcome.value;
    if (invocation === 0 && shouldRetryWithFreshPulse(outcome.error)) continue;
    throw outcome.error;
  }
  throw new Error("The local model download did not produce a result.");
}

export async function downloadLocalModelPackage(client, modelId, {
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
} = {}) {
  const normalizedModelId = String(modelId || "").trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9])?$/.test(normalizedModelId)) {
    throw new Error("The required local model ID is invalid.");
  }
  const effectiveTimeoutMs = positiveTimeoutMs(timeoutMs, DOWNLOAD_TIMEOUT_MS);
  for (let invocation = 0; invocation < 2; invocation += 1) {
    try {
      const value = await runRemoteNativeArtifactJson(
        REMOTE_MODEL_PACKAGE_DOWNLOAD_METHOD,
        {
          baseUrl: client.baseUrl,
          modelId: normalizedModelId,
          destinationRoot: client.destinationRoot,
          timeoutMs: effectiveTimeoutMs,
          maxRetries: 4,
          retryDelayMs: 1_000,
        },
        { manager: client.manager, timeoutMs: nativeProcessTimeoutMs(effectiveTimeoutMs) },
      );
      return validateModelPackageDownload(value, normalizedModelId);
    } catch (error) {
      if (invocation === 0 && shouldRetryWithFreshPulse(error)) continue;
      throw error;
    }
  }
  throw new Error("The required local model package did not produce a result.");
}

export function buildLocalModelDownloadPayload(client, artifact) {
  validateDownloadSelection(artifact);
  const downloadId = artifact.shorthand;
  return {
    baseUrl: client.baseUrl,
    shorthand: artifact.shorthand,
    expectedVersion: artifact.version,
    expectedBytes: artifact.bytes,
    expectedSha256: artifact.sha256,
    destinationRoot: client.destinationRoot,
    downloadId,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    maxRetries: 4,
    retryDelayMs: 1_000,
  };
}

export function validateLocalModelCatalog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The signed local model catalog response is invalid.");
  }
  const catalog = /** @type {Record<string, any>} */ (value);
  if (catalog.namespace !== "llm-models"
    || typeof catalog.revision !== "string"
    || !Array.isArray(catalog.artifacts)
    || catalog.artifacts.length === 0) {
    throw new Error("The signed local model catalog response is invalid.");
  }
  for (const artifact of catalog.artifacts) validateCatalogArtifact(artifact);
  return catalog;
}

function validateCatalogArtifact(artifact) {
  const recommendation = artifact?.recommendation;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)
    || !String(artifact.shorthand || "").trim()
    || !String(artifact.artifactId || "").trim()
    || !String(artifact.version || "").trim()
    || !String(artifact.displayName || "").trim()
    || !/^[a-f0-9]{64}$/.test(String(artifact.sha256 || ""))
    || !Number.isSafeInteger(artifact.bytes)
    || artifact.bytes <= 0
    || !recommendation
    || typeof recommendation !== "object"
    || Array.isArray(recommendation)
    || !String(recommendation.summary || "").trim()) {
    throw new Error("The signed local model catalog contains an invalid descriptor.");
  }
}

function validateDownloadSelection(artifact) {
  validateCatalogArtifact(artifact);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9])?$/.test(artifact.shorthand)
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9])?$/.test(artifact.version)) {
    throw new Error("The selected local model identity is invalid.");
  }
}

function validateModelPackageDownload(value, expectedModelId) {
  const result = value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
  if (!result
    || result.modelId !== expectedModelId
    || !String(result.profileId || "").trim()
    || !String(result.version || "").trim()
    || !String(result.archiveFormat || "").trim()
    || !String(result.archiveRoot || "").trim()
    || !path.isAbsolute(String(result.filePath || ""))
    || !Number.isSafeInteger(result.bytes)
    || result.bytes <= 0
    || !/^[a-f0-9]{64}$/.test(String(result.sha256 || ""))) {
    throw new Error("The native model package download response is invalid.");
  }
  return result;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryWithFreshPulse(error) {
  return /\b401\b|unauthori[sz]ed|pulse[^\n]*expired|heartbeat[^\n]*expired/i
    .test(String(error?.message || error || ""));
}

function positiveTimeoutMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1_000, parsed) : fallback;
}

function nativeProcessTimeoutMs(operationTimeoutMs) {
  return positiveTimeoutMs(operationTimeoutMs, DOWNLOAD_TIMEOUT_MS) + NATIVE_PROCESS_TIMEOUT_GRACE_MS;
}
