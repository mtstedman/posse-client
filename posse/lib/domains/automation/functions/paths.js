import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAccountSettingsPathForDisplay } from "../../settings/functions/account-settings.js";

export function automationDataDir() {
  const configured = String(process.env.POSSE_AUTOMATION_DATA_DIR || "").trim();
  if (configured) return path.resolve(configured);
  return path.dirname(getAccountSettingsPathForDisplay());
}

export function automationDbPath() {
  return path.resolve(process.env.POSSE_AUTOMATION_DB_PATH || path.join(automationDataDir(), "automation.db"));
}

export function automationSocketPath() {
  const configured = String(process.env.POSSE_AUTOMATION_SOCKET || "").trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    const identity = crypto.createHash("sha256").update(automationDataDir()).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\posse-automation-${identity}`;
  }
  return path.join(automationDataDir(), "automation.sock");
}

export function automationOperatorTokenPath() {
  return path.join(automationDataDir(), "automation.operator-token");
}

export function ensureAutomationOperatorToken() {
  const filename = automationOperatorTokenPath();
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    const info = fs.lstatSync(filename);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Automation operator token must be a regular file");
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("Automation operator token permissions must be 0600");
    const token = fs.readFileSync(filename, "utf8").trim();
    if (token.length < 43) throw new Error("Automation operator token is invalid");
    return token;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const token = crypto.randomBytes(32).toString("base64url");
    const fd = fs.openSync(filename, "wx", 0o600);
    try { fs.writeFileSync(fd, token + os.EOL); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return token;
  }
}

export function repositoryID(repoPath) {
  let resolved = path.resolve(repoPath);
  try { resolved = fs.realpathSync(resolved); } catch {}
  if (process.platform === "win32" || process.platform === "darwin") resolved = resolved.toLowerCase();
  const key = resolved.replaceAll(path.sep, "/");
  const base = path.basename(resolved).toLowerCase();
  return `${base}-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}
