// @ts-check
//
// Managed CPython toolchain install. When a repo needs a Python environment
// (venv + pytest) but no usable interpreter exists on the machine — common on
// Windows, where only the Microsoft Store alias is present — doctor downloads
// a self-contained CPython build into <posseRoot>/.posse/runtime/python-toolchain
// so every python resolver has a findable interpreter without admin rights.

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { createHash } from "crypto";
import { Transform } from "stream";
import { pipeline } from "stream/promises";

import {
  DEFAULT_POSSE_ROOT,
  getPythonToolchainExecutable,
  getPythonToolchainRoot,
} from "../../runtime/functions/python-runtime.js";
import {
  commandOnPath,
  runCommand as runInstallCommand,
} from "./scip-install-runtime.js";

// python-build-standalone "install_only" archives: one tar.gz per platform
// containing a relocatable python/ tree with pip preinstalled.
export const PYTHON_TOOLCHAIN_RELEASE_TAG = "20241016";
export const PYTHON_TOOLCHAIN_VERSION = "3.12.7";
const PYTHON_TOOLCHAIN_BASE_URL = "https://github.com/astral-sh/python-build-standalone/releases/download";
const PYTHON_TOOLCHAIN_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
const PYTHON_TOOLCHAIN_TAR_MAX_BYTES = 1024 * 1024 * 1024;
export const PYTHON_TOOLCHAIN_SHA256 = Object.freeze({
  "cpython-3.12.7+20241016-aarch64-apple-darwin-install_only.tar.gz": "4c18852bf9c1a11b56f21bcf0df1946f7e98ee43e9e4c0c5374b2b3765cf9508",
  "cpython-3.12.7+20241016-aarch64-unknown-linux-gnu-install_only.tar.gz": "bba3c6be6153f715f2941da34f3a6a69c2d0035c9c5396bc5bb68c6d2bd1065a",
  "cpython-3.12.7+20241016-x86_64-apple-darwin-install_only.tar.gz": "60c5271e7edc3c2ab47440b7abf4ed50fbc693880b474f74f05768f5b657045a",
  "cpython-3.12.7+20241016-x86_64-pc-windows-msvc-install_only.tar.gz": "f05531bff16fa77b53be0776587b97b466070e768e6d5920894de988bdcd547a",
  "cpython-3.12.7+20241016-x86_64-pc-windows-msvc-shared-install_only.tar.gz": "f05531bff16fa77b53be0776587b97b466070e768e6d5920894de988bdcd547a",
  "cpython-3.12.7+20241016-x86_64-unknown-linux-gnu-install_only.tar.gz": "43576f7db1033dd57b900307f09c2e86f371152ac8a2607133afa51cbfc36064",
});

/**
 * @param {{ platform?: NodeJS.Platform, arch?: string }} [input]
 * @returns {string[]} ordered release asset names to try
 */
