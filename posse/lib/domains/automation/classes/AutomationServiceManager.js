import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AutomationOwnerClient } from "./AutomationOwnerClient.js";
import { automationDataDir } from "../functions/paths.js";

const LABEL = "com.posse.automation";
const WINDOWS_TASK = "Posse Automation Owner";

export class AutomationServiceManager {
  constructor({ platform = process.platform, home = os.homedir(), nodePath = process.execPath, dataDir = automationDataDir(), run = runCommand } = {}) {
    this.platform = platform;
    this.home = home;
    this.nodePath = path.resolve(nodePath);
    this.dataDir = path.resolve(dataDir);
    this.run = run;
    this.entryPath = fileURLToPath(new URL("../functions/automation-supervisor-entry.js", import.meta.url));
  }

  definition() {
    if (this.platform === "linux") return this.linuxDefinition();
    if (this.platform === "darwin") return this.macDefinition();
    if (this.platform === "win32") return this.windowsDefinition();
    throw serviceError(`Automation startup is unsupported on ${this.platform}`, "service_unsupported");
  }

  async install() {
    const definition = this.definition();
    fs.mkdirSync(path.dirname(definition.path), { recursive: true, mode: 0o700 });
    writePrivateFile(definition.path, definition.content);
    await this.stopAdHocSupervisor();
    for (const command of definition.install) this.command(command);
    return { installed: true, manager: definition.manager, definition: definition.path, ...await this.status() };
  }

  async remove() {
    const definition = this.definition();
    for (const command of definition.remove) this.command(command, { allowFailure: true });
    fs.rmSync(definition.path, { force: true });
    await this.stopAdHocSupervisor();
    return { installed: false, manager: definition.manager, definition: definition.path };
  }

  async status() {
    const definition = this.definition();
    let owner = null;
    try { owner = await new AutomationOwnerClient({ timeoutMs: 500 }).health(); } catch {}
    const check = this.run(definition.status.command, definition.status.args, { encoding: "utf8", windowsHide: true });
    return {
      installed: fs.existsSync(definition.path),
      manager: definition.manager,
      definition: definition.path,
      manager_active: check.status === 0,
      owner_ready: owner?.ready === true,
      owner: owner?.ready === true ? owner : null,
    };
  }

  linuxDefinition() {
    const target = path.join(this.home, ".config", "systemd", "user", "posse-automation.service");
    const content = `[Unit]\nDescription=Posse automation owner\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=${systemdQuote(this.nodePath)} ${systemdQuote(this.entryPath)}\nEnvironment=POSSE_AUTOMATION_DATA_DIR=${systemdQuote(this.dataDir)}\nRestart=on-failure\nRestartSec=2\nTimeoutStopSec=20\n\n[Install]\nWantedBy=default.target\n`;
    return {
      manager: "systemd-user", path: target, content,
      install: [cmd("systemctl", "--user", "daemon-reload"), cmd("systemctl", "--user", "enable", "--now", "posse-automation.service")],
      remove: [cmd("systemctl", "--user", "disable", "--now", "posse-automation.service"), cmd("systemctl", "--user", "daemon-reload")],
      status: cmd("systemctl", "--user", "is-active", "--quiet", "posse-automation.service"),
    };
  }

  macDefinition() {
    const target = path.join(this.home, "Library", "LaunchAgents", `${LABEL}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array><string>${xml(this.nodePath)}</string><string>${xml(this.entryPath)}</string></array>\n<key>EnvironmentVariables</key><dict><key>POSSE_AUTOMATION_DATA_DIR</key><string>${xml(this.dataDir)}</string></dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ProcessType</key><string>Background</string>\n</dict></plist>\n`;
    const domain = `gui/${process.getuid?.() ?? 0}`;
    return {
      manager: "launchd-user", path: target, content,
      install: [cmd("launchctl", "bootout", domain, target, { allowFailure: true }), cmd("launchctl", "bootstrap", domain, target), cmd("launchctl", "kickstart", "-k", `${domain}/${LABEL}`)],
      remove: [cmd("launchctl", "bootout", domain, target)],
      status: cmd("launchctl", "print", `${domain}/${LABEL}`),
    };
  }

  windowsDefinition() {
    const target = path.join(this.dataDir, "automation-task.xml");
    const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME || os.userInfo().username;
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Posse automation owner</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority><RestartOnFailure><Interval>PT2S</Interval><Count>999</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${xml(this.nodePath)}</Command><Arguments>${xml(`\"${this.entryPath}\"`)}</Arguments><WorkingDirectory>${xml(path.dirname(this.entryPath))}</WorkingDirectory></Exec></Actions></Task>\n`;
    return {
      manager: "windows-task-scheduler", path: target, content,
      install: [cmd("schtasks.exe", "/Create", "/TN", WINDOWS_TASK, "/XML", target, "/F"), cmd("schtasks.exe", "/Run", "/TN", WINDOWS_TASK)],
      remove: [cmd("schtasks.exe", "/Delete", "/TN", WINDOWS_TASK, "/F")],
      status: cmd("schtasks.exe", "/Query", "/TN", WINDOWS_TASK),
    };
  }

  command(command, options = {}) {
    const result = this.run(command.command, command.args, { encoding: "utf8", windowsHide: true });
    if (result.status !== 0 && !(options.allowFailure || command.allowFailure)) {
      const detail = String(result.stderr || result.stdout || "").trim().slice(0, 500);
      throw serviceError(`Could not configure ${command.command}${detail ? `: ${detail}` : ""}`, "service_manager_failed");
    }
  }

  async stopAdHocSupervisor() {
    try {
      const health = await new AutomationOwnerClient({ timeoutMs: 500 }).health();
      if (health?.supervisor_pid) process.kill(health.supervisor_pid, "SIGTERM");
      else if (health?.pid) process.kill(health.pid, "SIGTERM");
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        try { await new AutomationOwnerClient({ timeoutMs: 100 }).health(); } catch { return; }
      }
    } catch {}
  }
}

function cmd(command, ...args) {
  const options = typeof args.at(-1) === "object" ? args.pop() : {};
  return { command, args, ...options };
}

function runCommand(command, args, options) { return spawnSync(command, args, options); }

function writePrivateFile(filename, content) {
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, filename);
  if (process.platform !== "win32") fs.chmodSync(filename, 0o600);
}

function systemdQuote(value) { return `"${String(value).replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`; }
function xml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function serviceError(message, code) { return Object.assign(new Error(message), { code }); }
