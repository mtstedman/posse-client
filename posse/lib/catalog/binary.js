// Native-binary catalogue.
//
// Authoritative registry for the Rust-compiled helper binaries Posse ships
// (posse-atlas, posse-git, posse-remote). This is the single source of truth consumed by
// BOTH the centralized deploy script
// (/home/mason/repos/deployment/posse/CI/deploy-rust-binaries.mjs) and the runtime
// binary manager (lib/shared/tools/classes/BinaryManager.js) — it replaces the old
// standalone lib/bin/native-binaries.json so the build pipeline and the
// runtime resolver can never drift.
//
// Pure data only (frozen objects + derived Sets), matching the rest of
// lib/catalog/*. Platform/arch detection logic lives in the platform helper
// (lib/shared/platform/functions/native-platform.js), which reads the maps
// exported here.

export const REQUIRED_ATLAS_BINARY_NAMES = Object.freeze(["atlas", "vector"]);
export const NATIVE_DAEMON_PROTOCOL = "posse.daemon.v1";
// Must match posse_worker::DEFAULT_MAX_WORKER_LINE_BYTES. Persistent native
// workers reject a larger JSONL request before it can recover the request id.
export const NATIVE_WORKER_MAX_REQUEST_BYTES = 64 * 1024 * 1024;
// Atlas and its vector sidecar use the cataloged bulk protocol in both
// directions. Tree construction for large repositories can legitimately
// exceed the smaller shared worker default.
export const ATLAS_NATIVE_WORKER_MAX_REQUEST_BYTES = 256 * 1024 * 1024;
export const NATIVE_UPDATE_PROTOCOL = "posse.native_update.v1";
export const ATLAS_NATIVE_PROTOCOL = "posse.atlas.native.v1";
export const ATLAS_EXECUTE_TOOL_CONTRACT_VERSION = 1;
export const ATLAS_NATIVE_PARSE_BUFFER_METHOD = "parser.parseBuffer";
// Edge resolution runs in the native resolver; the JS resolver is only a
// fallback for hosts where the Atlas binary is unusable.
export const ATLAS_NATIVE_RESOLVE_EDGES_METHOD = "resolve-edges";
export const ATLAS_VECTOR_NATIVE_PROTOCOL = "posse.atlas.vector.native.v1";
export const ATLAS_VECTOR_NATIVE_ROUTE = "atlas:vector";
export const GIT_NATIVE_PROTOCOL = "posse.git.native.v1";
export const GIT_READ_ROUTE = "git:read";
export const GIT_MUTATE_ROUTE = "git:mutate";
// Default output ceiling for one git command across the git layer (Repo.exec /
// execAsync, the gitExec* helpers, admin system git) and the wrap-up commit
// and push secrets scans. A ceiling, not an allocation: capture buffers grow
// only with what git actually prints.
export const GIT_CAPTURE_MAX_BYTES = 256 * 1024 * 1024;
// Hard per-call ceiling of the shipped posse-git `git.exec`. Must match
// posse-git MAX_CAPTURE_BYTES (a larger maxCaptureBytes is rejected before git
// runs) and posse_protocol MAX_WORKER_RESPONSE_BYTES (a response whose
// serialized JSON — escaped or base64 stdout plus stderr — is larger is
// refused, never truncated). Native captures are clamped to it until a
// posse-git release raises both.
export const GIT_NATIVE_MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
// A synchronous native call whose route has no cached pulse in this process
// fails closed with this code after requesting a background mint. It is a
// cold start, not a heartbeat failure: once the mint lands, the next call on
// that route succeeds.
export const NATIVE_PULSE_COLD_ERROR_CODE = "POSSE_NATIVE_PULSE_COLD";
// Info-level diagnostics kind for that cold start, recorded once per process
// (thread) and route.
export const NATIVE_PULSE_COLD_DIAGNOSTIC_KIND = "native.pulse.cold";
// Diagnostics kind for a real heartbeat/pulse-auth failure (a failed mint or a
// native binary rejecting its heartbeat auth). Never used for a cold start.
export const NATIVE_HEARTBEAT_FAILURE_DIAGNOSTIC_KIND = "native.heartbeat.failure";
export const ML_NATIVE_PROTOCOL = "posse.ml.native.v1";
export const ML_NATIVE_ROUTE = "ml:methods";
export const ML_CAPABILITIES_METHOD = "ml.capabilities";
export const ML_EMBED_METHOD = "ml.embed";
export const ML_GENERATE_METHOD = "ml.generate";
export const ML_MODEL_PACKAGE_INSTALL_METHOD = "ml.installModelPackage";
export const REMOTE_NATIVE_PROTOCOL = "posse.remote.native.v1";
export const REMOTE_PROMPTS_COMPILE_ROUTE = "prompts:compile";
export const REMOTE_PROMPTS_BUNDLE_ROUTE = "prompts:bundle";
export const REMOTE_CATALOG_READ_ROUTE = "catalog:read";
export const REMOTE_ARTIFACTS_READ_ROUTE = "artifacts:read";
// Engagement launch policy, answered locally by posse-remote (no network).
// Must equal posse-bin's ENGAGEMENT_CONTRACT_VERSION; requests carry it and
// the binary refuses any other.
export const ENGAGEMENT_CONTRACT_VERSION = 2;
// SHA-256 (hex) of test/fixtures/engagement/launch-plan.json with CRLF read as
// LF. engagement.capabilities reports the digest of the fixture the binary was
// verified against; a mismatch means the two policies may differ, so the
// client keeps its JS policy. Updated with the fixture (the engagement test
// fails until it matches).
export const ENGAGEMENT_POLICY_DIGEST = "d7605331132a30968d40ea6059f83bc8d9d06915954ff33b6e8a2c0fa3e48cfe";
export const ENGAGEMENT_RECOVERY_POLICY_DIGEST = "88b40cdc7bf34db84352e50c803b1eb157d01559edbb8f425c0b823e3134b54c";
export const ENGAGEMENT_CAPABILITIES_METHOD = "engagement.capabilities";
export const ENGAGEMENT_LAUNCH_PLAN_METHOD = "engagement.launchPlan";
export const ENGAGEMENT_LAUNCH_PLAN_BATCH_METHOD = "engagement.launchPlanBatch";
export const ENGAGEMENT_RECOVERY_HINT_METHOD = "engagement.recoveryHint";
// One-turn provider execution protocol served by
// `posse-remote engagement dispatch --stdio`. It is versioned independently
// from the pure engagement launch-policy contract.
export const PROVIDER_DISPATCH_PROTOCOL = "posse.provider-dispatch.v1";
export const PROVIDER_DISPATCH_AUTH_MODES = Object.freeze(["oauth", "api"]);
export const CLAUDE_NATIVE_MCP_SERVER = "posse";
export const CODEX_NATIVE_MCP_SERVERS = Object.freeze(["posse", "posse_serial"]);
export const CODEX_NATIVE_SERIAL_TOOL_IDS = Object.freeze([
  "tools.agent_handoff", "tools.sub_agent", "tools.dispatch_agent", "tools.custom_tools", "tools.project_db_query",
]);
export const PROVIDER_DISPATCH_COMMAND = "engagement.dispatch";
export const PROVIDER_DISPATCH_MAX_START_BYTES = 8 * 1024 * 1024;
export const PROVIDER_DISPATCH_MAX_EVENT_BYTES = 2 * 1024 * 1024;
export const PROVIDER_TOOL_GATEWAY_PROTOCOL = "posse.provider-tool-gateway.v1";
export const PROVIDER_TOOL_GATEWAY_PATH = "/v1/provider-tools/call";
export const PROVIDER_TOOL_GATEWAY_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const PROVIDER_TOOL_GATEWAY_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const PROVIDER_BREAKER_STORE_VERSION = 1;
export const PROVIDER_DISPATCH_EVENTS = Object.freeze([
  "dispatch.started",
  "surface.attested",
  "status",
  "output.delta",
  "commentary",
  "tool.requested",
  "tool.completed",
  "retry.scheduled",
  "breaker.changed",
  "usage.segment",
  "usage.progress",
  "prompt.finalized",
  "dispatch.completed",
  "dispatch.failed",
  "dispatch.cancelled",
]);
export const PROVIDER_DISPATCH_PROVIDERS = Object.freeze([
  "claude",
  "codex",
  "copilot",
  "anthropic",
  "openai",
  "grok",
  "posse-local",
]);
export const REMOTE_ARTIFACT_CATALOG_METHOD = "remote.artifactCatalog";
export const REMOTE_ARTIFACT_DOWNLOAD_METHOD = "remote.artifactDownload";
export const REMOTE_ARTIFACT_STATUS_METHOD = "remote.artifactStatus";
export const REMOTE_MODEL_PACKAGE_DOWNLOAD_METHOD = "remote.modelPackageDownload";

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

