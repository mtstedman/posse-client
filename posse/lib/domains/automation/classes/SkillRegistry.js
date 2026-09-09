import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AUTOMATION_BUILTINS } from "../../../catalog/custom-tools.js";
import { definitionDigest, demand, digest, validateDefinition } from "../functions/policy.js";

export class SkillRegistry {
  constructor(service) { this.service = service; this.store = service.store; }
  identity(definition) { return `${definition.name}@${definition.version}`; }
  entryID(definition) { return `skill:${definition.binding.kind === "repository" ? encodeURIComponent(definition.binding.repo_id) + "/" : ""}${this.identity(definition)}`; }
  draftKey(definition) { return JSON.stringify([definition.name, definition.binding.kind, definition.binding.repo_id || ""]); }
  saveDraft(definition) {
    demand(definition && /^[a-z][a-z0-9-]*$/.test(definition.name) && ["repository", "global", "run-only"].includes(definition.binding?.kind), "Invalid draft identity");
    demand(definition.binding.kind !== "repository" || definition.binding.repo_id, "Draft repository is required");
    demand(Buffer.byteLength(JSON.stringify(definition)) <= 256 * 1024, "Draft too large");
    const now = new Date().toISOString(), key = this.draftKey(definition), old = this.store.get("drafts", key);
    return this.store.put("drafts", key, { ...definition, state: "draft", created_at: old?.created_at || now, updated_at: now });
  }
  newest(name, repoID) {
    const drafts = this.store.list("drafts").filter(item => item.name === name && (item.binding.kind === "global" || (item.binding.repo_id || "") === (repoID || ""))).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    demand(drafts.length, "Skill draft not found", "draft_not_found"); return drafts[0];
  }
  reset(name, binding) { return this.saveDraft(csvTemplate(name || "process-csv-folder", binding)); }
  importPublished(definition, sourceDigest) {
    validateDefinition(definition);
    demand(["published", "deprecated"].includes(definition.state), "Imported skill must have a published lifecycle state");
    const hash = definitionDigest(definition);
    demand(hash === sourceDigest, "Imported skill digest does not match its canonical definition", "schema_mismatch");
    const entry = this.entry(definition);
    const existing = this.store.get("entries", entry.id);
    if (existing) {
      demand(existing.digest === hash && definitionDigest(existing.definition) === hash,
        "Imported skill conflicts with an existing immutable version", "schema_mismatch");
      return existing.definition;
    }
    entry.source_digest = sourceDigest;
    this.store.put("entries", entry.id, entry);
    return definition;
  }
  list({ repo_id = "", include_drafts = false, include_deprecated = false } = {}) {
    const definitions = this.store.list("entries").filter(entry => entry.kind === "skill" && (entry.enabled || include_deprecated)).map(entry => entry.definition)
      .filter(definition => definition.binding.kind === "global" || definition.binding.repo_id === repo_id);
    return include_drafts ? [...definitions, ...this.store.list("drafts").filter(item => item.binding.kind === "global" || (item.binding.repo_id || "") === repo_id)] : definitions;
  }
  resolve(identity, repoID = "") {
    const definitions = this.list({ repo_id: repoID }).filter(item => this.identity(item) === identity);
    demand(definitions.length === 1, "Published skill is missing or ambiguous", "skill_unavailable"); return definitions[0];
  }
  assertAdapters(definition) {
    for (const capability of definition.capabilities) {
      demand(capability.kind === "tool", "This capability needs an installed bounded adapter", "capability_unavailable");
      demand(AUTOMATION_BUILTINS[capability.id] || this.service.connectors?.has(capability.id), `Capability ${capability.id} has no installed adapter`, "capability_unavailable");
    }
    if (definition.runtime.mode === "bounded-agent") demand(this.service.agent, "Agent provider unavailable", "capability_unavailable");
  }
  entry(definition) {
    return { id: this.entryID(definition), source: "bossy", kind: "skill", digest: definitionDigest(definition), description: definition.intent, input_schema: definition.contract.input_schema, output_schema: definition.contract.output_schema, limits: definition.contract.limits, effect: definition.contract.effect, enabled: definition.state === "published", definition: structuredClone(definition) };
  }
  publish(definition, actor = "local-operator") {
    validateDefinition(definition); this.assertAdapters(definition);
    demand(definition.binding.kind !== "run-only" && definition.version !== "draft", "Publication requires a version and reusable binding");
    const hash = definitionDigest(definition), test = this.store.get("tests", hash);
    demand(test?.passed, "Publish requires a passing test of this exact definition");
    const published = { ...definition, state: "published", published_by: actor, published_at: new Date().toISOString() };
    const entry = this.entry(published);
    this.store.transaction(() => {
      demand(!this.store.get("entries", entry.id), "Skill version is already published and immutable");
      demand(!this.store.list("entries").some(other => other.kind === "skill" && this.identity(other.definition) === this.identity(definition) && other.definition.binding.kind !== definition.binding.kind), "Skill identity already exists in another scope");
      this.store.put("entries", entry.id, entry); this.store.remove("drafts", this.draftKey(definition));
    });
    return published;
  }
  deprecate(identity, repoID) {
    const definition = this.resolve(identity, repoID), entry = this.store.get("entries", this.entryID(definition));
    entry.enabled = false; entry.definition.state = "deprecated"; entry.definition.deprecated_at = new Date().toISOString();
    this.store.put("entries", entry.id, entry);
    for (const grant of this.store.list("grants")) if (grant.tool === entry.id) this.service.revoke(grant.id);
    return entry.definition;
  }
  async test(definition) {
    const hash = definitionDigest(definition), checks = [];
    const result = { skill_id: this.identity(definition), definition_digest: hash, checks, passed: false, tested_at: new Date().toISOString() };
    try {
      validateDefinition(definition); this.assertAdapters(definition);
      checks.push({ name: "Definition and fixtures validate", passed: true });
      // Tests get only scratch resources. Real filesystem grants are never
      // copied into this temporary publication or expanded by fixture input.
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "posse-skill-test-"));
      const id = randomUUID(), entry = this.entry({ ...definition, state: "published" });
      entry.id = `test:${id}`;
      const resources = [];
      const requirements = definition.resource_requirements || [];
      // Preserve resource names in fixtures without touching live registered
      // resources by using a separate store/service for the test execution.
      const { AutomationStore } = await import("./AutomationStore.js");
      const { AutomationService } = await import("./AutomationService.js");
      const testStore = new AutomationStore(":memory:");
      const testService = new AutomationService(testStore, { agent: this.service.agent });
      let run;
      try {
        for (const requirement of requirements) {
          const root = path.join(scratch, requirement.id); fs.mkdirSync(root);
          if (requirement.operations.includes("read")) { const filename = path.join(root, "fixture.ready.csv"); fs.writeFileSync(filename, "name,value\nexample,1\n"); fs.utimesSync(filename, new Date(0), new Date(0)); }
          testService.registerResource({ id: requirement.id, root, operations: requirement.operations }); resources.push(requirement);
        }
        testStore.put("entries", entry.id, entry);
        const principal = definition.binding.kind === "repository" ? { scope: "repository", repo_id: definition.binding.repo_id, role: "dev" } : { scope: "standalone", role: "dev" };
        testService.grant({ id, tool: entry.id, digest: entry.digest, scope: principal.scope, repo_id: principal.repo_id, roles: ["dev"], operations: ["describe", "invoke"], resources });
        run = testService.invoke(principal, { tool: entry.id, grant_id: id, input: definition.contract.tests.valid_input });
        await testService.active.get(run.id)?.promise;
        run = testStore.run(run.id);
        checks.push({ name: "Valid fixture executes within the contract", passed: run.status === "succeeded", detail: run.error || "" });
        checks.push({ name: "Declared artifacts are produced", passed: definition.contract.effect === "read_only" || run.artifacts?.length > 0 });
        this.store.insertRun({ ...run, tool: this.entryID(definition), skill_id: this.identity(definition), test: true }, `test:${id}`);
      } finally { await testService.shutdown(); testStore.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
      result.passed = checks.every(check => check.passed);
    } catch (error) { checks.push({ name: "Skill contract and adapters", passed: false, detail: error.message }); }
    this.store.put("tests", hash, result); return result;
  }
}

