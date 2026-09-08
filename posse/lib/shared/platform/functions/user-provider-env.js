import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Default import: a named `parseEnv` import is a link-time SyntaxError on Node
// releases before 20.12, which would fire before orchestrator.js can print
// its Node-floor remedy.
import util from "node:util";
import { INSTALLER_PROVIDER_KEY_NAMES } from "../../../catalog/provider-credentials.js";

export function userProviderEnvPath(home = os.homedir()) {
  return path.join(home, ".config", "posse", ".env");
}

/**
 * @param {string} [file]
 * @param {{ onWarning?: ((error: any) => void) | null }} [options] onWarning
 *   receives read errors from legacy files instead of them being thrown.
 */
export function readUserProviderEnv(file = userProviderEnvPath(), { onWarning = null } = {}) {
  let contents;
  try { contents = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return readLegacyProviderEnv(path.dirname(file), onWarning);
    throw error;
  }
  if (typeof util.parseEnv !== "function") throw new Error(`Node ${process.versions.node} lacks util.parseEnv; Posse requires Node 24+`);
  const parsed = util.parseEnv(contents);
  return Object.fromEntries(INSTALLER_PROVIDER_KEY_NAMES
    .filter((name) => parsed[name])
    .map((name) => [name, parsed[name]]));
}

export function loadUserProviderEnv({ file = userProviderEnvPath(), env = process.env, onWarning = null } = {}) {
  const values = readUserProviderEnv(file, { onWarning });
  for (const [name, value] of Object.entries(values)) {
    if (!env[name]) env[name] = value;
  }
  return values;
}

export function formatUserProviderEnv(values) {
  const lines = ["# Posse credentials. Private to this user; do not commit or share."];
  for (const name of INSTALLER_PROVIDER_KEY_NAMES) {
    const value = values[name];
    if (!value) continue;
    // Literal single quotes prevent dotenv expansion and preserve dollars and
    // backslashes. Reject characters that cannot round-trip in this format.
    if (/[\r\n\0']/.test(value)) throw new Error(`${name} contains unsupported quote or control characters`);
    lines.push(`${name}='${value}'`);
  }
  return `${lines.join("\n")}\n`;
}

export function saveUserProviderEnv(values, file = userProviderEnvPath()) {
  if (process.platform === "win32") throw new Error("Use the installer's restricted ACL writer on Windows");
  const contents = formatUserProviderEnv({ ...readUserProviderEnv(file), ...values });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// Read older installer files as data. Accept the literal single-quoted PS
// format and Bash printf %q's plain/backslash-escaped words; never source them.
function readLegacyProviderEnv(directory, onWarning = null) {
  const values = {};
  for (const filename of ["providers.env", "providers.env.ps1"]) {
    let contents;
    try { contents = fs.readFileSync(path.join(directory, filename), "utf8"); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      if (typeof onWarning === "function") { onWarning(error); continue; }
      throw error;
    }
    for (const line of contents.split(/\r?\n/)) {
      const ps = /^\s*\$env:(\w+)\s*=\s*'((?:[^']|'')*)'\s*$/.exec(line);
      if (ps && INSTALLER_PROVIDER_KEY_NAMES.includes(ps[1])) {
        values[ps[1]] = ps[2].replaceAll("''", "'");
        continue;
      }
      const bash = /^export (\w+)=(.*)$/.exec(line);
      if (!bash || !INSTALLER_PROVIDER_KEY_NAMES.includes(bash[1])) continue;
      const word = bash[2];
      if (/^(?:[a-zA-Z0-9_./:@%+=,-]|\\[^\r\n])+$/.test(word)) {
        values[bash[1]] = word.replace(/\\(.)/g, "$1");
      }
    }
  }
  return values;
}