// Linux C runtime floor. The native binaries build on an AlmaLinux 9 (glibc
// 2.34) baseline and the better-sqlite3 prebuilds need GLIBC_2.34 and
// GLIBCXX_3.4.29; an older userspace cannot load either. The Linux installer
// preflight mirrors this floor.
export const LINUX_GLIBC_FLOOR = Object.freeze({ major: 2, minor: 34 });
export const LINUX_GLIBC_SUPPORTED_SYSTEMS = "RHEL/Alma/Rocky 9+, Amazon Linux 2023, Ubuntu 22.04+, Debian 12+";

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

// @catalog-sync id=posse.native.artifact_packages role=mirror relation=strict compare=names extract=js-native-packages symbol=NATIVE_BINARIES synced_from=posse-remote@34b3c283a31327b57f907d93a435fb153cba6e28 projection_source=posse
// @linked_repos posse-remote:rust/catalog/native_artifact.rs#NATIVE_ARTIFACT_PACKAGES
export const NATIVE_BINARIES = Object.freeze({
  atlas: defineBinary("posse-atlas", { windows: "posse-atlas.exe", posix: "posse-atlas" }, { workerCapable: true, issuedVersionRequired: true }),
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
  // heartbeat gating and no worker daemon. Bossy is published to the same
  // pulse-authenticated artifact catalog as the method binaries, then cached
  // by version for the current platform. The Posse repo carries no Bossy
  // binary payloads.
  bossy: defineBinary("bossy", { windows: "bossy.exe", posix: "bossy" }, {
    keyGated: false,
  }),
});
// @catalog-sync end

