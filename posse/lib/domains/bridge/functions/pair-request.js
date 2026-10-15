import { abortable } from "../../../shared/concurrency/functions/abortable.js";
import { readResponseTextWithLimit } from "../../remote/functions/client.js";

// One deadline covers pulse acquisition, HTTP headers, and the complete body.
// Racing auth also prevents a late pulse from issuing a request after cancel.
export async function requestBridgePair(url, {
  fetchImpl,
  authHeaders,
  body,
  signal = null,
  timeoutMs = 15_000,
  onResponse = null,
}) {
  const timeout = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(), Math.max(1, Number(timeoutMs) || 15_000));
  try {
    requestSignal.throwIfAborted();
    const headers = await abortable(authHeaders(), requestSignal);
    requestSignal.throwIfAborted();
    const response = await abortable(fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: requestSignal,
    }), requestSignal);
    onResponse?.(response);
    const text = await abortable(readResponseTextWithLimit(response, {
      operation: "Bridge pairing",
      url: "trusted pairing relay",
    }), requestSignal);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      const message = `HTTP ${response.status}: relay returned a non-JSON response`;
      // A successful confirmation may already be committed on the relay.
      // Treat a missing/truncated body like an interrupted read so the caller
      // can recover the identity by replaying the same confirmation.
      if (response.ok) throw new Error(message);
      parsed = { error: { message } };
    }
    return { response, body: parsed };
  } catch (error) {
    if (timeout.signal.aborted && !signal?.aborted) {
      throw new Error("Pairing relay request timed out", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
