// @ts-check

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  VALID_BINARY_NAMES,
  nativeBinaryEntry,
  nativeBinaryPlatform,
} from "../../../catalog/binary.js";
import { PulseTokenManager } from "../classes/PulseTokenManager.js";

export const NATIVE_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;
const ARTIFACT_ROUTE_GRANT = "artifacts:read";
const DOWNLOAD_TIMEOUT_MS = 120_000;
const ERROR_RESPONSE_MAX_BYTES = 4 * 1024;
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

export function defaultNativeArtifactCacheRoot() {
  // lib/shared/native/functions -> lib/bin. Downloads belong to the
  // Posse installation so a fresh process resolves the same versioned files
  // that install/update/boot populated.
  return path.resolve(THIS_DIR, "..", "..", "..", "bin");
}

/** @param {{ cacheRoot?: string, name: string, version: string }} args */
export function nativeArtifactBundleRoot({ cacheRoot = defaultNativeArtifactCacheRoot(), name, version }) {
  const entry = nativeBinaryEntry(name);
  if (!entry || !version) return null;
  const normalizedVersion = String(version || "").trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(normalizedVersion)
    || normalizedVersion.includes("..")) return null;
  return path.join(cacheRoot, entry.package, normalizedVersion);
}

/** @param {{ cacheRoot?: string, name: string, version: string, os: string, arch: string }} args */
export function nativeArtifactCachePath({ cacheRoot, name, version, os: osToken, arch }) {
  const entry = nativeBinaryEntry(name);
  const platform = nativeBinaryPlatform(name, osToken);
  const resolvedCacheRoot = cacheRoot || defaultNativeArtifactCacheRoot();
  const versionRoot = nativeArtifactBundleRoot({ cacheRoot: resolvedCacheRoot, name, version });
  if (!entry || !platform || !versionRoot || !platform.arches?.[arch]) return null;
  return {
    package: entry.package,
    version,
    bundleRoot: resolvedCacheRoot,
    binaryPath: path.join(versionRoot, osToken, arch, platform.destinationFile),
    checksumPath: path.join(versionRoot, osToken, arch, `${platform.destinationFile}.sha256`),
    filename: platform.destinationFile,
  };
}

/**
 * Find the newest locally cached artifact that still matches its SHA-256
 * sidecar. This is the offline/startup fallback: the server-issued version is
 * preferred whenever boot can refresh it, but a previously verified artifact
 * remains usable when that refresh is unavailable.
 *
 * @param {{ cacheRoot?: string, name: string, version?: string | null, os: string, arch: string }} args
 * @returns {Promise<Record<string, any> | null>}
 */
export async function findVerifiedNativeBinaryArtifact({
  cacheRoot = defaultNativeArtifactCacheRoot(),
  name,
  version = null,
  os: osToken,
  arch,
}) {
  const entry = nativeBinaryEntry(name);
  if (!entry) return null;
  let versions;
  if (String(version || "").trim()) {
    versions = [String(version).trim()];
  } else {
    try {
      versions = (await fsp.readdir(path.join(cacheRoot, entry.package), { withFileTypes: true }))
        .filter((candidate) => candidate.isDirectory()
          && /^[a-zA-Z0-9._-]{1,64}$/.test(candidate.name)
          && !candidate.name.includes(".."))
        .map((candidate) => candidate.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }));
    } catch {
      return null;
    }
  }
  for (const version of versions) {
    const selected = nativeArtifactCachePath({ cacheRoot, name, version, os: osToken, arch });
    if (!selected) continue;
    const sha256 = await verifiedCachedArtifact(selected.binaryPath, selected.checksumPath);
    if (sha256) return { ...selected, sha256, source: "cache-fallback", downloaded: false };
  }
  return null;
}

/**
 * @param {{
 *   name: string,
 *   version: string,
 *   os: string,
 *   arch: string,
 *   authManager: any,
 *   pulseTokens?: any,
 *   fetchImpl?: typeof fetch,
 *   cacheRoot?: string,
 *   maxBytes?: number,
 *   timeoutMs?: number,
 *   onProgress?: ((event: { type: string, phase: string, name: string, package: string, loadedBytes: number, totalBytes: number | null }) => void) | null,
 * }} args
 * @returns {Promise<Record<string, any>>}
 */
