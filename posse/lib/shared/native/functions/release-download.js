// @ts-check
//
// Download a native binary from a public GitHub release instead of the
// pulse-authenticated artifact service. This is the distribution path for
// binaries published on their own GitHub release channel — currently bossy,
// the fleet TUI — so the Posse repo does not have to carry every OS/arch
// binary. Each host fetches only its own platform's archive on demand and
// caches it in the versioned native cache (lib/bin/<pkg>/<version>/...), which
// is already gitignored, so nothing is committed.
//
// Release layout (see posse-bossy/.github/workflows/deploy.yml):
//   https://github.com/<owner>/<repo>/releases/download/v<version>/<asset>
//   asset = <pkg>-<os>-<arch>.<ext>   ext = zip (windows) | tar.gz (else)
//   each asset has a sibling "<asset>.sha256" ("<sha>  <asset>").
// Every archive contains exactly one flat member: the binary itself.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { nativeBinaryEntry } from "../../../catalog/binary.js";
import { nativeArtifactCachePath } from "./artifact-download.js";
import { defaultNativeBinRoot } from "./artifact-layout.js";

const DOWNLOAD_TIMEOUT_MS = 120_000;
const RELEASE_MAX_BYTES = 256 * 1024 * 1024;
const LATEST_VERSION_TTL_MS = 24 * 60 * 60 * 1000;

function releaseError(code, message) {
  const err = /** @type {Error & { code: string, status?: number }} */ (new Error(message));
  err.code = code;
  return err;
}

/** Archive file extension for a target OS. */
function archiveExt(osToken) {
  return osToken === "windows" ? "zip" : "tar.gz";
}

/** Release asset filename, e.g. "bossy-linux-x64.tar.gz". */
export function releaseAssetName({ pkg, os: osToken, arch }) {
  return `${pkg}-${osToken}-${arch}.${archiveExt(osToken)}`;
}

function latestStatePath(cacheRoot, pkg) {
  return path.join(cacheRoot, pkg, ".release-latest.json");
}

async function readLatestState(cacheRoot, pkg) {
  try {
    const raw = await fsp.readFile(latestStatePath(cacheRoot, pkg), "utf8");
    const parsed = JSON.parse(raw);
    const version = String(parsed?.version || "").trim();
    const checkedAt = Number(parsed?.checkedAt || 0);
    if (!version || !Number.isFinite(checkedAt)) return null;
    return { version, checkedAt };
  } catch {
    return null;
  }
}

async function writeLatestState(cacheRoot, pkg, version, nowMs) {
  try {
    const file = latestStatePath(cacheRoot, pkg);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const part = `${file}.part-${process.pid}-${randomUUID()}`;
    await fsp.writeFile(part, JSON.stringify({ version, checkedAt: nowMs }), "utf8");
    await fsp.rename(part, file);
  } catch {
    // The state file is a cache; a write failure just means we re-query sooner.
  }
}

function normalizeTag(tag) {
  return String(tag || "").trim().replace(/^v/i, "");
}

/**
 * Resolve the release version to install. A pinned version wins; otherwise the
 * latest published release tag is fetched from the GitHub API and TTL-cached so
 * boot does not hit the API (or its unauthenticated rate limit) every run.
 *
 * @returns {Promise<{ version: string | null, source: string }>}
 */
