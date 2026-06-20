// Native-binary catalogue.
//
// Authoritative registry for the Rust-compiled helper binaries Posse ships
// (posse-atlas, posse-git, posse-remote). This is the single source of truth consumed by
// BOTH the deploy script (scripts/deploy-rust-binaries.mjs) and the runtime
// binary manager (lib/classes/tools/BinaryManager.js) — it replaces the old
// standalone lib/bin/native-binaries.json so the build pipeline and the
// runtime resolver can never drift.
//
// Pure data only (frozen objects + derived Sets), matching the rest of
// lib/catalog/*. Platform/arch detection logic lives in the platform helper
// (lib/shared/platform/functions/native-platform.js), which reads the maps
// exported here.

export const BINARY_NAMES = Object.freeze(["atlas", "git", "remote"]);
export const VALID_BINARY_NAMES = new Set(BINARY_NAMES);

// Folder + manifest keys. These are OUR canonical os/arch tokens — distinct
// from node's process.platform / process.arch, which the maps below translate.
export const BINARY_OS_VALUES = Object.freeze(["windows", "macos", "linux"]);
export const VALID_BINARY_OS = new Set(BINARY_OS_VALUES);

export const BINARY_ARCH_VALUES = Object.freeze(["x64", "arm64"]);
export const VALID_BINARY_ARCH = new Set(BINARY_ARCH_VALUES);

// process.platform -> our os token.
export const OS_BY_NODE_PLATFORM = Object.freeze({
  win32: "windows",
  darwin: "macos",
  linux: "linux",
});

// process.arch -> our arch token.
export const ARCH_BY_NODE_ARCH = Object.freeze({
  x64: "x64",
  arm64: "arm64",
});

/**
 * @param {string} pkg
 * @param {{ windows: string, posix: string }} files
 * @param {{ macosUniversal?: boolean, keyGated?: boolean }} [opts]
 */
function defineBinary(pkg, files, { macosUniversal = true, keyGated = true } = {}) {
  return Object.freeze({
    package: pkg,
    // Posse method binaries are gated on native heartbeat auth: when true the
    // runtime wrapper supplies the heartbeat envelope (URL + pinned public key
    // + audience) in the native JSON request. Raw Posse keys must never travel
    // in native process argv.
    keyGated,
    platforms: Object.freeze({
      windows: Object.freeze({
        sourceFile: files.windows,
        destinationFile: files.windows,
        arches: Object.freeze({
          x64: Object.freeze({ target: "x86_64-pc-windows-msvc" }),
          arm64: Object.freeze({ target: "aarch64-pc-windows-gnullvm" }),
        }),
      }),
      macos: Object.freeze({
        sourceFile: files.posix,
        destinationFile: files.posix,
        // A single lipo'd universal binary serves both arches; it is stored
        // at the os level (lib/bin/<tool>/macos/<file>), no arch subfolder.
        universal: macosUniversal,
        arches: Object.freeze({
          x64: Object.freeze({ target: "x86_64-apple-darwin" }),
          arm64: Object.freeze({ target: "aarch64-apple-darwin" }),
        }),
      }),
      linux: Object.freeze({
        sourceFile: files.posix,
        destinationFile: files.posix,
        arches: Object.freeze({
          x64: Object.freeze({ target: "x86_64-unknown-linux-musl" }),
          arm64: Object.freeze({ target: "aarch64-unknown-linux-musl" }),
        }),
      }),
    }),
  });
}

export const NATIVE_BINARIES = Object.freeze({
  atlas: defineBinary("posse-atlas", { windows: "posse-atlas.exe", posix: "posse-atlas" }),
  git: defineBinary("posse-git", { windows: "posse-git.exe", posix: "posse-git" }),
  remote: defineBinary("posse-remote", { windows: "posse-remote.exe", posix: "posse-remote" }),
});

/**
 * @param {string} name
 * @returns {(typeof NATIVE_BINARIES)[keyof typeof NATIVE_BINARIES] | null}
 */
export function nativeBinaryEntry(name) {
  return VALID_BINARY_NAMES.has(name) ? NATIVE_BINARIES[name] : null;
}

/**
 * @param {string} name
 * @param {string} os    Our os token (windows/macos/linux).
 * @returns {{ sourceFile: string, destinationFile: string, universal?: boolean, arches: object } | null}
 */
export function nativeBinaryPlatform(name, os) {
  const entry = nativeBinaryEntry(name);
  return entry && entry.platforms[os] ? entry.platforms[os] : null;
}

/**
 * Whether a tool stores a single universal binary at the os level for the
 * given os (true today for macOS), rather than per-arch subfolders.
 *
 * @param {string} name
 * @param {string} os
 * @returns {boolean}
 */
export function nativeBinaryIsUniversal(name, os) {
  return nativeBinaryPlatform(name, os)?.universal === true;
}

/**
 * Whether a tool is gated on native heartbeat auth. The runtime wrapper supplies
 * the heartbeat envelope for these. The name stays `keyGated` for catalog/back-
 * compat reasons.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function nativeBinaryIsKeyGated(name) {
  return nativeBinaryEntry(name)?.keyGated === true;
}
