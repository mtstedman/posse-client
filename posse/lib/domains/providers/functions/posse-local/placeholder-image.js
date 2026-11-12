// The stand-in a local image request leaves while the model works: a valid,
// opaque PNG of the final size, so everything that only needs the file to
// exist (a manifest, a layout, a reference) can carry on.
import { createHash } from "node:crypto";
import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A light grey RGB PNG with a darker frame. `marker` is stored in the file
 * as a comment, so each placeholder has its own bytes and can be told apart
 * from any other file, including another placeholder of the same size.
 */
export function encodePlaceholderPng({ width, height, marker = "" }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const frame = Math.max(1, Math.round(Math.min(width, height) / 64));
  const row = (edge) => {
    const line = Buffer.alloc(1 + width * 3, edge ? 0xb0 : 0xe6);
    line[0] = 0; // filter: none
    if (!edge) for (const x of [...Array(frame).keys()].flatMap(i => [i, width - 1 - i])) line.fill(0xb0, 1 + x * 3, 4 + x * 3);
    return line;
  };
  const edge = row(true), inner = row(false);
  const rows = Array.from({ length: height }, (_, y) => (y < frame || y >= height - frame ? edge : inner));
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("tEXt", Buffer.from(`Comment\0${marker}`, "latin1")),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
