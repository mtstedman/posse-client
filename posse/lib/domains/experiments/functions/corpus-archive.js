import { deflateRaw, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { EXPERIMENT_CORPUS_LIMITS as L } from '../../../catalog/experiment-corpus.js';

const deflate = promisify(deflateRaw), inflate = promisify(inflateRaw);
const filename = Buffer.from('payload');
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
export const corpusHash = bytes => createHash('sha256').update(bytes).digest('hex');

// Our ZIPs have exactly one entry named "payload", no extras, comments,
// symlinks, timestamps or platform attributes. Extraction never trusts paths
// inside an archive and never runs a general-purpose unzip command.
function headers(size, compressed, crc) {
  const local = Buffer.alloc(30 + filename.length);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(filename.length, 26); filename.copy(local, 30);
  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt16LE(33, 14);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(filename.length, 28); filename.copy(central, 46);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length + compressed, 16);
  return { local, tail: Buffer.concat([central, end]) };
}
export async function packCorpusResource(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > L.resourceBytes) throw new Error('Resource exceeds archive input limit.');
  const packed = await deflate(bytes, { level: 6 });
  const crc = crc32(bytes), { local, tail } = headers(bytes.length, packed.length, crc);
  const archive = Buffer.concat([local, packed, tail]);
  return { archive, manifest: { resource_id: corpusHash(bytes), archive_sha256: corpusHash(archive), archive_bytes: archive.length,
    files: [{ id: 'payload', sha256: corpusHash(bytes), bytes: bytes.length }], crc32: crc, compressed_bytes: packed.length } };
}
export async function unpackCorpusResource(archive, manifest) {
  const file = manifest?.files?.[0];
  if (!Buffer.isBuffer(archive) || manifest?.files?.length !== 1 || file?.id !== 'payload' || !Number.isInteger(file.bytes) || file.bytes < 0 || file.bytes > L.resourceBytes
    || !Number.isInteger(manifest.compressed_bytes) || manifest.compressed_bytes < 0 || manifest.compressed_bytes > L.resourceBytes + 1048576
    || !Number.isInteger(manifest.crc32) || manifest.crc32 < 0 || manifest.crc32 > 0xffffffff
    || archive.length !== manifest.archive_bytes || corpusHash(archive) !== manifest.archive_sha256) throw new Error('Resource archive identity or limits are invalid.');
  const { local, tail } = headers(file.bytes, manifest.compressed_bytes, manifest.crc32);
  if (archive.length !== local.length + manifest.compressed_bytes + tail.length || !archive.subarray(0, local.length).equals(local) || !archive.subarray(archive.length - tail.length).equals(tail)) throw new Error('Resource archive structure changed.');
  const bytes = await inflate(archive.subarray(local.length, archive.length - tail.length), { maxOutputLength: Math.max(1, file.bytes) });
  if (bytes.length !== file.bytes || crc32(bytes) !== manifest.crc32 || corpusHash(bytes) !== file.sha256 || file.sha256 !== manifest.resource_id) throw new Error('Unpacked resource identity changed.');
  return bytes;
}
