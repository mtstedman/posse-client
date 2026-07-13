// @ts-check

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  nativeBinaryEntry,
  nativeBinaryPlatform,
} from "../../../catalog/binary.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERSION_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/** The installation-owned root shared by staging, downloads, and resolution. */
export function defaultNativeBinRoot() {
  return path.resolve(THIS_DIR, "..", "..", "..", "bin");
}

export function validNativeArtifactVersion(value) {
  const version = String(value || "").trim();
  return VERSION_RE.test(version) && !version.includes("..") ? version : null;
}

/** Direct, unversioned development override paths in resolution order. */
export function nativeDevelopmentBinaryPaths({
  binRoot = defaultNativeBinRoot(),
  name,
  os: osToken,
  arch,
}) {
  const platform = nativeBinaryPlatform(name, osToken);
  if (!platform?.arches?.[arch]) return [];
  return [
    path.join(binRoot, name, osToken, arch, platform.destinationFile),
    path.join(binRoot, name, osToken, platform.destinationFile),
  ];
}

export function nativeArtifactVersionRoot({
  binRoot = defaultNativeBinRoot(),
  name,
  version,
}) {
  const entry = nativeBinaryEntry(name);
  const normalizedVersion = validNativeArtifactVersion(version);
  if (!entry || !normalizedVersion) return null;
  return path.join(binRoot, entry.package, normalizedVersion);
}

/**
 * Canonical remotely issued artifact layout. Package name, filename, platform,
 * and architecture support all come from the binary catalog.
 */
export function nativeArtifactLayout({
  binRoot = defaultNativeBinRoot(),
  name,
  version,
  os: osToken,
  arch,
}) {
  const entry = nativeBinaryEntry(name);
  const platform = nativeBinaryPlatform(name, osToken);
  const normalizedVersion = validNativeArtifactVersion(version);
  if (!entry || !platform?.arches?.[arch] || !normalizedVersion) return null;
  const packageRoot = path.join(binRoot, entry.package);
  const versionRoot = nativeArtifactVersionRoot({ binRoot, name, version: normalizedVersion });
  if (!versionRoot) return null;
  const platformRoot = path.join(versionRoot, osToken);
  const binaryPath = platform.universal
    ? path.join(platformRoot, platform.destinationFile)
    : path.join(platformRoot, arch, platform.destinationFile);
  return {
    name,
    package: entry.package,
    version: normalizedVersion,
    binRoot,
    packageRoot,
    versionRoot,
    binaryPath,
    checksumPath: `${binaryPath}.sha256`,
    filename: platform.destinationFile,
  };
}

export function installedNativeArtifactVersionsSync({
  binRoot = defaultNativeBinRoot(),
  name,
}) {
  const entry = nativeBinaryEntry(name);
  if (!entry) return [];
  try {
    return sortVersions(fs.readdirSync(path.join(binRoot, entry.package), { withFileTypes: true })
      .filter((candidate) => candidate.isDirectory())
      .map((candidate) => validNativeArtifactVersion(candidate.name))
      .filter(Boolean));
  } catch {
    return [];
  }
}

export async function installedNativeArtifactVersions({
  binRoot = defaultNativeBinRoot(),
  name,
}) {
  const entry = nativeBinaryEntry(name);
  if (!entry) return [];
  try {
    return sortVersions((await fsp.readdir(path.join(binRoot, entry.package), { withFileTypes: true }))
      .filter((candidate) => candidate.isDirectory())
      .map((candidate) => validNativeArtifactVersion(candidate.name))
      .filter(Boolean));
  } catch {
    return [];
  }
}

function sortVersions(versions) {
  return versions.sort((left, right) => right.localeCompare(left, undefined, {
    numeric: true,
    sensitivity: "base",
  }));
}
