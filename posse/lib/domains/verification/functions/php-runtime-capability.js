import { TEST_SUBPROCESS_ENV_KEYS } from "../../../catalog/process.js";
import { filterProcessEnv } from "../../../shared/platform/functions/process-env.js";
import { spawnSync } from "node:child_process";
import { PHP_RUNTIME_SYMBOL_EXTENSIONS } from "../../../catalog/php-runtime-capabilities.js";
import { parseCommandArguments } from "../../../shared/scope/functions/test-command.js";
import { phpUnitFailureReport } from "../../worker/functions/helpers/test-failure-evidence.js";

function missingExtension(diagnostic) {
  const match = /^(?:PHP Fatal error:\s+Uncaught |Error:\s+|Uncaught Error:\s+)?(?:Undefined constant ["']([^"']+)["']|Call to undefined function ([\w]+)\(\)|Class ["']([^"']+)["'] not found)(?:\s|$)/i.exec(diagnostic);
  const symbol = match && (match[1] || match[2] || match[3]);
  return symbol ? PHP_RUNTIME_SYMBOL_EXTENSIONS[symbol] || null : null;
}

/** Require complete failure evidence and confirm the runtime lacks the named
 * extension using the same PHP executable/configuration as the failed check. */
export function missingPhpRuntimeCapabilities(command, result, { projectRoot, probe = spawnSync } = {}) {
  if (result.stdout_truncated || result.stderr_truncated || result.signal || result.timed_out) return null;
  let argv;
  try { argv = parseCommandArguments(command); } catch { return null; }
  const executable = argv.shift();
  if (!/(?:^|[\\/])php(?:\.exe)?$/i.test(executable || "")) return null;
  const options = [];
  while (argv[0]?.startsWith("-")) {
    const option = argv.shift();
    if (option === "-n") options.push(option);
    else if (["-d", "-c"].includes(option) && argv.length) options.push(option, argv.shift());
    else return null; // Do not probe a different/unknown invocation configuration.
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const report = phpUnitFailureReport(output);
  let diagnostics;
  if (report) {
    if (report.counts.failures > 0) return null;
    diagnostics = report.failures.map((failure) => failure.diagnostic);
  } else {
    // Without a structured report, accept only a single fatal PHP error and
    // its stack trace, not an arbitrary runner's mixed pass/fail output.
    const lines = output.trim().split(/\r?\n/);
    if (!/^(?:PHP )?Fatal error: Uncaught Error: /.test(lines[0] || "")) return null;
    if (lines.slice(1).some((line) => !/^(?:Stack trace:|#\d+ |\s*thrown in |\s*$)/.test(line))) return null;
    diagnostics = [lines[0].replace(/^(?:PHP )?Fatal error: Uncaught Error: /, "Error: ")];
  }
  const extensions = diagnostics.map(missingExtension);
  if (!extensions.length || extensions.some((extension) => !extension)) return null;
  const checked = [...new Set(extensions)].sort();
  const response = probe(executable, [...options, "-r", "echo json_encode(get_loaded_extensions());"], {
    cwd: projectRoot || undefined, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024,
    windowsHide: true, env: filterProcessEnv(process.env, { allowedKeys: TEST_SUBPROCESS_ENV_KEYS }),
  });
  if (response.status !== 0 || response.error || response.signal) return null;
  let loaded;
  try { loaded = JSON.parse(response.stdout); } catch { return null; }
  if (!Array.isArray(loaded) || loaded.some((name) => typeof name !== "string")) return null;
  if (checked.some((extension) => loaded.map((name) => name.toLowerCase()).includes(extension))) return null;
  return checked;
}
