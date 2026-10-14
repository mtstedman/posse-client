export const PAIRING_COMMAND_CHECK_TIMEOUT_MS = 10_000;
export const PAIRING_DEPENDENCY_CHECK_TIMEOUT_MS = 2 * 60_000;
export const PAIRING_ENVIRONMENT_PROGRESS_INTERVAL_MS = 15_000;
export const PAIRING_GIT_TIMEOUT_ENV = "POSSE_PAIR_GIT_TIMEOUT_MS";
export const PAIRING_GIT_MAX_TIMEOUT_MS = 60 * 60_000;
export const PAIRING_GIT_TRANSFER_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000]);
export const PAIRING_GIT_TRANSFER_INTERRUPTION = /connection reset by peer|broken pipe|unexpected disconnect|remote end hung up unexpectedly|RPC failed.*(?:curl (?:18|56|92)|HTTP\/2)/iu;
export const PAIRING_GIT_OPERATION_TIMEOUTS = Object.freeze({
  fetch: 15 * 60_000, push: 15 * 60_000,
  switch: 5 * 60_000, checkout: 5 * 60_000,
  status: 2 * 60_000, "ls-files": 2 * 60_000,
  "rev-list": 2 * 60_000, "merge-base": 2 * 60_000,
});

export const PAIRING_RUNTIME_COMMANDS = Object.freeze([
  { command: "git", label: "Git", args: ["--version"], remedy: "Install Git and reopen your terminal. Check with `git --version`." },
  { command: "ssh", label: "OpenSSH", args: ["-V"], remedy: "Install or enable OpenSSH and reopen your terminal. Check with `ssh -V`." },
  { command: "ssh-keygen", label: "SSH key generation", args: null, remedy: "Install or enable OpenSSH, including ssh-keygen, and reopen your terminal." },
  { command: "gh", label: "GitHub CLI", args: ["--version"], hostOnly: true,
    remedy: "Install the GitHub CLI and reopen your terminal. Check with `gh --version` and `gh auth status`." },
]);