export function csvTemplate(name, binding) {
  return { schema_version: 1, name, version: "1.0.0", state: "draft", intent: "Process ready CSV files into JSON records and remember completed inputs.", binding,
    capabilities: [{ kind: "tool", id: "csv.process" }], required_capabilities: ["csv.process"],
    resource_requirements: [{ id: "csv-inbox", operations: ["list", "read"] }, { id: "csv-results", operations: ["write"] }],
    contract: { input_schema: { type: "object", additionalProperties: false, required: ["source_resource", "destination_resource", "readiness"], properties: { source_resource: { type: "string", enum: ["csv-inbox"] }, destination_resource: { type: "string", enum: ["csv-results"] }, readiness: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "atomic_rename" } } } } }, output_schema: { type: "object", required: ["processed", "skipped"], properties: { processed: { type: "array", items: { type: "object" } }, skipped: { type: "array", items: { type: "string" } } } }, effect: "artifact_write", limits: { wall_time_seconds: 120, turns: 8, calls: 16, spend_cap_usd: 1 }, tests: { valid_input: { source_resource: "csv-inbox", destination_resource: "csv-results", readiness: { kind: "atomic_rename" } }, invalid_input: {} } },
    runtime: { mode: "recipe", recipe: [{ id: "process", capability: "csv.process", input: "$input" }] } };
}
