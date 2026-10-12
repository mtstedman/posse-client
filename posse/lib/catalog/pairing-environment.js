export const PAIRING_COMMAND_CHECK_TIMEOUT_MS = 10_000;
export const PAIRING_DEPENDENCY_CHECK_TIMEOUT_MS = 2 * 60_000;
export const PAIRING_ENVIRONMENT_PROGRESS_INTERVAL_MS = 15_000;

export const PAIRING_RUNTIME_COMMANDS = Object.freeze([
  { command: "git", label: "Git", args: ["--version"], remedy: "Install Git and reopen your terminal. Check with `git --version`." },
  { command: "ssh", label: "OpenSSH", args: ["-V"], remedy: "Install or enable OpenSSH and reopen your terminal. Check with `ssh -V`." },
  { command: "ssh-keygen", label: "SSH key generation", args: null, remedy: "Install or enable OpenSSH, including ssh-keygen, and reopen your terminal." },
  { command: "gh", label: "GitHub CLI", args: ["--version"], hostOnly: true,
    remedy: "Install the GitHub CLI and reopen your terminal. Check with `gh --version` and `gh auth status`." },
]);
