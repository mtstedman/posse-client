import {
  COMMAND_BOOTSTRAP_POLICIES,
  UNKNOWN_COMMAND_BOOTSTRAP_POLICY,
  PAIRING_READ_SUBCOMMANDS,
} from "../../../catalog/cli-commands.js";

export { COMMAND_BOOTSTRAP_POLICIES };

const COMMAND_BOOTSTRAP_POLICY_BY_NAME = new Map();
for (const policy of COMMAND_BOOTSTRAP_POLICIES) {
  COMMAND_BOOTSTRAP_POLICY_BY_NAME.set(policy.name, policy);
  for (const alias of policy.aliases) COMMAND_BOOTSTRAP_POLICY_BY_NAME.set(alias, policy);
}

export function normalizeCommandName(command) {
  if (command == null || String(command).trim() === "") return "help";
  return String(command).trim().toLowerCase();
}

export function getCommandBootstrapPolicy(command) {
  const normalized = normalizeCommandName(command);
  return COMMAND_BOOTSTRAP_POLICY_BY_NAME.get(normalized) || UNKNOWN_COMMAND_BOOTSTRAP_POLICY;
}

/**
 * True when a command may start new work on branch state, so an interrupted
 * pairing close must be resumed before it runs. Read-only commands, operator
 * configuration (`admin`), and session reports only observe the clone: a
 * Bossy or dashboard poll in a clone whose session owner stopped must not
 * close the session as a side effect, and must not be refused while a
 * deliberate close drains.
 *
 * @param {string} command the normalized command name
 * @param {string} [pairSubcommand] the `pair`/`session` verb, when any
 */
export function commandResumesInterruptedPairing(command, pairSubcommand = "") {
  const policy = getCommandBootstrapPolicy(command);
  if (policy.readOnly || policy.name === "admin") return false;
  if (["pair", "session"].includes(policy.name)
    && PAIRING_READ_SUBCOMMANDS.includes(String(pairSubcommand || "").toLowerCase())) {
    return false;
  }
  return true;
}

export function isHelpCommand(command) {
  return getCommandBootstrapPolicy(command).name === "help";
}

export function isReadOnlyCommand(command) {
  return getCommandBootstrapPolicy(command).readOnly;
}

export function requiresWritableArtifactsForCommand(command) {
  return getCommandBootstrapPolicy(command).requiresWritableArtifacts;
}

export function requiresProviderForCommand(command) {
  return getCommandBootstrapPolicy(command).requiresProvider;
}

export function requiresNativeGitForCommand(command) {
  return getCommandBootstrapPolicy(command).requiresNativeGit;
}

export function shouldRefreshContextAfterCommand(command) {
  return getCommandBootstrapPolicy(command).refreshContextAfter;
}