export async function ensureNativeBinaryArtifact({
  name,
  version,
  os: osToken,
  arch,
  authManager,
  pulseTokens = null,
  fetchImpl = globalThis.fetch,
  cacheRoot = defaultNativeArtifactCacheRoot(),
  maxBytes = NATIVE_ARTIFACT_MAX_BYTES,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  onProgress = null,
}) {
  if (!VALID_BINARY_NAMES.has(name)) {
    throw artifactError("POSSE_ARTIFACT_UNSUPPORTED", `unknown native artifact: ${name}`);
  }
  if (typeof fetchImpl !== "function") throw artifactError("POSSE_ARTIFACT_FETCH_UNAVAILABLE", "native artifact download requires fetch");
  if (!authManager?.getTrustedAuthPolicy || !authManager?.hasLaunchKey?.()) {
    throw artifactError("POSSE_ARTIFACT_AUTH_UNAVAILABLE", "native artifact download requires Posse authentication");
  }
  const policy = authManager.getTrustedAuthPolicy();
  if (!policy?.origin) throw artifactError("POSSE_ARTIFACT_AUTH_UNAVAILABLE", "trusted native artifact origin is unavailable");
  const broker = pulseTokens || new PulseTokenManager({ authManager, fetchImpl });
  const pulse = await broker.getPulseEnvelope({ requiredRoute: ARTIFACT_ROUTE_GRANT });
  if (!pulse?.token) throw artifactError("POSSE_ARTIFACT_AUTH_UNAVAILABLE", "native artifact pulse could not be minted");
  const issuedVersion = String(pulse.nativeArtifacts?.[nativeBinaryEntry(name)?.package] || "").trim();
  const selectedVersion = issuedVersion || String(version || "").trim();
  if (!selectedVersion) {
    throw artifactError("POSSE_ARTIFACT_VERSION_UNAVAILABLE", "heartbeat did not issue a native artifact version");
  }
  const selected = nativeArtifactCachePath({ cacheRoot, name, version: selectedVersion, os: osToken, arch });
  if (!selected) throw artifactError("POSSE_ARTIFACT_PLATFORM_UNSUPPORTED", "native artifact is unavailable for this platform");

  const cachedSha = await verifiedCachedArtifact(selected.binaryPath, selected.checksumPath);
  if (cachedSha) {
    return { ...selected, sha256: cachedSha, source: "cache", downloaded: false };
  }

  const url = `${policy.origin}/v1/native/artifacts/${encodeURIComponent(selected.package)}/${encodeURIComponent(selected.version)}/${encodeURIComponent(osToken)}/${encodeURIComponent(arch)}`;
  broker.assertTrustedResourceUrl(url, "native artifact download");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), positiveInteger(timeoutMs, DOWNLOAD_TIMEOUT_MS));
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/octet-stream",
        authorization: `Bearer ${pulse.token}`,
      },
      redirect: "error",
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === "AbortError") {
      throw artifactError("POSSE_ARTIFACT_TIMEOUT", "native artifact download timed out");
    }
    throw artifactError("POSSE_ARTIFACT_FETCH_FAILED", "native artifact download failed");
  }

  let responseComplete = false;
  try {
    if (!response.ok) {
      const detail = await readSmallResponse(response, ac.signal);
      responseComplete = true;
      clearTimeout(timer);
      const err = artifactError(
        response.status === 404 ? "POSSE_ARTIFACT_NOT_PUBLISHED" : "POSSE_ARTIFACT_REJECTED",
        `native artifact download was rejected with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
      err.status = response.status;
      throw err;
    }

    const expectedSha = response.headers.get("x-artifact-sha256")?.trim().toLowerCase() || "";
    if (!/^[a-f0-9]{64}$/.test(expectedSha)) {
      throw artifactError("POSSE_ARTIFACT_INVALID_RESPONSE", "native artifact response omitted a valid SHA-256 digest");
    }
    const digestSha = shaFromDigestHeader(response.headers.get("digest"));
    if (digestSha && digestSha !== expectedSha) {
      throw artifactError("POSSE_ARTIFACT_INVALID_RESPONSE", "native artifact response digest headers disagree");
    }
    const limit = positiveInteger(maxBytes, NATIVE_ARTIFACT_MAX_BYTES);
    const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(contentLength) && contentLength > limit) {
      throw artifactError("POSSE_ARTIFACT_TOO_LARGE", `native artifact exceeds the ${limit}-byte limit`);
    }
    const totalBytes = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null;
    reportArtifactProgress(onProgress, {
      type: "native-artifact-download",
      phase: "start",
      name,
      package: selected.package,
      loadedBytes: 0,
      totalBytes,
    });

    await fsp.mkdir(path.dirname(selected.binaryPath), { recursive: true });
    const partPath = `${selected.binaryPath}.part-${process.pid}-${randomUUID()}`;
    try {
      const actual = await writeResponseToPart(response, partPath, limit, ac.signal, (loadedBytes) => {
        reportArtifactProgress(onProgress, {
          type: "native-artifact-download",
          phase: "progress",
          name,
          package: selected.package,
          loadedBytes,
          totalBytes,
        });
      });
      responseComplete = true;
      clearTimeout(timer);
      if (actual.size === 0) {
        throw artifactError("POSSE_ARTIFACT_INVALID_RESPONSE", "native artifact response was empty");
      }
      if (Number.isFinite(contentLength) && actual.size !== contentLength) {
        throw artifactError("POSSE_ARTIFACT_INVALID_RESPONSE", "native artifact response length did not match its header");
      }
      if (actual.sha256 !== expectedSha) {
        throw artifactError("POSSE_ARTIFACT_CHECKSUM_MISMATCH", "native artifact checksum verification failed");
      }

      const concurrentSha = await verifiedCachedArtifact(selected.binaryPath, selected.checksumPath);
      if (concurrentSha) {
        await safeUnlink(partPath);
        return { ...selected, sha256: concurrentSha, source: "cache", downloaded: false };
      }
      await deleteInvalidCache(selected.binaryPath, selected.checksumPath);
      await fsp.rename(partPath, selected.binaryPath);
      if (osToken !== "windows") await fsp.chmod(selected.binaryPath, 0o755);
      await writeChecksumSidecar(selected.checksumPath, actual.sha256);
      await syncDirectory(path.dirname(selected.binaryPath));
      reportArtifactProgress(onProgress, {
        type: "native-artifact-download",
        phase: "complete",
        name,
        package: selected.package,
        loadedBytes: actual.size,
        totalBytes: actual.size,
      });
      return { ...selected, sha256: actual.sha256, size: actual.size, source: "remote", downloaded: true };
    } finally {
      await safeUnlink(partPath);
    }
  } catch (err) {
    if (!responseComplete && (ac.signal.aborted || err?.name === "AbortError")) {
      throw artifactError("POSSE_ARTIFACT_TIMEOUT", "native artifact download timed out");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** @param {{ binaryPath?: string, checksumPath?: string }} [args] */
export async function invalidateNativeArtifactCache({ binaryPath, checksumPath } = {}) {
  if (!binaryPath || !checksumPath) return;
  await deleteInvalidCache(binaryPath, checksumPath);
}

async function verifiedCachedArtifact(binaryPath, checksumPath) {
  try {
    const stat = await fsp.stat(binaryPath);
    if (!stat.isFile()) return null;
    const expected = (await fsp.readFile(checksumPath, "utf8")).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) return null;
    const actual = await sha256File(binaryPath);
    return actual === expected ? actual : null;
  } catch {
    return null;
  }
}

async function writeResponseToPart(response, partPath, maxBytes, signal, onChunk = null) {
  const handle = await fsp.open(partPath, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await readWithSignal(reader, signal);
          if (done) break;
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          size += chunk.byteLength;
          if (size > maxBytes) {
            try { await reader.cancel(); } catch { /* best effort */ }
            throw artifactError("POSSE_ARTIFACT_TOO_LARGE", `native artifact exceeds the ${maxBytes}-byte limit`);
          }
          hash.update(chunk);
          await handle.write(chunk);
          onChunk?.(size);
        }
      } finally {
        try { reader.releaseLock?.(); } catch { /* best effort */ }
      }
    } else {
      const chunk = new Uint8Array(await abortable(response.arrayBuffer(), signal));
      size = chunk.byteLength;
      if (size > maxBytes) throw artifactError("POSSE_ARTIFACT_TOO_LARGE", `native artifact exceeds the ${maxBytes}-byte limit`);
      hash.update(chunk);
      await handle.write(chunk);
      onChunk?.(size);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), size };
}

async function writeChecksumSidecar(checksumPath, sha256) {
  const part = `${checksumPath}.part-${process.pid}-${randomUUID()}`;
  const handle = await fsp.open(part, "wx", 0o600);
  try {
    await handle.writeFile(`${sha256}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await safeUnlink(checksumPath);
    await fsp.rename(part, checksumPath);
  } finally {
    await safeUnlink(part);
  }
}

async function deleteInvalidCache(binaryPath, checksumPath) {
  await safeUnlink(checksumPath);
  await safeUnlink(binaryPath);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function syncDirectory(dirPath) {
  let handle = null;
  try {
    handle = await fsp.open(dirPath, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on Windows; the files themselves were synced.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readSmallResponse(response, signal) {
  try {
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (size < ERROR_RESPONSE_MAX_BYTES) {
          const { done, value } = await readWithSignal(reader, signal);
          if (done) break;
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          const remaining = ERROR_RESPONSE_MAX_BYTES - size;
          chunks.push(chunk.subarray(0, remaining));
          size += Math.min(chunk.byteLength, remaining);
          if (chunk.byteLength > remaining || size >= ERROR_RESPONSE_MAX_BYTES) {
            try { await reader.cancel(); } catch { /* best effort */ }
            break;
          }
        }
      } finally {
        try { reader.releaseLock?.(); } catch { /* best effort */ }
      }
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
        .toString("utf8")
        .replace(/\s+/g, " ")
        .trim();
    }
    const text = await abortable(response.text(), signal);
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, ERROR_RESPONSE_MAX_BYTES);
  } catch {
    return "";
  }
}

function readWithSignal(reader, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => {});
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(reader.read()).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function abortError() {
  const err = new Error("operation aborted");
  err.name = "AbortError";
  return err;
}

function shaFromDigestHeader(value) {
  const match = /^sha-256=([A-Za-z0-9+/]+={0,2})$/.exec(String(value || "").trim());
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[1], "base64");
    return bytes.length === 32 ? bytes.toString("hex") : null;
  } catch {
    return null;
  }
}

async function safeUnlink(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function reportArtifactProgress(onProgress, event) {
  if (typeof onProgress !== "function") return;
  try { onProgress(event); } catch { /* progress reporting is observational */ }
}

function artifactError(code, message) {
  const err = /** @type {Error & { code: string, status?: number }} */ (new Error(message));
  err.code = code;
  return err;
}
