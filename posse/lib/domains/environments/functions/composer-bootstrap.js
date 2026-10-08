// @ts-check

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { findCommandOnPath } from "../../../shared/platform/functions/command-launch.js";
import { composerBin, runCommand, scipDependencyInstallEnv } from "./scip-install-runtime.js";

const COMPOSER_INSTALLER_URL = "https://getcomposer.org/installer";
const COMPOSER_SIGNATURE_URL = "https://composer.github.io/installer.sig";
// Composer needs openssl (TLS downloads). curl and zip only make installs
// faster: enabled when the PHP build has them, never required.
const COMPOSER_REQUIRED_EXTENSIONS = ["openssl"];
const COMPOSER_PHP_EXTENSIONS = ["openssl", "curl", "zip"];

/** Where Posse keeps its own Composer, beside its other managed tools. */
export function managedComposerPhar(installRoot) {
  return path.join(installRoot, "scip", "bin", "composer.phar");
}

/** The CA bundle Posse's own Composer verifies TLS against. */
export function managedComposerCaFile(installRoot) {
  return path.join(installRoot, "scip", "bin", "composer-cacert.pem");
}

/**
 * Writes the certificate authorities Posse's own downloads already trust
 * (Node's bundled roots plus the OS store) for Posse's Composer. PHP's
 * OpenSSL never reads the Windows store: it trusts whatever openssl.cafile or
 * SSL_CERT_FILE names, and a wrong or stale bundle there (or an antivirus
 * root only the OS store holds) fails every download with "certificate
 * verify failed" while Posse's own downloads succeed.
 *
 * @param {string} installRoot
 * @param {{ certificates?: (type: "default" | "system") => readonly string[] }} [options]
 * @returns {string | null} the bundle path, or null when none could be written
 *   (Composer then keeps PHP's own CA configuration)
 */
