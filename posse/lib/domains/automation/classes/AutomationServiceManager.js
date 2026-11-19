import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AutomationOwnerClient, ensureAutomationOwner, stopAutomationOwner } from "./AutomationOwnerClient.js";
import { automationDataDir } from "../functions/paths.js";
import { AUTOMATION_OWNER_LAUNCH } from "../../../catalog/custom-tools.js";

const LABEL = "com.posse.automation";
const WINDOWS_TASK = "Posse Automation Owner";
// How long install waits for the service's owner to become ready. A prior
// owner that did not release the dispatcher lease holds it for up to 15 s.
const SERVICE_START_TIMEOUT_MS = 30_000;

export class AutomationServiceManager {
  constructor({ platform = process.platform, home = os.homedir(), nodePath = process.execPath, dataDir = automationDataDir(), run = runCommand,
    ownerHealth = () => new AutomationOwnerClient({ timeoutMs: 500 }).health(), startTimeoutMs = SERVICE_START_TIMEOUT_MS } = {}) {
    this.platform = platform;
    this.home = home;
    this.nodePath = path.resolve(nodePath);
    this.dataDir = path.resolve(dataDir);
    this.run = run;
    this.ownerHealth = ownerHealth;
    this.startTimeoutMs = startTimeoutMs;
    this.entryPath = fileURLToPath(new URL("../functions/automation-supervisor-entry.js", import.meta.url));
  }

  definition() {
    if (this.platform === "linux") return this.linuxDefinition();
    if (this.platform === "darwin") return this.macDefinition();
    if (this.platform === "win32") return this.windowsDefinition();
    throw serviceError(`Automation startup is unsupported on ${this.platform}`, "service_unsupported");
  }

  // The service's owner can serve only after the running owner (ad hoc, or
  // the service's previous build) releases the dispatcher lease, so that
  // owner is stopped as late as possible: after the manager accepted the
  // definition, right before the command that starts it. Install succeeds
  // only once the service's own owner is ready; otherwise it fails, and an
  // owner it stopped is started again.
  async install() {
    const definition = this.definition();
    const previous = fs.existsSync(definition.path) ? fs.readFileSync(definition.path) : null;
    fs.mkdirSync(path.dirname(definition.path), { recursive: true, mode: 0o700 });
    writePrivateFile(definition.path, definition.content, definition.encoding);
    const starting = definition.install.findIndex(command => command.starts);
    try {
      for (const command of definition.install.slice(0, starting)) this.command(command);
    } catch (error) {
      if (previous) writePrivateFile(definition.path, previous); else fs.rmSync(definition.path, { force: true });
      throw error;
    }
    const stop = await this.stopAdHocSupervisor();
    if (stop === "running") throw serviceError("The running automation owner did not stop; stop it and install the service again", "service_manager_failed");
    try {
      for (const command of definition.install.slice(starting)) this.command(command);
      await this.awaitServiceOwner(definition);
    } catch (error) {
      if (stop === "stopped") await this.restartAdHocOwner();
      else if (previous) {
        // A reinstall: the service's previous build was the running owner, and
        // the commands above may already have stopped it (launchd's bootout).
        // Put its definition back and start it again, best effort.
        try {
          writePrivateFile(definition.path, previous);
          for (const command of definition.install) this.command(command, { allowFailure: true });
        } catch { /* the install error is the one to report */ }
      }
      throw error;
    }
    return { installed: true, manager: definition.manager, definition: definition.path, ...await this.status() };
  }

  async awaitServiceOwner(definition) {
    const deadline = Date.now() + this.startTimeoutMs;
    for (;;) {
      let health = null;
      try { health = await this.ownerHealth(); } catch {}
      if (health?.ready === true && health.launch === AUTOMATION_OWNER_LAUNCH.SERVICE) return health;
      if (Date.now() >= deadline) {
        throw serviceError(`${definition.manager} did not start a ready automation owner within ${Math.round(this.startTimeoutMs / 1000)}s; check the service's log`, "service_start_failed");
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
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
    try { owner = await this.ownerHealth(); } catch {}
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
      install: [cmd("systemctl", "--user", "daemon-reload"), cmd("systemctl", "--user", "enable", "posse-automation.service"), cmd("systemctl", "--user", "start", "posse-automation.service", { starts: true })],
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
      install: [cmd("launchctl", "bootout", domain, target, { allowFailure: true }), cmd("launchctl", "bootstrap", domain, target, { starts: true }), cmd("launchctl", "kickstart", "-k", `${domain}/${LABEL}`)],
      remove: [cmd("launchctl", "bootout", domain, target)],
      status: cmd("launchctl", "print", `${domain}/${LABEL}`),
    };
  }

  windowsDefinition() {
    const target = path.join(this.dataDir, "automation-task.xml");
    const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME || os.userInfo().username;
    // schtasks /XML reads task files as UTF-16; a UTF-8 file fails with
    // "The task XML is malformed ... unable to switch the encoding".
    // Task Scheduler's schema bounds RestartOnFailure: Interval PT1M..P31D and
    // Count an unsignedByte (1..255); anything outside is rejected as
    // "incorrectly formatted or out of range".
    const content = `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Posse automation owner</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${xml(this.nodePath)}</Command><Arguments>${xml(`\"${this.entryPath}\"`)}</Arguments><WorkingDirectory>${xml(path.dirname(this.entryPath))}</WorkingDirectory></Exec></Actions></Task>\n`;
    return {
      manager: "windows-task-scheduler", path: target, content, encoding: "utf16le",
      install: [cmd("schtasks.exe", "/Create", "/TN", WINDOWS_TASK, "/XML", target, "/F"), cmd("schtasks.exe", "/Run", "/TN", WINDOWS_TASK, { starts: true })],
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

  // Stops the owner now serving, if any: "none", "stopped", or "running"
  // when it would not stop.
  async stopAdHocSupervisor() {
    let health;
    try { health = await this.ownerHealth(); } catch { return "none"; }
    try { return await stopAutomationOwner(health, { timeoutMs: 3000 }) ? "stopped" : "running"; } catch { return "running"; }
  }

  async restartAdHocOwner() {
    try { await ensureAutomationOwner(); } catch {}
  }
}

function cmd(command, ...args) {
  const options = typeof args.at(-1) === "object" ? args.pop() : {};
  return { command, args, ...options };
}

function runCommand(command, args, options) { return spawnSync(command, args, options); }

function writePrivateFile(filename, content, encoding = "utf8") {
  const temporary = `${filename}.${process.pid}.tmp`;
  // UTF-16 files carry a byte-order mark so readers detect the encoding.
  const data = encoding === "utf16le" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]) : content;
  fs.writeFileSync(temporary, data, { mode: 0o600 });
  fs.renameSync(temporary, filename);
  if (process.platform !== "win32") fs.chmodSync(filename, 0o600);
}

function systemdQuote(value) { return `"${String(value).replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`; }
function xml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function serviceError(message, code) { return Object.assign(new Error(message), { code }); }
