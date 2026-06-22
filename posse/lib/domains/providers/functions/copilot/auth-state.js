import fs from "fs";
import os from "os";
import path from "path";

function readCopilotToken() {
  const gh = process.env.GH_TOKEN;
  if (typeof gh === "string" && gh.trim()) return { token: gh.trim(), source: "GH_TOKEN" };
  const github = process.env.GITHUB_TOKEN;
  if (typeof github === "string" && github.trim()) return { token: github.trim(), source: "GITHUB_TOKEN" };
  return null;
}

function readCopilotOauthLogin() {
  try {
    const cfgPath = path.join(os.homedir(), ".copilot", "config.json");
    if (!fs.existsSync(cfgPath)) return null;
    const raw = fs.readFileSync(cfgPath, "utf-8");
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
    const parsed = JSON.parse(stripped);
    const users = Array.isArray(parsed?.loggedInUsers) ? parsed.loggedInUsers : [];
    const first = users.find((u) => u && typeof u.login === "string" && u.login.trim());
    if (!first) return null;
    return { login: String(first.login), host: String(first.host || "https://github.com") };
  } catch {
    return null;
  }
}

export function resolveCopilotAuth() {
  const oauth = readCopilotOauthLogin();
  if (oauth) return { mode: "oauth", source: `~/.copilot (login=${oauth.login})` };
  const pat = readCopilotToken();
  if (pat) return { mode: "pat", source: pat.source };
  return null;
}

export function hasCredentials() {
  return resolveCopilotAuth() !== null;
}

export function getAuthMethod() {
  return resolveCopilotAuth();
}
