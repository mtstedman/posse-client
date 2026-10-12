// System agent-owner release reconciler: the canonical paths, units,
// configuration keys, defaults, limits and result codes of
// `posse agent service update --system`. Pure data only.

export const AGENT_RELEASE_STATE_SCHEMA = "posse.agent_release_state.v1";
export const AGENT_RELEASE_MANIFEST_SCHEMA = "posse.agent_release_manifest.v1";
// Written beside `posse/` in every staged release directory.
export const AGENT_RELEASE_MANIFEST_FILE = "release.json";

const STATE_DIRECTORY = "posse-agent-release";

export const AGENT_RELEASE_PATHS = Object.freeze({
  installRoot: "/opt/posse-agent",
  releasesRoot: "/opt/posse-agent/releases",
  current: "/opt/posse-agent/current",
  // The newest release whose own reconciler completed a real upgrade (a run
  // that ended `installed`, AGENT_RELEASE_RESULTS[*].proves); the fallback
  // reconcile unit runs from here when the one in `current` fails.
  fallback: "/opt/posse-agent/fallback",
  node: "/opt/posse-agent/bin/node",
  // systemd StateDirectory= name of the reconcile unit; root only (0700).
  stateDirectory: STATE_DIRECTORY,
  stateDir: `/var/lib/${STATE_DIRECTORY}`,
  // Holds the run lock; tmpfs, so nothing in it outlives a boot.
  runDir: `/run/${STATE_DIRECTORY}`,
  releaseEnv: "/etc/posse-agent/release.env",
});
export const AGENT_RELEASE_STATE_FILE = "state.json";
// An SQLite file whose exclusive lock the kernel drops when its holder dies.
export const AGENT_RELEASE_LOCK_FILE = "reconcile.lock";

// Absolute tools the root reconciler runs; never resolved through PATH.
export const AGENT_RELEASE_COMMANDS = Object.freeze({
  git: "/usr/bin/git",
  tar: "/usr/bin/tar",
  chown: "/usr/bin/chown",
  chmod: "/usr/bin/chmod",
  getent: "/usr/bin/getent",
  systemctl: "/usr/bin/systemctl",
  systemdRun: "/usr/bin/systemd-run",
});
// The environment every unprivileged child (git, npm, probes) starts from.
export const AGENT_RELEASE_CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";

export const AGENT_RELEASE_UNITS = Object.freeze({
  service: "posse-agent-release.service",
  path: "posse-agent-release.path",
  timer: "posse-agent-release.timer",
  // OnFailure= of the service: the same run from AGENT_RELEASE_PATHS.fallback.
  fallback: "posse-agent-release-fallback.service",
});
// OnCalendar (wall clock), never OnUnitActiveSec: a monotonic re-arm can stall
// for days when the unit's last activation is lost.
export const AGENT_RELEASE_TIMER = Object.freeze({
  onBootSec: "3min",
  onCalendar: "*:0/15",
  randomizedDelaySec: "60",
});

// /etc/posse-agent/release.env keys and the config field each sets.
export const AGENT_RELEASE_CONFIG_KEYS = Object.freeze({
  POSSE_RELEASE_SOURCE_REPO: "sourceRepo",
  POSSE_RELEASE_REF: "ref",
  POSSE_RELEASE_ARTIFACT_ROOT: "artifactRoot",
  POSSE_RELEASE_PRODUCTS: "products",
  POSSE_RELEASE_DRAIN_TIMEOUT_SECONDS: "drainTimeoutSeconds",
  POSSE_RELEASE_KEEP: "keep",
  POSSE_RELEASE_NPM_CLI: "npmCli",
});
// The source repository and npm CLI are operator configuration: no default.
export const AGENT_RELEASE_DEFAULTS = Object.freeze({
  sourceRepo: "",
  ref: "origin/main",
  artifactRoot: "/var/lib/posse/artifacts/staging/bundles",
  products: Object.freeze(["posse-remote"]),
  drainTimeoutSeconds: 600,
  keep: 3,
  npmCli: "",
});

