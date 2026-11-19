import fs from "node:fs";
import path from "node:path";
import { managedNodeVerificationRoot } from "./node-verification-runtime.js";
import { MANAGED_NODE_VERIFIER_ENTRIES } from "../../../catalog/node-verification.js";
import { commandSpawnSpec } from "../../../shared/platform/functions/command-launch.js";

// Doctor/setup owns installation. Test discovery and execution only use the
// shipped toolchain; they never download a package manager into the project.
export function resolveManagedPnpm(posseRoot) {
  const root = managedNodeVerificationRoot(posseRoot);
  const entry = path.join(root, "node_modules", "pnpm", MANAGED_NODE_VERIFIER_ENTRIES.pnpm);
  const runner = path.join(root, "pnpm-runner.cjs");
  try { return fs.statSync(entry).isFile() && fs.statSync(runner).isFile() ? runner : null; } catch { return null; }
}

export function nodeToolEnvironment(env = process.env, { posseRoot = undefined, platform = process.platform } = {}) {
  if (!resolveManagedPnpm(posseRoot)) return { ...env };
  const result = { ...env };
  const pathKey = platform === "win32" ? Object.keys(result).find(key => key.toUpperCase() === "PATH") || "PATH" : "PATH";
  const current = result[pathKey] || "";
  if (platform === "win32") {
    for (const key of Object.keys(result)) if (key !== pathKey && key.toUpperCase() === "PATH") delete result[key];
  }
  // The managed bin directory holds only the pnpm launchers, so scripts that
  // invoke pnpm reach the managed copy. Posse's Node directory goes last: it
  // is a fallback for those launchers, and a project-pinned Node stays first.
  const bin = path.join(managedNodeVerificationRoot(posseRoot), "bin");
  const separator = platform === "win32" ? ";" : ":";
  result[pathKey] = [...new Set([bin, ...current.split(separator).filter(Boolean), path.dirname(process.execPath)])].join(separator);
  return result;
}

export function nodeToolSpawnSpec(command, args = [], { env = process.env, posseRoot = undefined, ...options } = {}) {
  const childEnv = nodeToolEnvironment(env, { posseRoot, ...options });
  const pnpm = /^pnpm(?:\.cmd|\.exe)?$/i.test(command) && resolveManagedPnpm(posseRoot);
  if (!pnpm) return { ...commandSpawnSpec(command, args, { ...options, env: childEnv }), env: childEnv };
  // pnpm otherwise downloads a project-declared version during `pnpm test`.
  // The runner reapplies this for nested pnpm runs; npm warns about it, so
  // other commands do not get it.
  childEnv.npm_config_manage_package_manager_versions = "false";
  return { command: process.execPath, args: [pnpm, ...args], windowsVerbatimArguments: false, env: childEnv };
}
