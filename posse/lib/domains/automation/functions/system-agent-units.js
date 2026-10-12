// Unit and launcher text for the system registered-agent owner and its
// release reconciler. Pure renderers: callers verify every path first.

import path from "node:path";

import {
  AGENT_RELEASE_LIMITS,
  AGENT_RELEASE_PATHS,
  AGENT_RELEASE_TIMER,
  AGENT_RELEASE_UNITS,
} from "../../../catalog/agent-release.js";
import { SYSTEM_REGISTERED_AGENT } from "../../../catalog/registered-agent.js";
import { sourceRefWatchPaths } from "./agent-release-config.js";

const { account: ACCOUNT, clientGroup: CLIENT_GROUP, ownerService: SERVICE } = SYSTEM_REGISTERED_AGENT;

/** @param {{ node: string, entry: string }} release */
export function renderOwnerUnit(release) {
  return `[Unit]\nDescription=Posse registered agent owner\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nUser=${ACCOUNT}\nGroup=${CLIENT_GROUP}\nWorkingDirectory=/var/lib/posse-agent\nStateDirectory=posse-agent\nStateDirectoryMode=0700\nRuntimeDirectory=posse-agent\nRuntimeDirectoryMode=0755\nEnvironment=POSSE_AUTOMATION_DATA_DIR=/var/lib/posse-agent\nEnvironment=POSSE_REGISTERED_AGENT_SOCKET=/run/posse-agent/agent.sock\nEnvironment=POSSE_REGISTERED_AGENT_SOCKET_MODE=0660\nEnvironment=POSSE_AGENT_GATEWAY_BACKEND=/run/posse-agent/private/registered.sock\nEnvironment=POSSE_AGENT_GATEWAY_KEY=/var/lib/posse-agent/gateway.key\nEnvironmentFile=-/etc/posse-agent/owner.env\nExecStart=${release.node} ${release.entry}\nRestart=always\nRestartSec=3\nTimeoutStopSec=30\nNoNewPrivileges=true\nPrivateTmp=true\nLimitNOFILE=4096\nMemoryMax=2G\n\n[Install]\nWantedBy=multi-user.target\n`;
}

/** @param {string} python @param {{ gateway: string }} release */
export function renderGatewayUnit(python, release) {
  return `[Unit]\nDescription=Posse registered agent local identity gateway\nRequires=${SERVICE}\nAfter=${SERVICE}\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nUser=${ACCOUNT}\nGroup=${CLIENT_GROUP}\nWorkingDirectory=/var/lib/posse-agent\nEnvironment=POSSE_AGENT_GATEWAY_SOCKET=/run/posse-agent/public.sock\nEnvironment=POSSE_AGENT_GATEWAY_BACKEND=/run/posse-agent/private/registered.sock\nEnvironment=POSSE_AGENT_GATEWAY_KEY=/var/lib/posse-agent/gateway.key\nExecStart=${python} ${release.gateway}\nRestart=always\nRestartSec=3\nNoNewPrivileges=true\nPrivateTmp=true\nLimitNOFILE=4096\nMemoryMax=512M\n\n[Install]\nWantedBy=multi-user.target\n`;
}

/** @param {{ node: string, root: string }} release */
export function renderLauncher(release) {
  return `#!/bin/sh\n# posse-registered-agent-managed\nexec '${release.node}' '${path.join(release.root, "registered-agent.js")}' "$@"\n`;
}

// Root reconcile runs read input that the source owner controls, so they run
// with a read-only system and home except the paths install() writes. The
// kernel and namespace protections cost nothing here: git, npm, tar, chown,
// chmod, getent, systemctl and systemd-run (a D-Bus client; PID 1 builds the
// probe sandbox, outside this unit's filters) need no sysctl or cgroup
// writes, kernel modules, new namespaces or personality changes.
function releaseServiceBody({ node, drainTimeoutSeconds, paths, root, flags }) {
  const timeout = drainTimeoutSeconds + AGENT_RELEASE_LIMITS.unitTimeoutSlackSeconds;
  const writable = [paths.installRoot, SYSTEM_REGISTERED_AGENT.unitDir, SYSTEM_REGISTERED_AGENT.configDir,
    path.dirname(SYSTEM_REGISTERED_AGENT.launcher)].map(dir => `-${dir}`).join(" ");
  return `[Service]\nType=oneshot\nWorkingDirectory=${paths.stateDir}\nStateDirectory=${paths.stateDirectory}\nStateDirectoryMode=0700\nUMask=0022\nExecStart=${node} ${root}/posse/orchestrator.js agent service update --system${flags}\nTimeoutStartSec=${timeout}\nPrivateTmp=true\nNoNewPrivileges=true\nRestrictSUIDSGID=true\nProtectSystem=full\nProtectHome=read-only\nReadWritePaths=${writable}\nProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true\nRestrictNamespaces=true\nLockPersonality=true\n`;
}

