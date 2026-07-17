// Native-binary catalogue.
//
// Authoritative registry for the Rust-compiled helper binaries Posse ships
// (posse-atlas, posse-git, posse-remote). This is the single source of truth consumed by
// BOTH the deploy script (scripts/deploy-rust-binaries.mjs) and the runtime
// binary manager (lib/shared/tools/classes/BinaryManager.js) — it replaces the old
// standalone lib/bin/native-binaries.json so the build pipeline and the
// runtime resolver can never drift.
//
// Pure data only (frozen objects + derived Sets), matching the rest of
// lib/catalog/*. Platform/arch detection logic lives in the platform helper
// (lib/shared/platform/functions/native-platform.js), which reads the maps
// exported here.

export const REQUIRED_ATLAS_BINARY_NAMES = Object.freeze(["atlas", "vector"]);
export const ATLAS_VECTOR_NATIVE_PROTOCOL = "posse.atlas.vector.native.v1";
export const ATLAS_VECTOR_NATIVE_ROUTE = "atlas:vector";
export const ML_NATIVE_PROTOCOL = "posse.ml.native.v1";
export const ML_NATIVE_ROUTE = "ml:methods";
export const ML_CAPABILITIES_METHOD = "ml.capabilities";
export const ML_EMBED_METHOD = "ml.embed";
export const ML_MODEL_PACKAGE_INSTALL_METHOD = "ml.installModelPackage";

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
 * @param {{ macosUniversal?: boolean, keyGated?: boolean, workerCapable?: boolean, exactVersion?: string | null, issuedVersionRequired?: boolean }} [opts]
 */
function defineBinary(pkg, files, {
  macosUniversal = true,
  keyGated = true,
  workerCapable = false,
  exactVersion = null,
  issuedVersionRequired = false,
  releaseSource = null,
} = {}) {
  return Object.freeze({
    package: pkg,
    // Posse method binaries are gated on native heartbeat auth: when true the
    // runtime wrapper supplies the heartbeat envelope (URL + pinned public key
    // + audience) in the native JSON request. Raw Posse keys must never travel
    // in native process argv.
    keyGated,
    workerCapable,
    exactVersion,
    issuedVersionRequired,
    // When set, the binary is distributed via a public GitHub release channel
    // rather than the pulse-authenticated artifact service. Each host downloads
    // only its own platform's asset on demand (see release-download.js), so the
    // repo carries no committed per-OS binaries. { owner, repo, pinnedVersion? }.
    releaseSource: releaseSource ? Object.freeze({ ...releaseSource }) : null,
    platforms: Object.freeze({
      windows: Object.freeze({
        sourceFile: files.windows,
        destinationFile: files.windows,
        arches: Object.freeze({
          x64: Object.freeze({ target: "x86_64-pc-windows-msvc" }),
          arm64: Object.freeze({ target: "aarch64-pc-windows-msvc" }),
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
          x64: Object.freeze({ target: "x86_64-unknown-linux-gnu" }),
          arm64: Object.freeze({ target: "aarch64-unknown-linux-gnu" }),
        }),
      }),
    }),
  });
}

export const NATIVE_BINARIES = Object.freeze({
  atlas: defineBinary("posse-atlas", { windows: "posse-atlas.exe", posix: "posse-atlas" }, { workerCapable: true }),
  git: defineBinary("posse-git", { windows: "posse-git.exe", posix: "posse-git" }, { workerCapable: true }),
  ml: defineBinary(
    "posse-ml",
    { windows: "posse-ml.exe", posix: "posse-ml" },
    { workerCapable: true },
  ),
  remote: defineBinary("posse-remote", { windows: "posse-remote.exe", posix: "posse-remote" }),
  vector: defineBinary(
    "posse-atlas-vector",
    { windows: "posse-atlas-vector.exe", posix: "posse-atlas-vector" },
    { workerCapable: true, issuedVersionRequired: true },
  ),
  // The Bossy fleet TUI. A user-facing dashboard, not a method binary: no
  // heartbeat gating, no worker daemon. Distributed via its own public GitHub
  // release channel (posse-bossy), NOT the pulse artifact service: each host
  // downloads only its own platform's asset on demand into the versioned
  // native cache, so the Posse repo carries no committed bossy binaries. Leave
  // pinnedVersion unset to track the latest release (TTL-gated) without a Posse
  // commit per Bossy release; set it to freeze a specific version.
  bossy: defineBinary("bossy", { windows: "bossy.exe", posix: "bossy" }, {
    keyGated: false,
    releaseSource: { owner: "mtstedman", repo: "posse-bossy" },
  }),
});

// Inventory is derived from the registry itself. Adding a catalog entry is
// enough to propagate it to pull/reconcile loops; there is no second name list
// to remember to update.
export const BINARY_NAMES = Object.freeze(Object.keys(NATIVE_BINARIES));
export const VALID_BINARY_NAMES = new Set(BINARY_NAMES);

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

export function nativeBinaryIsWorkerCapable(name) {
  return nativeBinaryEntry(name)?.workerCapable === true;
}

export function nativeBinaryRequiresIssuedVersion(name) {
  return nativeBinaryEntry(name)?.issuedVersionRequired === true;
}

export function nativeBinaryExactVersion(name) {
  return nativeBinaryEntry(name)?.exactVersion || null;
}

/**
 * Release-channel coordinates for a binary distributed via public GitHub
 * releases instead of the pulse artifact service, or null. Shape:
 * { owner, repo, pinnedVersion? }.
 *
 * @param {string} name
 */
export function nativeBinaryReleaseSource(name) {
  return nativeBinaryEntry(name)?.releaseSource || null;
}
