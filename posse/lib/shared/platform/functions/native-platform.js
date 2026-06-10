// @ts-check
//
// Native-platform helpers — the single source of truth for translating
// node's process.platform / process.arch into Posse's os/arch tokens
// (windows|macos|linux, x64|arm64) and the executable suffix.
//
// Centralizes logic that is otherwise scattered as inline
// `process.platform === "win32"` checks and duplicated `commandExts()` across
// the codebase. The os/arch token vocabulary and translation maps live in the
// catalog (lib/catalog/binary.js); this module is the behavior that reads them.

import {
  OS_BY_NODE_PLATFORM,
  ARCH_BY_NODE_ARCH,
  VALID_BINARY_OS,
  VALID_BINARY_ARCH,
} from "../../../catalog/binary.js";

/** Thrown when the host OS/arch has no mapped native-binary token. */
export class UnsupportedPlatformError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "UnsupportedPlatformError";
  }
}

/**
 * Map a node `process.platform` value to our os token.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {"windows" | "macos" | "linux"}
 */
export function osKey(platform = process.platform) {
  const mapped = OS_BY_NODE_PLATFORM[platform];
  if (!mapped || !VALID_BINARY_OS.has(mapped)) {
    throw new UnsupportedPlatformError(`Unsupported OS for native binaries: ${String(platform)}`);
  }
  return /** @type {"windows" | "macos" | "linux"} */ (mapped);
}

/**
 * Map a node `process.arch` value to our arch token.
 *
 * @param {string} [arch]
 * @returns {"x64" | "arm64"}
 */
export function archKey(arch = process.arch) {
  const mapped = ARCH_BY_NODE_ARCH[arch];
  if (!mapped || !VALID_BINARY_ARCH.has(mapped)) {
    throw new UnsupportedPlatformError(`Unsupported architecture for native binaries: ${String(arch)}`);
  }
  return /** @type {"x64" | "arm64"} */ (mapped);
}

/**
 * `true` when the given (or current) platform is Windows.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function isWindows(platform = process.platform) {
  return platform === "win32";
}

/**
 * Executable filename suffix for the given (or current) platform:
 * `".exe"` on Windows, `""` elsewhere.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function exeSuffix(platform = process.platform) {
  return isWindows(platform) ? ".exe" : "";
}

/**
 * Convenience: resolve both os and arch tokens in one call. Returns
 * `{ os, arch }` or throws `UnsupportedPlatformError`.
 *
 * @param {{ platform?: NodeJS.Platform, arch?: string }} [opts]
 * @returns {{ os: "windows" | "macos" | "linux", arch: "x64" | "arm64" }}
 */
export function platformTokens({ platform = process.platform, arch = process.arch } = {}) {
  return { os: osKey(platform), arch: archKey(arch) };
}
