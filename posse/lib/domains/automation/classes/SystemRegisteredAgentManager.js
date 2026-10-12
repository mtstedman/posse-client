import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { AGENT_RELEASE_PATHS, AGENT_RELEASE_UNITS } from "../../../catalog/agent-release.js";
import { SYSTEM_OWNER_ENV_RESERVED_KEYS, SYSTEM_REGISTERED_AGENT } from "../../../catalog/registered-agent.js";
import { loadReleaseConfig } from "../functions/agent-release-config.js";
import { demand } from "../functions/policy.js";
import { readTrustedConfigFile, verifySystemRelease, verifyTrustedExecutable } from "../functions/system-release-integrity.js";
import {
  renderGatewayUnit,
  renderLauncher,
  renderOwnerUnit,
  renderReleaseFallbackService,
  renderReleasePath,
  renderReleaseService,
  renderReleaseTimer,
} from "../functions/system-agent-units.js";

const {
  ownerService: SERVICE, gatewayService: GATEWAY_SERVICE, account: ACCOUNT, clientGroup: CLIENT_GROUP, launcher: LAUNCHER,
} = SYSTEM_REGISTERED_AGENT;
const UNIT = path.join(SYSTEM_REGISTERED_AGENT.unitDir, SERVICE);
const GATEWAY_UNIT = path.join(SYSTEM_REGISTERED_AGENT.unitDir, GATEWAY_SERVICE);
// Reconcile triggers, stopped before the services they start.
const RELEASE_UNITS = [AGENT_RELEASE_UNITS.timer, AGENT_RELEASE_UNITS.path, AGENT_RELEASE_UNITS.service, AGENT_RELEASE_UNITS.fallback];

const DEFAULT_HOST = Object.freeze({ fs, spawnSync, unitDir: SYSTEM_REGISTERED_AGENT.unitDir,
  platform: process.platform, getuid: () => process.getuid?.() ?? -1, releaseEnv: AGENT_RELEASE_PATHS.releaseEnv });

function run(command, args, host = DEFAULT_HOST) {
  const result = host.spawnSync(command, args, { encoding: "utf8" });
  demand(result.status === 0, `${command} failed: ${String(result.stderr || result.error || "").slice(0, 300)}`, "service_manager_failed");
  return String(result.stdout || "").trim();
}

function installFile(filename, content, mode, host = DEFAULT_HOST) {
  const io = host.fs;
  if (io.existsSync(filename)) {
    const info = io.lstatSync(filename);
    demand(info.isFile() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022),
      `Untrusted managed file: ${filename}`, "forbidden");
    if (filename === LAUNCHER) demand(io.readFileSync(filename, "utf8").includes("# posse-registered-agent-managed"),
      `Existing launcher is not managed by Posse: ${filename}`, "forbidden");
  }
  const previous = io.existsSync(filename) ? io.readFileSync(filename, "utf8") : null;
  if (previous !== content) {
    const temporary = `${filename}.${process.pid}.new`;
    try { io.writeFileSync(temporary, content, { flag: "wx", mode }); io.renameSync(temporary, filename); }
    finally { io.rmSync(temporary, { force: true }); }
  }
  io.chmodSync(filename, mode);
  return previous !== content;
}

function processMatches(service, executable, entry) {
  try {
    if (run("systemctl", ["show", "-p", "DropInPaths", "--value", service])) return false;
    const unit = service === SERVICE ? UNIT : GATEWAY_UNIT;
    if (fs.realpathSync(run("systemctl", ["show", "-p", "FragmentPath", "--value", service])) !== fs.realpathSync(unit)) return false;
    const pid = Number(run("systemctl", ["show", "-p", "MainPID", "--value", service]));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const expectedUID = Number(run("id", ["-u", ACCOUNT]));
    const expectedGID = Number(run("getent", ["group", CLIENT_GROUP]).split(":")[2]);
    const ids = label => status.match(new RegExp(`^${label}:\\s+([0-9\\s]+)$`, "m"))?.[1]?.trim().split(/\s+/).map(Number);
    if (!ids("Uid")?.every(value => value === expectedUID)
      || !ids("Gid")?.every(value => value === expectedGID)) return false;
    return fs.realpathSync(`/proc/${pid}/exe`) === fs.realpathSync(executable)
      && argv.length === 2 && fs.realpathSync(argv[1]) === fs.realpathSync(entry);
  } catch { return false; }
}

