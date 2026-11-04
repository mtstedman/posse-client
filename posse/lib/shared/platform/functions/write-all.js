/**
 * Persist a complete chunk even when the filesystem accepts a short write.
 * @param {import("node:fs/promises").FileHandle} handle
 * @param {Uint8Array} bytes
 * @param {AbortSignal | null} [signal]
 */
export async function writeAllBytes(handle, bytes, signal = null) {
  let offset = 0;
  while (offset < bytes.length) {
    signal?.throwIfAborted();
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (bytesWritten <= 0) throw new Error("filesystem write made no progress");
    offset += bytesWritten;
  }
}
