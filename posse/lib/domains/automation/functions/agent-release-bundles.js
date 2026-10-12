// Native bundle resolution for the release reconciler. The posse-bin builder
// publishes bundles/<product>/<version>/<os>/<arch>/<binary> plus
// <binary>.tar.gz (contract posse.native-artifact-tarball.v1, which carries
// the binary's own .sha256), and moves a version directory into bundles/ only
// after every target of it passed. A version is complete for this host when
// its linux/<arch> binary and tarball are both present.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { NATIVE_BINARIES } from "../../../catalog/binary.js";
import { validNativeArtifactVersion } from "../../../shared/native/functions/artifact-layout.js";
import { extractNativeArtifactTarball } from "../../../shared/native/functions/artifact-tarball.js";
import { demand } from "./policy.js";

const OS = "linux";

/** The linux file name a native package publishes. */
export function nativeProductFile(product) {
  const entry = Object.values(NATIVE_BINARIES).find(candidate => candidate.package === product);
  demand(entry, `Unknown native product: ${product}`, "invalid_request");
  return entry.platforms[OS].destinationFile;
}

const READ_NO_FOLLOW = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

function regularFile(io, filename) {
  const info = io.lstatSync(filename, { throwIfNoEntry: false });
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}

function realDirectory(io, dir) {
  const info = io.lstatSync(dir, { throwIfNoEntry: false });
  return Boolean(info?.isDirectory() && !info.isSymbolicLink());
}

function artifactError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Open a regular file for reading, refusing a symlink in its last component. */
function openRegularFile(io, filename, label) {
  let fd;
  try { fd = io.openSync(filename, READ_NO_FOLLOW); }
  catch (error) { throw artifactError("forbidden", `${label} must be a regular file: ${error?.code || error?.message || error}`); }
  if (!io.fstatSync(fd).isFile()) {
    io.closeSync(fd);
    throw artifactError("forbidden", `${label} must be a regular file`);
  }
  return fd;
}

function sha256Descriptor(io, fd) {
  const hash = crypto.createHash("sha256");
  const chunk = Buffer.alloc(1024 * 1024);
  for (let position = 0; ;) {
    const read = io.readSync(fd, chunk, 0, chunk.length, position);
    if (read === 0) return hash.digest("hex");
    hash.update(chunk.subarray(0, read));
    position += read;
  }
}

/**
 * Extract the tarball's binary to `outPath` (checked against the archive's
 * own .sha256) and require the published bare binary to be the same bytes.
 * Both files are read through descriptors opened without following a
 * symlink, so a path swapped after the check is never what gets read.
 *
 * @returns {Promise<string>} the binary's sha256
 */
export async function extractVerifiedBundleBinary({ io = fs, candidate, outPath, maxBytes, extract = extractNativeArtifactTarball }) {
  const label = `Native bundle file of ${candidate.product} ${candidate.version}`;
  const binaryFd = openRegularFile(io, candidate.binaryPath, label);
  let tarballFd = null;
  try {
    tarballFd = openRegularFile(io, candidate.tarballPath, label);
    const opened = `/proc/self/fd/${tarballFd}`;
    const tarballPath = io.existsSync(opened) ? opened : candidate.tarballPath;
    const extracted = await extract({ tarballPath, outPath, filename: candidate.filename, maxBytes, artifactError });
    demand(extracted.sha256 === sha256Descriptor(io, binaryFd),
      `Native bundle checksum mismatch: ${candidate.product} ${candidate.version}`, "artifact_checksum_mismatch");
    return extracted.sha256;
  } finally {
    io.closeSync(binaryFd);
    if (tarballFd !== null) io.closeSync(tarballFd);
  }
}

/**
 * The newest complete, checksum-verified bundle of each required product.
 *
 * @param {{ io?: typeof fs, artifactRoot: string, products: readonly string[], arch: string, scratchDir: string,
 *   maxBytes: number, extract?: typeof extractNativeArtifactTarball }} options
 */
export async function resolveNativeBundles({ io = fs, artifactRoot, products, arch, scratchDir, maxBytes, extract }) {
  const resolved = [];
  for (const product of products) {
    const filename = nativeProductFile(product);
    const productDir = path.join(artifactRoot, product);
    const info = io.lstatSync(productDir, { throwIfNoEntry: false });
    demand(info?.isDirectory() && !info.isSymbolicLink(), `No native bundles for ${product} under ${artifactRoot}`, "artifact_unavailable");
    const versions = io.readdirSync(productDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && validNativeArtifactVersion(entry.name) === entry.name)
      .map(entry => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }));
    const version = versions.find(candidate => {
      const dir = path.join(productDir, candidate, OS, arch);
      return realDirectory(io, path.join(productDir, candidate, OS)) && realDirectory(io, dir)
        && regularFile(io, path.join(dir, filename)) && regularFile(io, path.join(dir, `${filename}.tar.gz`));
    });
    demand(version, `No complete ${OS}/${arch} bundle for ${product}`, "artifact_unavailable");
    const dir = path.join(productDir, version, OS, arch);
    const candidate = { product, version, arch, filename, binaryPath: path.join(dir, filename), tarballPath: path.join(dir, `${filename}.tar.gz`) };
    const outPath = path.join(scratchDir, `${product}-${version}-${process.pid}-${crypto.randomUUID()}`);
    try {
      const sha256 = await extractVerifiedBundleBinary({ io, candidate, outPath, maxBytes, extract });
      resolved.push({ ...candidate, sha256 });
    } finally { io.rmSync(outPath, { force: true }); }
  }
  return resolved;
}