/**
 * The oneshot reconcile service. It always runs `update --system` from the
 * current release, so a swap changes the code the next run uses. When that
 * run fails, the fallback service runs from the newest release whose own
 * reconciler completed an upgrade. It has no start limit: its path unit fails
 * with the service when the service hits one, and a burst of ref or bundle
 * changes must never leave the path unit failed.
 *
 * @param {{ node: string, drainTimeoutSeconds: number, paths?: typeof AGENT_RELEASE_PATHS }} options
 */
export function renderReleaseService({ node, drainTimeoutSeconds, paths = AGENT_RELEASE_PATHS }) {
  return `[Unit]\nDescription=Reconcile the Posse registered agent owner release\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=0\nOnFailure=${AGENT_RELEASE_UNITS.fallback}\n\n${releaseServiceBody({ node, drainTimeoutSeconds, paths, root: paths.current, flags: "" })}`;
}

/**
 * The reconcile run from AGENT_RELEASE_PATHS.fallback, started only by the
 * reconcile service's OnFailure=, so on every failed run whether the path
 * unit or the timer started it. It keeps updates and crash repair going on
 * `current`'s behalf while the reconciler in `current` fails, and rolls back
 * a release whose reconciler never runs at all (fallbackRunAction()).
 *
 * @param {{ node: string, drainTimeoutSeconds: number, paths?: typeof AGENT_RELEASE_PATHS }} options
 */
export function renderReleaseFallbackService({ node, drainTimeoutSeconds, paths = AGENT_RELEASE_PATHS }) {
  return `[Unit]\nDescription=Reconcile the Posse registered agent owner from the last release whose reconciler completed an upgrade\nAfter=network-online.target\nWants=network-online.target\nConditionPathExists=${paths.fallback}/posse/orchestrator.js\n\n${releaseServiceBody({ node, drainTimeoutSeconds, paths, root: paths.fallback, flags: " --fallback" })}`;
}

/**
 * Starts a reconcile when published posse moves (the source repository's
 * remote-tracking ref, loose or packed) or a required native product gains a
 * bundle. Its trigger rate limit is off (TriggerLimitIntervalSec=0): hitting
 * it would fail the path unit, which then stops watching. Triggers cannot
 * spin: the path unit stops watching while its service runs, and the service
 * writes none of the watched paths.
 *
 * @param {{ sourceRepo: string, ref: string, artifactRoot: string, products: readonly string[] }} config
 * @returns {string | null} null when nothing is configured to watch
 */
export function renderReleasePath(config) {
  const watched = [...sourceRefWatchPaths(config), ...config.products.map(product => `${config.artifactRoot}/${product}`)];
  // systemd refuses a path unit with nothing to watch.
  if (!watched.length) return null;
  return `[Unit]\nDescription=Watch published posse and native bundles for the registered agent owner\n\n[Path]\n${watched.map(file => `PathChanged=${file}\n`).join("")}Unit=${AGENT_RELEASE_UNITS.service}\nTriggerLimitIntervalSec=0\n\n[Install]\nWantedBy=paths.target\n`;
}

/** Reconcile at boot and on a wall-clock backstop that survives downtime. */
export function renderReleaseTimer() {
  return `[Unit]\nDescription=Reconcile the Posse registered agent owner at boot and periodically\n\n[Timer]\nOnBootSec=${AGENT_RELEASE_TIMER.onBootSec}\nOnCalendar=${AGENT_RELEASE_TIMER.onCalendar}\nRandomizedDelaySec=${AGENT_RELEASE_TIMER.randomizedDelaySec}\nPersistent=true\nUnit=${AGENT_RELEASE_UNITS.service}\n\n[Install]\nWantedBy=timers.target\n`;
}
