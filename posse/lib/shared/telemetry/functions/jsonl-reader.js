import fs from "node:fs";

const READ_CHUNK_BYTES = 64 * 1024;

// Read complete UTF-8 lines before decoding so a multibyte character split
// across chunks is preserved. The caller can stop after its result limit.
export function* readJsonlLines(filePath, { reverse = false } = {}) {
  const fd = fs.openSync(filePath, "r");
  try {
    if (reverse) {
      let position = fs.fstatSync(fd).size;
      let carry = Buffer.alloc(0);
      while (position > 0) {
        const size = Math.min(position, READ_CHUNK_BYTES);
        const chunk = Buffer.allocUnsafe(size);
        const count = fs.readSync(fd, chunk, 0, size, position - size);
        if (count === 0) break;
        position -= size;
        const bytes = carry.length ? Buffer.concat([chunk.subarray(0, count), carry]) : chunk.subarray(0, count);
        let end = bytes.length;
        for (let i = bytes.length - 1; i >= 0; i--) {
          if (bytes[i] !== 10) continue;
          yield bytes.subarray(i + 1, end).toString("utf8");
          end = i;
        }
        carry = Buffer.from(bytes.subarray(0, end));
      }
      if (carry.length) yield carry.toString("utf8");
      return;
    }

    let position = 0;
    const fileSize = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    while (position < fileSize) {
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, fileSize - position), position);
      if (count === 0) break;
      position += count;
      const bytes = carry.length ? Buffer.concat([carry, chunk.subarray(0, count)]) : chunk.subarray(0, count);
      let start = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 10) continue;
        yield bytes.subarray(start, i).toString("utf8");
        start = i + 1;
      }
      carry = Buffer.from(bytes.subarray(start));
    }
    if (carry.length) yield carry.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
