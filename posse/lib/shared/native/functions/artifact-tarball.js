// Reader for native artifact tarballs (contract posse.native-artifact-tarball.v1,
// ~/repos/docs/posse/plans/2026-10-04-native-artifact-tarballs.md). The
// publishing pipelines write a gzip'd ustar archive with exactly two regular
// files: the binary and `<binary>.sha256`. This reads only that shape: any
// other entry, link, directory, duplicate, or oversized member is rejected
// before its bytes are written anywhere.

import fs from "node:fs";
import fsp from "node:fs/promises";
import zlib from "node:zlib";
import { createHash } from "node:crypto";

export const NATIVE_ARTIFACT_TARBALL_FORMAT = "tar.gz";

const BLOCK = 512;
const MAX_SHA_ENTRY_BYTES = 128;

/**
 * True when a native artifact response carries the tarball rather than the
 * bare binary.
 * @param {{ get(name: string): string | null }} headers
 */
export function isNativeArtifactTarballResponse(headers) {
  const format = String(headers.get("x-artifact-format") || "").trim().toLowerCase();
  if (format) return format === NATIVE_ARTIFACT_TARBALL_FORMAT;
  const type = String(headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  return type === "application/gzip";
}

/**
 * Extract the binary named `filename` from the tarball at `tarballPath` into
 * `outPath` (created exclusively), verifying it against the archive's own
 * `<filename>.sha256`.
 *
 * @param {{ tarballPath: string, outPath: string, filename: string, maxBytes: number, artifactError: (code: string, message: string) => Error }} args
 * @returns {Promise<{ sha256: string, size: number }>}
 */
export async function extractNativeArtifactTarball({ tarballPath, outPath, filename, maxBytes, artifactError }) {
  const invalid = (message) => artifactError("POSSE_ARTIFACT_INVALID_RESPONSE", `native artifact tarball ${message}`);
  const source = fs.createReadStream(tarballPath).pipe(zlib.createGunzip());
  const reader = new ExactReader(source, invalid);
  const shaName = `${filename}.sha256`;
  let binary = null;
  let declaredSha = null;
  try {
    while (true) {
      const header = await reader.read(BLOCK);
      if (header.length === 0) throw invalid("ended without an end-of-archive marker");
      if (header.length < BLOCK) throw invalid("is truncated");
      if (isZeroBlock(header)) break;
      const entry = parseUstarHeader(header, invalid);
      if (entry.name === filename) {
        if (binary) throw invalid(`repeats ${filename}`);
        if (entry.size > maxBytes) {
          throw artifactError("POSSE_ARTIFACT_TOO_LARGE", `native artifact exceeds the ${maxBytes}-byte limit`);
        }
        binary = await writeEntry(reader, entry.size, outPath);
      } else if (entry.name === shaName) {
        if (declaredSha !== null) throw invalid(`repeats ${shaName}`);
        if (entry.size > MAX_SHA_ENTRY_BYTES) throw invalid(`has an oversized ${shaName}`);
        declaredSha = (await reader.read(entry.size)).toString("utf8").trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(declaredSha)) throw invalid(`has a malformed ${shaName}`);
      } else {
        throw invalid(`holds an unexpected entry: ${JSON.stringify(entry.name)}`);
      }
      await reader.skip(padding(entry.size));
    }
  } finally {
    source.destroy();
  }
  if (!binary) throw invalid(`is missing ${filename}`);
  if (declaredSha === null) throw invalid(`is missing ${shaName}`);
  if (binary.size === 0) throw invalid(`holds an empty ${filename}`);
  if (binary.sha256 !== declaredSha) {
    throw artifactError("POSSE_ARTIFACT_CHECKSUM_MISMATCH", "native artifact checksum verification failed");
  }
  return binary;
}

async function writeEntry(reader, size, outPath) {
  const handle = await fsp.open(outPath, "wx", 0o600);
  const hash = createHash("sha256");
  try {
    await reader.stream(size, async (chunk) => {
      hash.update(chunk);
      await handle.write(chunk);
    });
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), size };
}

function parseUstarHeader(header, invalid) {
  const magic = header.subarray(257, 263).toString("latin1");
  if (magic !== "ustar\0" && magic !== "ustar ") throw invalid("is not a ustar archive");
  const stored = parseOctal(header.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  if (stored !== sum) throw invalid("has a corrupt header");
  const type = header[156];
  // '0' and NUL are regular files; links, directories, and extension
  // headers are never part of the contract.
  if (type !== 0x30 && type !== 0) throw invalid("holds a non-file entry");
  const name = cString(header.subarray(0, 100));
  const prefix = cString(header.subarray(345, 500));
  const fullName = prefix ? `${prefix}/${name}` : name;
  if (!fullName || fullName.includes("/") || fullName.includes("\\")) {
    throw invalid(`holds an entry outside its root: ${JSON.stringify(fullName)}`);
  }
  const size = parseOctal(header.subarray(124, 136));
  if (!Number.isSafeInteger(size) || size < 0) throw invalid("has a corrupt entry size");
  return { name: fullName, size };
}

function parseOctal(field) {
  const text = cString(field).trim();
  if (!/^[0-7]+$/.test(text)) return Number.NaN;
  return Number.parseInt(text, 8);
}

function cString(field) {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function isZeroBlock(block) {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function padding(size) {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

// Reads exact byte counts from a stream of chunks.
class ExactReader {
  constructor(stream, invalid) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.ended = false;
    this.invalid = invalid;
  }

  async next() {
    try {
      const { value, done } = await this.iterator.next();
      if (done) this.ended = true;
      return done ? null : value;
    } catch {
      throw this.invalid("is not valid gzip");
    }
  }

  // Up to n bytes; fewer only at the end of the stream.
  async read(n) {
    while (this.buffer.length < n && !this.ended) {
      const chunk = await this.next();
      if (chunk) this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    }
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(out.length);
    return out;
  }

  async stream(n, onChunk) {
    let left = n;
    while (left > 0) {
      if (this.buffer.length === 0) {
        const chunk = this.ended ? null : await this.next();
        if (!chunk) throw this.invalid("is truncated");
        this.buffer = chunk;
      }
      const take = Math.min(left, this.buffer.length);
      await onChunk(this.buffer.subarray(0, take));
      this.buffer = this.buffer.subarray(take);
      left -= take;
    }
  }

  async skip(n) {
    await this.stream(n, () => {});
  }
}
