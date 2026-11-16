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
  const bin = path.join(managedNodeVerificationRoot(posseRoot), "bin");
  const separator = platform === "win32" ? ";" : ":";
  result[pathKey] = [...new Set([bin, path.dirname(process.execPath), ...current.split(separator).filter(Boolean)])].join(separator);
  // pnpm otherwise downloads a project-declared version during `pnpm test`.
  // Keep verification on the installed Posse toolchain, including nested runs.
  result.npm_config_manage_package_manager_versions = "false";
  return result;
}

export function nodeToolSpawnSpec(command, args = [], { env = process.env, posseRoot = undefined, ...options } = {}) {
  const childEnv = nodeToolEnvironment(env, { posseRoot, ...options });
  const pnpm = /^pnpm(?:\.cmd|\.exe)?$/i.test(command) && resolveManagedPnpm(posseRoot);
  const invocation = pnpm ? { command: process.execPath, args: [pnpm, ...args], windowsVerbatimArguments: false }
    : commandSpawnSpec(command, args, { ...options, env: childEnv });
  return { ...invocation, env: childEnv };
}
