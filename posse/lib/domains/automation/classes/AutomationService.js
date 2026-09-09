import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { AUTOMATION_BUILTINS, CUSTOM_TOOLS_TERMINAL } from "../../../catalog/custom-tools.js";
import { authorize, definitionDigest, demand, digest, matchesGrant, narrowLimits, object, publicEntry, schemaCheck, subject, validateDefinition, validateGrant } from "../functions/policy.js";
import { ResourceSandbox } from "./ResourceSandbox.js";
import { nextOccurrence, previewOccurrences, validateTrigger } from "../functions/triggers.js";

const defaultLimits = { wall_time_seconds: 120, calls: 16, turns: 8, spend_cap_usd: 1 };
export class AutomationService {
  constructor(store, { agent = null, connectors = null, now = () => Date.now(), claimOwner = true, leaseTTLms = 15000 } = {}) {
    this.store = store; this.agent = agent; this.connectors = connectors; this.now = now;
    this.active = new Map(); this.owner = randomUUID(); this.stopping = false;
    this.leaseTTLms = leaseTTLms; this.lease = null; this.leaseTimer = null;
    if (claimOwner) {
      this.lease = this.store.claim("dispatcher", this.owner, this.now(), this.leaseTTLms);
      demand(this.lease, "Another automation owner holds the dispatcher lease", "owner_unavailable");
      this.leaseTimer = setInterval(() => {
        if (!this.store.renew("dispatcher", this.owner, this.lease.generation, this.now(), this.leaseTTLms)) this.stopping = true;
      }, Math.max(250, Math.floor(this.leaseTTLms / 3)));
      this.leaseTimer.unref?.();
    }
    for (const [id, descriptor] of Object.entries(AUTOMATION_BUILTINS)) {
      const entry = { id: `builtin:${id}@1`, source: "builtin", kind: "builtin", capability: id, description: descriptor.description, input_schema: descriptor.input, output_schema: { type: "object" }, effect: descriptor.operation === "write" ? "artifact_write" : "read_only", limits: defaultLimits, enabled: true };
      entry.digest = digest(entry);
      const existing = this.store.get("entries", entry.id);
      demand(!existing || existing.digest === entry.digest, "Builtin contract changed without a version bump");
      if (!existing) this.store.put("entries", entry.id, entry);
    }
  }
  health() { return { protocol: "posse.custom_tools.v1", ready: !this.stopping && this.ownsLease(), owner: this.owner, generation: this.lease?.generation || null, pid: process.pid, supervisor_pid: Number(process.env.POSSE_AUTOMATION_SUPERVISOR_PID) || null }; }
  ownsLease() { return !this.lease || this.store.owns("dispatcher", this.owner, this.lease.generation, this.now()); }
  assertOwner() { demand(!this.stopping && this.ownsLease(), "Automation owner lease changed", "owner_fenced"); }
  registerResource(value) {
    object(value, ["id", "root", "operations", "enabled"], ["id", "root", "operations"]);
    demand(/^[a-zA-Z0-9._-]{1,120}$/.test(value.id), "Invalid resource ID");
    demand(Array.isArray(value.operations) && value.operations.length && value.operations.every(op => ["list", "read", "write"].includes(op)), "Invalid resource operations");
    const root = fs.realpathSync(value.root), stat = fs.statSync(root);
    demand(stat.isDirectory() && !root.split(path.sep).some(part => [".git", ".posse"].includes(part)), "Protected or invalid resource root");
    const previous = this.store.get("resources", value.id);
    const result = { ...value, root, device: String(stat.dev), inode: String(stat.ino), revision: (previous?.revision || 0) + 1, enabled: value.enabled !== false };
    this.store.put("resources", value.id, result);
    // Resource replacement is a permission change: old bindings cannot follow it.
    if (previous) for (const grant of this.store.list("grants")) if (grant.resources.some(item => item.id === value.id)) this.revoke(grant.id);
    return result;
  }
  disableResource(id) {
    const resource = this.store.get("resources", id); demand(resource, "Resource not found");
    resource.enabled = false; resource.revision = Number(resource.revision || 0) + 1;
    this.store.put("resources", id, resource);
    for (const grant of this.store.list("grants")) {
      if (grant.resources.some(item => item.id === id) && grant.enabled) this.revoke(grant.id);
    }
    return resource;
  }
  grant(value) {
    const grant = validateGrant(value), entry = this.store.get("entries", grant.tool);
    demand(entry?.enabled && entry.digest === grant.digest, "Grant must pin an enabled tool's exact digest");
    if (entry.definition?.binding.kind === "repository") demand(grant.scope === "repository" && grant.repo_id === entry.definition.binding.repo_id, "Skill repository binding mismatch");
    for (const item of grant.resources) {
      const resource = this.store.get("resources", item.id);
      demand(resource?.enabled && item.operations.every(op => resource.operations.includes(op)), "Grant exceeds resource permissions");
    }
    this.checkResourceCeiling(entry, grant);
    grant.revision = (this.store.get("grants", grant.id)?.revision || 0) + 1;
    this.store.put("grants", grant.id, grant);
    this.cancelChangedGrants(grant.id);
    return grant;
  }
  checkResourceCeiling(entry, grant) {
    if (!entry.definition) return;
    const definition = entry.definition;
    for (const resource of grant.resources) {
      const requirement = definition.resource_requirements?.find(item => item.id === resource.id);
      if (requirement) demand(resource.operations.every(op => requirement.operations.includes(op)), "Grant exceeds skill resource ceiling");
      else {
        // Old repository skills have a published output-root ceiling. A grant
        // cannot reinterpret those relative roots as any arbitrary host folder.
        demand(!definition.resource_requirements?.length && definition.binding.kind === "repository" && resource.operations.every(op => op === "write"), "Resource is absent from the skill contract");
        const repository = this.store.get("repositories", definition.binding.repo_id);
        const registered = this.store.get("resources", resource.id);
        demand(repository && registered && (definition.output_roots || []).some(root => {
          const relative = path.relative(path.resolve(repository.root, root), registered.root);
          return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
        }), "Resource lies outside published skill output roots");
      }
    }
  }
  revoke(id) {
    const grant = this.store.get("grants", id); demand(grant, "Grant not found");
    grant.enabled = false; grant.revision++; this.store.put("grants", id, grant); this.cancelChangedGrants(id); return grant;
  }
  cancelChangedGrants(id) { for (const active of this.active.values()) if (active.run.grant_id === id) active.controller.abort(new Error("Grant changed or revoked")); }
  entryAvailable(entry) {
    if (!entry?.enabled) return false;
    if (entry.kind === "builtin") return true;
    if (entry.kind === "mcp") return this.connectors?.has?.(entry.id) === true;
    if (!entry.definition) return false;
    if (entry.definition.runtime?.mode === "bounded-agent") return typeof this.agent === "function";
    if (entry.definition.runtime?.mode !== "recipe") return false;
    return entry.definition.capabilities.every(capability => AUTOMATION_BUILTINS[capability.id] || this.connectors?.has?.(capability.id) === true);
  }
  discover(principal, query = "") {
    subject(principal); const grants = this.store.list("grants");
    return this.store.list("entries").filter(entry => this.entryAvailable(entry) && (entry.description.toLowerCase().includes(String(query).toLowerCase()) || entry.id.toLowerCase().includes(String(query).toLowerCase())))
      .flatMap(entry => {
        const eligible = grants.filter(grant => grant.tool === entry.id && grant.digest === entry.digest && matchesGrant(grant, principal, "describe"));
        return eligible.length ? [{ id: entry.id, source: entry.source, kind: entry.kind, digest: entry.digest, description: entry.description, grant_ids: eligible.map(grant => grant.id) }] : [];
      }).slice(0, 50);
  }
  resolve(principal, id, operation, grantID) {
    subject(principal); const entry = this.store.get("entries", id);
    demand(this.entryAvailable(entry), "Custom tool is unavailable in this scope", "forbidden");
    const grant = authorize(this.store.list("grants"), entry, principal, operation, grantID);
    this.checkResourceCeiling(entry, grant);
    return { entry, grant };
  }
  tool(principal, args) {
    object(args, ["operation", "query", "tool", "grant_id", "input", "run_id", "idempotency_key"], ["operation"]);
    switch (args.operation) {
      case "search": return { category: "Custom Tools", tools: this.discover(principal, args.query) };
      case "describe": { const { entry, grant } = this.resolve(principal, args.tool, "describe", args.grant_id); return publicEntry(entry, [grant]); }
      case "invoke": return this.invoke(principal, args);
      case "status": return this.ownedRun(principal, args.run_id);
      case "cancel": { const run = this.ownedRun(principal, args.run_id); this.cancel(run.id); return this.store.run(run.id); }
      default: throw new Error("Unknown Custom Tools operation");
    }
  }
  ownedRun(principal, id) {
    subject(principal); const run = this.store.run(id);
    demand(run && digest(run.principal) === digest(principal), "Run is outside this caller's scope", "forbidden");
    return run;
  }
  invoke(principal, args, schedule = null) {
    this.assertOwner();
    const { entry, grant } = this.resolve(principal, args.tool, "invoke", args.grant_id);
    demand(!schedule || grant.unattended && grant.revision === schedule.grant_revision, "Schedule grant changed or is not unattended", "grant_changed");
    schemaCheck(entry.input_schema, args.input);
    const key = args.idempotency_key || randomUUID();
    demand(typeof key === "string" && key.length > 0 && key.length <= 120, "Invalid idempotency key");
    const idem = digest([principal, grant.id, key]);
    const fingerprint = digest([entry.id, entry.digest, grant.revision, args.input]);
    const run = this.store.transaction(() => {
      const existing = this.store.byIdempotency(idem);
      if (existing) { demand(existing.fingerprint === fingerprint, "Idempotency key reused with different input or authority", "idempotency_conflict"); return existing; }
      return this.store.insertRun(this.newRun(principal, entry, grant, args.input, fingerprint, schedule), idem);
    });
    if (run.status === "queued" && !this.active.has(run.id)) this.start(run, entry, grant);
    return run;
  }
  newRun(principal, entry, grant, input, fingerprint, schedule = null) {
    const measuredZero = entry.kind === "builtin" || entry.definition?.runtime?.mode === "recipe";
    return { id: randomUUID(), tool: entry.id, skill_id: entry.definition ? `${entry.definition.name}@${entry.definition.version}` : entry.id, principal: structuredClone(principal), grant_id: grant.id, grant_revision: grant.revision, resource_revisions: grant.resources.map(item => ({ id: item.id, revision: this.store.get("resources", item.id)?.revision })), digest: entry.digest, fingerprint, input: structuredClone(input), status: "queued", created_at: new Date(this.now()).toISOString(), started_at: null, calls: 0, turns: 0, spend_usd: measuredZero ? 0 : null, schedule_id: schedule?.id || null, schedule_revision: schedule?.revision || null, owner_generation: this.lease?.generation || null, attempt: 1, retry: structuredClone(schedule?.retry || { max_attempts: 1 }) };
  }
  start(run, entry, grant) {
    const controller = new AbortController();
    const state = { run, controller, promise: null };
    this.active.set(run.id, state);
    state.promise = this.execute(run, entry, grant, controller).finally(() => this.active.delete(run.id));
  }
  async execute(run, entry, grant, controller) {
    const limits = narrowLimits(entry.limits, grant.limits || entry.limits);
    const deadline = performance.now() + limits.wall_time_seconds * 1000;
    const timer = setTimeout(() => controller.abort(Object.assign(new Error("Wall time limit exceeded"), { code: "wall_time_limit" })), limits.wall_time_seconds * 1000);
    const check = () => {
      controller.signal.throwIfAborted();
      this.assertOwner();
      demand(performance.now() < deadline, "Wall time limit exceeded", "wall_time_limit");
      const current = this.store.get("grants", grant.id), currentEntry = this.store.get("entries", entry.id);
      demand(current?.enabled && current.revision === grant.revision && currentEntry?.enabled && currentEntry.digest === entry.digest, "Run authority changed", "grant_changed");
    };
    const sandbox = new ResourceSandbox(this.store.list("resources"), grant.resources, { signal: controller.signal, check, checkpoint: key => this.store.checkpoint(key), namespace: digest([entry.id, entry.digest, grant.id, grant.revision]) });
    const capability = async (id, input) => {
      check();
      demand(++run.calls <= limits.calls, "Call limit exceeded", "call_limit");
      const allowed = entry.kind === "builtin" ? [entry.capability] : entry.definition.capabilities.map(cap => cap.id);
      demand(allowed.includes(id), "Capability is not in the approved skill", "forbidden");
      const builtin = AUTOMATION_BUILTINS[id];
      if (builtin) {
        schemaCheck(builtin.input, input);
        demand(entry.effect !== "read_only" || builtin.operation !== "write", "Read-only skill cannot write", "forbidden");
        if (id === "files.list") return { files: sandbox.list(input.resource, input.directory, input.extension) };
        if (id === "files.read") return sandbox.read(input.resource, input.path);
        if (id === "files.write") return sandbox.write(input.resource, input.path, input.content);
        if (id === "csv.process") return sandbox.processCSV(input);
      }
      demand(this.connectors, `Capability ${id} has no installed adapter`, "capability_unavailable");
      return this.connectors.call(id, input, { signal: controller.signal, effect: entry.effect, grant, check });
    };
    try {
      check(); run.status = "running"; run.started_at ||= new Date(this.now()).toISOString(); this.store.updateRun(run);
      let output;
      if (entry.kind === "builtin") output = await capability(entry.capability, run.input);
      else if (entry.kind === "mcp") {
        demand(this.connectors, "Connector adapter unavailable");
        run.calls++; output = await this.connectors.call(entry.id, run.input, { signal: controller.signal, effect: entry.effect, grant, check });
      } else if (entry.definition.runtime.mode === "recipe") {
        const previous = {};
        for (const step of entry.definition.runtime.recipe) {
          check(); const input = step.input === undefined ? run.input : mapInput(step.input, run.input, previous);
          output = await capability(step.capability, input);
          const cap = entry.definition.capabilities.find(item => item.id === step.capability);
          if (cap.output_schema) schemaCheck(cap.output_schema, output);
          previous[step.id] = output;
        }
      } else {
        demand(this.agent, "Bounded agent provider unavailable", "capability_unavailable");
        run.spend_reserved_usd = limits.spend_cap_usd; this.store.updateRun(run);
        let usageObserved = false;
        output = await this.agent({ definition: entry.definition, input: run.input, limits, signal: controller.signal, capability, check, usage: usage => {
          usageObserved = true; run.turns = usage.turns; run.spend_usd = usage.spend_usd;
          demand(Number.isFinite(run.spend_usd) && run.spend_usd >= 0 && run.spend_usd <= limits.spend_cap_usd && run.turns <= limits.turns, "Agent budget exceeded", "budget_limit");
        } });
        demand(usageObserved, "Agent usage is unavailable; budget reservation requires reconciliation", "usage_unknown");
        run.spend_reserved_usd = 0;
      }
      check(); schemaCheck(entry.output_schema, output); check();
      run.output = output; run.status = "committing";
      this.store.transaction(() => {
        this.assertOwner();
        this.store.reserveOutputs(run.id, sandbox.reservations());
        this.store.put("commits", run.id, sandbox.manifest());
        this.store.updateRun(run);
      });
      check(); run.artifacts = sandbox.commit(); check(); run.status = "succeeded";
      run.completed_at = new Date(this.now()).toISOString();
      this.store.transaction(() => {
        for (const item of sandbox.checkpoints) this.store.saveCheckpoint(item.id, item.value);
        this.store.updateRun(run); this.store.remove("commits", run.id); this.store.releaseOutputs(run.id);
      });
    } catch (error) {
      const uncertain = ["rollback_failed", "rollback_conflict", "usage_unknown", "external_outcome_unknown", "owner_fenced"].includes(error.code);
      run.error_code = error.code || "execution_failed";
      // Avoid reflecting arbitrary provider/connector errors or secrets into history.
      run.error = ["forbidden", "grant_changed", "schema_mismatch", "capability_unavailable", "wall_time_limit", "call_limit", "budget_limit", "usage_unknown", "owner_fenced", "output_conflict"].includes(run.error_code) ? error.message : "Execution failed; inspect the operator's local diagnostics";
      if (!uncertain) this.store.transaction(() => { this.store.remove("commits", run.id); this.store.releaseOutputs(run.id); });
      if (!uncertain && retryEligible(error, run)) {
        run.status = "retry_wait";
        run.next_retry_at = this.now() + retryDelayMs(run);
      } else run.status = uncertain ? "interrupted" : controller.signal.aborted ? "canceled" : "failed";
      if (uncertain && run.schedule_id) {
        const schedule = this.store.get("schedules", run.schedule_id);
        if (schedule) { schedule.enabled = false; schedule.error_code = "reconciliation_required"; this.store.put("schedules", schedule.id, schedule); }
      }
    } finally {
      clearTimeout(timer);
      if (run.status === "retry_wait") delete run.completed_at;
      else run.completed_at = new Date(this.now()).toISOString();
      this.store.transaction(() => {
        this.store.updateRun(run);
        if (run.schedule_id) {
          const schedule = this.store.get("schedules", run.schedule_id);
          if (schedule?.trigger?.kind === "once" && schedule.last_run_id === run.id && run.status !== "retry_wait") {
            schedule.state = run.status === "succeeded" ? "completed" : run.status;
            schedule.enabled = false; this.store.put("schedules", schedule.id, schedule);
          }
        }
      });
    }
    return run;
  }
  cancel(id) {
    const active = this.active.get(id); if (active) { active.controller.abort(new Error("Run canceled")); return; }
    const run = this.store.run(id); if (run && !CUSTOM_TOOLS_TERMINAL.includes(run.status)) { run.status = "canceled"; run.completed_at = new Date(this.now()).toISOString(); this.store.updateRun(run); }
  }
  recover() {
    for (const run of this.store.unfinishedRuns()) {
      if (run.status === "queued" && !run.started_at) continue;
      const journal = this.store.get("commits", run.id);
      if (journal && ResourceSandbox.reconcile(journal)) {
        this.store.transaction(() => {
          run.status = "succeeded"; run.artifacts = journal.files.map(item => `${item.resource}/${item.name}`);
          run.completed_at = new Date(this.now()).toISOString();
          for (const item of journal.checkpoints) this.store.saveCheckpoint(item.id, item.value);
          this.store.updateRun(run); this.store.remove("commits", run.id); this.store.releaseOutputs(run.id);
        });
        continue;
      }
      run.status = "interrupted"; run.error_code = "owner_restarted"; run.error = "Prior execution outcome is unknown; reconcile before retrying";
      run.completed_at = new Date(this.now()).toISOString(); this.store.updateRun(run);
      if (run.schedule_id) {
        const schedule = this.store.get("schedules", run.schedule_id);
        if (schedule) { schedule.enabled = false; schedule.error_code = "reconciliation_required"; this.store.put("schedules", schedule.id, schedule); }
      }
    }
  }
  saveSchedule(value) {
    object(value, ["id", "tool", "grant_id", "principal", "input", "trigger", "every_seconds", "anchor", "enabled", "overlap", "misfire", "retry"], ["id", "tool", "grant_id", "principal", "input"]);
    demand(/^[a-zA-Z0-9._-]{1,120}$/.test(value.id), "Invalid schedule ID");
    const overlap = normalizeOverlap(value.overlap);
    const misfire = normalizeMisfire(value.misfire);
    const retry = normalizeRetry(value.retry);
    const { entry, grant } = this.resolve(value.principal, value.tool, "invoke", value.grant_id);
    demand(grant.unattended, "Grant does not permit unattended execution"); schemaCheck(entry.input_schema, value.input);
    demand(retry.max_attempts === 1 || this.retrySafe(entry), "This target cannot safely retry the same logical firing");
    const legacyAnchor = value.anchor === undefined ? this.now() : Date.parse(value.anchor);
    const trigger = value.trigger || { kind: "interval", every_seconds: value.every_seconds, anchor: new Date(legacyAnchor).toISOString() };
    validateTrigger(trigger);
    const first = nextOccurrence(trigger, this.now() - 1);
    const preview = previewOccurrences(trigger, 5, this.now() - 1);
    demand(preview.length > 0, "Schedule trigger has no future occurrence");
    const prior = this.store.get("schedules", value.id);
    const schedule = { ...structuredClone(value), trigger, grant_revision: grant.revision, resource_revisions: grant.resources.map(item => ({ id: item.id, revision: this.store.get("resources", item.id)?.revision })), digest: entry.digest, next_at: first.at, next_local_key: first.localKey, preview, enabled: value.enabled !== false, state: value.enabled === false ? "paused" : "active", overlap, misfire, retry, revision: (prior?.revision || 0) + 1 };
    delete schedule.every_seconds; delete schedule.anchor;
    return this.store.put("schedules", schedule.id, schedule);
  }
  setScheduleEnabled(id, enabled) {
    const schedule = this.store.get("schedules", id); demand(schedule, "Schedule not found");
    schedule.enabled = enabled === true;
    schedule.state = schedule.enabled ? "active" : "paused";
    delete schedule.error_code;
    return this.store.put("schedules", id, schedule);
  }
  removeSchedule(id) {
    const schedule = this.store.get("schedules", id); demand(schedule, "Schedule not found");
    demand(this.store.scheduleRunCount(id, ["queued", "running", "committing", "retry_wait", "interrupted"]) === 0,
      "Schedule has an unfinished or unreconciled run");
    this.store.remove("schedules", id); return schedule;
  }
  runScheduleNow(id, idempotencyKey = randomUUID()) {
    const schedule = this.store.get("schedules", id); demand(schedule, "Schedule not found");
    const active = this.store.scheduleRunCount(id, ["queued", "running", "committing", "retry_wait"]);
    demand(schedule.overlap.mode === "allow" ? active < schedule.overlap.max_concurrency : active === 0,
      "Schedule overlap policy does not allow run now", "schedule_attention");
    return this.invoke(schedule.principal, {
      operation: "invoke", tool: schedule.tool, grant_id: schedule.grant_id,
      input: schedule.input, idempotency_key: `run-now:${idempotencyKey}`,
    }, schedule);
  }
  tick() {
    this.assertOwner();
    for (const retrying of this.store.retryRuns(this.now())) {
      this.store.transaction(() => {
        const run = this.store.run(retrying.id);
        if (run?.status !== "retry_wait" || run.next_retry_at > this.now()) return;
        run.status = "queued"; run.attempt = Number(run.attempt || 1) + 1;
        delete run.next_retry_at; delete run.error; delete run.error_code;
        this.store.updateRun(run);
      });
    }
    this.startQueuedRuns();
    for (const value of this.store.list("schedules")) {
      if (!value.enabled || value.next_at > this.now()) continue;
      const materialized = [];
      try { this.store.transaction(() => {
        this.assertOwner();
        const schedule = this.store.get("schedules", value.id);
        if (!schedule.enabled || schedule.next_at > this.now()) return;
        const due = [];
        let cursor = { at: schedule.next_at, localKey: schedule.next_local_key || null };
        for (let index = 0; cursor && cursor.at <= this.now() && index < 1000; index++) {
          due.push(cursor);
          cursor = nextOccurrence(schedule.trigger, cursor.at, { lastLocalKey: cursor.localKey });
        }
        demand(!cursor || cursor.at > this.now(), "Schedule has more than 1000 missed occurrences; operator review is required", "schedule_attention");
        schedule.next_at = cursor?.at ?? null; schedule.next_local_key = cursor?.localKey ?? null;
        if (!cursor && schedule.trigger.kind === "once") { schedule.enabled = false; schedule.state = "completing"; }
        let firings = schedule.misfire.mode === "skip" && due.length > 1 ? []
          : schedule.misfire.mode === "catch_up_bounded" ? due.slice(0, schedule.misfire.max_runs)
            : due.length ? [due[0]] : [];
        if (schedule.misfire.mode === "run_once" && firings.length) firings[0] = { ...firings[0], range_end: due.at(-1).at };
        const active = this.store.scheduleRunCount(schedule.id, ["running", "committing", "retry_wait"]);
        const pending = this.store.scheduleRunCount(schedule.id, ["queued"]);
        if (schedule.overlap.mode === "forbid" && (active > 0 || pending > 0)) firings = [];
        if (schedule.overlap.mode === "queue_one") firings = pending > 0 ? [] : firings.slice(0, 1);
        if (schedule.overlap.mode === "allow") firings = firings.slice(0, Math.max(0, schedule.overlap.max_concurrency - active - pending));
        if (!firings.length) schedule.last_skipped_at = due.at(-1)?.at || null;
        for (const firing of firings) {
          const { entry, grant } = this.resolve(schedule.principal, schedule.tool, "invoke", schedule.grant_id);
          demand(grant.unattended && grant.revision === schedule.grant_revision, "Schedule grant changed or is not unattended", "grant_changed");
          const key = digest(["schedule", schedule.id, schedule.revision, firing.at]);
          const idem = digest([schedule.principal, grant.id, key]);
          const fingerprint = digest([entry.id, entry.digest, grant.revision, schedule.input]);
          let run = this.store.byIdempotency(idem);
          if (!run) run = this.store.insertRun(this.newRun(schedule.principal, entry, grant, schedule.input, fingerprint, schedule), idem);
          else demand(run.fingerprint === fingerprint, "Schedule firing identity conflicts with persisted run", "idempotency_conflict");
          run.expected_fire_at = firing.at; run.expected_fire_end_at = firing.range_end || firing.at; run.triggered_by = "schedule";
          this.store.updateRun(run); materialized.push(run);
          schedule.last_run_id = run.id;
          schedule.last_local_key = firing.localKey;
        }
        this.store.put("schedules", schedule.id, schedule);
      }); } catch (error) {
        if (error.code === "owner_fenced") throw error;
        const schedule = this.store.get("schedules", value.id);
        if (schedule) {
          schedule.enabled = false; schedule.state = "attention";
          schedule.error_code = ["grant_changed", "schedule_attention", "idempotency_conflict"].includes(error.code) ? error.code : "schedule_error";
          this.store.put("schedules", schedule.id, schedule);
        }
        continue;
      }
      if (materialized.length) this.startQueuedRuns();
    }
  }
  startQueuedRuns() {
    for (const queued of this.store.queuedRuns()) {
      if (this.active.has(queued.id)) continue;
      const schedule = queued.schedule_id ? this.store.get("schedules", queued.schedule_id) : null;
      if (schedule) {
        const active = this.store.scheduleRunCount(schedule.id, ["running", "committing"]);
        if (schedule.overlap.mode !== "allow" && active > 0) continue;
        if (schedule.overlap.mode === "allow" && active >= schedule.overlap.max_concurrency) continue;
      }
      try {
        const { entry, grant } = this.resolve(queued.principal, queued.tool, "invoke", queued.grant_id);
        demand(entry.digest === queued.digest && grant.revision === queued.grant_revision, "Queued run authority changed", "grant_changed");
        this.start(queued, entry, grant);
      } catch (error) {
        queued.status = "failed"; queued.error_code = error.code || "grant_changed";
        queued.error = "Queued run authority changed before dispatch"; queued.completed_at = new Date(this.now()).toISOString();
        this.store.updateRun(queued);
        if (schedule) { schedule.enabled = false; schedule.state = "attention"; schedule.error_code = queued.error_code; this.store.put("schedules", schedule.id, schedule); }
      }
    }
  }
  retrySafe(entry) {
    if (entry.kind === "builtin" || entry.retry_safe === true) return true;
    return entry.definition?.runtime?.mode === "recipe"
      && entry.definition.capabilities.every(capability => !!AUTOMATION_BUILTINS[capability.id]);
  }
  async shutdown() { this.stopping = true; if (this.leaseTimer) clearInterval(this.leaseTimer); for (const active of this.active.values()) active.controller.abort(Object.assign(new Error("Owner stopping"), { code: "owner_shutdown", retryable: true })); await Promise.allSettled([...this.active.values()].map(active => active.promise)); if (this.lease) this.store.release("dispatcher", this.owner, this.lease.generation); }
}

