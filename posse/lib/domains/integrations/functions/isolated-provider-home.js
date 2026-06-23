// lib/domains/integrations/functions/isolated-provider-home.js
//
// Generic provider-CLI context isolation, surfaced through the MCP helper so it
// applies uniformly to every provider that attaches the deterministic MCP. When
// Posse runs an agent MCP-only it is the sole source of context, so the provider
// CLI must not load its own global memory/config/history. We redirect the
// provider's "home" env var at a clean, Posse-owned directory containing only an
// empty marker config plus a mirror of the provider's credential file(s).
//
// Add a provider to PROVIDER_HOME_PROFILES once its home env var, marker config,
// and credential filenames are verified. Until a provider has a profile it is a
// no-op here (its existing home handling is unchanged), so this never regresses
// a provider that has not been wired yet.

import fs from "fs";
import os from "os";
import path from "path";

function homeDir(env = process.env) {
  return String(env?.HOME || "").trim() || os.homedir();
}

function bestEffortChmod(target, mode) {
  try { fs.chmodSync(target, mode); } catch { /* Windows / best-effort */ }
}

export const PROVIDER_HOME_PROFILES = {
  codex: {
    homeEnvVar: "CODEX_HOME",
    isolatedDirName: "codex-home",
    realHome: (env) => {
      const configured = String(env?.CODEX_HOME || "").trim();
      return configured ? path.resolve(configured) : path.join(homeDir(env), ".codex");
    },
    // Empty marker so codex reads no global config of its own; Posse passes every
    // real setting via `-c` overrides and CLI flags.
    markerConfig: {
      filename: "config.toml",
      contents: [
        "# Posse-controlled CODEX_HOME -- intentionally empty.",
        "# Posse passes all configuration via `-c` overrides and CLI flags so codex",
        "# never inherits the operator's global ~/.codex context (AGENTS.md /",
        "# instructions / mcp_servers / session history).",
        "",
      ].join("\n"),
    },
    // Credential file(s) mirrored from the operator's real home so auth keeps
    // working. Mirrored only when present, which matches today's behavior (the
    // real home already carried auth.json), so api-key runs are unaffected.
    authFiles: ["auth.json"],
  },
};

const NOT_ISOLATED = Object.freeze({ envVar: null, home: null, isolated: false });

// Copy a credential file into the isolated home only when the operator's copy is
// newer than ours (a fresh login) or ours is missing. When the provider refreshes
// the token in place our copy becomes newer and is left untouched, so a rotated
// refresh token survives across runs.
function mirrorFileIfNewer(src, dst) {
  try {
    if (!fs.existsSync(src)) return;
    const srcMtime = fs.statSync(src).mtimeMs;
    let dstMtime = -1;
    try { dstMtime = fs.statSync(dst).mtimeMs; } catch { /* target missing */ }
    if (dstMtime >= srcMtime) return;
    fs.copyFileSync(src, dst);
    bestEffortChmod(dst, 0o600);
  } catch {
    // Best-effort: provider readiness surfaces real auth problems; a mirror
    // failure must not crash the call path.
  }
}

// Provision a clean, Posse-owned home for a provider CLI and return the env var
// to point at it. POSIX-only (Windows providers keep their existing home
// handling). Stable across runs so provider session/resume state persists. Fails
// safe: any error (or an unprofiled provider) returns "not isolated" instead of
// breaking the run.
export function prepareIsolatedProviderHome(providerName, {
  env = process.env,
  platform = process.platform,
  homeRoot = null,
} = {}) {
  const profile = PROVIDER_HOME_PROFILES[String(providerName || "").toLowerCase()];
  if (!profile || platform === "win32") return { ...NOT_ISOLATED };
  const underTest = !!(env?.POSSE_TEST_RUN || env?.NODE_TEST_CONTEXT);
  if (underTest && !homeRoot) {
    // Never provision under the operator's real home during tests.
    return { ...NOT_ISOLATED };
  }

  const sourceHome = profile.realHome(env);
  const isolatedHome = homeRoot || path.join(homeDir(env), ".posse", profile.isolatedDirName);
  try {
    if (path.resolve(sourceHome) === path.resolve(isolatedHome)) {
      // Provider already points at our isolated dir; nothing to write.
      return { envVar: profile.homeEnvVar, home: isolatedHome, isolated: true };
    }
    fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
    bestEffortChmod(isolatedHome, 0o700);
    if (profile.markerConfig) {
      const cfg = path.join(isolatedHome, profile.markerConfig.filename);
      fs.writeFileSync(cfg, profile.markerConfig.contents, "utf8");
      bestEffortChmod(cfg, 0o600);
    }
    for (const name of (profile.authFiles || [])) {
      mirrorFileIfNewer(path.join(sourceHome, name), path.join(isolatedHome, name));
    }
    return { envVar: profile.homeEnvVar, home: isolatedHome, isolated: true };
  } catch (err) {
    return { ...NOT_ISOLATED, error: err };
  }
}
