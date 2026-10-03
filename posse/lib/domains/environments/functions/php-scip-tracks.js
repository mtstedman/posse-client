// @ts-check
//
// Posse ships two Composer environments for the PHP SCIP indexer:
//
//   scip/php         current upstream scip-php (needs PHP 8.3+)
//   scip/php-legacy  scip-php v0.0.2, pinned for PHP 8.1/8.2 hosts
//                    (Debian 12, Ubuntu 22.04)
//
// The installer picks a track from the PHP version it detects, installs that
// environment, and stamps it with a hash of its Composer inputs. The stamp is
// what marks the environment active: the wrapper (scip/bin/scip-php.mjs) runs
// the stamped track, a changed input hash triggers a reinstall, and the stager
// folds the stamp into its reuse keys as the indexer identity.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PHP_SCIP_ENV_STAMP_FILENAME = ".posse-scip-env.json";
export const PHP_SCIP_ENV_STAMP_SCHEMA = 1;
export const PHP_SCIP_ENV_INPUTS = Object.freeze(["composer.json", "composer.lock", "patch-scip-php.mjs"]);

/** @typedef {"modern" | "legacy"} PhpScipTrackId */

/**
 * @typedef {{
 *   id: PhpScipTrackId,
 *   dir: string,
 *   minPhp: string,
 *   description: string,
 * }} PhpScipTrack
 */

/** @type {Readonly<Record<PhpScipTrackId, Readonly<PhpScipTrack>>>} */
export const PHP_SCIP_TRACKS = Object.freeze({
  modern: Object.freeze({ id: "modern", dir: "php", minPhp: "8.3.0", description: "current upstream scip-php" }),
  legacy: Object.freeze({ id: "legacy", dir: "php-legacy", minPhp: "8.1.0", description: "pinned scip-php v0.0.2" }),
});

/** Preference order when no installer decision is recorded. */
/** @type {readonly PhpScipTrackId[]} */
export const PHP_SCIP_TRACK_ORDER = Object.freeze(["modern", "legacy"]);

/**
 * @param {unknown} text
 * @returns {string | null}
 */
export function parsePhpVersion(text) {
  const match = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/u);
  if (!match) return null;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

/**
 * Version from `php -v` output ("PHP 8.3.6 (cli) ..."), ignoring any startup
 * warnings printed before it.
 *
 * @param {unknown} text
 * @returns {string | null}
 */
