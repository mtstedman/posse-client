import {
  nativeIndexedReadTargets,
  atlasDiscoveryFileTargets,
  isEmptySourceFileForGate,
} from "../../../domains/integrations/functions/deterministic-mcp/source-file-gate.js";

function stripAtlasPrefix(action) {
  const raw = String(action || "");
  return raw.startsWith("atlas.") ? raw.slice("atlas.".length) : raw;
}

const ATLAS_GATEWAY_TOOL_NAMES = new Set(["query", "code", "repo", "agent"]);

function effectiveAtlasAction(action, args = {}) {
  const normalized = stripAtlasPrefix(action);
  if (!ATLAS_GATEWAY_TOOL_NAMES.has(normalized)) return normalized;
  const nested = String(
    args?.gatewayAction
    || args?.targetAction
    || args?.actionName
    || args?.action
    || "",
  ).trim();
  return nested ? stripAtlasPrefix(nested) : normalized;
}

function isUnavailableUnlockReason(reason) {
  const normalized = String(reason || "");
  return normalized.startsWith("atlas_")
    || normalized.startsWith("prefetch_")
    || normalized === "atlas_unavailable";
}

export class ToolGate {
  constructor({
    role = null,
    atlasAvailable = false,
    gatedRoles = new Set(),
    gatedTools = new Set(),
    meaningfulAtlasActions = new Set(),
    fallbackStrikeLimit = 3,
    requiredMeaningfulAtlasCalls = 3,
    atlasLabel = "ATLAS",
  } = {}) {
    this._gatedRoles = gatedRoles instanceof Set ? gatedRoles : new Set(gatedRoles || []);
    this._gatedTools = gatedTools instanceof Set ? gatedTools : new Set(gatedTools || []);
    this._meaningfulAtlasActions = meaningfulAtlasActions instanceof Set
      ? meaningfulAtlasActions
      : new Set(meaningfulAtlasActions || []);
    this._requiredMeaningfulAtlasCalls = Number.isFinite(Number(requiredMeaningfulAtlasCalls))
      ? Math.max(1, Number(requiredMeaningfulAtlasCalls))
      : 3;
    this._fallbackStrikeLimit = Number.isFinite(Number(fallbackStrikeLimit))
      ? Math.max(this._requiredMeaningfulAtlasCalls, Number(fallbackStrikeLimit))
      : this._requiredMeaningfulAtlasCalls;
    this.configure({ role, atlasAvailable, atlasLabel });
  }

  configure({ role = null, atlasAvailable = false, atlasLabel = "ATLAS" } = {}) {
    const nextRole = role || null;
    const nextAtlasAvailable = !!atlasAvailable;
    const nextAtlasLabel = String(atlasLabel || "ATLAS").trim() || "ATLAS";
    if (
      this._configured === true
      && this.role === nextRole
      && this.atlasAvailable === nextAtlasAvailable
      && this.atlasLabel === nextAtlasLabel
    ) {
      return;
    }
    this.role = role || null;
    this.atlasAvailable = nextAtlasAvailable;
    this.atlasLabel = nextAtlasLabel;
    this.unlocked = false;
    this.unlockReason = null;
    this.unhelpfulStrikes = 0;
    this.meaningfulAtlasCalls = 0;
    this.usefulAtlasCalls = 0;
    this.discoveredFiles = new Set();
    this._configured = true;
  }

  release() {
    this.role = null;
    this.atlasAvailable = false;
    this.unlocked = false;
    this.unlockReason = null;
    this.unhelpfulStrikes = 0;
    this.meaningfulAtlasCalls = 0;
    this.usefulAtlasCalls = 0;
    this.discoveredFiles = new Set();
    this._configured = false;
  }

  isActive() {
    return this._gatedRoles.has(this.role) && this.atlasAvailable;
  }

  isGatedTool(toolName) {
    return this._gatedTools.has(toolName);
  }

  isUnlocked() {
    return this.unlocked;
  }

  getUnlockReason() {
    return this.unlockReason;
  }

  getUnhelpfulStrikes() {
    return this.unhelpfulStrikes;
  }

  getMeaningfulAtlasCalls() {
    return this.meaningfulAtlasCalls;
  }

  getUsefulAtlasCalls() {
    return this.usefulAtlasCalls;
  }

  getFallbackStrikeLimit() {
    return this._fallbackStrikeLimit;
  }

  getRequiredMeaningfulAtlasCalls() {
    return this._requiredMeaningfulAtlasCalls;
  }

