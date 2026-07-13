// @ts-check

import { BINARY_NAMES, nativeBinaryEntry } from "../../../catalog/binary.js";
import { nativeBinaries as defaultNativeBinaries } from "../../tools/classes/BinaryManager.js";

function firstLine(value) {
  return String(value || "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r(?!\n)/gu, "\n")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function resultMessage(result, packageName, dryRun) {
  const version = String(result?.version || "").trim();
  const identity = version ? `${packageName} ${version}` : packageName;
  if (result?.available) {
    if (result.downloaded) return `downloaded ${identity}`;
    return `${identity} ready${result.source ? ` (${result.source})` : ""}`;
  }
  if (dryRun && result?.planned) return `would download ${identity}`;
  const detail = firstLine(result?.error?.message || result?.reason || "native artifact unavailable");
  return `${identity} unavailable${detail ? `: ${detail}` : ""}`;
}

function dependencyEntry(result, { dryRun }) {
  const name = String(result?.name || "unknown");
  const packageName = nativeBinaryEntry(name)?.package || name;
  const planned = dryRun && result?.available !== true && result?.planned === true;
  const installed = result?.available === true && result?.downloaded === true;
  const ready = result?.available === true;
  return {
    present: true,
    label: `native ${name}`,
    name,
    package: packageName,
    version: result?.version || null,
    path: result?.path || null,
    source: result?.source || null,
    downloaded: result?.downloaded === true,
    ok: ready || planned,
    status: installed ? "installed" : ready ? "ok" : planned ? "dry-run" : "failed",
    action: installed || planned ? "download" : "none",
    reason: result?.reason || null,
    message: resultMessage(result, packageName, dryRun),
  };
}

/**
 * Reconcile every enabled catalog binary with the exact version issued by the
 * authenticated artifact service. Doctor/update use the dependency-shaped
 * entries directly; boot uses the same entries for its status panel before
 * probing required workers for protocol readiness.
 *
 * @param {{
 *   manager?: any,
 *   names?: readonly string[],
 *   refresh?: boolean,
 *   dryRun?: boolean,
 *   onProgress?: ((message: string) => void) | null,
 * }} [opts]
 */
export async function reconcileNativeBinaries({
  manager = defaultNativeBinaries,
  names = BINARY_NAMES,
  refresh = true,
  dryRun = false,
  onProgress = null,
} = {}) {
  if (typeof manager?.ensureAvailable !== "function") return [];
  const enabledNames = names.filter((name) => {
    try { return manager.enabled?.(name) === true; } catch { return false; }
  });
  return await Promise.all(enabledNames.map(async (name) => {
    const packageName = nativeBinaryEntry(name)?.package || name;
    onProgress?.(`native ${name}: checking ${packageName}`);
    let result;
    try {
      result = await manager.ensureAvailable(name, { refresh, dryRun });
    } catch (error) {
      result = {
        available: false,
        name,
        reason: error?.code || "artifact_download_failed",
        error,
      };
    }
    return dependencyEntry({ name, ...result }, { dryRun });
  }));
}
