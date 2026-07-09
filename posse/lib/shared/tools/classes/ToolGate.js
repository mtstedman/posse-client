import {
  ATLAS_TOOL_DEFS,
  getAtlasRouteDefinitionForRole,
} from "../../../domains/integrations/functions/deterministic-mcp/tool-descriptors.js";
import {
  nativeIndexedReadTargets,
  atlasDiscoveryFileTargets,
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

function snakeAtlasToolName(action) {
  return `atlas_${String(action || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()}`;
}

function formatAtlasToolName(action, { atlasNameStyle = "dotted" } = {}) {
  const raw = String(action || "").trim();
  if (!raw) return "";
  if (atlasNameStyle === "embedded") {
    if (raw.startsWith("atlas_")) return raw;
    const normalized = stripAtlasPrefix(raw);
    return ATLAS_TOOL_DEFS[normalized]?.name || snakeAtlasToolName(normalized);
  }
  const normalized = stripAtlasPrefix(action);
  return normalized ? `atlas.${normalized}` : "";
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
      const lockedTargets = indexedReadTargets.filter((target) => !this.discoveredFiles.has(target.toLowerCase()));
      if (lockedTargets.length > 0 && !isUnavailableUnlockReason(this.unlockReason)) {
        return {
          allowed: false,
          reason: "indexed_file_discovery_required",
          target: lockedTargets[0],
          targets: lockedTargets,
        };
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
    const label = this.atlasLabel || "ATLAS";
    const formatTool = (action) => formatAtlasToolName(action, { atlasNameStyle });
    const indexedReadTargets = nativeIndexedReadTargets(toolName, args, { cwd });
    const lockedIndexedTargets = indexedReadTargets
      .filter((target) => !this.discoveredFiles.has(target.toLowerCase()));
    if (lockedIndexedTargets.length > 0) {
      const target = lockedIndexedTargets[0];
      const route = getAtlasRouteDefinitionForRole(this.role);
      const routedMeaningfulTools = (route?.tools || [])
        .map(stripAtlasPrefix)
        .filter((action) => this._meaningfulAtlasActions.has(action))
        .map(formatTool);
      const meaningfulTools = routedMeaningfulTools.length > 0
        ? routedMeaningfulTools
        : [...this._meaningfulAtlasActions].map(formatTool);
      return [
        `[${label}-first] ${label} is the inspection path for indexable source files while it is available; a native read is the exception for what ${label} cannot provide.`,
        "",
        `Target file not yet inspected through ${label}: ${target}`,
        "",
        `Inspect this file through ${label} first — often that answers the question and no native read is needed. If a gap remains (stale/empty/conflicting evidence, or exact surrounding text ${label} could not provide), the native read follows naturally from that focused attempt.`,
        `Good first calls: ${formatTool("code.skeleton")}({ file: "${target}" }), ${formatTool("code.lens")}, ${formatTool("code.window")}, ${formatTool("symbol.search")}, ${formatTool("tree.branch")}, or ${formatTool("tree.expand")}.`,
        "",
        `${label} prefetch and internal bookkeeping calls do NOT count as file discovery; they are not active retrieval.`,
        `Discovery is file-scoped: each indexable source file needs its own focused ${label} attempt before a native read of it.`,
        "",
        `Meaningful ${label} tools for this role:`,
        ...meaningfulTools.map((tool) => `  - ${tool}`),
        "",
        `Attempted tool: ${toolName}`,
      ].join("\n");
    }

    const callLine = `  Task-relevant ${label} retrieval calls recorded: ${this.meaningfulAtlasCalls}/${this._requiredMeaningfulAtlasCalls}.`;
    const strikeLine = this.unhelpfulStrikes > 0
      ? `  Unhelpful ${label} attempts recorded: ${this.unhelpfulStrikes}/${this._fallbackStrikeLimit} (at ${this._fallbackStrikeLimit}, empty/error fallback to standard tools is appropriate).`
      : null;
    const roleLabel = this.role || "this";
    const lines = [
      `[${label}-first] ${label} is the inspection path for the ${roleLabel} role while it is available; native research tools are the exception for evidence gaps ${label} cannot answer.`,
      "",
      `Always prefer ${label}: use it to answer the question, and stop when the evidence is sufficient — do not make ${label} calls merely to make native tools available. A focused retrieval aimed at your actual evidence gap is what counts.`,
      `Native research tools are appropriate when ${label} is unavailable, or when focused ${label} attempts (at least ${this._requiredMeaningfulAtlasCalls} since prefetch) still leave a named gap: stale/empty/conflicting results, non-indexed config/data/docs, files you mutated, or exact text ${label} could not provide.`,
      `For indexable source file reads, discovery is file-scoped: attempt ${label} against that file first.`,
      `If real ${label} calls only return empty/errors, native research tools are the appropriate fallback.`,
      "",
      callLine,
    ];
    if (strikeLine) {
      lines.push("", strikeLine);
    }
    const route = getAtlasRouteDefinitionForRole(this.role);
    const routedMeaningfulTools = (route?.tools || [])
      .map(stripAtlasPrefix)
      .filter((action) => this._meaningfulAtlasActions.has(action))
      .map(formatTool);
    const meaningfulTools = routedMeaningfulTools.length > 0
      ? routedMeaningfulTools
      : [...this._meaningfulAtlasActions].map(formatTool);
    const replacementHints = {
      read_file: `For raw file reads, first use ${label} discovery tools such as ${formatTool("symbol.search")}, ${formatTool("tree.branch")}, ${formatTool("tree.expand")}, or ${formatTool("code.skeleton")}; native reads are fallback after discovery.`,
      inspect_file: `For structure, prefer ${formatTool("symbol.card")} or ${formatTool("code.skeleton")}.`,
      list_files: `For repo shape, prefer ${formatTool("tree.branch")}, ${formatTool("tree.expand")}, or ${formatTool("symbol.search")}.`,
      search_files: `For semantic discovery, prefer ${formatTool("symbol.search")} or ${formatTool("tree.expand")}.`,
      chain_read: `For research context, prefer ${formatTool("symbol.search")}, ${formatTool("tree.branch")}, or ${formatTool("code.skeleton")}.`,
      git_history: `For assessment changes, prefer ${formatTool("review.risk")} when version ids are known.`,
    };
    const hint = replacementHints[String(toolName || "")] || `Use one of the role-routed ${label} tools below to close your actual evidence gap.`;
    lines.push(
      "",
      `Replacement hint: ${hint}`,
      "",
      `Meaningful ${label} tools (aim focused retrieval at the actual gap - these are the calls that count):`,
      ...meaningfulTools.map((tool) => `  - ${tool}`),
      "",
      `${label} prefetch and internal bookkeeping calls do NOT count - they are not active retrieval.`,
      "",
      `Use ${label} evidence first; when you do fall back to a native tool, state the precise gap and the ${label} result that was insufficient.`,
      "",
      `Attempted tool: ${toolName}`,
    );
    return lines.join("\n");
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
