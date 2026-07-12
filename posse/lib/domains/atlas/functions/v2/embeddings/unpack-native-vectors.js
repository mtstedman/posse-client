// @ts-check

/**
 * @param {any} data
 * @param {number} expectedCount
 * @param {number} expectedDim
 * @param {string} [label]
 */
export function unpackNativeEmbeddingVectors(data, expectedCount, expectedDim, label = "ATLAS") {
  const count = Number(data?.count);
  const dim = Number(data?.dim);
  if (count !== expectedCount || dim !== expectedDim) {
    throw new RangeError(`${label} returned ${count}x${dim}, expected ${expectedCount}x${expectedDim}`);
  }
  const packed = Buffer.from(String(data?.vectors_b64 || ""), "base64");
  const expectedBytes = count * dim * Float32Array.BYTES_PER_ELEMENT;
  if (packed.byteLength !== expectedBytes) {
    throw new RangeError(`${label} returned ${packed.byteLength} vector bytes, expected ${expectedBytes}`);
  }
  return Array.from({ length: count }, (_, row) => {
    const vector = new Float32Array(dim);
    const offset = row * dim * Float32Array.BYTES_PER_ELEMENT;
    for (let column = 0; column < dim; column += 1) {
      vector[column] = packed.readFloatLE(offset + column * Float32Array.BYTES_PER_ELEMENT);
    }
    return vector;
  });
}