export async function resolveReleaseVersion({
  owner,
  repo,
  pkg,
  pinnedVersion = null,
  cacheRoot = defaultNativeBinRoot(),
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  ttlMs = LATEST_VERSION_TTL_MS,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
} = {}) {
  const pinned = normalizeTag(pinnedVersion);
  if (pinned) return { version: pinned, source: "pinned" };

  const cached = await readLatestState(cacheRoot, pkg);
  if (cached && nowMs - cached.checkedAt < ttlMs) {
    return { version: cached.version, source: "cache" };
  }
  if (typeof fetchImpl !== "function") {
    return { version: cached?.version || null, source: cached ? "cache-stale" : "unresolved" };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      method: "GET",
      headers: { accept: "application/vnd.github+json", "user-agent": "posse-native-release" },
      redirect: "follow",
      signal: ac.signal,
    });
    if (!response.ok) {
      // 404 = no releases cut yet. Fall back to any stale cache, else unresolved.
      return { version: cached?.version || null, source: cached ? "cache-stale" : "unresolved" };
    }
    const body = await response.json();
    const version = normalizeTag(body?.tag_name);
    if (!version) return { version: cached?.version || null, source: cached ? "cache-stale" : "unresolved" };
    await writeLatestState(cacheRoot, pkg, version, nowMs);
    return { version, source: "latest" };
  } catch {
    return { version: cached?.version || null, source: cached ? "cache-stale" : "unresolved" };
  } finally {
    clearTimeout(timer);
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function safeUnlink(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

async function verifiedCachedArtifact(binaryPath, checksumPath) {
  try {
    if (!(await fsp.stat(binaryPath)).isFile()) return null;
    const expected = (await fsp.readFile(checksumPath, "utf8")).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) return null;
    const actual = await sha256File(binaryPath);
    return actual === expected ? actual : null;
  } catch {
    return null;
  }
}

async function downloadToFile({ url, destPath, fetchImpl, maxBytes, signal, onProgress }) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/octet-stream", "user-agent": "posse-native-release" },
    redirect: "follow",
    signal,
  });
  if (!response.ok) {
    const err = releaseError(
      response.status === 404 ? "POSSE_RELEASE_NOT_PUBLISHED" : "POSSE_RELEASE_REJECTED",
      `release asset download failed with HTTP ${response.status}`,
    );
    err.status = response.status;
    throw err;
  }
  const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw releaseError("POSSE_RELEASE_TOO_LARGE", `release asset exceeds the ${maxBytes}-byte limit`);
  }
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const handle = await fsp.open(destPath, "w", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          size += chunk.byteLength;
          if (size > maxBytes) {
            try { await reader.cancel(); } catch { /* best effort */ }
            throw releaseError("POSSE_RELEASE_TOO_LARGE", `release asset exceeds the ${maxBytes}-byte limit`);
          }
          hash.update(chunk);
          await handle.write(chunk);
          onProgress?.(size);
        }
      } finally {
        try { reader.releaseLock?.(); } catch { /* best effort */ }
      }
    } else {
      const chunk = new Uint8Array(await response.arrayBuffer());
      size = chunk.byteLength;
      if (size > maxBytes) throw releaseError("POSSE_RELEASE_TOO_LARGE", `release asset exceeds the ${maxBytes}-byte limit`);
      hash.update(chunk);
      await handle.write(chunk);
      onProgress?.(size);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), size };
}

/** Parse a "<sha256>  <filename>" sidecar into just the digest. */
function parseSha256Sidecar(text) {
  const match = /^([a-f0-9]{64})\b/i.exec(String(text || "").trim());
  return match ? match[1].toLowerCase() : null;
}

function runExtractor(command, args, cwd) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(releaseError("POSSE_RELEASE_EXTRACT_FAILED", `${command} exited ${code}: ${stderr.trim().slice(0, 200)}`));
    });
  });
}

/**
 * Extract the single binary member from a release archive into `destDir`.
 * Archives are flat (one file), so we extract everything and take the member.
 * tar handles .tar.gz everywhere and .zip on Windows (bsdtar); PowerShell
 * Expand-Archive is the Windows fallback.
 *
 * @returns {Promise<string>} path to the extracted binary
 */
async function extractReleaseArchive({ archivePath, osToken, member, destDir }) {
  await fsp.mkdir(destDir, { recursive: true });
  if (osToken === "windows") {
    try {
      await runExtractor("tar", ["-xf", archivePath, "-C", destDir], destDir);
    } catch {
      await runExtractor("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
      ], destDir);
    }
  } else {
    await runExtractor("tar", ["-xzf", archivePath, "-C", destDir], destDir);
  }
  const extracted = path.join(destDir, member);
  if (!(await fsp.stat(extracted).then((s) => s.isFile()).catch(() => false))) {
    throw releaseError("POSSE_RELEASE_MEMBER_MISSING", `release archive did not contain ${member}`);
  }
  return extracted;
}

/**
 * Ensure the current platform's release binary is present in the versioned
 * native cache. Downloads + verifies + extracts on cache miss; returns the
 * same shape as ensureNativeBinaryArtifact so BinaryManager can consume it.
 *
 * @param {{
 *   name: string, os: string, arch: string, version: string,
 *   owner: string, repo: string,
 *   cacheRoot?: string, fetchImpl?: typeof fetch, maxBytes?: number,
 *   timeoutMs?: number, onProgress?: ((event: any) => void) | null,
 * }} args
 * @returns {Promise<Record<string, any>>}
 */
