export function abortError(message = "Operation aborted", options = {}) {
  const err = new Error(message, options);
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  return err;
}

export function isAbortError(err) {
  return err?.name === "AbortError" || err?.code === "ABORT_ERR";
}

export function signalAbortError(signal, message = "Operation aborted") {
  const reason = signal?.reason;
  if (isAbortError(reason)) return reason;
  if (reason instanceof Error) {
    const err = abortError(reason.message || message, { cause: reason });
    if (reason._killReason) err._killReason = reason._killReason;
    return err;
  }
  if (reason != null) {
    return abortError(String(reason), { cause: reason });
  }
  return abortError(message);
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signalAbortError(signal);
}

export function yieldNow({ signal = null } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const finish = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      reject(signalAbortError(signal));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    setImmediate(finish);
  });
}
