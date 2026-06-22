import fs from "fs";
import os from "os";
import path from "path";

let claudeConfigDirOverride = null;
const configDirChangeListeners = new Set();

export function getClaudeConfigDir() {
  if (claudeConfigDirOverride) return claudeConfigDirOverride;
  return path.join(os.homedir(), ".claude");
}

export function onClaudeConfigDirChanged(listener) {
  if (typeof listener !== "function") return () => {};
  configDirChangeListeners.add(listener);
  return () => configDirChangeListeners.delete(listener);
}

export function setClaudeConfigDirForTests(configDir = null) {
  claudeConfigDirOverride = configDir == null || String(configDir).trim() === ""
    ? null
    : path.resolve(String(configDir));
  for (const listener of Array.from(configDirChangeListeners)) {
    try { listener(claudeConfigDirOverride); } catch { /* test hook cleanup is best effort */ }
  }
}

export function readClaudeCredentials(configDir = getClaudeConfigDir()) {
  const credentialsPath = path.join(configDir, ".credentials.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    const oauth = parsed?.claudeAiOauth || {};
    const organization = oauth.organization || parsed?.organization || {};
    return {
      subscriptionType: oauth.subscriptionType || null,
      rateLimitTier: oauth.rateLimitTier || null,
      oauthToken: String(
        process.env.CLAUDE_CODE_OAUTH_TOKEN ||
        oauth.accessToken ||
        oauth.access_token ||
        parsed?.accessToken ||
        parsed?.access_token ||
        ""
      ).trim() || null,
      expiresAt:
        oauth.expiresAt ||
        oauth.expires_at ||
        parsed?.expiresAt ||
        parsed?.expires_at ||
        null,
      organizationUuid:
        oauth.organizationUuid ||
        oauth.organization_uuid ||
        organization.uuid ||
        organization.id ||
        null,
    };
  } catch {
    return {
      subscriptionType: null,
      rateLimitTier: null,
      oauthToken: String(process.env.CLAUDE_CODE_OAUTH_TOKEN || "").trim() || null,
      expiresAt: null,
      organizationUuid: null,
    };
  }
}

export function hasUsableClaudeOauthToken(credentials, nowMs = Date.now()) {
  const token = String(credentials?.oauthToken || "").trim();
  if (!token) return false;
  const expiresAt = credentials?.expiresAt ? Date.parse(credentials.expiresAt) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return false;
  return true;
}
