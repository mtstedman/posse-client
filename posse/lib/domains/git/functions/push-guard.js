import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { runGitNativeMethod, runGitNativeMethodAsync } from "./native/invoke.js";

export const SAFE_PUSH_REFSPEC = "HEAD";

const execFileAsync = promisify(execFileCallback);
const REMOTE_PUSH_CONFIG_RE = "^remote\\..*\\.(push|mirror)$";

function refspecSource(refspec) {
  return String(refspec || "").trim().replace(/^\+/, "").split(":")[0].replace(/\/+$/, "");
}

export function pushRefspecIsClearlyRestrictive(refspec) {
  const source = refspecSource(refspec);
  return !source
    || source === SAFE_PUSH_REFSPEC
    || source === "refs/heads"
    || source.startsWith("refs/heads/");
}

function isTrueConfigValue(value) {
  return /^(?:true|yes|on|1)$/i.test(String(value || "").trim());
}

export async function remotePushConfigsAreClearlyRestrictive(cwd, options = {}) {
  const execFileAsyncImpl = options.execFileAsync || execFileAsync;
  let stdout = "";
  try {
    const result = await execFileAsyncImpl("git", [
      "config",
      "--get-regexp",
      REMOTE_PUSH_CONFIG_RE,
    ], {
      cwd,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 5_000,
      windowsHide: true,
    });
    stdout = String(result?.stdout || "");
  } catch (err) {
    if (Number(err?.code) !== 1) return false;
    stdout = String(err?.stdout || "");
  }

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\S+)\s+(.*)$/);
    if (!match) return false;
    const [, key, value] = match;
    const keyMatch = key.match(/^remote\..+\.(push|mirror)$/);
    if (!keyMatch) return false;
    const field = keyMatch[1];
    if (field === "mirror" && isTrueConfigValue(value)) return false;
    if (field === "push" && !pushRefspecIsClearlyRestrictive(value)) return false;
  }
  return true;
}

export function pushRefspecCanPublishSnapshotRefs(refspec, nativeParity = {}) {
  return Boolean(runGitNativeMethod(
    "git.push.refspecCanPublishSnapshotRefs",
    { refspec: String(refspec || "") },
    nativeParity,
  ));
}

export function snapshotPublishingPushConfigs(cwd, nativeParity = {}) {
  return runGitNativeMethod("git.snapshotPublishingPushConfigs", { cwd }, nativeParity);
}

export async function snapshotPublishingPushConfigsAsync(cwd, nativeParity = {}) {
  return runGitNativeMethodAsync("git.snapshotPublishingPushConfigs", { cwd }, nativeParity);
}

function gitNativeOptions(options = {}) {
  return options.nativeParity || options;
}

export async function ensureRestrictivePushRefspecsAsync(cwd, options = {}) {
  const result = await runGitNativeMethodAsync(
    "git.ensureRestrictivePushRefspecs",
    { cwd },
    gitNativeOptions(options),
  );
  return Array.isArray(result?.changed) ? result.changed : [];
}