function waitForOwner(release) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processMatches(SERVICE, release.node, release.entry)
      && fs.existsSync("/run/posse-agent/agent.sock")
      && fs.existsSync("/var/lib/posse-agent/gateway.key")) return true;
    Atomics.wait(pause, 0, 0, 100);
  }
  return false;
}

function waitForServices(release, python) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (processMatches(SERVICE, release.node, release.entry)
      && processMatches(GATEWAY_SERVICE, python, release.gateway)
      && fs.existsSync("/run/posse-agent/agent.sock")
      && fs.existsSync("/run/posse-agent/public.sock")) return true;
    Atomics.wait(pause, 0, 0, 50);
  }
  return false;
}

export class SystemRegisteredAgentManager {
  constructor({ packageRoot = "", host = {} } = {}) {
    this.packageRoot = packageRoot;
    this.host = { ...DEFAULT_HOST, ...host };
  }

  /**
   * Install the verified release as the owner and gateway, then wire the
   * reconcile triggers. A trigger problem is reported in the returned status
   * (`release_triggers`) and never fails the owner install.
   *
   * @param {{ restart?: boolean }} [options] restart: restart the owner and
   *   gateway even when their units and processes already match (a hung owner)
   */
  install({ restart = false } = {}) {
    const { release, status } = this.installServices({ restart });
    return { ...status, release_triggers: this.installReleaseTriggers(release) };
  }

  /** @param {{ restart?: boolean }} [options] */
  installServices({ restart = false } = {}) {
    demand(process.platform === "linux" && process.getuid() === 0, "System installation requires Linux root", "forbidden");
    demand(this.packageRoot && path.isAbsolute(this.packageRoot), "An installed package root is required", "invalid_request");
    const release = verifySystemRelease(this.packageRoot, process.execPath);
    demand([release.root, release.node, release.entry, release.gateway].every(value => /^\/[A-Za-z0-9_./-]+$/.test(value)),
      "System release paths contain unsupported characters", "invalid_request");
    const python = verifyTrustedExecutable("/usr/bin/python3");
    if (spawnSync("getent", ["group", CLIENT_GROUP]).status !== 0) run("groupadd", ["--system", CLIENT_GROUP]);
    if (spawnSync("id", ["-u", ACCOUNT]).status !== 0) run("useradd", ["--system", "--home-dir", "/var/lib/posse-agent", "--shell", "/usr/sbin/nologin", ACCOUNT]);
    fs.mkdirSync("/etc/posse-agent", { recursive: true, mode: 0o700 });
    const configDir = fs.lstatSync("/etc/posse-agent");
    demand(configDir.isDirectory() && !configDir.isSymbolicLink() && configDir.uid === 0,
      "System owner configuration directory is untrusted", "forbidden");
    fs.chmodSync("/etc/posse-agent", 0o700);
    readTrustedConfigFile(SYSTEM_REGISTERED_AGENT.ownerEnv,
      { label: "System owner environment", reservedKeys: SYSTEM_OWNER_ENV_RESERVED_KEYS });
    const owner = renderOwnerUnit(release);
    const gateway = renderGatewayUnit(python, release);
    const launcher = renderLauncher(release);
    const ownerChanged = installFile(UNIT, owner, 0o644);
    const gatewayChanged = installFile(GATEWAY_UNIT, gateway, 0o644);
    installFile(LAUNCHER, launcher, 0o755);
    run("systemctl", ["daemon-reload"]);
    run("systemctl", ["enable", "--now", SERVICE]);
    if (restart || ownerChanged || !processMatches(SERVICE, release.node, release.entry)) run("systemctl", ["restart", SERVICE]);
    demand(waitForOwner(release), "Registered owner did not adopt verified release", "service_manager_failed");
    run("systemctl", ["enable", "--now", GATEWAY_SERVICE]);
    if (restart || gatewayChanged || !processMatches(GATEWAY_SERVICE, python, release.gateway)) run("systemctl", ["restart", GATEWAY_SERVICE]);
    const ready = waitForServices(release, python);
    const status = this.status();
    demand(ready && status.active && status.gateway_active,
    "Registered services did not adopt verified release", "service_manager_failed");
    return { release, status };
  }