export function writeComposerCaFile(installRoot, {
  certificates = (type) => (typeof tls.getCACertificates === "function" ? tls.getCACertificates(type) : tls.rootCertificates),
} = {}) {
  const pems = new Set();
  for (const type of /** @type {const} */ (["default", "system"])) {
    try { for (const pem of certificates(type)) pems.add(String(pem).trim()); } catch { /* that store is unavailable */ }
  }
  if (pems.size === 0) return null;
  const file = managedComposerCaFile(installRoot);
  const contents = `${[...pems].join("\n")}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === contents) return file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, file);
    return file;
  } catch {
    fs.rmSync(tmp, { force: true });
    // A bundle a running Composer holds open still verifies; keep using it.
    return fs.existsSync(file) ? file : null;
  }
}

function managedComposer(phar, caFile) {
  return caFile
    ? { command: "php", args: [phar], env: { COMPOSER_CAFILE: caFile } }
    : { command: "php", args: [phar] };
}

/**
 * The Composer command Posse runs: `composer` on PATH, else PHP with Posse's
 * managed composer.phar. When PHP is present but Composer is not, Posse
 * installs composer.phar itself (Composer's signature-verified installer), so
 * a skipped or failed installer step is repaired by the next doctor run
 * instead of leaving PHP indexing unavailable. The managed Composer verifies
 * TLS with Posse's CA bundle (`env` holds COMPOSER_CAFILE; callers add it to
 * the command's environment).
 *
 * @param {{
 *   installRoot: string,
 *   dryRun?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   fetchImpl?: typeof fetch,
 *   onProgress?: ((message: string) => void) | null,
 *   timeoutMs?: number,
 *   install?: boolean,
 * }} options
 * @returns {Promise<{ command: string, args: string[], env?: Record<string, string> } | { pending: string } | { error: string }>}
 */
export async function ensureComposer({
  installRoot,
  dryRun = false,
  env = scipDependencyInstallEnv(),
  platform = process.platform,
  fetchImpl = globalThis.fetch,
  onProgress = null,
  timeoutMs = 5 * 60_000,
  // false: use a Composer that is already there, never install one.
  install = true,
}) {
  if (findCommandOnPath("composer", { env, platform })) return { command: composerBin(platform), args: [] };
  const php = findCommandOnPath("php", { env, platform });
  if (!php) return { error: "PHP is not installed (or not on PATH), so Composer cannot run" };
  const phar = managedComposerPhar(installRoot);
  if (fs.existsSync(phar)) {
    const healthy = await runCommand(php, [phar, "--version", "--no-ansi"], {
      env,
      timeoutMs: Math.min(timeoutMs, 30_000),
    });
    if (healthy.ok) return managedComposer(phar, writeComposerCaFile(installRoot));
    if (!install) return { error: `Composer is not usable: ${firstLine(healthy.message) || "the managed composer.phar failed its version check"}` };
    if (dryRun) return { pending: `would reinstall Composer into ${path.dirname(phar)}` };
    onProgress?.("reinstalling Posse's unusable Composer");
    fs.rmSync(phar, { force: true });
  }
  if (!install) return { error: "Composer is not installed" };
  if (dryRun) return { pending: `would install Composer into ${path.dirname(phar)}` };

  onProgress?.("installing Composer for PHP");
  if (platform === "win32") {
    const extensions = await enablePhpComposerExtensions(php, { env });
    if (!extensions.ok) return { error: extensions.message };
  }
  const setupDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-composer-"));
  try {
    const setup = path.join(setupDir, "composer-setup.php");
    // The signature and installer are fetched separately; a release landing
    // between the two reads is a mismatch that one fresh pair resolves.
    let verified = false;
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !verified; attempt++) {
      try {
        const expected = (await fetchText(fetchImpl, COMPOSER_SIGNATURE_URL)).trim().toLowerCase();
        const installer = await fetchBytes(fetchImpl, COMPOSER_INSTALLER_URL);
        const actual = crypto.createHash("sha384").update(installer).digest("hex");
        if (/^[0-9a-f]{96}$/u.test(expected) && actual === expected) {
          fs.writeFileSync(setup, installer);
          verified = true;
        } else {
          lastError = "the Composer installer did not match its published SHA-384 signature";
        }
      } catch (err) {
        lastError = `could not download the Composer installer: ${err?.message || err}`;
      }
    }
    if (!verified) return { error: lastError };
    fs.mkdirSync(path.dirname(phar), { recursive: true });
    const caFile = writeComposerCaFile(installRoot);
    const run = await runCommand(php, [
      setup,
      `--install-dir=${path.dirname(phar)}`,
      "--filename=composer.phar",
      ...(caFile ? [`--cafile=${caFile}`] : []),
      "--quiet",
    ], {
      env,
      timeoutMs,
    });
    if (!run.ok || !fs.existsSync(phar)) {
      return { error: `the Composer installer failed: ${firstLine(run.message) || "composer.phar was not created"}` };
    }
    const healthy = await runCommand(php, [phar, "--version", "--no-ansi"], {
      env,
      timeoutMs: Math.min(timeoutMs, 30_000),
    });
    if (!healthy.ok) {
      fs.rmSync(phar, { force: true });
      return { error: `the Composer installer produced an unusable composer.phar: ${firstLine(healthy.message) || "version check failed"}` };
    }
    onProgress?.(`installed Composer into ${path.dirname(phar)}`);
    return managedComposer(phar, caFile);
  } finally {
    fs.rmSync(setupDir, { recursive: true, force: true });
  }
}

/**
 * Turns on the PHP extensions Composer needs, the way the Windows installer
 * does: a winget PHP ships without a php.ini, so openssl, curl, and zip are
 * off. Writes the loaded php.ini (backed up once), or creates one from PHP's
 * bundled template.
 *
 * @param {string} php
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ ok: boolean, changed: boolean, message: string }>}
 */
export async function enablePhpComposerExtensions(php, { env = process.env } = {}) {
  const missing = await missingPhpExtensions(php, env);
  if (missing === null) return { ok: false, changed: false, message: `${php} did not run` };
  if (!missing.some((name) => COMPOSER_REQUIRED_EXTENSIONS.includes(name))) {
    return { ok: true, changed: false, message: "PHP has the extensions Composer needs" };
  }

  const binary = (await phpOutput(php, ["-r", "echo PHP_BINARY;"], env)) || php;
  let phpDir;
  try { phpDir = path.dirname(fs.realpathSync(binary)); }
  catch { phpDir = path.dirname(binary); }
  const extDir = path.join(phpDir, "ext");
  const available = missing.filter((name) => fs.existsSync(path.join(extDir, `php_${name}.dll`)));
  const missingRequired = COMPOSER_REQUIRED_EXTENSIONS.filter((name) => missing.includes(name) && !available.includes(name));
  if (missingRequired.length > 0) {
    return { ok: false, changed: false, message: `this PHP build has no ${missingRequired.join(", ")} extension; install the official PHP for Windows build` };
  }
  const loaded = await phpOutput(php, ["-r", "echo php_ini_loaded_file() ?: '';"], env);
  const iniPath = loaded || path.join(phpDir, "php.ini");
  try {
    if (!fs.existsSync(iniPath)) {
      const template = ["php.ini-production", "php.ini-development"]
        .map((name) => path.join(phpDir, name))
        .find((candidate) => fs.existsSync(candidate));
      if (!template) return { ok: false, changed: false, message: `PHP has no php.ini or php.ini template in ${phpDir}` };
      fs.copyFileSync(template, iniPath);
    } else if (!fs.existsSync(`${iniPath}.posse-backup`)) {
      fs.copyFileSync(iniPath, `${iniPath}.posse-backup`);
    }
    let contents = fs.readFileSync(iniPath, "utf8");
    const newline = contents.includes("\r\n") ? "\r\n" : "\n";
    // A configured extension_dir that already holds these extensions stays:
    // other extensions may load from it. Otherwise point it at PHP's own ext.
    const configuredDir = /^[ \t]*extension_dir[ \t]*=[ \t]*"?([^"\r\n;]*)"?/imu.exec(contents)?.[1]?.trim() || "";
    const keepDir = configuredDir && available.every((name) => fs.existsSync(path.join(path.resolve(phpDir, configuredDir), `php_${name}.dll`)));
    // Drop active copies so the block below is authoritative; the template's
    // commented examples stay as documentation.
    if (!keepDir) contents = contents.replace(/^[ \t]*extension_dir[ \t]*=.*(?:\r?\n)?/gimu, "");
    contents = contents.replace(/^[ \t]*extension[ \t]*=[ \t]*(?:php_)?(?:openssl|curl|zip)(?:\.dll)?[ \t]*(?:;.*)?(?:\r?\n)?/gimu, "");
    const block = [
      "; Posse: secure and fast Composer package downloads.",
      ...(keepDir ? [] : [`extension_dir = "${extDir.replaceAll("\\", "/")}"`]),
      ...available.map((name) => `extension=${name}`),
    ].join(newline);
    // Settings after a [PATH=...] or [HOST=...] section apply only there, so
    // the block goes before the first such section.
    const section = /^[ \t]*\[(?:PATH|HOST)=/imu.exec(contents);
    contents = section
      ? `${contents.slice(0, section.index).replace(/[\r\n]+$/u, "")}${newline}${newline}${block}${newline}${newline}${contents.slice(section.index)}`
      : `${contents.replace(/[\r\n]+$/u, "")}${newline}${newline}${block}${newline}`;
    fs.writeFileSync(iniPath, contents);
  } catch (err) {
    return { ok: false, changed: false, message: `could not enable PHP's Composer extensions in ${iniPath}: ${err?.message || err}` };
  }
  const still = await missingPhpExtensions(php, env);
  const stillRequired = still === null ? COMPOSER_REQUIRED_EXTENSIONS : still.filter((name) => COMPOSER_REQUIRED_EXTENSIONS.includes(name));
  if (stillRequired.length > 0) {
    return { ok: false, changed: true, message: `PHP still cannot load ${stillRequired.join(", ")} after configuring ${iniPath}` };
  }
  return { ok: true, changed: true, message: `enabled PHP ${available.join(", ")} in ${iniPath}` };
}

