import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SCRIPT_TOOL_ENTRY_EFFECTS, SCRIPT_TOOL_LIMITS, SCRIPT_TOOL_MANIFEST_FILE } from "../../../catalog/custom-tools.js";
import { automationDataDir, repositoryID } from "../functions/paths.js";
import { demand, digest, schemaCheck } from "../functions/policy.js";
import { normalizeScriptManifest, parseParamSpec, renderScriptTemplate, validScriptEnvName, validScriptToolName } from "../functions/script-tools.js";
import { runScriptTool } from "../functions/script-runner.js";

const SECRET_KIND = "script_secrets";

// Operator-authored script tools in <automation data dir>/tools/<name>/.
// A tool becomes an automation entry only after a passing test; the entry
// pins the digest of its manifest and script, so an edit needs a new test and
// new grants before agents can call it again. Secrets are owner-held and
// write-only: they are injected into the declaring tool's process and never
// returned by any operation.
export class ScriptToolRegistry {
  constructor(service, { dir = path.join(automationDataDir(), "tools"), now = () => Date.now() } = {}) {
    this.service = service; this.store = service.store; this.dir = dir; this.now = now;
    service.scripts = this;
  }
  entryID(name) { return `script:${name}`; }
  load(name) {
    demand(validScriptToolName(name), `${JSON.stringify(name)} is not a script tool name`, "script_invalid");
    const dir = path.join(this.dir, name), manifestPath = path.join(dir, SCRIPT_TOOL_MANIFEST_FILE);
    demand(fs.existsSync(manifestPath), `No script tool named ${name} (expected ${manifestPath})`, "script_not_found");
    const raw = readBounded(manifestPath, SCRIPT_TOOL_LIMITS.MAX_MANIFEST_BYTES);
    let parsed;
    try { parsed = JSON.parse(raw.toString("utf8")); } catch (error) { demand(false, `Script tool ${name}: ${SCRIPT_TOOL_MANIFEST_FILE} is not valid JSON (${error.message})`, "script_invalid"); }
    const manifest = normalizeScriptManifest(parsed);
    demand(manifest.name === name, `Script tool ${name}: manifest name ${JSON.stringify(manifest.name)} must match its folder`, "script_invalid");
    const realDir = fs.realpathSync(dir);
    let entryPath;
    try { entryPath = fs.realpathSync(path.join(dir, ...manifest.entry.split("/"))); } catch { demand(false, `Script tool ${name}: entry ${manifest.entry} does not exist`, "script_invalid"); }
    const relative = path.relative(realDir, entryPath);
    demand(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `Script tool ${name}: entry must stay inside the tool folder`, "script_invalid");
    const info = fs.statSync(entryPath);
    demand(info.isFile(), `Script tool ${name}: entry ${manifest.entry} must be a regular file`, "script_invalid");
    if (manifest.interpreter === "exec" && process.platform !== "win32") demand((info.mode & 0o111) !== 0, `Script tool ${name}: interpreter exec needs an executable entry (chmod +x ${entryPath})`, "script_invalid");
    const script = readBounded(entryPath, SCRIPT_TOOL_LIMITS.MAX_ENTRY_BYTES);
    const scriptDigest = createHash("sha256").update(script).digest("hex");
    return { manifest, dir: realDir, entryPath, digest: digest({ manifest, script_sha256: scriptDigest }) };
  }
  // Every tool folder with its load error, if any, plus test and secret state.
  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir, { withFileTypes: true })
      .filter(item => item.isDirectory() && !item.name.startsWith("."))
      .map(item => item.name).sort()
      .map(name => { try { return this.status(this.load(name)); } catch (error) { return { name, error: error.message, error_code: error.code || "script_invalid" }; } });
  }
  status(tool) {
    const entry = this.store.get("entries", this.entryID(tool.manifest.name));
    const published = entry?.enabled ? entry.digest : null;
    return {
      name: tool.manifest.name, description: tool.manifest.description, effect: tool.manifest.effect, digest: tool.digest,
      published_digest: published, tested: published === tool.digest, stale: Boolean(published) && published !== tool.digest,
      secrets: this.secretStatus(tool.manifest), dir: tool.dir,
    };
  }
  // `repoPath` lets a client match grants to its repository without
  // re-deriving repository IDs.
  show(name, { repoPath = "" } = {}) {
    const tool = this.load(name);
    return {
      ...this.status(tool), manifest: tool.manifest, grants: this.store.list("grants").filter(grant => grant.tool === this.entryID(name)),
      ...(typeof repoPath === "string" && path.isAbsolute(repoPath) ? { context_repo_id: repositoryID(repoPath) } : {}),
    };
  }
  create(spec) {
    const { name, template = "bash", description, effect = "read", params = [], input_schema = null, env = [], secrets = [] } = spec || {};
    demand(validScriptToolName(name), "Tool name must be lower-case like orders.lookup", "script_invalid");
    const variables = [
      ...env.map(item => typeof item === "string" ? { name: item.split("=")[0], ...(item.includes("=") ? { default: item.slice(item.indexOf("=") + 1) } : {}) } : item),
      ...secrets.map(secret => ({ name: secret, secret: true })),
    ];
    const rendered = renderScriptTemplate({
      name, template, effect, env: variables,
      description: String(description || "").trim() || `TODO: describe what ${name} does and when to use it`,
      params: params.map(param => typeof param === "string" ? parseParamSpec(param) : param),
      inputSchema: input_schema,
    });
    const dir = path.join(this.dir, name);
    demand(!fs.existsSync(dir), `${dir} already exists; edit it or pick another name`, "script_invalid");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, SCRIPT_TOOL_MANIFEST_FILE), `${JSON.stringify(rendered.manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(path.join(dir, rendered.entry), rendered.script, { mode: 0o700, flag: "wx" });
    return { name, dir, entry: rendered.entry, manifest: rendered.manifest };
  }
  entryFor(tool) {
    return {
      id: this.entryID(tool.manifest.name), source: "script", kind: "script", script: tool.manifest.name,
      description: tool.manifest.description, input_schema: tool.manifest.params, output_schema: { type: "object" },
      effect: SCRIPT_TOOL_ENTRY_EFFECTS[tool.manifest.effect],
      limits: { wall_time_seconds: Math.min(3600, tool.manifest.timeout_seconds + 10), calls: 1, turns: 1, spend_cap_usd: 1 },
      enabled: true, digest: tool.digest,
    };
  }
  // The entry is callable only while the folder still holds the tested script.
  available(entry) {
    try { return this.load(entry.script).digest === entry.digest; } catch { return false; }
  }
  // Runs the tool against operator input; a pass publishes this exact digest
  // as the tool's entry and revokes grants that pinned an older version.
  async test(name, input = {}, privateInputs = {}) {
    const tool = this.load(name);
    schemaCheck(tool.manifest.params, input);
    const selected = this.selectInputs(tool, privateInputs);
    const result = await runScriptTool(tool, { ...input, ...selected }, { secrets: this.secretValues(tool.manifest), privateInputs: selected });
    if (!result.ok) return { tool: name, digest: tool.digest, result, published: null, revoked_grants: [] };
    const entry = this.entryFor(tool);
    this.store.put("entries", entry.id, entry);
    this.store.put("tests", tool.digest, { passed: true, tool: entry.id, tested_at: new Date(this.now()).toISOString() });
    const revoked = this.store.list("grants").filter(grant => grant.tool === entry.id && grant.enabled && grant.digest !== tool.digest).map(grant => this.service.revoke(grant.id).id);
    return { tool: name, digest: tool.digest, result, published: { id: entry.id, digest: entry.digest }, revoked_grants: revoked };
  }
  // Grants the tested version to roles in one repository (by path, so
  // clients never re-derive repository IDs) or to standalone sessions. The
  // grant ID is stable per tool, scope, and roles, so re-granting after a
  // re-test replaces the revoked grant instead of piling up new ones.
  grant(name, { repoPath = "", standalone = false, roles = ["dev"], unattended = false } = {}) {
    const tool = this.load(name), entry = this.store.get("entries", this.entryID(name));
    demand(entry?.enabled && entry.digest === tool.digest, `${name} has no passing test for its current version; run \`posse tools test ${name}\` first`, "invalid_request");
    demand(standalone || (typeof repoPath === "string" && path.isAbsolute(repoPath)), "A repository grant needs an absolute repo path", "invalid_request");
    const roleList = [...new Set((Array.isArray(roles) ? roles : [roles]).map(role => String(role).trim()).filter(Boolean))].sort();
    demand(roleList.length > 0, "A grant needs at least one role", "invalid_request");
    const repoID = standalone ? undefined : repositoryID(repoPath);
    const id = `script-${name}-${createHash("sha256").update(JSON.stringify([repoID || "standalone", roleList])).digest("hex").slice(0, 10)}`;
    return this.service.grant({
      id, tool: entry.id, digest: entry.digest, scope: standalone ? "standalone" : "repository",
      ...(repoID ? { repo_id: repoID } : {}), roles: roleList, operations: ["describe", "invoke"], unattended: Boolean(unattended),
    });
  }
  // AutomationService execute() hook for kind "script".
  async run(entry, input, { signal, privateInputs = {} } = {}) {
    const tool = this.load(entry.script);
    demand(tool.digest === entry.digest, `Script tool ${entry.script} changed since it was tested; run \`posse tools test ${entry.script}\``, "script_changed");
    schemaCheck(tool.manifest.params, input);
    const selected = this.selectInputs(tool, privateInputs);
    const result = await runScriptTool(tool, { ...input, ...selected }, { secrets: this.secretValues(tool.manifest), privateInputs: selected, signal });
    demand(!result.timed_out, `Script tool ${entry.script} timed out after ${tool.manifest.timeout_seconds}s`, "script_timeout");
    return result;
  }
  selectInputs(tool, supplied) {
    if (!tool.manifest.inputs) return {};
    const selected = Object.fromEntries(Object.keys(tool.manifest.inputs.properties)
      .filter(key => Object.hasOwn(supplied, key)).map(key => [key, supplied[key]]));
    schemaCheck(tool.manifest.inputs, selected);
    return selected;
  }
  declaredSecret(tool, name) {
    const manifest = this.load(tool).manifest;
    demand(validScriptEnvName(name) && manifest.env.some(item => item.secret && item.name === name), `${tool} does not declare a secret named ${name}; add {"name":"${name}","secret":true} to its env in ${SCRIPT_TOOL_MANIFEST_FILE}`, "script_invalid");
    return manifest;
  }
  setSecret(tool, name, value) {
    this.declaredSecret(tool, name);
    demand(typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= SCRIPT_TOOL_LIMITS.MAX_SECRET_BYTES && !value.includes("\0"), `A secret must be 1-${SCRIPT_TOOL_LIMITS.MAX_SECRET_BYTES} bytes without NUL characters`, "script_invalid");
    this.store.put(SECRET_KIND, `${tool}/${name}`, { value, set_at: new Date(this.now()).toISOString() });
    return { tool, name, set: true, fingerprint: fingerprint(value) };
  }
  unsetSecret(tool, name) {
    this.declaredSecret(tool, name);
    const existed = Boolean(this.store.get(SECRET_KIND, `${tool}/${name}`));
    if (existed) this.store.remove(SECRET_KIND, `${tool}/${name}`);
    return { tool, name, removed: existed };
  }
  secretStatus(manifest) {
    return manifest.env.filter(item => item.secret).map(item => {
      const stored = this.store.get(SECRET_KIND, `${manifest.name}/${item.name}`);
      return stored?.value ? { name: item.name, set: true, fingerprint: fingerprint(stored.value), set_at: stored.set_at } : { name: item.name, set: false };
    });
  }
  // Values for injection only; an unset declared secret fails closed.
  secretValues(manifest) {
    const values = {};
    for (const item of manifest.env.filter(variable => variable.secret)) {
      const stored = this.store.get(SECRET_KIND, `${manifest.name}/${item.name}`);
      demand(stored?.value, `${item.name} is not set; run \`posse tools secret set ${manifest.name} ${item.name}\``, "script_secret_missing");
      values[item.name] = stored.value;
    }
    return values;
  }
}

function fingerprint(value) { return `····${createHash("sha256").update(value).digest("hex").slice(0, 6)}`; }
function readBounded(file, limit) {
  const info = fs.statSync(file);
  demand(info.size <= limit, `${file} is larger than ${limit} bytes`, "script_invalid");
  return fs.readFileSync(file);
}