export function parsePhpCliVersion(text) {
  const match = String(text || "").match(/(?:^|\n)\s*PHP (\d+\.\d+\.\d+)/u);
  return match ? parsePhpVersion(match[1]) : parsePhpVersion(text);
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function comparePhpVersions(left, right) {
  const a = String(left).split(".").map((part) => Number(part) || 0);
  const b = String(right).split(".").map((part) => Number(part) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Choose the scip-php track for a detected PHP version.
 *
 * @param {string | null | undefined} phpVersion
 * @returns {{ track: PhpScipTrackId | null, phpVersion: string | null, reason: string }}
 */
export function selectPhpScipTrack(phpVersion) {
  const version = parsePhpVersion(phpVersion);
  if (!version) return { track: null, phpVersion: null, reason: "PHP CLI not found" };
  const modern = PHP_SCIP_TRACKS.modern;
  const legacy = PHP_SCIP_TRACKS.legacy;
  if (comparePhpVersions(version, modern.minPhp) >= 0) {
    return { track: "modern", phpVersion: version, reason: `PHP ${version} >= ${shortVersion(modern.minPhp)}` };
  }
  if (comparePhpVersions(version, legacy.minPhp) >= 0) {
    return { track: "legacy", phpVersion: version, reason: `PHP ${version} < ${shortVersion(modern.minPhp)}` };
  }
  return {
    track: null,
    phpVersion: version,
    reason: `PHP ${version} is older than ${shortVersion(legacy.minPhp)}, the oldest PHP scip-php runs on`,
  };
}

/**
 * One-line, user-facing description of a track decision.
 *
 * @param {{ track: PhpScipTrackId | null, reason: string }} selection
 * @returns {string}
 */
export function describePhpScipSelection(selection) {
  if (!selection?.track) return `no scip-php track (${selection?.reason || "PHP CLI not found"})`;
  const track = PHP_SCIP_TRACKS[selection.track];
  return `scip-php ${track.id} track, ${track.description} (${selection.reason})`;
}

/**
 * Hash of the Composer inputs that define an environment: composer.json,
 * composer.lock, and the post-install patch script. Line endings are
 * normalized so a CRLF checkout stamps the same as an LF one.
 *
 * @param {string} dir
 * @returns {string | null} null when any input is missing
 */
export function phpScipEnvInputHash(dir) {
  const hash = crypto.createHash("sha256");
  for (const name of PHP_SCIP_ENV_INPUTS) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      return null;
    }
    hash.update(`${name}\0${text.replace(/\r\n/gu, "\n")}\0`);
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * @param {string} envDir
 * @returns {string}
 */
export function phpScipEnvStampPath(envDir) {
  // Inside vendor/: gitignored in a checkout, and gone with the install it
  // describes when vendor/ is removed.
  return path.join(envDir, "vendor", PHP_SCIP_ENV_STAMP_FILENAME);
}

/**
 * @param {string} envDir
 * @returns {string}
 */
export function phpScipUpstreamCommand(envDir) {
  // The extensionless PHP proxy Composer writes on every platform; the
  // wrapper runs it with `php`.
  return path.join(envDir, "vendor", "bin", "scip-php");
}

/**
 * @typedef {{
 *   schema: number,
 *   track: PhpScipTrackId,
 *   input_hash: string,
 *   php_version: string | null,
 *   installed_at: string,
 * }} PhpScipEnvStamp
 */

/**
 * @param {string} envDir
 * @returns {PhpScipEnvStamp | null}
 */
export function readPhpScipEnvStamp(envDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(phpScipEnvStampPath(envDir), "utf8"));
    if (Number(parsed?.schema) !== PHP_SCIP_ENV_STAMP_SCHEMA) return null;
    if (!Object.hasOwn(PHP_SCIP_TRACKS, String(parsed?.track || ""))) return null;
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(parsed?.input_hash || ""))) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {string} envDir
 * @param {{ track: PhpScipTrackId, inputHash: string, phpVersion?: string | null, now?: Date }} input
 * @returns {PhpScipEnvStamp}
 */
export function writePhpScipEnvStamp(envDir, { track, inputHash, phpVersion = null, now = new Date() }) {
  /** @type {PhpScipEnvStamp} */
  const stamp = {
    schema: PHP_SCIP_ENV_STAMP_SCHEMA,
    track,
    input_hash: inputHash,
    php_version: phpVersion || null,
    installed_at: now.toISOString(),
  };
  const file = phpScipEnvStampPath(envDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
  return stamp;
}

/**
 * @param {string} envDir
 */
export function removePhpScipEnvStamp(envDir) {
  try { fs.rmSync(phpScipEnvStampPath(envDir), { force: true }); } catch { /* best effort */ }
}

/**
 * @typedef {{
 *   track: PhpScipTrackId,
 *   envDir: string,
 *   upstream: string,
 *   stamp: PhpScipEnvStamp | null,
 *   identity: string,
 * }} PhpScipRuntime
 */

/**
 * Find the environment the wrapper should run. A stamped environment (the
 * installer's decision) wins; without one, the first installed track in
 * preference order is used so hand-made installs keep working.
 *
 * @param {{ scipRoots: string[] }} input  directories that contain php/ and php-legacy/
 * @returns {PhpScipRuntime | null}
 */
export function resolvePhpScipRuntime({ scipRoots }) {
  /** @type {PhpScipRuntime[]} */
  const installed = [];
  const seen = new Set();
  for (const root of scipRoots || []) {
    if (!root) continue;
    const resolvedRoot = path.resolve(root);
    if (seen.has(resolvedRoot)) continue;
    seen.add(resolvedRoot);
    for (const trackId of PHP_SCIP_TRACK_ORDER) {
      const envDir = path.join(resolvedRoot, PHP_SCIP_TRACKS[trackId].dir);
      const upstream = phpScipUpstreamCommand(envDir);
      if (!isFile(upstream)) continue;
      const rawStamp = readPhpScipEnvStamp(envDir);
      const stamp = rawStamp?.track === trackId ? rawStamp : null;
      installed.push({ track: trackId, envDir, upstream, stamp, identity: phpScipIndexerIdentity(trackId, stamp) });
    }
  }
  return installed.find((entry) => entry.stamp) || installed[0] || null;
}

/**
 * Stable identity of the indexer an environment runs, for reuse keys.
 *
 * @param {PhpScipTrackId} track
 * @param {PhpScipEnvStamp | null} stamp
 * @returns {string}
 */
export function phpScipIndexerIdentity(track, stamp) {
  return `scip-php:${track}:${stamp?.input_hash || "unstamped"}`;
}

/**
 * @param {string} version
 * @returns {string}
 */
function shortVersion(version) {
  return String(version).replace(/\.0$/u, "");
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
