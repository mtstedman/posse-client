// @ts-check
//
// Linux C runtime floor for Posse's native code (the Rust binaries and the
// better-sqlite3 addon). Only reads the running glibc version, so it is safe
// to import before any native addon loads.

import { LINUX_GLIBC_FLOOR, LINUX_GLIBC_SUPPORTED_SYSTEMS } from "../../../catalog/binary.js";

const FLOOR = `${LINUX_GLIBC_FLOOR.major}.${LINUX_GLIBC_FLOOR.minor}`;

/**
 * The running glibc version (for example "2.36"), or "" off glibc Linux.
 *
 * @returns {string}
 */
export function runtimeGlibcVersion() {
  if (process.platform !== "linux") return "";
  try {
    const report = /** @type {{ header?: { glibcVersionRuntime?: string } } | undefined} */ (process.report?.getReport?.());
    return String(report?.header?.glibcVersionRuntime || "");
  } catch {
    return "";
  }
}

/**
 * Why this glibc cannot run Posse's native code, or null when it can (or the
 * version is unknown).
 *
 * @param {string | null | undefined} version
 * @returns {string | null}
 */
export function glibcFloorProblem(version) {
  const match = /^(\d+)\.(\d+)/u.exec(String(version || ""));
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > LINUX_GLIBC_FLOOR.major || (major === LINUX_GLIBC_FLOOR.major && minor >= LINUX_GLIBC_FLOOR.minor)) return null;
  return `glibc ${major}.${minor} is too old: Posse's native binaries and its SQLite driver need glibc ${FLOOR}+. Supported: ${LINUX_GLIBC_SUPPORTED_SYSTEMS}.`;
}

/**
 * The C/C++ runtime symbol a dynamic-loader failure names, for example
 * "GLIBC_2.34" from "version `GLIBC_2.34' not found (required by ...)".
 *
 * @param {unknown} text
 * @returns {string}
 */
export function missingRuntimeSymbol(text) {
  const match = /\b((?:GLIBC|GLIBCXX|CXXABI)_\d[\d.]*)['’]?\s+not found/u.exec(String(text || ""));
  return match ? match[1] : "";
}

/**
 * Remedy for a native-addon load failure, or "" when the text is not one.
 * A missing runtime symbol is an operating-system floor, not a Node ABI
 * mismatch: rebuilding or reinstalling cannot fix it.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function nativeLoadFailureRemedy(text) {
  const symbol = missingRuntimeSymbol(text);
  if (symbol) {
    return `This system's C/C++ runtime is too old for Posse's native code (${symbol} not found). `
      + `Posse needs glibc ${FLOOR}+ (${LINUX_GLIBC_SUPPORTED_SYSTEMS}); \`posse doctor\` or reinstalling cannot fix this.`;
  }
  if (/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED/u.test(String(text || ""))) {
    return "Node changed under this install (native addon ABI mismatch). Run `posse doctor` to rebuild dependencies, or re-run the installer.";
  }
  return "";
}
