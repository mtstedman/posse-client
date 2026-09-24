// @ts-check
//
// Whether a `git.exec` argv must carry Team work-item grant pins. Mirrors the
// posse-git session-scope classification: only the subcommand Git will run
// counts, leading global options are skipped by closed sets, and anything
// that cannot be classified is pinned (the binary denies it under a scope).

import {
  TEAM_GRANT_GIT_EXEC_BUILTIN_COMMANDS,
  TEAM_GRANT_GIT_EXEC_CONFIG_OPTIONS,
  TEAM_GRANT_GIT_EXEC_EXPANDING_CONFIG_SECTIONS,
  TEAM_GRANT_GIT_EXEC_GLOBAL_FLAGS,
  TEAM_GRANT_GIT_EXEC_GLOBAL_VALUE_OPTIONS,
  TEAM_GRANT_PINNED_GIT_EXEC_COMMANDS,
} from "../../../catalog/team.js";

/**
 * @param {unknown} args
 * @returns {boolean}
 */
export function gitExecArgsRequireTeamGrant(args) {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return true;
  let index = 0;
  for (;;) {
    if (index >= args.length) return false; // No subcommand: Git prints usage.
    const arg = args[index];
    if (!arg.startsWith("-")) break;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (equals === -1 && TEAM_GRANT_GIT_EXEC_GLOBAL_FLAGS.includes(name)) {
      index += 1;
      continue;
    }
    if (!TEAM_GRANT_GIT_EXEC_GLOBAL_VALUE_OPTIONS.includes(name)) return true;
    let value;
    if (equals === -1) {
      if (index + 1 >= args.length) return true;
      value = args[index + 1];
      index += 2;
    } else {
      value = arg.slice(equals + 1);
      index += 1;
    }
    if (TEAM_GRANT_GIT_EXEC_CONFIG_OPTIONS.includes(name)) {
      const key = value.split("=", 1)[0].toLowerCase();
      if (TEAM_GRANT_GIT_EXEC_EXPANDING_CONFIG_SECTIONS.some((section) => key.startsWith(section))) return true;
    }
  }
  const subcommand = args[index];
  if (TEAM_GRANT_PINNED_GIT_EXEC_COMMANDS.includes(subcommand)) return true;
  // Any other non-builtin (or empty) subcommand may be an alias for a push.
  return !TEAM_GRANT_GIT_EXEC_BUILTIN_COMMANDS.includes(subcommand);
}
