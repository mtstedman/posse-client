import { scrubSecretText } from "../../../shared/telemetry/functions/logging/scrub-secret-text.js";

const WARNING_FILTER_INSTALLED = Symbol.for("posse.cli.warningFilterInstalled");

// Warnings about choices Posse made on purpose: they tell the user nothing.
const EXPECTED_WARNINGS = [
  // Posse stores state in node:sqlite; Node 24 releases before it was
  // declared stable announce that on every command that opens a store.
  (warning) => warning?.name === "ExperimentalWarning"
    && /^SQLite is an experimental feature/u.test(String(warning?.message || "")),
];

// Node's own printer honors --disable-warning=<code|type>; the replacement
// below must too.
function disabledWarnings(processLike) {
  const args = [
    ...(processLike.execArgv || []),
    ...String(processLike.env?.NODE_OPTIONS || "").split(/\s+/u),
  ];
  const disabled = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--disable-warning" && args[index + 1]) disabled.push(args[++index]);
    else if (arg.startsWith("--disable-warning=")) disabled.push(arg.slice("--disable-warning=".length));
  }
  return disabled;
}

// Node's one-line format: `(node:PID) [CODE] Name: message`, with the stack
// only under --trace-warnings (or --trace-deprecation for deprecations).
function formatWarningForLog(warning, processLike = process) {
  const name = String(warning?.name || "Warning");
  const trace = processLike.traceProcessWarnings
    || (name === "DeprecationWarning" && processLike.traceDeprecation);
  const body = trace && warning?.stack ? String(warning.stack) : `${name}: ${warning?.message ?? warning}`;
  const code = warning?.code ? `[${warning.code}] ` : "";
  const detail = typeof warning?.detail === "string" ? `\n${warning.detail}` : "";
  return scrubSecretText(`(node:${processLike.pid ?? process.pid}) ${code}${body}${detail}`);
}

export function installCliWarningFilter({
  processLike = process,
  suppressedCodes = ["DEP0040"],
  warn = (warning) => console.warn(formatWarningForLog(warning, processLike)),
} = {}) {
  if (processLike[WARNING_FILTER_INSTALLED]) return false;
  const suppressed = new Set([...suppressedCodes, ...disabledWarnings(processLike)].map((code) => String(code)).filter(Boolean));
  // Node prints warnings from its own 'warning' listener, so a second
  // listener printed each one twice (once with its stack) and could suppress
  // none. This takes that printer's place; under --no-warnings there is no
  // printer, and nothing is printed.
  const printers = processLike.listeners("warning");
  for (const printer of printers) processLike.removeListener("warning", printer);
  processLike.on("warning", (warning) => {
    if (printers.length === 0) return;
    if (suppressed.has(String(warning?.code || "")) || suppressed.has(String(warning?.name || ""))) return;
    if (warning?.name === "DeprecationWarning" && processLike.noDeprecation) return;
    if (EXPECTED_WARNINGS.some((expected) => expected(warning))) return;
    warn(warning);
  });
  processLike[WARNING_FILTER_INSTALLED] = true;
  return true;
}

export const __testWarningFilterInstalledSymbol = WARNING_FILTER_INSTALLED;