export const AGENT_RELEASE_LIMITS = Object.freeze({
  maxDrainTimeoutSeconds: 3600,
  maxKeep: 20,
  drainPollMs: 5_000,
  // Consecutive drain timeouts after which a run reports drain_stuck.
  drainStuckRuns: 4,
  smokeTimeoutSeconds: 240,
  selfCheckTimeoutSeconds: 60,
  healthAttempts: 15,
  healthIntervalMs: 2_000,
  // Owner or gateway restarts since the last install that count as a loop.
  crashLoopRestarts: 5,
  // A loop this soon after a swap rolls back; later it reinstalls.
  recentSwapSeconds: 3_600,
  maxRecordedFailures: 20,
  // Releases whose reconciler's last run is remembered (newest kept).
  maxRecordedReconcilers: 20,
  // A transient smoke failure (AGENT_RELEASE_SMOKE.transientFailureClasses) is
  // tried again by a run at least this long after it (the next timer run),
  // until this many smokes of the same inputs have failed that way.
  transientSmokeRetrySeconds: 600,
  transientSmokeAttempts: 3,
  archiveMaxBytes: 512 * 1024 * 1024,
  nativeBinaryMaxBytes: 512 * 1024 * 1024,
  gitTimeoutMs: 120_000,
  npmTimeoutMs: 900_000,
  probeTimeoutMs: 30_000,
  // Added to the drain timeout for the reconcile unit's TimeoutStartSec.
  unitTimeoutSlackSeconds: 3_600,
});

// `update --system` refuses a non-root caller with exactly this message before
// it does anything else. The pre-swap self-check depends on it: a staged
// release must print AGENT_RELEASE_SELF_CHECK.refusal when its reconciler runs
// unprivileged, proving the whole CLI -> reconciler import graph loads. Older
// reconcilers check newer releases against it, so never change it.
export const AGENT_RELEASE_ROOT_REFUSAL = "Release reconciliation requires Linux root";
export const AGENT_RELEASE_SELF_CHECK = Object.freeze({
  args: Object.freeze(["agent", "service", "update", "--system", "--dry-run"]),
  refusal: `forbidden: ${AGENT_RELEASE_ROOT_REFUSAL}`,
});

// The live smoke: a two-turn tool-call chat through the staged release.
// On failure its last stdout line is {"ok":false,"error":...,"failure":{"class","code"}};
// `class` is the native provider-dispatch failure class (posse-bin
// FailureClass wire names) or the smoke's own "timeout". These classes are
// the provider's or the network's fault (429, 5xx, transport, timeouts), so a
// smoke that failed with one is tried again instead of being remembered.
export const AGENT_RELEASE_SMOKE = Object.freeze({
  model: "anthropic:claude-sonnet-4-6",
  tool: "records.lookup",
  recordId: "r-17",
  expected: "teal",
  transientFailureClasses: Object.freeze(["rate_limit", "transient_provider", "ambiguous_provider_commit", "timeout", "stall"]),
});

// Every run ends in exactly one of these. `ok: false` exits non-zero so the
// reconcile unit shows failed in the journal, and starts the fallback unit.
// `proves: true` marks the one result that proves a reconciler's upgrade path
// end to end: it staged, gated, drained, swapped and installed a release and
// the owner came up healthy. A run of the reconciler shipped in release X that
// ends with it (other than finishing an earlier run's swap) makes X the
// fallback reconciler. Nothing else proves anything: a noop, a skip or a drain
// timeout never reached the upgrade path.
export const AGENT_RELEASE_RESULTS = Object.freeze({
  noop: Object.freeze({ ok: true, proves: false }),
  dry_run: Object.freeze({ ok: true, proves: false }),
  installed: Object.freeze({ ok: true, proves: true }),
  reinstalled: Object.freeze({ ok: true, proves: false }),
  skipped_failed: Object.freeze({ ok: true, proves: false }),
  drain_timeout: Object.freeze({ ok: true, proves: false }),
  busy: Object.freeze({ ok: true, proves: false }),
  // No source repository: nothing published was reconciled.
  unconfigured: Object.freeze({ ok: true, proves: false }),
  // A fallback run with nothing to add: its own release is `current`, or the
  // reconciler in `current` ran since its swap and its last run was ok.
  fallback_idle: Object.freeze({ ok: true, proves: false }),
  drain_stuck: Object.freeze({ ok: false, proves: false }),
  stage_failed: Object.freeze({ ok: false, proves: false }),
  smoke_failed: Object.freeze({ ok: false, proves: false }),
  rolled_back: Object.freeze({ ok: false, proves: false }),
  failed: Object.freeze({ ok: false, proves: false }),
});
// Where a recorded failure happened. `reconciler`: the release's own
// reconciler never ran after its swap (it crashed on import), and the fallback
// rolled it back.
export const AGENT_RELEASE_FAILURE_STAGES = Object.freeze(["resolve", "stage", "self_check", "smoke", "install", "health", "crash_loop",
  "reconciler"]);
// Stages a fallback run redoes in full with its own code. When another
// release's reconciler recorded a failure at one of these, that reconciler may
// be the broken part, so a fallback run tries those inputs itself, once; its
// own failure is then remembered like any other. crash_loop (the owner looped
// after a healthy install) and reconciler (a fallback rolled the release back)
// are verdicts on the release itself and block every run.
export const AGENT_RELEASE_FALLBACK_RETRY_STAGES = Object.freeze(["stage", "self_check", "smoke", "install", "health"]);