export async function ensureGithubReleaseBinary({
  name,
  os: osToken,
  arch,
  version,
  owner,
  repo,
  cacheRoot = defaultNativeBinRoot(),
  fetchImpl = globalThis.fetch,
  maxBytes = RELEASE_MAX_BYTES,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  onProgress = null,
}) {
  const entry = nativeBinaryEntry(name);
  if (!entry) throw releaseError("POSSE_RELEASE_UNSUPPORTED", `unknown native binary: ${name}`);
  if (!version) throw releaseError("POSSE_RELEASE_VERSION_UNAVAILABLE", "no release version resolved");
  if (typeof fetchImpl !== "function") throw releaseError("POSSE_RELEASE_FETCH_UNAVAILABLE", "release download requires fetch");

  const selected = nativeArtifactCachePath({ cacheRoot, name, version, os: osToken, arch });
  if (!selected) throw releaseError("POSSE_RELEASE_PLATFORM_UNSUPPORTED", "release binary unavailable for this platform");

  const cachedSha = await verifiedCachedArtifact(selected.binaryPath, selected.checksumPath);
  if (cachedSha) return { ...selected, version, sha256: cachedSha, source: "cache", downloaded: false };

  const asset = releaseAssetName({ pkg: entry.package, os: osToken, arch });
  const base = `https://github.com/${owner}/${repo}/releases/download/v${version}`;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `posse-release-${entry.package}-`));
  const archivePath = path.join(tmpDir, asset);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    onProgress?.({ type: "native-artifact-download", phase: "start", name, package: entry.package, loadedBytes: 0, totalBytes: null });
    const archive = await downloadToFile({
      url: `${base}/${asset}`,
      destPath: archivePath,
      fetchImpl,
      maxBytes,
      signal: ac.signal,
      onProgress: (loadedBytes) => onProgress?.({ type: "native-artifact-download", phase: "progress", name, package: entry.package, loadedBytes, totalBytes: null }),
    });

    // Verify the archive against its published .sha256 sidecar before trusting
    // its contents. A missing sidecar is fatal — we never install unverified.
    const sidecar = await fetchImpl(`${base}/${asset}.sha256`, {
      headers: { accept: "text/plain", "user-agent": "posse-native-release" },
      redirect: "follow",
      signal: ac.signal,
    });
    if (!sidecar.ok) throw releaseError("POSSE_RELEASE_CHECKSUM_MISSING", `release checksum sidecar missing (HTTP ${sidecar.status})`);
    const expected = parseSha256Sidecar(await sidecar.text());
    if (!expected) throw releaseError("POSSE_RELEASE_CHECKSUM_INVALID", "release checksum sidecar was malformed");
    if (archive.sha256 !== expected) throw releaseError("POSSE_RELEASE_CHECKSUM_MISMATCH", "release archive checksum did not match its sidecar");

    const extracted = await extractReleaseArchive({ archivePath, osToken, member: selected.filename, destDir: tmpDir });
    const binarySha = await sha256File(extracted);

    // Atomically publish into the versioned cache; write the binary's own
    // digest sidecar so later boots verify from cache without re-downloading.
    await fsp.mkdir(path.dirname(selected.binaryPath), { recursive: true });
    await safeUnlink(selected.binaryPath);
    await fsp.rename(extracted, selected.binaryPath).catch(async (err) => {
      if (err?.code !== "EXDEV") throw err;
      await fsp.copyFile(extracted, selected.binaryPath); // cross-device temp → cache
    });
    if (osToken !== "windows") await fsp.chmod(selected.binaryPath, 0o755);
    const sidecarPart = `${selected.checksumPath}.part-${process.pid}-${randomUUID()}`;
    await fsp.writeFile(sidecarPart, `${binarySha}\n`, "utf8");
    await fsp.rename(sidecarPart, selected.checksumPath);

    onProgress?.({ type: "native-artifact-download", phase: "complete", name, package: entry.package, loadedBytes: archive.size, totalBytes: archive.size });
    return { ...selected, version, sha256: binarySha, size: archive.size, source: "release", downloaded: true };
  } finally {
    clearTimeout(timer);
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
