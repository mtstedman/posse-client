import fs from "node:fs";

import { getRuntimeDbPath } from "../../runtime/functions/paths.js";
import { getLivePairingState } from "./state.js";

// Git gives this environment variable precedence over core.sshCommand. A new
// terminal does not inherit the cleanup performed by `posse pair`, so restore
// the session's credential selection before any native workers inherit it.
export function applyPairingGitEnvironment(env = process.env) {
  if (env.GIT_SSH_COMMAND == null || !fs.existsSync(getRuntimeDbPath())) return;
  if (getLivePairingState()?.credential_directory) {
    delete env.GIT_SSH_COMMAND;
  }
}
