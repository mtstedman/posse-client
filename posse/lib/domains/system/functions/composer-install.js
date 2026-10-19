import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { commandSpawnSpec } from "../../../shared/platform/functions/command-launch.js";

// Let Composer evaluate its own version constraints, including aliases and
// virtual packages. This local validation never installs or runs project code.
export function composerLockRepairNames({ dir, command, manifest }, env) {
  if (!fs.existsSync(path.join(dir, "composer.lock"))) return [];
  const spec = commandSpawnSpec(command, ["validate", "--check-lock", "--no-check-publish", "--no-check-all", "--no-interaction", "--no-ansi", "--no-plugins", "--no-scripts"]);
  const result = spawnSync(spec.command, spec.args, { cwd: dir, env: { ...process.env, ...env }, encoding: "utf8", timeout: 20_000, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments });
  if (result.error || result.signal) throw new Error("Composer could not validate the existing lockfile; request setup again after repairing Composer.");
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const declared = new Set(Object.keys({ ...manifest.require, ...manifest["require-dev"] }));
  // Composer's lock diagnostics identify only missing/incompatible roots.
  // Unknown errors remain failures of install, never permission to update all.
  return [...new Set([...output.matchAll(/^- Required(?: \(in require-dev\))? package "([^"]+)" (?:is not present in the lock file|is in the lock file as .*but that does not satisfy your constraint)/gmu)]
    .map((match) => match[1]).filter((name) => declared.has(name)))];
}

// Verification shares installed packages with worktrees using symlinks. An
// installer must own its tree before Composer can add/remove packages through
// those links. Stage a complete copy before replacing anything so a failed
// copy leaves the original tree available.
export function materializeComposerVendor(dir) {
  const vendor = path.join(dir, "vendor");
  if (!fs.existsSync(vendor)) return;
  function hasExternalLink(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).some((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = path.relative(vendor, fs.realpathSync(file));
        return target === ".." || target.startsWith(`..${path.sep}`) || path.isAbsolute(target);
      }
      return entry.isDirectory() && hasExternalLink(file);
    });
  }
  if (!hasExternalLink(vendor)) return;
  const staging = fs.mkdtempSync(path.join(dir, ".posse-vendor-"));
  const copy = path.join(staging, "copy");
  const original = path.join(staging, "original");
  const ancestors = new Set();
  function copyOwned(source, destination) {
    const real = fs.realpathSync(source);
    const stat = fs.statSync(source);
    if (stat.isFile()) { fs.copyFileSync(source, destination); return; }
    if (!stat.isDirectory() || ancestors.has(real)) throw new Error("Composer vendor contains a cycle or unsupported file; cannot isolate the installation.");
    ancestors.add(real);
    fs.mkdirSync(destination);
    for (const name of fs.readdirSync(source)) copyOwned(path.join(source, name), path.join(destination, name));
    fs.chmodSync(destination, stat.mode);
    ancestors.delete(real);
  }
  try {
    copyOwned(vendor, copy);
    fs.renameSync(vendor, original);
    try { fs.renameSync(copy, vendor); }
    catch (error) { fs.renameSync(original, vendor); throw error; }
  } finally {
    // If restoring the original failed, preserve it for recovery.
    if (!fs.existsSync(original) || fs.existsSync(vendor)) fs.rmSync(staging, { recursive: true, force: true });
  }
}
