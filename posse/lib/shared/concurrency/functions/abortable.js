// @ts-check
// Race work against cancellation, removing the listener on every outcome.
// Cancellation does not stop the supplied operation; its owner remains
// responsible for aborting I/O. Late rejections are always observed.
export function abortable(promise, signal) {
  const work = Promise.resolve(promise);
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); reject(abortError()); };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export function abortError() {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}
