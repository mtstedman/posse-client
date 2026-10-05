// Relay socket failures reach the bridge from our own Errors and from Node's
// bundled undici WebSocket, which reports an abnormal close (1006, including a
// refused connection) as `new TypeError("")`. Logging `err?.message || err`
// printed only "TypeError" for that case. These renderers always name the
// error, its code, and its cause chain, and never return an empty string.

const MAX_CAUSE_DEPTH = 3;

function errorName(value) {
  if (value && typeof value === "object") {
    if (typeof value.name === "string" && value.name.trim()) return value.name.trim();
    const constructorName = value.constructor?.name;
    if (constructorName && constructorName !== "Object") return constructorName;
  }
  return "Error";
}

function errorMessage(value) {
  const raw = value && typeof value === "object" ? value.message : value;
  const text = raw === undefined || raw === null ? "" : String(raw).trim();
  return text || "(no message)";
}

function firstStackFrame(value) {
  if (!value || typeof value !== "object" || typeof value.stack !== "string") return "";
  return value.stack.split("\n").map((line) => line.trim()).find((line) => line.startsWith("at ")) || "";
}

function renderRelayError(err, depth) {
  let text = `${errorName(err)}: ${errorMessage(err)}`;
  if (!err || typeof err !== "object") return text;
  if (err.code !== undefined && err.code !== null && err.code !== "") text += ` [code=${err.code}]`;
  if (err.cause !== undefined && err.cause !== null && depth < MAX_CAUSE_DEPTH) {
    text += ` [cause=${renderRelayError(err.cause, depth + 1)}]`;
  }
  return text;
}

/** `Name: message [code=…] [cause=Name: message …]` for any thrown value. */
export function formatRelayError(err) {
  return renderRelayError(err, 0);
}

/**
 * One relay error log line: the formatted error, the first stack frame of the
 * innermost error that has one (where the failure originated), and what the
 * relay client did about it.
 */
export function formatRelayErrorLog(err, { state, reconnectAttempt, reconnectScheduled } = {}) {
  let frame = "";
  let current = err;
  for (let depth = 0; current && typeof current === "object" && depth <= MAX_CAUSE_DEPTH; depth += 1) {
    frame = firstStackFrame(current) || frame;
    current = current.cause;
  }
  const reconnect = reconnectScheduled
    ? `reconnect attempt ${reconnectAttempt} scheduled`
    : "no reconnect scheduled";
  return `${formatRelayError(err)}${frame ? ` ${frame}` : ""} (state=${state || "unknown"}; ${reconnect})`;
}
