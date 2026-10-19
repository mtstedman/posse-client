import fs from "node:fs";
import path from "node:path";

// The queue database is created by the first successful Posse bootstrap.
// Check the project itself, not a Git parent: commands run against cwd.
export function isPosseProjectInitialized(projectDir = process.cwd()) {
  return fs.existsSync(path.join(path.resolve(projectDir), ".posse", "db", "orchestrator.db"));
}

// add, go, and admin init (Bossy's "set up Posse in a folder") create a
// project's Posse state, and its Git repository when the folder has none.
// `admin init --provider-clis-only` skips repository setup, and `--json` is
// the admin settings contract rather than setup.
export function commandInitializesProject(command, positionalArgs = [], argv = []) {
  if (command === "add" || command === "go") return true;
  return command === "admin"
    && String(positionalArgs[0] || "").toLowerCase() === "init"
    && !argv.includes("--provider-clis-only")
    && !argv.includes("--json");
}

export function uninitializedProjectMessage(projectDir = process.cwd()) {
  return `${path.resolve(projectDir)} has not been initialized by Posse. Run posse add or posse go there first.`;
}

// The installers explicitly run doctor in Posse's own checkout to provision
// installation-level indexers and models before any user project exists.
export function isInstallationDoctor(projectDir, posseRoot, argv = []) {
  return argv.includes("--adopt-node-install")
    && path.resolve(projectDir) === path.resolve(posseRoot);
}
