// Cancellation and stall wrapper for Anthropic Messages API calls. The SDK
// accepts an AbortSignal in the per-request options object.

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

export async function callAbortableMessagesCreate({
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
  if (!client?.messages?.create) {
    throw new Error("callAbortableMessagesCreate requires client.messages.create");
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

  const create = () => client.messages.create(requestOpts, { signal: controller.signal });
  const requestPromise = typeof withRetry === "function"
    ? withRetry(create, { emit, signal: controller.signal })
    : create();
  requestPromise.catch(() => {});

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

export function createAbortableMessagesCaller(options = {}) {
  return (requestOpts, label) => callAbortableMessagesCreate({
    ...options,
    requestOpts,
    label,
  });
}