function normalizeMisfire(value) {
  const input = typeof value === "string" ? { mode: value } : value || { mode: "run_once" };
  object(input, ["mode", "max_runs"], ["mode"]);
  demand(["skip", "run_once", "catch_up_bounded"].includes(input.mode), "Unsupported misfire policy");
  const max = input.mode === "catch_up_bounded" ? input.max_runs : 1;
  demand(Number.isInteger(max) && max >= 1 && max <= 100, "Invalid catch-up bound");
  return { mode: input.mode, max_runs: max };
}
function normalizeOverlap(value) {
  const input = typeof value === "string" ? { mode: value } : value || { mode: "forbid" };
  object(input, ["mode", "max_concurrency"], ["mode"]);
  demand(["forbid", "queue_one", "allow"].includes(input.mode), "Unsupported overlap policy");
  const max = input.mode === "allow" ? input.max_concurrency : 1;
  demand(Number.isInteger(max) && max >= 1 && max <= 16, "Invalid overlap concurrency");
  return { mode: input.mode, max_concurrency: max };
}
function normalizeRetry(value) {
  const input = value || { max_attempts: 1, initial_delay_seconds: 5, max_delay_seconds: 300, backoff_factor: 2, jitter: 0.2 };
  object(input, ["max_attempts", "initial_delay_seconds", "max_delay_seconds", "backoff_factor", "jitter"], ["max_attempts"]);
  const result = { max_attempts: input.max_attempts, initial_delay_seconds: input.initial_delay_seconds ?? 5, max_delay_seconds: input.max_delay_seconds ?? 300, backoff_factor: input.backoff_factor ?? 2, jitter: input.jitter ?? 0.2 };
  demand(Number.isInteger(result.max_attempts) && result.max_attempts >= 1 && result.max_attempts <= 10, "Invalid retry attempts");
  demand(Number.isFinite(result.initial_delay_seconds) && result.initial_delay_seconds >= 1 && result.initial_delay_seconds <= 86400, "Invalid retry delay");
  demand(Number.isFinite(result.max_delay_seconds) && result.max_delay_seconds >= result.initial_delay_seconds && result.max_delay_seconds <= 604800, "Invalid maximum retry delay");
  demand(Number.isFinite(result.backoff_factor) && result.backoff_factor >= 1 && result.backoff_factor <= 10, "Invalid retry factor");
  demand(Number.isFinite(result.jitter) && result.jitter >= 0 && result.jitter <= 0.5, "Invalid retry jitter");
  return result;
}
function retryEligible(error, run) {
  const retry = run.retry || { max_attempts: 1 };
  return Number(run.attempt || 1) < retry.max_attempts && (error?.retryable === true || ["rate_limited", "transient_provider", "wall_time_limit", "owner_shutdown"].includes(error?.code));
}
function retryDelayMs(run) {
  const retry = run.retry;
  const exponent = Math.max(0, Number(run.attempt || 1) - 1);
  const base = Math.min(retry.max_delay_seconds, retry.initial_delay_seconds * retry.backoff_factor ** exponent);
  const hash = parseInt(digest([run.id, run.attempt]).slice(0, 8), 16) / 0xffffffff;
  return Math.round(base * (1 + (hash * 2 - 1) * retry.jitter) * 1000);
}

function mapInput(value, input, steps) {
  if (typeof value === "string" && /^\$(input|steps)(\.|$)/.test(value)) {
    const [root, ...keys] = value.slice(1).split("."); let result = root === "input" ? input : steps;
    for (const key of keys) { demand(result && typeof result === "object" && Object.hasOwn(result, key) && !["__proto__", "constructor", "prototype"].includes(key), "Missing recipe input reference"); result = result[key]; }
    return structuredClone(result);
  }
  if (Array.isArray(value)) return value.map(item => mapInput(item, input, steps));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapInput(item, input, steps)]));
  return value;
}
