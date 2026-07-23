// @ts-check
//
// Monotonic consumer for Posse Remote tool capability decisions.
//
// Remote issuance is the authority. Local runtime, task-mode, scope, and
// operator policy may remove capabilities, but no caller-supplied option may
// synthesize a tool or raise web, SQL, write, shell, test, image, or ATLAS
// authority above the remote response.

import { INTERNAL_ATLAS_SURFACE_ACTION_SET } from "../../../catalog/internal-tools.js";
import { isRemotePromptClientIssuance } from "../../../domains/remote/classes/RemotePromptClient.js";

const KNOWN_ISSUED_ROLES = new Set([
  "researcher",
  "planner",
  "dev",
  "artificer",
  "assessor",
  "preflight",
  "delegator",
  "summary",
]);

const TEST_TOOL_NAMES = new Set([
  "run_scoped_checks",
  "create_test_suite",
  "create_test",
  "run_test",
  "run_test_suite",
]);
const WRITE_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "move_file",
  "copy_file",
  "make_dir",
  "prune_artifact_output",
  "clean_image",
  "generate_image",
]);
const TRUSTED_REMOTE_POLICY_OBJECTS = new WeakSet();
const TRUSTED_REMOTE_SURFACE_OBJECTS = new WeakSet();

/**
 * @typedef {object} IssuedToolPolicy
 * @property {boolean} allow_read
 * @property {boolean} allow_write
 * @property {boolean} allow_shell
 * @property {boolean} allow_tests
 * @property {number} fallback_reads
 */

const EMPTY_TOOL_POLICY = /** @type {Readonly<IssuedToolPolicy>} */ (Object.freeze({
  allow_read: false,
  allow_write: false,
  allow_shell: false,
  allow_tests: false,
  fallback_reads: 0,
}));

const EMPTY_WEB_ACCESS = Object.freeze({
  role: "",
  mode: "none",
  general_discovery: false,
  live_documentation_verification: false,
  asset_sourcing_or_fetching: false,
  network_access: false,
  image_generation_eligible: false,
});

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
}

