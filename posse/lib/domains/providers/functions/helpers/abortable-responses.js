// lib/provider/helpers/abortable-responses.js
//
// Shared cancellation wrapper for OpenAI-compatible Responses API calls.
// The SDK accepts AbortSignal as the second argument to responses.create().

function buildAbortError(providerLabel, label) {
  const err = new Error(`${providerLabel} API aborted during ${label}`);
  err.name = "AbortError";
  err.aborted = true;
  return err;
}

function buildStallError(providerLabel, baseStallSec, label) {
  const err = new Error(`${providerLabel} API stall: no response within ${baseStallSec}s for ${label}`);
  err.stallKill = true;
  return err;
}

export async function callAbortableResponsesCreate({
  client,
  requestOpts,
  label = "request",
  providerLabel = "Provider",
  externalSignal = null,
  stallMs = 600_000,
  baseStallSec = Math.ceil(stallMs / 1000),
  withRetry = null,
  emit = null,
} = {}) {
  if (!client?.responses?.create) {
    throw new Error("callAbortableResponsesCreate requires client.responses.create");
  }

  const controller = new AbortController();
  let timer = null;
  let removeExternalAbort = () => {};

  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
    throw buildAbortError(providerLabel, label);
  }

  const abortPromise = externalSignal
    ? new Promise((_, reject) => {
      const onAbort = () => {
        controller.abort(externalSignal.reason);
        reject(buildAbortError(providerLabel, label));
      };
      externalSignal.addEventListener("abort", onAbort, { once: true });
      removeExternalAbort = () => externalSignal.removeEventListener("abort", onAbort);
    })
    : null;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = buildStallError(providerLabel, baseStallSec, label);
      controller.abort(err);
      reject(err);
    }, Math.max(1, Number(stallMs) || 1));
  });

  const create = () => client.responses.create(requestOpts, { signal: controller.signal });
  const requestPromise = typeof withRetry === "function"
    ? withRetry(create, { emit, signal: controller.signal })
    : create();
  requestPromise.catch(() => {
    // If timeout/abort wins the race, the SDK promise may settle later.
    // Observing the rejection here prevents an unhandled-rejection warning.
  });

  try {
    const racers = abortPromise
      ? [requestPromise, timeoutPromise, abortPromise]
      : [requestPromise, timeoutPromise];
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    removeExternalAbort();
  }
}

export function createAbortableResponsesCaller(options = {}) {
  return (requestOpts, label) => callAbortableResponsesCreate({
    ...options,
    requestOpts,
    label,
  });
}
