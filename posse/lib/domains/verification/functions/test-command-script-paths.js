import { NODE_TEST_VALUE_FLAGS, PHP_TEST_VALUE_FLAGS } from "../../../catalog/test-command-policy.js";
import { parseCommandArguments } from "../../../shared/scope/functions/test-command.js";

// Identify script operands, not flag values. Node's test runner accepts more
// than one file; an interpreted PHP script owns everything after its path.
export function testCommandScriptPaths(command, executable) {
  const node = ["node", "node.exe"].includes(executable);
  const php = ["php", "php.exe"].includes(executable);
  if (!node && !php) return [];
  const args = parseCommandArguments(command).slice(1);
  const paths = [];
  let operands = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!operands && arg === "--") { operands = true; continue; }
    if (!operands && (node ? NODE_TEST_VALUE_FLAGS : PHP_TEST_VALUE_FLAGS).has(arg)) { index++; continue; }
    if (!operands && node && ["-e", "--eval", "-p", "--print"].includes(arg)) return [];
    if (!operands && php && ["-r", "--run"].includes(arg)) return [];
    if (!operands && php && (arg === "-f" || arg === "--file")) continue;
    const file = !operands && php && arg.startsWith("--file=") ? arg.slice(7)
      : !operands && php && arg.startsWith("-f") && arg.length > 2 ? arg.slice(2) : arg;
    if (file.startsWith("-")) continue;
    if (/\.(?:php|[cm]?js|[cm]?ts)$/i.test(file) && !/[?*\[\]{}]/.test(file)) paths.push(file);
    if (php || !args.includes("--test")) break;
  }
  return paths;
}
