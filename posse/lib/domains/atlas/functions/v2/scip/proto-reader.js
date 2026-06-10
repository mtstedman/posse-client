// @ts-check
//
// Minimal hand-rolled protobuf reader. Only what the SCIP consumer needs:
// varints, length-delimited fields (string, bytes, sub-message), and the
// ability to skip over unknown fields without losing position.
//
// We deliberately don't depend on `protobufjs` — adding a runtime dependency
// for protobuf parsing widens posse's surface area, and the SCIP wire format
// we touch is a closed set. If new fields show up later we just add cases.

/**
 * @typedef {Object} ProtoReader
 * @property {() => boolean} done
 * @property {() => { fieldNumber: number, wireType: number }} readTag
 * @property {() => number} readUInt32
 * @property {() => number} readInt32
 * @property {() => bigint} readUInt64
 * @property {() => bigint} readInt64
 * @property {() => string} readString
 * @property {() => Uint8Array} readBytes
 * @property {() => ProtoReader} readSubMessage
 * @property {(wireType: number) => void} skipField
 * @property {() => number} position
 */

/**
 * Wrap a Buffer in a reader. Independent positions: a sub-message reader
 * advances its own cursor without touching the parent's.
 *
 * @param {Buffer | Uint8Array} buf
 * @param {number} [start]
 * @param {number} [end]
 * @returns {ProtoReader}
 */
export function createProtoReader(buf, start = 0, end = buf.length) {
  const view = buf instanceof Buffer ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = start;
  const limit = end;

  function readVarintRaw() {
    let result = 0n;
    let shift = 0n;
    let byte;
    do {
      if (pos >= limit) throw new Error("proto-reader: unexpected end of input in varint");
      byte = view[pos++];
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) && shift >= 70n) throw new Error("proto-reader: varint too long");
    } while (byte & 0x80);
    return result;
  }

  return {
    done() { return pos >= limit; },

    position() { return pos; },

    readTag() {
      const v = readVarintRaw();
      const fieldNumber = Number(v >> 3n);
      const wireType = Number(v & 0x7n);
      return { fieldNumber, wireType };
    },

    readUInt32() {
      return Number(readVarintRaw()) >>> 0;
    },

    readInt32() {
      // Protobuf int32 is sign-extended to 64 bits on the wire; cast back.
      const v = readVarintRaw();
      const masked = v & 0xffffffffn;
      const signed = masked & 0x80000000n ? Number(masked) - 0x1_0000_0000 : Number(masked);
      return signed;
    },

    readUInt64() {
      return readVarintRaw();
    },

    readInt64() {
      // sint vs int — protobuf int64 is two's-complement varint, no zigzag.
      const raw = readVarintRaw();
      if (raw & (1n << 63n)) return raw - (1n << 64n);
      return raw;
    },

    readString() {
      const len = Number(readVarintRaw());
      if (pos + len > limit) throw new Error("proto-reader: string overflows buffer");
      const out = view.toString("utf8", pos, pos + len);
      pos += len;
      return out;
    },

    readBytes() {
      const len = Number(readVarintRaw());
      if (pos + len > limit) throw new Error("proto-reader: bytes overflow buffer");
      const out = view.subarray(pos, pos + len);
      pos += len;
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    },

    readSubMessage() {
      const len = Number(readVarintRaw());
      if (pos + len > limit) throw new Error("proto-reader: sub-message overflows buffer");
      const sub = createProtoReader(view, pos, pos + len);
      pos += len;
      return sub;
    },

    skipField(wireType) {
      switch (wireType) {
        case 0: readVarintRaw(); return;
        case 1: {
          if (pos + 8 > limit) throw new Error("proto-reader: fixed64 overflows buffer");
          pos += 8;
          return;
        }
        case 2: {
          const len = Number(readVarintRaw());
          if (pos + len > limit) throw new Error("proto-reader: length-delimited field overflows buffer");
          pos += len;
          return;
        }
        case 5: {
          if (pos + 4 > limit) throw new Error("proto-reader: fixed32 overflows buffer");
          pos += 4;
          return;
        }
        default:
          throw new Error(`proto-reader: unsupported wire type ${wireType}`);
      }
    },
  };
}

/**
 * Read every (tag, value) pair in `reader` and feed them to `consume`.
 * The consumer chooses whether to interpret each field by `fieldNumber`
 * and `wireType`. Any field that returns `false` is skipped using the
 * standard wire-type rules.
 *
 * @param {ProtoReader} reader
 * @param {(reader: ProtoReader, fieldNumber: number, wireType: number) => boolean} consume
 */
export function readAllFields(reader, consume) {
  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.readTag();
    const handled = consume(reader, fieldNumber, wireType);
    if (!handled) reader.skipField(wireType);
  }
}
