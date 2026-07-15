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
    if (result?.current === false) {
      const detail = firstLine(result?.refreshError || "current version could not be verified");
      return `${identity} cached but current-version check failed${detail ? `: ${detail}` : ""}`;
    }
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
  const ready = result?.available === true && result?.current !== false;
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
    status: installed && ready ? "installed" : ready ? "ok" : planned ? "dry-run" : "failed",
    action: installed || planned || result?.current === false ? "download" : "none",
    reason: result?.reason || null,
    current: result?.current ?? null,
    refresh_error: result?.refreshError || null,
    message: resultMessage(result, packageName, dryRun),
  };
}

function byteCount(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function createDownloadAggregator(names, onDownloadProgress) {
  if (typeof onDownloadProgress !== "function") return null;
  const states = new Map(names.map((name) => [name, {
    name,
    package: nativeBinaryEntry(name)?.package || name,
    phase: "checking",
    loadedBytes: 0,
    totalBytes: null,
    downloaded: false,
  }]));
  let currentName = null;
  let sawDownload = false;

  const emit = () => {
    if (!sawDownload) return;
    const entries = [...states.values()];
    const active = entries.filter((entry) => entry.phase === "downloading");
    if (!active.some((entry) => entry.name === currentName)) {
      currentName = active.at(-1)?.name || currentName;
    }
    const current = states.get(currentName) || active.at(-1) || null;
    const totalsKnown = entries.every((entry) => entry.phase === "settled" || entry.totalBytes != null);
    const totalBytes = entries.reduce((sum, entry) => sum + (entry.totalBytes || 0), 0);
    const loadedBytes = entries.reduce((sum, entry) => {
      const loaded = entry.loadedBytes || 0;
      return sum + (entry.totalBytes == null ? loaded : Math.min(loaded, entry.totalBytes));
    }, 0);
    const percent = totalsKnown && totalBytes > 0
      ? Math.min(100, (loadedBytes / totalBytes) * 100)
      : null;
    try {
      onDownloadProgress({
        loadedBytes,
        totalBytes: totalsKnown ? totalBytes : null,
        percent,
        currentName: current?.name || null,
        currentPackage: current?.package || null,
        activeCount: active.length,
        downloadCount: entries.filter((entry) => entry.downloaded || entry.totalBytes != null).length,
      });
    } catch { /* progress reporting is observational */ }
  };

  return {
    event(name, event) {
      if (event?.type !== "native-artifact-download") return;
      const state = states.get(name);
      if (!state) return;
      sawDownload = true;
      state.downloaded = true;
      state.phase = event.phase === "complete" ? "verifying" : "downloading";
      state.package = String(event.package || state.package);
      state.loadedBytes = byteCount(event.loadedBytes) ?? state.loadedBytes;
      state.totalBytes = byteCount(event.totalBytes) ?? state.totalBytes;
      currentName = name;
      emit();
    },
    settled(name, result) {
      const state = states.get(name);
      if (!state) return;
      const resultSize = byteCount(result?.size);
      if (resultSize != null && result?.downloaded === true) {
        state.downloaded = true;
        state.loadedBytes = resultSize;
        state.totalBytes = resultSize;
      } else if (state.downloaded && state.totalBytes != null && result?.available === true) {
        state.loadedBytes = state.totalBytes;
      }
      state.phase = "settled";
      emit();
    },
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
 *   onDownloadProgress?: ((progress: { loadedBytes: number, totalBytes: number | null, percent: number | null, currentName: string | null, currentPackage: string | null, activeCount: number, downloadCount: number }) => void) | null,
 * }} [opts]
 */
export async function reconcileNativeBinaries({
  manager = defaultNativeBinaries,
  names = BINARY_NAMES,
  refresh = true,
  dryRun = false,
  onProgress = null,
  onDownloadProgress = null,
} = {}) {
  if (typeof manager?.ensureAvailable !== "function") return [];
  const enabledNames = names.filter((name) => {
    try { return manager.enabled?.(name) === true; } catch { return false; }
  });
  const downloadAggregator = createDownloadAggregator(enabledNames, onDownloadProgress);
  return await Promise.all(enabledNames.map(async (name) => {
    const packageName = nativeBinaryEntry(name)?.package || name;
    onProgress?.(`native ${name}: checking ${packageName}`);
    let result;
    try {
      const ensureOptions = { refresh, dryRun };
      if (downloadAggregator) {
        ensureOptions.onProgress = (event) => downloadAggregator.event(name, event);
      }
      result = await manager.ensureAvailable(name, ensureOptions);
    } catch (error) {
      result = {
        available: false,
        name,
        reason: error?.code || "artifact_download_failed",
        error,
      };
    }
    downloadAggregator?.settled(name, result);
    return dependencyEntry({ name, ...result }, { dryRun });
  }));
}
