// @ts-check
//
// SyncChannel — the SharedArrayBuffer + Atomics mechanism shared by every
// blocking daemon call. A client resets the channel, sends its request out of
// band (postMessage to the broker), then blocks on Atomics.wait; the broker
// writes the JSON response into the buffer and notifies. One channel is reused
// serially per client (a blocking call can't overlap another on the same
// thread), so a single fixed buffer is sufficient.
//
// Layout: control[0] = signal (0 waiting, 1 ready, 2 overflow), control[1] =
// response length in bytes; the remainder is the response data region.

const HEADER_INTS = 2;
const HEADER_BYTES = HEADER_INTS * 4;

/**
 * @param {number} maxBytes
 * @returns {{ shared: SharedArrayBuffer, control: Int32Array, data: Uint8Array }}
 */
export function createSyncChannel(maxBytes) {
  const shared = new SharedArrayBuffer(HEADER_BYTES + maxBytes);
  return {
    shared,
    control: new Int32Array(shared, 0, HEADER_INTS),
    data: new Uint8Array(shared, HEADER_BYTES),
  };
}

/** Re-bind a channel view over a SharedArrayBuffer received in another thread. */
export function bindSyncChannel(shared) {
  return {
    shared,
    control: new Int32Array(shared, 0, HEADER_INTS),
    data: new Uint8Array(shared, HEADER_BYTES),
  };
}

/** Client: arm the channel before sending the matching request. */
export function channelArm(control) {
  Atomics.store(control, 0, 0);
}

/**
 * Client: block until the broker responds (or timeout). Returns the parsed
 * response object, or null on timeout/overflow (caller falls back).
 *
 * @param {Int32Array} control
 * @param {Uint8Array} data
 * @param {number} timeoutMs
 * @returns {Record<string, unknown> | null}
 */
export function channelWait(control, data, timeoutMs) {
  Atomics.wait(control, 0, 0, timeoutMs);
  if (Atomics.load(control, 0) !== 1) return null;
  const length = Atomics.load(control, 1);
  try {
    return JSON.parse(Buffer.from(data.buffer, data.byteOffset, length).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Broker: write a response object into the channel and wake the waiter.
 * Signals overflow (2) when the response exceeds the buffer.
 *
 * @param {Int32Array} control
 * @param {Uint8Array} data
 * @param {Record<string, unknown>} response
 */
export function channelRespond(control, data, response) {
  const bytes = Buffer.from(JSON.stringify(response), "utf8");
  if (bytes.length > data.length) {
    Atomics.store(control, 1, 0);
    Atomics.store(control, 0, 2);
  } else {
    data.set(bytes);
    Atomics.store(control, 1, bytes.length);
    Atomics.store(control, 0, 1);
  }
  Atomics.notify(control, 0);
}