  noteAtlasCall({ action = "", ok = false, empty = false, args = {}, artifacts = null, cwd = null } = {}) {
    const normalized = effectiveAtlasAction(action, args);
    const meaningful = this._meaningfulAtlasActions.has(normalized);
    if (!meaningful) return;

    for (const filePath of atlasDiscoveryFileTargets(normalized, args, artifacts, { cwd })) {
      this.discoveredFiles.add(filePath.toLowerCase());
    }

    if (this.unlocked) return;

    this.meaningfulAtlasCalls += 1;
    if (ok && !empty) {
      this.usefulAtlasCalls += 1;
    } else {
      this.unhelpfulStrikes += 1;
    }

    if (this.meaningfulAtlasCalls >= this._requiredMeaningfulAtlasCalls) {
      this.unlocked = true;
      this.unlockReason = this.usefulAtlasCalls > 0 ? "primary" : "fallback";
      return;
    }

    if (this.unhelpfulStrikes >= this._fallbackStrikeLimit) {
      this.unlocked = true;
      this.unlockReason = "fallback";
    }
  }

  unlockForAtlasUnavailable({ reason = "atlas_unavailable" } = {}) {
    if (!this.isActive()) return;
    this.unlocked = true;
    this.unlockReason = reason;
  }

  unlockForAtlasPrefetch({ reason = "prefetch_ok" } = {}) {
    void reason;
    return false;
  }

  isFileDiscovered(filePath, { cwd = null } = {}) {
    return nativeIndexedReadTargets("read_file", { path: filePath }, { cwd })
      .some((target) => this.discoveredFiles.has(target.toLowerCase()));
  }

  checkNativeToolAllowed(toolName, args = {}, { cwd = null } = {}) {
    if (!this.isActive() || !this.isGatedTool(toolName)) {
      return { allowed: true, reason: "not_gated" };
    }
    if (toolName === "chain_verdict") {
      return { allowed: true, reason: "audit_verdict" };
    }

    const indexedReadTargets = nativeIndexedReadTargets(toolName, args, { cwd });
    const exactReadTool = toolName === "read_file" || toolName === "chain_read";
    if (indexedReadTargets.length > 0) {
      const gatedTargets = indexedReadTargets
        .filter((target) => !isEmptySourceFileForGate(target, { cwd }));
      const lockedTargets = gatedTargets
        .filter((target) => !this.discoveredFiles.has(target.toLowerCase()));
      if (lockedTargets.length > 0 && !isUnavailableUnlockReason(this.unlockReason)) {
        return {
          allowed: false,
          reason: "indexed_file_discovery_required",
          target: lockedTargets[0],
          targets: lockedTargets,
        };
      }
      if (gatedTargets.length === 0) {
        return { allowed: true, reason: "indexed_file_empty", targets: indexedReadTargets };
      }
      return { allowed: true, reason: "indexed_file_discovered", targets: indexedReadTargets };
    }
    if (exactReadTool) {
      return { allowed: true, reason: "non_indexed_or_unresolved_read" };
    }

    if (this.unlocked) {
      return { allowed: true, reason: this.unlockReason || "unlocked" };
    }

    return { allowed: false, reason: "global_atlas_first_required" };
  }

  buildLockedToolError(toolName, { args = {}, cwd = null, atlasNameStyle = "dotted" } = {}) {
    void atlasNameStyle;
    const label = this.atlasLabel || "ATLAS";
    const indexedReadTargets = nativeIndexedReadTargets(toolName, args, { cwd });
    const lockedIndexedTargets = indexedReadTargets
      .filter((target) => !this.discoveredFiles.has(target.toLowerCase()));
    if (lockedIndexedTargets.length > 0) {
      const target = lockedIndexedTargets[0];
      return `Native source access is not yet available for ${target}. Inspect it with an available ${label} repository tool first.`;
    }
    return `Native repository access is not yet available. Use an available ${label} repository tool first.`;
  }

  snapshot() {
    return {
      role: this.role,
      atlasAvailable: this.atlasAvailable,
      atlasLabel: this.atlasLabel,
      unlocked: this.unlocked,
      unlockReason: this.unlockReason,
      unhelpfulStrikes: this.unhelpfulStrikes,
      meaningfulAtlasCalls: this.meaningfulAtlasCalls,
      usefulAtlasCalls: this.usefulAtlasCalls,
      discoveredFiles: [...this.discoveredFiles],
      fallbackStrikeLimit: this._fallbackStrikeLimit,
      requiredMeaningfulAtlasCalls: this._requiredMeaningfulAtlasCalls,
    };
  }

  static stripAtlasPrefix(action) {
    return stripAtlasPrefix(action);
  }
}
