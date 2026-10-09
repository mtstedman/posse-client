import fs from "node:fs";
import path from "node:path";

// The queue database is created by the first successful Posse bootstrap.
// Check the project itself, not a Git parent: commands run against cwd.
export function isPosseProjectInitialized(projectDir = process.cwd()) {
  return fs.existsSync(path.join(path.resolve(projectDir), ".posse", "db", "orchestrator.db"));
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
