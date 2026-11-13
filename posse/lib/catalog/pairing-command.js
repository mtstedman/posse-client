import { readonlyMap } from "./readonly-collections.js";
export const REMOTE_ACCESS_COMMANDS = Object.freeze(["serve", "pair", "session"]);
const SERVE_VALUE_OPTIONS = Object.freeze(["--confirmation-code", "--pair-code"]);
const SERVE_FLAGS = Object.freeze(["--pair", "--show-token", "--show-lan-token"]);

/** Strip phone/token options before parsing the shared session operation. */
export function sessionArgumentsForServe(argv = []) {
  const result = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (SERVE_FLAGS.includes(arg)) continue;
    if (SERVE_VALUE_OPTIONS.includes(arg)) { i += 1; continue; }
    if (SERVE_VALUE_OPTIONS.some((name) => arg.startsWith(`${name}=`))) continue;
    result.push(arg);
  }
  return result;
}
// Canonical `posse serve` / `pair` / `session` action table. The argument parser
// and the addon-free run bootstrap both read it: the bootstrap has to know,
// before SQLite loads, whether a command opens a session.

// Action -> [minimum, maximum] positional words, the action word included.
// A hold reason is free text: every word after `hold` belongs to it.
export const PAIRING_ACTION_ARITY = readonlyMap([
  ["host", [1, 1]], ["join", [2, 2]], ["leave", [1, 1]], ["close", [1, 1]],
  ["status", [1, 1]], ["admit", [2, 3]], ["members", [1, 1]], ["pending", [1, 1]],
  ["kick", [2, 2]], ["invite", [2, 2]], ["scope", [3, 3]], ["policy", [2, 2]],
  ["lease", [3, 3]],
  ["publication", [2, 2]],
  ["integrate", [1, 1]], ["abandon-integration", [1, 1]],
  ["hold", [1, Number.MAX_SAFE_INTEGER]], ["resume", [1, 1]],
  ["merge", [1, 1]], ["deploy", [1, 1]], ["auto", [1, 3]],
]);

// Options whose space-separated form takes the next argument as its value.
export const PAIRING_VALUE_OPTIONS = Object.freeze([
  "--remote", "--branch", "--merge-mode", "--deploy-mode", "--approve-source-oid", "--approve-origin-oid",
]);

/**
 * True when `posse <pair|session> ...args` hosts or joins a session: no action
 * word (hosting), `host`, `join`, or a first word that names no action, which
 * the parser reads as an invite code.
 *
 * @param {string[]} args the words after `pair`/`session`
 */
export function pairingCommandOpensSession(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] ?? "");
    if (PAIRING_VALUE_OPTIONS.includes(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg === "host" || arg === "join" || !PAIRING_ACTION_ARITY.has(arg);
  }
  return true;
}