  /**
   * Write the reconcile units from release.env and enable their triggers.
   *
   * @param {{ node: string }} release
   * @returns {{ ok: boolean, detail?: string }}
   */
  installReleaseTriggers(release) {
    try {
      const changed = this.writeReleaseTriggers(release, loadReleaseConfig({ filename: this.host.releaseEnv }));
      if (changed.size) run("systemctl", ["daemon-reload"], this.host);
      this.enableReleaseTriggers(changed);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: String(error?.message || error).slice(0, 300) };
    }
  }

  /**
   * Write the reconcile service, its fallback, and the path and timer units.
   * The path unit is dropped when release.env names nothing to watch.
   *
   * @returns {Set<string>} the release units whose text changed or that were removed
   */
  writeReleaseTriggers(release, releaseConfig) {
    const changed = new Set();
    const unitPath = name => path.join(this.host.unitDir, name);
    const service = { node: release.node, drainTimeoutSeconds: releaseConfig.drainTimeoutSeconds };
    const units = {
      [AGENT_RELEASE_UNITS.service]: renderReleaseService(service),
      [AGENT_RELEASE_UNITS.fallback]: renderReleaseFallbackService(service),
      [AGENT_RELEASE_UNITS.path]: renderReleasePath(releaseConfig),
      [AGENT_RELEASE_UNITS.timer]: renderReleaseTimer(),
    };
    for (const [name, text] of Object.entries(units)) {
      if (text === null) {
        if (this.host.fs.existsSync(unitPath(name))) {
          this.host.spawnSync("systemctl", ["disable", "--now", name]);
          this.host.fs.rmSync(unitPath(name), { force: true });
          changed.add(name);
        }
        continue;
      }
      if (installFile(unitPath(name), text, 0o644, this.host)) changed.add(name);
    }
    return changed;
  }

  /** Enable the path and timer triggers; restart one whose unit changed. */
  enableReleaseTriggers(changed = new Set()) {
    for (const name of [AGENT_RELEASE_UNITS.path, AGENT_RELEASE_UNITS.timer]) {
      if (!this.host.fs.existsSync(path.join(this.host.unitDir, name))) continue;
      run("systemctl", ["enable", "--now", name], this.host);
      if (changed.has(name)) run("systemctl", ["restart", name], this.host);
    }
  }

  status() {
    const active = name => this.host.spawnSync("systemctl", ["is-active", "--quiet", name]).status === 0;
    return { installed: this.host.fs.existsSync(path.join(this.host.unitDir, SERVICE)), active: active(SERVICE),
      gateway_active: active(GATEWAY_SERVICE),
      service: SERVICE, socket: "/run/posse-agent/agent.sock", public_socket: "/run/posse-agent/public.sock",
      client_group: CLIENT_GROUP, launcher: LAUNCHER,
      release_path_active: active(AGENT_RELEASE_UNITS.path), release_timer_active: active(AGENT_RELEASE_UNITS.timer) };
  }

  remove() {
    demand(this.host.platform === "linux" && this.host.getuid() === 0, "System removal requires Linux root", "forbidden");
    for (const name of [...RELEASE_UNITS, GATEWAY_SERVICE, SERVICE]) this.host.spawnSync("systemctl", ["disable", "--now", name]);
    for (const name of [...RELEASE_UNITS, GATEWAY_SERVICE, SERVICE]) this.host.fs.rmSync(path.join(this.host.unitDir, name), { force: true });
    run("systemctl", ["daemon-reload"], this.host);
    return this.status();
  }
}
