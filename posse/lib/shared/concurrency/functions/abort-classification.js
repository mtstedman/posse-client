// @ts-check



export function isAbortLikeError(err) {
  if (!err) return false;
  const anyErr = /** @type {any} */ (err);
  return anyErr.name === "AbortError"
    || anyErr.code === "ABORT_ERR"
    || anyErr.code === "DAEMON_ABORTED";
}
