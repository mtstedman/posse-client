import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { demand } from "../functions/policy.js";
import { verifySystemRelease, verifyTrustedExecutable } from "../functions/system-release-integrity.js";

const UNIT = "/etc/systemd/system/posse-registered-agent.service";
const GATEWAY_UNIT = "/etc/systemd/system/posse-registered-agent-gateway.service";
const SERVICE = "posse-registered-agent.service";
const GATEWAY_SERVICE = "posse-registered-agent-gateway.service";
const ACCOUNT = "posse-agent";
const CLIENT_GROUP = "posse-agent-clients";
const LAUNCHER = "/usr/local/bin/posse-agent";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  demand(result.status === 0, `${command} failed: ${String(result.stderr || result.error || "").slice(0, 300)}`, "service_manager_failed");
  return result.stdout.trim();
}

function installFile(filename, content, mode) {
  if (fs.existsSync(filename)) {
    const info = fs.lstatSync(filename);
    demand(info.isFile() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022),
      `Untrusted managed file: ${filename}`, "forbidden");
    if (filename === LAUNCHER) demand(fs.readFileSync(filename, "utf8").includes("# posse-registered-agent-managed"),
      `Existing launcher is not managed by Posse: ${filename}`, "forbidden");
  }
  const previous = fs.existsSync(filename) ? fs.readFileSync(filename, "utf8") : null;
  if (previous !== content) {
    const temporary = `${filename}.${process.pid}.new`;
    try { fs.writeFileSync(temporary, content, { flag: "wx", mode }); fs.renameSync(temporary, filename); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  fs.chmodSync(filename, mode);
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
  constructor({ packageRoot = "" } = {}) { this.packageRoot = packageRoot; }

  install() {
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
    if (fs.existsSync("/etc/posse-agent/owner.env")) {
      const config = fs.lstatSync("/etc/posse-agent/owner.env");
      demand(config.isFile() && !config.isSymbolicLink() && config.uid === 0 && !(config.mode & 0o022),
        "System owner environment file is untrusted", "forbidden");
      const reserved = new Set(["NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME", "LD_PRELOAD",
        "LD_LIBRARY_PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "POSSE_NATIVE_BIN_ROOT",
        "POSSE_ACCOUNT_DB_PATH", "POSSE_AUTOMATION_DATA_DIR", "POSSE_AUTOMATION_DB_PATH",
        "POSSE_AUTOMATION_SOCKET", "POSSE_REGISTERED_AGENT_SOCKET", "POSSE_REGISTERED_AGENT_SOCKET_MODE",
        "POSSE_AGENT_GATEWAY_BACKEND", "POSSE_AGENT_GATEWAY_KEY"]);
      for (const line of fs.readFileSync("/etc/posse-agent/owner.env", "utf8").split("\n")) {
        const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
        demand(!key || !reserved.has(key), `System owner environment cannot override ${key}`, "forbidden");
      }
    }
    const owner = `[Unit]\nDescription=Posse registered agent owner\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nUser=${ACCOUNT}\nGroup=${CLIENT_GROUP}\nWorkingDirectory=/var/lib/posse-agent\nStateDirectory=posse-agent\nStateDirectoryMode=0700\nRuntimeDirectory=posse-agent\nRuntimeDirectoryMode=0755\nEnvironment=POSSE_AUTOMATION_DATA_DIR=/var/lib/posse-agent\nEnvironment=POSSE_REGISTERED_AGENT_SOCKET=/run/posse-agent/agent.sock\nEnvironment=POSSE_REGISTERED_AGENT_SOCKET_MODE=0660\nEnvironment=POSSE_AGENT_GATEWAY_BACKEND=/run/posse-agent/private/registered.sock\nEnvironment=POSSE_AGENT_GATEWAY_KEY=/var/lib/posse-agent/gateway.key\nEnvironmentFile=-/etc/posse-agent/owner.env\nExecStart=${release.node} ${release.entry}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nNoNewPrivileges=true\nPrivateTmp=true\nLimitNOFILE=4096\nMemoryMax=2G\n\n[Install]\nWantedBy=multi-user.target\n`;
    const gateway = `[Unit]\nDescription=Posse registered agent local identity gateway\nRequires=${SERVICE}\nAfter=${SERVICE}\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nUser=${ACCOUNT}\nGroup=${CLIENT_GROUP}\nWorkingDirectory=/var/lib/posse-agent\nEnvironment=POSSE_AGENT_GATEWAY_SOCKET=/run/posse-agent/public.sock\nEnvironment=POSSE_AGENT_GATEWAY_BACKEND=/run/posse-agent/private/registered.sock\nEnvironment=POSSE_AGENT_GATEWAY_KEY=/var/lib/posse-agent/gateway.key\nExecStart=${python} ${release.gateway}\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=true\nPrivateTmp=true\nLimitNOFILE=4096\nMemoryMax=512M\n\n[Install]\nWantedBy=multi-user.target\n`;
    const launcher = `#!/bin/sh\n# posse-registered-agent-managed\nexec '${release.node}' '${path.join(release.root, "registered-agent.js")}' "$@"\n`;
    const ownerChanged = installFile(UNIT, owner, 0o644);
    const gatewayChanged = installFile(GATEWAY_UNIT, gateway, 0o644);
    installFile(LAUNCHER, launcher, 0o755);
    run("systemctl", ["daemon-reload"]);
    run("systemctl", ["enable", "--now", SERVICE]);
    if (ownerChanged || !processMatches(SERVICE, release.node, release.entry)) run("systemctl", ["restart", SERVICE]);
    demand(waitForOwner(release), "Registered owner did not adopt verified release", "service_manager_failed");
    run("systemctl", ["enable", "--now", GATEWAY_SERVICE]);
    if (gatewayChanged || !processMatches(GATEWAY_SERVICE, python, release.gateway)) run("systemctl", ["restart", GATEWAY_SERVICE]);
    const ready = waitForServices(release, python);
    const status = this.status();
    demand(ready && status.active && status.gateway_active,
    "Registered services did not adopt verified release", "service_manager_failed");
    return status;
  }

  status() {
    return { installed: fs.existsSync(UNIT), active: spawnSync("systemctl", ["is-active", "--quiet", SERVICE]).status === 0,
      gateway_active: spawnSync("systemctl", ["is-active", "--quiet", GATEWAY_SERVICE]).status === 0,
      service: SERVICE, socket: "/run/posse-agent/agent.sock", public_socket: "/run/posse-agent/public.sock",
      client_group: CLIENT_GROUP, launcher: LAUNCHER };
  }

  remove() {
    demand(process.platform === "linux" && process.getuid() === 0, "System removal requires Linux root", "forbidden");
    spawnSync("systemctl", ["disable", "--now", GATEWAY_SERVICE]);
    spawnSync("systemctl", ["disable", "--now", SERVICE]);
    for (const filename of [GATEWAY_UNIT, UNIT]) fs.rmSync(filename, { force: true });
    run("systemctl", ["daemon-reload"]);
    return this.status();
  }
}
