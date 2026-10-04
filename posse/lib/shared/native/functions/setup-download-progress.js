// @ts-check

import fs from "node:fs";

const MIB = 1024 * 1024;

/**
 * One progress line for Posse Setup's progress file: TAB-separated printable
 * ASCII fields, "-" for an empty field, CRLF-terminated. Mirrors
 * Write-SetupProgress in installers/windows/install-posse-atlas.ps1.
 *
 * @param {Array<string | number>} fields
 * @returns {string}
 */
export function formatSetupProgressLine(fields) {
  const clean = fields.map((value) => {
    let field = String(value ?? "").replace(/[\t\r\n]+/g, " ").replace(/[^\x20-\x7E]/g, "").trim();
    if (field.length > 180) field = `${field.slice(0, 177)}...`;
    return field || "-";
  });
  return `${clean.join("\t")}\r\n`;
}

/**
 * Appends progress lines to the file Posse Setup watches, or does nothing
 * when setup did not pass one. Progress is observational: a failed write
 * never fails the download.
 *
 * @param {string | undefined} progressFile
 * @returns {(fields: Array<string | number>) => void}
 */
export function setupProgressWriter(progressFile) {
  const target = String(progressFile || "").trim();
  if (!target) return () => {};
  return (fields) => {
    try { fs.appendFileSync(target, formatSetupProgressLine(fields), "ascii"); } catch { /* observational */ }
  };
}

/**
 * Sums the per-binary download events from BinaryManager.ensureAvailable into
 * one percentage for setup's item bar: bytes received across every download
 * over the sum of their sizes. The bar starts only once each requested binary
 * has either started downloading or settled (a current binary never starts),
 * so the total cannot grow after the bar first moves, and it never moves back.
 *
 * @param {{
 *   names: string[],
 *   write: (fields: Array<string | number>) => void,
 *   activity?: string,
 *   now?: () => number,
 *   intervalMs?: number,
 * }} options
 */
export function createCollectiveDownloadProgress({
  names,
  write,
  activity = "Downloading Posse's native tools",
  now = Date.now,
  intervalMs = 250,
}) {
  const waiting = new Set(names);
  /** @type {Map<string, { loaded: number, total: number }>} */
  const downloads = new Map();
  let unknownSize = false;
  let announced = false;
  let reported = -1;
  let reportedAt = 0;

  function report(force) {
    if (waiting.size > 0 || unknownSize || downloads.size === 0) return;
    let loaded = 0;
    let total = 0;
    for (const download of downloads.values()) {
      loaded += Math.min(download.loaded, download.total);
      total += download.total;
    }
    if (total <= 0) return;
    const percent = Math.min(100, Math.floor((100 * loaded) / total));
    if (!announced) {
      announced = true;
      write(["act", `${activity} (${Math.max(1, Math.round(total / MIB))} MB)`, percent]);
    } else {
      if (percent <= reported) return;
      if (!force && now() - reportedAt < intervalMs) return;
      write(["actpct", percent]);
    }
    reported = percent;
    reportedAt = now();
  }

  return {
    /** @param {Record<string, unknown>} event */
    onProgress(event) {
      if (event?.type !== "native-artifact-download") return;
      const name = String(event.name || "");
      if (!waiting.has(name) && !downloads.has(name)) return;
      waiting.delete(name);
      const total = Number(event.totalBytes);
      if (!Number.isFinite(total) || total <= 0) {
        // Without every size the combined percentage would be a guess; setup
        // keeps its animated bar instead.
        unknownSize = true;
        return;
      }
      downloads.set(name, { loaded: Math.max(0, Number(event.loadedBytes) || 0), total });
      report(event.phase === "complete");
    },
    /** A binary finished (downloaded, already current, or failed). */
    settle(/** @type {string} */ name) {
      waiting.delete(name);
      report(true);
    },
  };
}