function uniqueStrings(values = []) {
  const out = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export function normalizeIssuedRole(value) {
  const role = String(value || "").trim().toLowerCase();
  const normalized = role === "developer" || role === "development" || role === "fix"
    ? "dev"
    : role;
  return KNOWN_ISSUED_ROLES.has(normalized) ? normalized : "";
}

function rolesMatch(left, right) {
  const a = normalizeIssuedRole(left);
  const b = normalizeIssuedRole(right);
  return !!a && !!b && a === b;
}

export function normalizeProjectDbCapability(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "read" || normalized === "write" ? normalized : "none";
}

function projectDbRank(value) {
  if (value === "write") return 2;
  if (value === "read") return 1;
  return 0;
}

export function intersectProjectDbCapabilities(left, right) {
  const a = normalizeProjectDbCapability(left);
  const b = normalizeProjectDbCapability(right);
  return projectDbRank(a) <= projectDbRank(b) ? a : b;
}

function stripSuitePrefix(name, suite) {
  const raw = String(name || "").trim();
  const dotted = `${suite}.`;
  if (raw.startsWith(dotted)) return raw.slice(dotted.length);
  const underscored = `${suite}_`;
  if (raw.startsWith(underscored)) {
    const stripped = raw.slice(underscored.length);
    return suite === "atlas" ? stripped.replace(/_/g, ".") : stripped;
  }
  return raw;
}

function entrySuite(entry, fallback = "") {
  const explicit = String(plainObject(entry)?.suite || fallback || "").trim().toLowerCase();
  if (explicit === "deterministic") return "tools";
  if (explicit === "tools" || explicit === "atlas") return explicit;
  const raw = typeof entry === "string"
    ? entry
    : String(plainObject(entry)?.name || plainObject(entry)?.local_name || "");
  if (raw.startsWith("tools.") || raw.startsWith("tools_")) return "tools";
  if (raw.startsWith("atlas.") || raw.startsWith("atlas_")) return "atlas";
  return "";
}

function canonicalToolEntry(entry, fallbackSuite = "") {
  const object = plainObject(entry);
  const suite = entrySuite(entry, fallbackSuite);
  if (!suite) return null;
  const raw = object
    ? String(object.local_name || object.name || "").trim()
    : String(entry || "").trim();
  const name = stripSuitePrefix(raw, suite);
  if (!name) return null;
  if (suite === "atlas" && INTERNAL_ATLAS_SURFACE_ACTION_SET.has(name)) return null;
  return { suite, name, canonical: `${suite}.${name}` };
}

function toolAllowedByIssuedFacts(tool, policy, projectDbCapability, atlasAvailable, coordination = {}) {
  if (!tool) return false;
  if (tool.suite === "tools" && tool.name === "agent_handoff") return coordination.agentHandoff === true;
  if (tool.suite === "tools" && tool.name === "sub_agent") return coordination.subAgent === true;
  if (tool.suite === "tools" && tool.name === "sub_agent_next_input") return coordination.subAgentNextInput === true;
  if (!policy.allow_read) return false;
  if (tool.suite === "atlas") return atlasAvailable !== false;
  if (tool.name === "project_db_query") return projectDbCapability !== "none";
  if (TEST_TOOL_NAMES.has(tool.name)) return policy.allow_tests;
  if (tool.name === "bash") return policy.allow_shell;
  if (WRITE_TOOL_NAMES.has(tool.name)) return policy.allow_write;
  return true;
}

/**
 * @param {unknown} value
 * @param {{
 *   policy?: Readonly<IssuedToolPolicy>,
 *   projectDbCapability?: string,
 *   atlasAvailable?: boolean,
 *   coordinationAvailable?: boolean,
 *   subAgentAvailable?: boolean,
 *   subAgentNextInputAvailable?: boolean,
 * }} [options]
 */
export function normalizeIssuedToolSurface(value, {
  policy = EMPTY_TOOL_POLICY,
  projectDbCapability = "none",
  atlasAvailable = true,
  coordinationAvailable = false,
  subAgentAvailable = false,
  subAgentNextInputAvailable = false,
} = {}) {
  const entries = Array.isArray(value) ? value : [];
  const out = [];
  for (const entry of entries) {
    const tool = canonicalToolEntry(entry);
    if (!toolAllowedByIssuedFacts(tool, policy, projectDbCapability, atlasAvailable, {
      agentHandoff: coordinationAvailable,
      subAgent: subAgentAvailable,
      subAgentNextInput: subAgentNextInputAvailable,
    })) continue;
    if (!out.includes(tool.canonical)) out.push(tool.canonical);
  }
  return out;
}

export function issuedToolNamesForSuite(surface = [], suite = "") {
  const target = String(suite || "").trim().toLowerCase();
  if (target !== "tools" && target !== "atlas") return [];
  const out = [];
  for (const entry of surface || []) {
    const tool = canonicalToolEntry(entry);
    if (tool?.suite === target && !out.includes(tool.name)) out.push(tool.name);
  }
  return out;
}

export function issuedToolAllowlist(surface = []) {
  return {
    tools: issuedToolNamesForSuite(surface, "tools"),
    atlas: issuedToolNamesForSuite(surface, "atlas"),
  };
}

export function normalizeSuiteToolAllowlist(value) {
  const source = plainObject(value);
  if (!source) return {};
  const out = {};
  for (const suite of ["tools", "atlas"]) {
    if (!Object.prototype.hasOwnProperty.call(source, suite)) continue;
    const names = [];
    for (const rawName of stringArray(source[suite])) {
      const tool = canonicalToolEntry(rawName, suite);
      if (tool?.suite !== suite || names.includes(tool.name)) continue;
      names.push(tool.name);
    }
    out[suite] = names;
  }
  return out;
}

export function intersectSuiteToolAllowlists(authority, narrower) {
  const issued = normalizeSuiteToolAllowlist(authority);
  const local = plainObject(narrower) ? normalizeSuiteToolAllowlist(narrower) : null;
  const out = {};
  for (const suite of ["tools", "atlas"]) {
    const issuedNames = Array.isArray(issued[suite]) ? issued[suite] : [];
    const localNames = local && Array.isArray(local[suite]) ? new Set(local[suite]) : null;
    out[suite] = localNames ? issuedNames.filter((name) => localNames.has(name)) : issuedNames;
  }
  return out;
}

export function isInternalAtlasAction(value) {
  const tool = canonicalToolEntry(value, "atlas");
  return !tool || INTERNAL_ATLAS_SURFACE_ACTION_SET.has(tool.name);
}

export function isToolAuthorizedByIssuedSurface(toolLike, issuedSurface = null) {
  const object = plainObject(toolLike);
  const rawName = object ? object.name : toolLike;
  const specAccess = String(object?.access || "");
  const suite = entrySuite(toolLike, specAccess === "atlas" ? "atlas" : "tools");
  const tool = canonicalToolEntry(toolLike, suite);
  if (!tool) return false;
  if (issuedSurface == null) return true;
  return new Set(normalizeIssuedToolSurfaceForComparison(issuedSurface)).has(tool.canonical);
}

function normalizeIssuedToolSurfaceForComparison(surface) {
  const out = [];
  for (const entry of Array.isArray(surface) ? surface : []) {
    const tool = canonicalToolEntry(entry);
    if (tool && !out.includes(tool.canonical)) out.push(tool.canonical);
  }
  return out;
}

function normalizeToolPolicy(value) {
  const source = plainObject(value) || {};
  return {
    allow_read: source.allow_read === true || source.allowRead === true,
    allow_write: source.allow_write === true || source.allowWrite === true,
    allow_shell: source.allow_shell === true || source.allowShell === true,
    allow_tests: source.allow_tests === true || source.allowTests === true,
    fallback_reads: nonNegativeInteger(source.fallback_reads ?? source.fallbackReads),
  };
}

function normalizeWebAccess(value, role = "") {
  const source = plainObject(value) || {};
  const mode = ["discovery", "verification"].includes(String(source.mode || "").trim().toLowerCase())
    ? String(source.mode).trim().toLowerCase()
    : "none";
  return {
    role: normalizeIssuedRole(source.role) || role || "",
    mode,
    general_discovery: source.general_discovery === true || source.generalDiscovery === true,
    live_documentation_verification: source.live_documentation_verification === true || source.liveDocumentationVerification === true,
    asset_sourcing_or_fetching: source.asset_sourcing_or_fetching === true || source.assetSourcingOrFetching === true,
    network_access: source.network_access === true || source.networkAccess === true,
    image_generation_eligible: source.image_generation_eligible === true || source.imageGenerationEligible === true,
  };
}

function failClosedIssuedPolicy() {
  const policy = {
    valid: false,
    role: "",
    provider: "",
    toolPolicy: { ...EMPTY_TOOL_POLICY },
    toolSurface: [],
    toolAllowlist: { tools: [], atlas: [] },
    webAccess: { ...EMPTY_WEB_ACCESS },
    projectDbCapability: "none",
    childToolSurface: [],
    coordination: {
      agentHandoffV1: false,
      agentHandoffCompactV1: false,
      agentHandoffCompactV2: false,
      agentHandoffCompactV3: false,
      subAgentV1: false,
    },
  };
  TRUSTED_REMOTE_POLICY_OBJECTS.add(policy);
  return policy;
}

export function normalizeRemoteIssuedPolicy(value, {
  expectedRole = null,
  expectedProvider = null,
} = {}) {
  const source = plainObject(value);
  if (!source) return failClosedIssuedPolicy();
  const policySource = String(source.source || source.policy_source || source.policySource || "").trim().toLowerCase();
  const role = normalizeIssuedRole(source.role);
  const provider = String(source.provider || "").trim().toLowerCase();
  if (policySource !== "posse-remote" || !role) return failClosedIssuedPolicy();
  if (expectedRole && !rolesMatch(role, expectedRole)) return failClosedIssuedPolicy();
  if (expectedProvider && provider !== String(expectedProvider).trim().toLowerCase()) return failClosedIssuedPolicy();

  const toolPolicy = normalizeToolPolicy(source.tool_policy || source.toolPolicy);
  const projectDbCapability = normalizeProjectDbCapability(
    source.project_db_capability ?? source.projectDbCapability,
  );
  const atlas = plainObject(source.atlas);
  const atlasAvailable = atlas ? atlas.available === true : true;
  const coordinationSource = plainObject(source.coordination);
  const coordination = {
    agentHandoffV1: coordinationSource?.agent_handoff_v1 === true,
    agentHandoffCompactV1: coordinationSource?.agent_handoff_v1 === true
      && coordinationSource?.agent_handoff_compact_v1 === true,
    agentHandoffCompactV2: coordinationSource?.agent_handoff_v1 === true
      && coordinationSource?.agent_handoff_compact_v1 === true
      && coordinationSource?.agent_handoff_compact_v2 === true,
    agentHandoffCompactV3: coordinationSource?.agent_handoff_v1 === true
      && coordinationSource?.agent_handoff_compact_v1 === true
      && coordinationSource?.agent_handoff_compact_v2 === true
      && coordinationSource?.agent_handoff_compact_v3 === true,
    subAgentV1: coordinationSource?.agent_handoff_v1 === true
      && coordinationSource?.sub_agent_v1 === true,
    subAgentNextInputV1: coordinationSource?.agent_handoff_v1 === true
      && coordinationSource?.sub_agent_next_input_v1 === true,
  };
  const toolSurface = normalizeIssuedToolSurface(
    Array.isArray(source.tool_surface) ? source.tool_surface : source.tools,
    {
      policy: toolPolicy,
      projectDbCapability,
      atlasAvailable,
      coordinationAvailable: coordination.agentHandoffV1,
      subAgentAvailable: coordination.subAgentV1,
      subAgentNextInputAvailable: coordination.subAgentNextInputV1,
    },
  );
  const childToolSurface = normalizeIssuedToolSurface(source.child_tools, {
    policy: toolPolicy,
    projectDbCapability: "none",
    atlasAvailable: false,
    coordinationAvailable: coordination.agentHandoffV1,
    subAgentAvailable: false,
    subAgentNextInputAvailable: coordination.subAgentNextInputV1,
  }).filter((name) => name === "tools.sub_agent_next_input");
  const subAgentEnabled = coordination.subAgentV1
    && coordination.subAgentNextInputV1
    && childToolSurface.includes("tools.sub_agent_next_input")
    && toolSurface.includes("tools.agent_handoff")
    && toolSurface.includes("tools.sub_agent");
  const effectiveToolSurface = subAgentEnabled
    ? toolSurface
    : toolSurface.filter((name) => name !== "tools.sub_agent");
  const webAccess = normalizeWebAccess(source.web_access || source.webAccess, role);
  const issued = {
    valid: true,
    role,
    provider,
    toolPolicy,
    toolSurface: effectiveToolSurface,
    childToolSurface,
    toolAllowlist: issuedToolAllowlist(effectiveToolSurface),
    webAccess,
    projectDbCapability: toolSurface.includes("tools.project_db_query")
      ? projectDbCapability
      : "none",
    coordination: {
      agentHandoffV1: coordination.agentHandoffV1 && toolSurface.includes("tools.agent_handoff"),
      agentHandoffCompactV1: coordination.agentHandoffCompactV1
        && toolSurface.includes("tools.agent_handoff"),
      agentHandoffCompactV2: coordination.agentHandoffCompactV2
        && toolSurface.includes("tools.agent_handoff"),
      agentHandoffCompactV3: coordination.agentHandoffCompactV3
        && toolSurface.includes("tools.agent_handoff"),
      subAgentV1: subAgentEnabled,
      ...(coordination.subAgentNextInputV1 && childToolSurface.includes("tools.sub_agent_next_input")
        ? { subAgentNextInputV1: true }
        : {}),
    },
  };
  TRUSTED_REMOTE_POLICY_OBJECTS.add(issued);
  return issued;
}

export function sanitizeRemoteToolSurfaceResponse(value, opts = {}) {
  const source = plainObject(value);
  const issued = normalizeRemoteIssuedPolicy(value, opts);
  if (!source || !issued.valid) return null;
  const allowed = new Set(issued.toolSurface);
  const tools = (Array.isArray(source.tools) ? source.tools : issued.toolSurface)
    .map((entry) => {
      const tool = canonicalToolEntry(entry);
      if (!tool || !allowed.has(tool.canonical)) return null;
      return plainObject(entry)
        ? { ...entry }
        : { suite: tool.suite, name: tool.canonical, local_name: tool.name };
    })
    .filter(Boolean);
  const allowedChild = new Set(issued.childToolSurface);
  const childTools = (Array.isArray(source.child_tools) ? source.child_tools : [])
    .map((entry) => {
      const tool = canonicalToolEntry(entry);
      if (!tool || !allowedChild.has(tool.canonical)) return null;
      return plainObject(entry)
        ? { ...entry }
        : { suite: tool.suite, name: tool.canonical, local_name: tool.name };
    })
    .filter(Boolean);
  const sanitized = {
    ...source,
    role: issued.role,
    provider: issued.provider,
    tools,
    child_tools: childTools,
    tool_surface: issued.toolSurface.slice(),
    tool_policy: { ...issued.toolPolicy },
    web_access: { ...issued.webAccess },
    project_db_capability: issued.projectDbCapability,
    coordination: {
      agent_handoff_v1: issued.coordination.agentHandoffV1,
      agent_handoff_compact_v1: issued.coordination.agentHandoffCompactV1,
      agent_handoff_compact_v2: issued.coordination.agentHandoffCompactV2,
      agent_handoff_compact_v3: issued.coordination.agentHandoffCompactV3,
      sub_agent_v1: issued.coordination.subAgentV1,
      sub_agent_next_input_v1: "subAgentNextInputV1" in issued.coordination
        && issued.coordination.subAgentNextInputV1 === true,
    },
  };
  if (!isRegisteredRemoteToolSurface(source)) return sanitized;
  const frozen = deepFreezeJson(sanitized);
  TRUSTED_REMOTE_SURFACE_OBJECTS.add(frozen);
  return frozen;
}

export function isRegisteredRemoteToolSurface(value) {
  return !!value && typeof value === "object" && (
    TRUSTED_REMOTE_SURFACE_OBJECTS.has(value)
    || isRemotePromptClientIssuance(value)
  );
}

function deepFreezeJson(value) {
  const clone = JSON.parse(JSON.stringify(value));
  const freeze = (entry) => {
    if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return entry;
    for (const child of Object.values(entry)) freeze(child);
    return Object.freeze(entry);
  };
  return freeze(clone);
}

export function deriveRemoteToolSurfaceNarrowing(authorityValue, candidateValue, opts = {}) {
  if (!isRegisteredRemoteToolSurface(authorityValue)) return null;
  const authority = normalizeRemoteIssuedPolicy(authorityValue, opts);
  const candidate = normalizeRemoteIssuedPolicy(candidateValue, opts);
  const authorityNextInput = "subAgentNextInputV1" in authority.coordination
    && authority.coordination.subAgentNextInputV1 === true;
  const candidateNextInput = "subAgentNextInputV1" in candidate.coordination
    && candidate.coordination.subAgentNextInputV1 === true;
  if (!authority.valid || !candidate.valid
    || authority.role !== candidate.role
    || authority.provider !== candidate.provider
    || candidate.toolSurface.some((tool) => !authority.toolSurface.includes(tool))
    || candidate.childToolSurface.some((tool) => !authority.childToolSurface.includes(tool))
    || candidate.toolPolicy.allow_read && !authority.toolPolicy.allow_read
    || candidate.toolPolicy.allow_write && !authority.toolPolicy.allow_write
    || candidate.toolPolicy.allow_shell && !authority.toolPolicy.allow_shell
    || candidate.toolPolicy.allow_tests && !authority.toolPolicy.allow_tests
    || candidate.toolPolicy.fallback_reads > authority.toolPolicy.fallback_reads
    || projectDbRank(candidate.projectDbCapability) > projectDbRank(authority.projectDbCapability)
    || candidate.webAccess.general_discovery && !authority.webAccess.general_discovery
    || candidate.webAccess.live_documentation_verification && !authority.webAccess.live_documentation_verification
    || candidate.webAccess.asset_sourcing_or_fetching && !authority.webAccess.asset_sourcing_or_fetching
    || candidate.webAccess.network_access && !authority.webAccess.network_access
    || candidate.webAccess.image_generation_eligible && !authority.webAccess.image_generation_eligible
    || candidate.coordination.agentHandoffV1 && !authority.coordination.agentHandoffV1
    || candidate.coordination.agentHandoffCompactV1 && !authority.coordination.agentHandoffCompactV1
    || candidate.coordination.agentHandoffCompactV2 && !authority.coordination.agentHandoffCompactV2
    || candidate.coordination.agentHandoffCompactV3 && !authority.coordination.agentHandoffCompactV3
    || candidate.coordination.subAgentV1 && !authority.coordination.subAgentV1
    || candidateNextInput && !authorityNextInput) {
    return null;
  }
  const sanitized = sanitizeRemoteToolSurfaceResponse(candidateValue, opts);
  if (!sanitized) return null;
  const frozen = deepFreezeJson(sanitized);
  TRUSTED_REMOTE_SURFACE_OBJECTS.add(frozen);
  return frozen;
}

export function narrowBootConfigToRemoteSurface(bootConfig = {}, remoteSurface = null) {
  const issued = normalizeRemoteIssuedPolicy(remoteSurface, {
    expectedRole: bootConfig.role,
    expectedProvider: bootConfig.providerName || null,
  });
  const localProjectDb = normalizeProjectDbCapability(
    bootConfig.projectDbCapability || (bootConfig.projectDbWrite === true ? "write" : "none"),
  );
  const projectDbCapability = issued.valid
    ? intersectProjectDbCapabilities(issued.projectDbCapability, localProjectDb)
    : "none";
  const localAllowlist = plainObject(bootConfig.toolAllowlist) ? bootConfig.toolAllowlist : null;
  const toolAllowlist = issued.valid
    ? intersectSuiteToolAllowlists(issued.toolAllowlist, localAllowlist)
    : { tools: [], atlas: [] };
  if (projectDbCapability === "none") {
    toolAllowlist.tools = toolAllowlist.tools.filter((name) => name !== "project_db_query");
  }
  const imageIssued = toolAllowlist.tools.includes("generate_image")
    && issued.webAccess.image_generation_eligible;
  return {
    ...bootConfig,
    allowWrite: bootConfig.allowWrite === true && issued.toolPolicy.allow_write,
    allowShell: bootConfig.allowShell === true && issued.toolPolicy.allow_shell,
    projectDbCapability,
    projectDbWrite: bootConfig.projectDbWrite === true && projectDbCapability === "write",
    allowImageHelpers: bootConfig.allowImageHelpers === true
      && toolAllowlist.tools.some((name) => ["read_image_metadata", "validate_artifact_output", "extract_image_text", "clean_image"].includes(name)),
    allowImageGeneration: bootConfig.allowImageGeneration === true && imageIssued,
    atlasAvailable: bootConfig.atlasAvailable === true && toolAllowlist.atlas.length > 0,
    allowTests: bootConfig.allowTests === true && issued.toolPolicy.allow_tests,
    issuedToolPolicy: { ...issued.toolPolicy },
    issuedWebAccess: { ...issued.webAccess },
    toolAllowlist,
    remoteToolSurface: sanitizeRemoteToolSurfaceResponse(remoteSurface, {
      expectedRole: bootConfig.role,
      expectedProvider: bootConfig.providerName || null,
    }),
  };
}

function intersectStrings(authority, narrower) {
  const signed = uniqueStrings(stringArray(authority));
  if (!Array.isArray(narrower)) return signed;
  const local = new Set(uniqueStrings(stringArray(narrower)));
  return signed.filter((value) => local.has(value));
}

export function narrowBootConfigToSignedClaims(signedBootConfig = {}, callerBootConfig = {}) {
  const signed = plainObject(signedBootConfig) || {};
  const caller = plainObject(callerBootConfig) || {};
  const callerHasAllowlist = !!plainObject(caller.toolAllowlist);
  const result = {
    ...signed,
    disableSystemTools: signed.disableSystemTools === true || caller.disableSystemTools === true,
    allowWrite: signed.allowWrite === true && caller.allowWrite !== false,
    allowShell: signed.allowShell === true && caller.allowShell !== false,
    allowTests: signed.allowTests === true && caller.allowTests !== false,
    projectDbWrite: signed.projectDbWrite === true && caller.projectDbWrite !== false,
    allowImageHelpers: signed.allowImageHelpers === true && caller.allowImageHelpers !== false,
    allowImageGeneration: signed.allowImageGeneration === true && caller.allowImageGeneration !== false,
    atlasAvailable: signed.atlasAvailable === true && caller.atlasAvailable !== false,
    atlasGateEnabled: signed.atlasGateEnabled === true || caller.atlasGateEnabled === true,
    scopedFiles: intersectStrings(signed.scopedFiles, caller.scopedFiles),
    createFiles: intersectStrings(signed.createFiles, caller.createFiles),
    deleteFiles: intersectStrings(signed.deleteFiles, caller.deleteFiles),
    createRoots: intersectStrings(signed.createRoots, caller.createRoots),
    readRoots: intersectStrings(signed.readRoots, caller.readRoots),
    toolAllowlist: intersectSuiteToolAllowlists(
      signed.toolAllowlist,
      callerHasAllowlist ? caller.toolAllowlist : null,
    ),
  };
  const signedDb = normalizeProjectDbCapability(
    signed.projectDbCapability || (signed.projectDbWrite === true ? "write" : "none"),
  );
  const callerDb = Object.prototype.hasOwnProperty.call(caller, "projectDbCapability")
    ? normalizeProjectDbCapability(caller.projectDbCapability)
    : signedDb;
  result.projectDbCapability = intersectProjectDbCapabilities(signedDb, callerDb);
  result.projectDbWrite = result.projectDbWrite && result.projectDbCapability === "write";
  if (result.projectDbCapability === "none") {
    result.toolAllowlist.tools = result.toolAllowlist.tools.filter((name) => name !== "project_db_query");
  }
  return result;
}

/**
 * Bind a trusted Agent -> Job attachment to an immutable signed role contract.
 * File authority is deliberately absent: tools resolve it from the persisted
 * Agent call -> Job -> Work Item chain at execution time.
 */
export function bindAgentAttachmentToSignedContract(signedBootConfig = {}, attachmentBootConfig = {}) {
  const signed = plainObject(signedBootConfig) || {};
  const attachment = plainObject(attachmentBootConfig) || {};
  const agentCallRole = String(attachment.agentCallRole || "").trim().toLowerCase();
  const runtimeRole = signed.coordinationChild === true && agentCallRole === "subagent"
    ? "subagent"
    : signed.role;
  const signedDb = normalizeProjectDbCapability(
    signed.projectDbCapability || (signed.projectDbWrite === true ? "write" : "none"),
  );
  const requestedDb = normalizeProjectDbCapability(
    attachment.projectDbCapability || (attachment.projectDbWrite === true ? "write" : "none"),
  );
  const projectDbCapability = intersectProjectDbCapabilities(signedDb, requestedDb);
  const toolAllowlist = normalizeSuiteToolAllowlist(signed.toolAllowlist);
  if (attachment.agentHandoff !== true) {
    toolAllowlist.tools = toolAllowlist.tools.filter((name) => name !== "agent_handoff");
  }
  if (attachment.subAgent !== true) {
    toolAllowlist.tools = toolAllowlist.tools.filter((name) => name !== "sub_agent");
  }
  return {
    ...signed,
    role: runtimeRole,
    agentId: signed.agentId || "",
    scopeBindingMode: "dispatcher",
    cwd: String(attachment.cwd || ""),
    jobId: attachment.jobId ?? null,
    workItemId: attachment.workItemId ?? null,
    attemptId: attachment.attemptId ?? null,
    agentCallId: attachment.agentCallId ?? null,
    promptChars: Math.max(0, Number(attachment.promptChars) || 0),
    scopedFiles: [],
    createFiles: [],
    deleteFiles: [],
    createRoots: [],
    readRoots: [],
    disableSystemTools: signed.disableSystemTools === true || attachment.disableSystemTools === true,
    allowWrite: signed.allowWrite === true && attachment.allowWrite === true,
    allowShell: signed.allowShell === true && attachment.allowShell !== false,
    allowTests: signed.allowTests === true
      && attachment.allowTests !== false
      && projectDbCapability !== "write",
    projectDbCapability,
    projectDbWrite: signed.projectDbWrite === true
      && attachment.projectDbWrite === true
      && projectDbCapability === "write",
    allowImageHelpers: signed.allowImageHelpers === true && attachment.allowImageHelpers !== false,
    allowImageGeneration: signed.allowImageGeneration === true && attachment.allowImageGeneration === true,
    atlasAvailable: signed.atlasAvailable === true && attachment.atlasAvailable !== false,
    atlasGateEnabled: signed.atlasGateEnabled === true && attachment.atlasGateEnabled !== false,
    atlasPrefetchStatus: String(attachment.atlasPrefetchStatus || ""),
    atlas: { ...(plainObject(attachment.atlas) || {}) },
    // The signed OAuth capability claims are the immutable role/tool contract.
    // A rotating bearer and its Job attachment can never widen this allowlist.
    toolAllowlist,
  };
}

function packetTaskMode(packet = {}, opts = {}) {
  return String(
    opts.taskMode
    || packet?._raw_payload?.assessmentContext?.task_mode
    || packet?._raw_payload?.assessment_context?.task_mode
    || packet?._raw_payload?.task_mode
    || "",
  ).trim().toLowerCase();
}

/** @param {Record<string, any>} [options] */
export function narrowProviderOptionsToRemoteIssuance(options = {}) {
  const opts = { ...options };
  delete opts._remoteIssuedPolicy;
  delete opts._remoteToolSurface;
  const packet = plainObject(opts.sessionPacket);
  const consumesRemote = !!packet && (
    packet.remote_prompt_composed === true
    || plainObject(packet.remote_issuance) != null
  );
  if (!consumesRemote) return opts;

  const remoteIssuance = plainObject(packet.remote_issuance);
  const localAgentHandoff = packet?.agent_coordination?.agent_handoff_v1 === true;
  const localAgentHandoffCompact = packet?.agent_coordination?.agent_handoff_compact_v1 === true;
  const localAgentHandoffCompactV2 = packet?.agent_coordination?.agent_handoff_compact_v2 === true;
  const localAgentHandoffCompactV3 = packet?.agent_coordination?.agent_handoff_compact_v3 === true;
  const localSubAgent = packet?.agent_coordination?.sub_agent_v1 === true;
  let executionIssuance = opts._subAgentChild === true
    ? remoteIssuance
    : (remoteIssuance && (!localAgentHandoff || !localSubAgent)
    ? {
        ...remoteIssuance,
        coordination: {
          ...(plainObject(remoteIssuance.coordination) || {}),
          agent_handoff_v1: localAgentHandoff,
          agent_handoff_compact_v1: localAgentHandoff && localAgentHandoffCompact,
          agent_handoff_compact_v2: localAgentHandoff && localAgentHandoffCompact && localAgentHandoffCompactV2,
          agent_handoff_compact_v3: localAgentHandoff
            && localAgentHandoffCompact
            && localAgentHandoffCompactV2
            && localAgentHandoffCompactV3,
          sub_agent_v1: localSubAgent,
        },
      }
    : remoteIssuance);
  if (remoteIssuance && executionIssuance !== remoteIssuance) {
    executionIssuance = deriveRemoteToolSurfaceNarrowing(remoteIssuance, executionIssuance, {
      expectedRole: opts.role,
    }) || executionIssuance;
  }
  const issued = normalizeRemoteIssuedPolicy(executionIssuance, {
    expectedRole: opts.role,
  });
  const taskMode = packetTaskMode(packet, opts);
  const hasExplicitProjectDbCapability = Object.prototype.hasOwnProperty.call(opts, "projectDbCapability")
    || opts.projectDbWrite === true;
  const requestedDb = normalizeProjectDbCapability(
    opts.projectDbCapability
    || (opts.projectDbWrite === true ? "write" : "none")
  );
  const inferredDb = !hasExplicitProjectDbCapability
    && String(opts.role || "").toLowerCase() === "assessor"
    && taskMode === "db"
    ? "read"
    : requestedDb;
  const effectiveDb = issued.valid
    ? intersectProjectDbCapabilities(issued.projectDbCapability, inferredDb)
    : "none";
  const writeToolIssued = issued.toolSurface.some((entry) => {
    const tool = canonicalToolEntry(entry);
    return tool?.suite === "tools" && WRITE_TOOL_NAMES.has(tool.name);
  });
  const imageIssued = issued.toolSurface.includes("tools.generate_image")
    && issued.webAccess.image_generation_eligible;
  return {
    ...opts,
    allowWrite: opts.allowWrite === true && issued.toolPolicy.allow_write && writeToolIssued,
    projectDbCapability: effectiveDb,
    projectDbWrite: opts.projectDbWrite === true && effectiveDb === "write",
    needsImageGeneration: opts.needsImageGeneration === true && imageIssued,
    disableAtlas: opts.disableAtlas === true || issued.toolAllowlist.atlas.length === 0,
    fallbackReads: Math.min(
      nonNegativeInteger(opts.fallbackReads ?? issued.toolPolicy.fallback_reads),
      issued.toolPolicy.fallback_reads,
    ),
    _remoteIssuedPolicy: issued,
    _remoteToolSurface: sanitizeRemoteToolSurfaceResponse(executionIssuance, {
      expectedRole: opts.role,
    }),
  };
}

export function issuedWebAccessEnabled(remoteIssuedPolicy) {
  if (!remoteIssuedPolicy) return true;
  return TRUSTED_REMOTE_POLICY_OBJECTS.has(remoteIssuedPolicy)
    && remoteIssuedPolicy.valid === true
    && remoteIssuedPolicy.webAccess?.network_access === true;
}

export function issuedToolSurfaceForProviderPolicy(remoteIssuedPolicy) {
  if (remoteIssuedPolicy == null) return null;
  if (!TRUSTED_REMOTE_POLICY_OBJECTS.has(remoteIssuedPolicy)) return [];
  return Array.isArray(remoteIssuedPolicy.toolSurface)
    ? remoteIssuedPolicy.toolSurface.slice()
    : [];
}
