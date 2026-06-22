import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import { readModelSetting } from "./model-config.js";
import { buildCopilotSpawn } from "./launch.js";

let COPILOT_CMD = null;
let COPILOT_RESOLVE_ERROR = null;
let copilotResolved = false;

const COPILOT_PROBE_TIMEOUT_MS = 30_000;

function probeCopilotVersion(cmd) {
  try {
    const launch = buildCopilotSpawn(cmd, ["--version"]);
    const result = spawnSync(launch.command, launch.args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: COPILOT_PROBE_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    return result?.status === 0;
  } catch {
    return false;
  }
}

function resolveCopilot() {
  const configured = readModelSetting("copilot_cli_path");
  if (configured && fs.existsSync(configured) && probeCopilotVersion(configured)) {
    COPILOT_RESOLVE_ERROR = null;
    COPILOT_CMD = configured;
    return;
  }

  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const raw = execFileSync(locator, ["copilot"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (raw) {
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const preferred = lines.find((line) => /\.(exe|cmd)$/i.test(line)) || lines[0];
      if (preferred && probeCopilotVersion(preferred)) {
        COPILOT_RESOLVE_ERROR = null;
        COPILOT_CMD = preferred;
        return;
      }
    }
  } catch {
    // Fall through.
  }

  if (probeCopilotVersion("copilot")) {
    COPILOT_RESOLVE_ERROR = null;
    COPILOT_CMD = "copilot";
    return;
  }

  COPILOT_RESOLVE_ERROR = "Copilot CLI not found on PATH (install via `winget install GitHub.CopilotCLI` or `npm i -g @github/copilot-cli`).";
  COPILOT_CMD = null;
}

export function ensureCopilotResolved() {
  if (copilotResolved && COPILOT_CMD) return;
  copilotResolved = true;
  resolveCopilot();
}

export function getCopilotInfo() {
  ensureCopilotResolved();
  return { cmd: COPILOT_CMD, error: COPILOT_RESOLVE_ERROR };
}