async function missingPhpExtensions(php, env) {
  const code = `foreach (${JSON.stringify(COMPOSER_PHP_EXTENSIONS)} as $e) { if (!extension_loaded($e)) { echo $e, PHP_EOL; } }`;
  const output = await phpOutput(php, ["-r", code], env);
  if (output === null) return null;
  return output.split(/\r?\n/u).map((line) => line.trim()).filter((line) => COMPOSER_PHP_EXTENSIONS.includes(line));
}

/**
 * Runs a PHP snippet from a temporary file: no code passes through a command
 * line (cmd.exe and PowerShell 5.1 both mangle quotes), and a php.cmd/.bat
 * shim runs through cmd.exe with nothing but two quoted paths.
 * @returns {Promise<string | null>} trimmed stdout, or null when PHP failed
 */
function phpOutput(php, args, env) {
  const code = args[0] === "-r" ? args[1] : null;
  const dir = code === null ? null : fs.mkdtempSync(path.join(os.tmpdir(), "posse-php-"));
  const script = dir ? path.join(dir, "probe.php") : null;
  if (script) fs.writeFileSync(script, `<?php ${code}`);
  const phpArgs = script ? [script] : args;
  const shim = process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(php);
  const [file, fileArgs, options] = shim
    ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${php}" ${phpArgs.map((arg) => `"${arg}"`).join(" ")}"`], { windowsVerbatimArguments: true }]
    : [php, phpArgs, {}];
  return new Promise((resolve) => {
    execFile(file, fileArgs, { env, timeout: 30_000, windowsHide: true, ...options }, (err, stdout) => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      resolve(err ? null : String(stdout || "").trim());
    });
  });
}

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.text();
}

async function fetchBytes(fetchImpl, url) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || "";
}
