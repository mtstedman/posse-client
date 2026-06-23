// Keep inherited Node entrypoint flags away from file-backed worker threads.
// Flags such as --input-type and -e are valid for stdin/eval launches but make
// Worker fail before it can run its module.

const SAFE_FLAGS_WITH_VALUES = new Set([
  "--conditions",
  "-C",
  "--disable-warning",
  "--experimental-loader",
  "--experimental-specifier-resolution",
  "--icu-data-dir",
  "--import",
  "--inspect-port",
  "--loader",
  "--redirect-warnings",
  "--require",
  "-r",
]);

const SAFE_FLAGS_WITHOUT_VALUES = new Set([
  "--enable-source-maps",
  "--experimental-vm-modules",
  "--no-deprecation",
  "--no-warnings",
  "--pending-deprecation",
  "--preserve-symlinks",
  "--preserve-symlinks-main",
  "--throw-deprecation",
  "--trace-deprecation",
  "--trace-uncaught",
  "--trace-warnings",
]);

const KNOWN_UNSAFE_FLAGS_WITH_VALUES = new Set([
  "--input-type",
  "--eval",
  "--print",
  "-e",
  "-p",
]);

const ENTRYPOINT_ONLY_FLAGS = new Set([
  "--check",
  "--interactive",
  "-c",
  "-i",
]);

const ENTRYPOINT_ONLY_PREFIXES = [
  "--input-type=",
  "--eval=",
  "--print=",
];

export function sanitizeWorkerExecArgv(execArgv = process.execArgv) {
  if (!Array.isArray(execArgv)) return [];
  const sanitized = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = String(execArgv[i] ?? "");
    const equalsAt = arg.indexOf("=");
    if (equalsAt > 0) {
      const name = arg.slice(0, equalsAt);
      if (SAFE_FLAGS_WITH_VALUES.has(name) || SAFE_FLAGS_WITHOUT_VALUES.has(name)) {
        sanitized.push(execArgv[i]);
      }
      continue;
    }
    if (SAFE_FLAGS_WITH_VALUES.has(arg)) {
      if (i + 1 < execArgv.length) {
        sanitized.push(execArgv[i], execArgv[++i]);
      }
      continue;
    }
    if (SAFE_FLAGS_WITHOUT_VALUES.has(arg)) {
      sanitized.push(execArgv[i]);
      continue;
    }
    if (KNOWN_UNSAFE_FLAGS_WITH_VALUES.has(arg)) {
      i += 1;
      continue;
    }
    if (ENTRYPOINT_ONLY_FLAGS.has(arg)) continue;
    if (ENTRYPOINT_ONLY_PREFIXES.some((prefix) => arg.startsWith(prefix))) continue;
    if (arg.startsWith("-") && i + 1 < execArgv.length && !String(execArgv[i + 1] ?? "").startsWith("-")) {
      i += 1;
    }
  }
  return sanitized;
}
