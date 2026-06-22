import path from "path";

import { getSetting, setSetting } from "../../queue/functions/index.js";
import { discoverClaudeCli } from "./claude/cli-discovery.js";
import { discoverCodexCli } from "./codex/index.js";

function readSetting(key) {
  try {
    const value = getSetting(key);
    return value && String(value).trim() ? String(value).trim() : "";
  } catch {
    return "";
  }
}

function samePath(a, b) {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  if (!left || !right) return left === right;
  try {
    const resolvedLeft = path.resolve(left);
    const resolvedRight = path.resolve(right);
    return process.platform === "win32"
      ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
      : resolvedLeft === resolvedRight;
  } catch {
    return process.platform === "win32"
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  }
}

function initOne(discovery, { force = false, dryRun = false } = {}) {
  const current = readSetting(discovery.settingKey);
  const selected = discovery.selected || "";
  const shouldWrite = !!selected && (force || !current || !samePath(current, selected));
  if (shouldWrite && !dryRun) setSetting(discovery.settingKey, selected);
  return {
    ...discovery,
    current,
    changed: shouldWrite,
    status: selected
      ? shouldWrite
        ? (dryRun ? "would_update" : "updated")
        : "kept"
      : "missing",
  };
}

export function initializeProviderCliSettings({ force = false, dryRun = false } = {}) {
  const entries = [
    initOne(discoverClaudeCli(), { force, dryRun }),
    initOne(discoverCodexCli(), { force, dryRun }),
  ];
  return {
    entries,
    changed: entries.filter((entry) => entry.changed).length,
  };
}