export function nativeWorkerMaxRequestBytes(name) {
  return name === "atlas" || name === "vector"
    ? ATLAS_NATIVE_WORKER_MAX_REQUEST_BYTES
    : NATIVE_WORKER_MAX_REQUEST_BYTES;
}

// Inventory is derived from the registry itself. Adding a catalog entry is
// enough to propagate it to pull/reconcile loops; there is no second name list
// to remember to update.
export const BINARY_NAMES = Object.freeze(Object.keys(NATIVE_BINARIES));
export const VALID_BINARY_NAMES = new Set(BINARY_NAMES);
export const BINARY_PACKAGE_NAMES = Object.freeze(
  BINARY_NAMES.map((name) => NATIVE_BINARIES[name].package),
);
export const VALID_BINARY_PACKAGE_NAMES = new Set(BINARY_PACKAGE_NAMES);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Heartbeat package validation derives from the canonical registry so package
// ids such as `bossy` do not disappear merely because they lack a `posse-`
// prefix. Keep this regex unflagged: callers reuse the singleton with `test()`.
export const NATIVE_BINARY_PACKAGE_PATTERN = new RegExp(
  `^(?:${BINARY_PACKAGE_NAMES.map(escapeRegExp).join("|")})$`,
);

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

// Methods a key-gated binary answers before any authenticated route: pure
// functions of their payload that touch no network, credentials, or files.
// Callers opt in per call (`localPolicy: true`); NativeBinary then spawns
// without minting a pulse, and refuses the opt-in for any method not listed
// here. Every other method of these binaries stays pulse-gated.
export const NATIVE_LOCAL_POLICY_METHODS = Object.freeze({
  remote: Object.freeze([
    ENGAGEMENT_CAPABILITIES_METHOD,
    ENGAGEMENT_LAUNCH_PLAN_METHOD,
    ENGAGEMENT_LAUNCH_PLAN_BATCH_METHOD,
    ENGAGEMENT_RECOVERY_HINT_METHOD,
  ]),
});

/**
 * @param {string} name
 * @param {string} method
 * @returns {boolean}
 */
export function nativeMethodIsLocalPolicy(name, method) {
  if (!Object.prototype.hasOwnProperty.call(NATIVE_LOCAL_POLICY_METHODS, name)) return false;
  const methods = /** @type {Record<string, readonly string[]>} */ (NATIVE_LOCAL_POLICY_METHODS)[name];
  return methods.includes(String(method || ""));
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
