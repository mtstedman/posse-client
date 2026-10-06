import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { demand } from "../functions/policy.js";

const UNIT = "/etc/systemd/system/posse-registered-agent.service";
const SERVICE = "posse-registered-agent.service";
const ACCOUNT = "posse-agent";
const CLIENT_GROUP = "posse-agent-clients";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  demand(result.status === 0, `${command} failed: ${String(result.stderr || result.error || "").slice(0, 300)}`, "service_manager_failed");
  return result.stdout.trim();
}

export class SystemRegisteredAgentManager {
  constructor({ packageRoot = "" } = {}) { this.packageRoot = packageRoot; }

  install() {
    demand(process.platform === "linux" && process.getuid() === 0, "System installation requires Linux root", "forbidden");
    demand(this.packageRoot && path.isAbsolute(this.packageRoot), "An installed package root is required", "invalid_request");
    const root = fs.realpathSync(this.packageRoot);
    const entry = path.join(root, "lib/domains/automation/functions/automation-owner-entry.js");
    demand(!root.startsWith("/home/") && !root.startsWith("/tmp/") && fs.statSync(entry).isFile(),
      "System code must be installed outside a developer home", "invalid_request");
    let cursor = root;
    while (cursor !== "/") {
      const info = fs.statSync(cursor);
      demand(info.uid === 0 && !(info.mode & 0o022), "System code path must be root-owned and not group/world writable", "forbidden");
      cursor = path.dirname(cursor);
    }
    const node = fs.realpathSync(process.execPath);
    demand(fs.statSync(node).uid === 0, "System Node runtime must be root-owned", "forbidden");
    if (spawnSync("getent", ["group", CLIENT_GROUP]).status !== 0) run("groupadd", ["--system", CLIENT_GROUP]);
    if (spawnSync("id", ["-u", ACCOUNT]).status !== 0) run("useradd", ["--system", "--home-dir", "/var/lib/posse-agent", "--shell", "/usr/sbin/nologin", ACCOUNT]);
    fs.mkdirSync("/etc/posse-agent", { recursive: true, mode: 0o700 });
    fs.chmodSync("/etc/posse-agent", 0o700);
    const content = `[Unit]\nDescription=Posse registered agent owner\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${ACCOUNT}\nGroup=${CLIENT_GROUP}\nWorkingDirectory=/var/lib/posse-agent\nStateDirectory=posse-agent\nStateDirectoryMode=0700\nRuntimeDirectory=posse-agent\nRuntimeDirectoryMode=0750\nEnvironment=POSSE_AUTOMATION_DATA_DIR=/var/lib/posse-agent\nEnvironment=POSSE_REGISTERED_AGENT_SOCKET=/run/posse-agent/agent.sock\nEnvironment=POSSE_REGISTERED_AGENT_SOCKET_MODE=0660\nEnvironmentFile=-/etc/posse-agent/owner.env\nExecStart=${node} ${entry}\nRestart=on-failure\nRestartSec=2\nTimeoutStopSec=30\nNoNewPrivileges=true\nPrivateTmp=true\nLimitNOFILE=4096\nMemoryMax=2G\n\n[Install]\nWantedBy=multi-user.target\n`;
    fs.writeFileSync(UNIT, content, { mode: 0o644 });
    run("systemctl", ["daemon-reload"]);
    run("systemctl", ["enable", "--now", SERVICE]);
    return this.status();
  }

  status() {
    return { installed: fs.existsSync(UNIT), active: spawnSync("systemctl", ["is-active", "--quiet", SERVICE]).status === 0,
      service: SERVICE, socket: "/run/posse-agent/agent.sock", client_group: CLIENT_GROUP };
  }

  remove() {
    demand(process.platform === "linux" && process.getuid() === 0, "System removal requires Linux root", "forbidden");
    spawnSync("systemctl", ["disable", "--now", SERVICE]);
    fs.rmSync(UNIT, { force: true });
    run("systemctl", ["daemon-reload"]);
    return this.status();
  }
}