export function pythonToolchainAssetCandidates({ platform = process.platform, arch = process.arch } = {}) {
  const version = `${PYTHON_TOOLCHAIN_VERSION}+${PYTHON_TOOLCHAIN_RELEASE_TAG}`;
  const assetsFor = (triple) => [
    `cpython-${version}-${triple}-install_only.tar.gz`,
    `cpython-${version}-${triple}-shared-install_only.tar.gz`,
  ].filter((asset) => PYTHON_TOOLCHAIN_SHA256[asset]);
  if (platform === "win32") {
    // arm64 Windows runs x86_64 binaries under emulation, so keep the x86_64
    // asset as a fallback for release tags without native arm64 builds.
    return arch === "arm64"
      ? [...assetsFor("aarch64-pc-windows-msvc"), ...assetsFor("x86_64-pc-windows-msvc")]
      : assetsFor("x86_64-pc-windows-msvc");
  }
  if (platform === "darwin") {
    return assetsFor(arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin");
  }
  return assetsFor(arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu");
}

/**
 * Ensure the managed CPython toolchain is installed and runnable.
 *
 * @param {{
 *   posseRoot?: string,
 *   dryRun?: boolean,
 *   timeoutMs?: number | null,
 *   onProgress?: ((message: string) => void) | null,
 *   platform?: NodeJS.Platform,
 *   arch?: string,
 *   runCommand?: typeof runInstallCommand,
 *   isCommandOnPath?: typeof commandOnPath,
 * }} [input]
 * @returns {Promise<{ ok: boolean, status: string, message: string, python: string }>}
 */
export async function ensureManagedPythonToolchain({
  posseRoot = DEFAULT_POSSE_ROOT,
  dryRun = false,
  timeoutMs = null,
  onProgress = null,
  platform = process.platform,
  arch = process.arch,
  runCommand = runInstallCommand,
  isCommandOnPath = commandOnPath,
} = {}) {
  const root = getPythonToolchainRoot(posseRoot);
  const python = getPythonToolchainExecutable(posseRoot);

  if (fs.existsSync(python)) {
    const probe = await runCommand(python, ["--version"], { timeoutMs: 30_000 });
    if (probe.ok) {
      return { ok: true, status: "ok", message: `managed CPython ready (${probe.message || PYTHON_TOOLCHAIN_VERSION})`, python };
    }
    if (!dryRun) {
      // A broken install (interrupted extract, deleted DLLs) must not shadow a
      // fresh one; clear it and fall through to reinstall.
      try { fs.rmSync(path.join(root, "python"), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  if (dryRun) {
    return {
      ok: true,
      status: "dry-run",
      message: `would download CPython ${PYTHON_TOOLCHAIN_VERSION} (python-build-standalone) into ${root}`,
      python,
    };
  }

  for (const tool of ["curl", "tar"]) {
    if (!(await isCommandOnPath(tool))) {
      return {
        ok: false,
        status: "failed",
        message: `${tool} not found; install ${tool} or install Python manually so it is on PATH`,
        python,
      };
    }
  }

  await fs.promises.mkdir(root, { recursive: true });
  const installDir = path.join(root, "python");
  // A prior interrupted extraction may leave the directory without the
  // executable checked above. It cannot be the destination of the atomic
  // staging rename, so clear only this managed install directory first.
  if (fs.existsSync(installDir) && !fs.existsSync(python)) {
    await fs.promises.rm(installDir, { recursive: true, force: true });
  }
  const archivePath = path.join(root, "cpython.download.tar.gz");
  const tarPath = path.join(root, "cpython.download.tar");
  const stagingRoot = path.join(root, `.python-extract-${process.pid}`);
  const errors = [];
  for (const asset of pythonToolchainAssetCandidates({ platform, arch })) {
    const url = `${PYTHON_TOOLCHAIN_BASE_URL}/${PYTHON_TOOLCHAIN_RELEASE_TAG}/${asset}`;
    onProgress?.(`downloading ${asset}`);
    const download = await runCommand("curl", [
      "-fsSL", "--retry", "2", "--max-filesize", String(PYTHON_TOOLCHAIN_ARCHIVE_MAX_BYTES),
      "-o", archivePath, url,
    ], { timeoutMs });
    if (!download.ok) {
      errors.push(`${asset}: ${download.message || "download failed"}`);
      await unlinkIfExists(archivePath);
      continue;
    }
    const archiveStat = await fs.promises.stat(archivePath).catch(() => null);
    if (!archiveStat || archiveStat.size <= 0 || archiveStat.size > PYTHON_TOOLCHAIN_ARCHIVE_MAX_BYTES) {
      errors.push(`${asset}: archive size is outside the allowed range`);
      await unlinkIfExists(archivePath);
      continue;
    }
    let actualSha256;
    try {
      actualSha256 = await sha256File(archivePath);
    } catch (err) {
      errors.push(`${asset}: checksum failed: ${err?.message || err}`);
      await unlinkIfExists(archivePath);
      continue;
    }
    if (actualSha256 !== PYTHON_TOOLCHAIN_SHA256[asset]) {
      errors.push(`${asset}: SHA-256 checksum mismatch`);
      await unlinkIfExists(archivePath);
      continue;
    }
    onProgress?.(`extracting ${asset}`);
    // Gunzip with node's zlib: GNU tar's -z shells out to a gzip binary that
    // minimal environments lack, while plain -x works with GNU tar and bsdtar.
    try {
      await pipeline(
        fs.createReadStream(archivePath),
        zlib.createGunzip(),
        byteLimitTransform(PYTHON_TOOLCHAIN_TAR_MAX_BYTES),
        fs.createWriteStream(tarPath, { mode: 0o600 }),
      );
    } catch (err) {
      errors.push(`${asset}: gunzip failed: ${err?.message || err}`);
      await unlinkIfExists(archivePath);
      await unlinkIfExists(tarPath);
      continue;
    }
    await unlinkIfExists(archivePath);
    await fs.promises.rm(stagingRoot, { recursive: true, force: true });
    await fs.promises.mkdir(stagingRoot, { recursive: true });
    const extract = await runCommand("tar", ["-xf", tarPath, "-C", stagingRoot], { timeoutMs });
    await unlinkIfExists(tarPath);
    if (!extract.ok) {
      errors.push(`${asset}: extract failed: ${extract.message}`);
      await fs.promises.rm(stagingRoot, { recursive: true, force: true });
      continue;
    }
    const stagedPython = path.join(stagingRoot, "python");
    if (!fs.existsSync(stagedPython)) {
      errors.push(`${asset}: archive did not contain the expected python directory`);
      await fs.promises.rm(stagingRoot, { recursive: true, force: true });
      continue;
    }
    await fs.promises.rename(stagedPython, installDir);
    await fs.promises.rm(stagingRoot, { recursive: true, force: true });
    const probe = await runCommand(python, ["--version"], { timeoutMs: 30_000 });
    if (!probe.ok) {
      errors.push(`${asset}: installed python failed its --version probe: ${probe.message}`);
      try { fs.rmSync(path.join(root, "python"), { recursive: true, force: true }); } catch { /* best effort */ }
      continue;
    }
    return {
      ok: true,
      status: "installed",
      message: `installed managed CPython ${PYTHON_TOOLCHAIN_VERSION} (${probe.message || asset})`,
      python,
    };
  }
  return {
    ok: false,
    status: "failed",
    message: `managed CPython ${PYTHON_TOOLCHAIN_VERSION} download failed (${errors.join("; ")}); install Python manually and re-run posse doctor`,
    python,
  };
}

function byteLimitTransform(maxBytes) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      callback(total > maxBytes
        ? new Error(`decompressed archive exceeds the ${maxBytes}-byte limit`)
        : null, chunk);
    },
  });
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

async function unlinkIfExists(file) {
  try { await fs.promises.unlink(file); } catch { /* best effort */ }
}
