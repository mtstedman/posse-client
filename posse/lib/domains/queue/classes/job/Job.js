// lib/job.js
//
// Snapshot wrapper for a jobs row. Job instances are not identity-tracked:
// two workers reading the same row will construct distinct objects, and
// job1 === job2 is not meaningful across reads.

import { parseJobPayload } from "../../functions/payload.js";

function requireDep(deps, name) {
  if (typeof deps?.[name] !== "function") {
    throw new Error(`Job requires deps.${name}`);
  }
  return deps[name];
}

function resultToJson(value) {
  return value === undefined ? null : JSON.stringify(value);
}

export class Job {
  constructor({ row, agent = null, deps } = {}) {
    if (!row) throw new Error("Job requires row");
    if (!deps) throw new Error("Job requires deps");
    this.row = row;
    this.agent = agent;
    this.deps = deps;
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver);
        return target.row?.[prop];
      },
      set(target, prop, value, receiver) {
        if (prop in target) return Reflect.set(target, prop, value, receiver);
        throw new Error(`Job row field "${String(prop)}" is read-only; use an explicit Job mutation method`);
      },
    });
  }

  get id() { return this.row.id; }
  get type() { return this.row.job_type; }
  get status() { return this.row.status; }
  get workItemId() { return this.row.work_item_id; }
  get payload() { return parseJobPayload(this.row); }
  get contextText() { return this.row.context_text ?? null; }

  getRole() {
    if (this.agent && typeof this.agent.getRole === "function") {
      return this.agent.getRole();
    }
    return null;
  }

  getDependsOnIds() {
    const getDependencies = requireDep(this.deps, "getDependencies");
    return getDependencies(this.id).map((dep) => dep.depends_on_job_id);
  }

  resolveDependencies() {
    const getJob = requireDep(this.deps, "getJob");
    return this.getDependsOnIds()
      .map((id) => getJob(id))
      .filter(Boolean);
  }

  async run(attemptCtx = {}) {
    if (!this.agent || typeof this.agent.run !== "function") {
      throw new Error(`Job ${this.id} has no agent`);
    }
    return await this.agent.run(this, attemptCtx);
  }

  async setStatus(status, opts = undefined) {
    const updateJobStatus = requireDep(this.deps, "updateJobStatus");
    const changed = opts && Object.keys(opts).length > 0
      ? await updateJobStatus(this.id, status, opts)
      : await updateJobStatus(this.id, status);
    if (changed === false) return false;
    this.row.status = status;
    return true;
  }

  async setResult(result) {
    const setJobResult = requireDep(this.deps, "setJobResult");
    await setJobResult(this.id, result);
    this.row.result_json = resultToJson(result);
  }

  async setError(errorText) {
    const setJobError = requireDep(this.deps, "setJobError");
    await setJobError(this.id, errorText);
    this.row.last_error = errorText;
  }

  async setContext(text) {
    const setJobContext = requireDep(this.deps, "setJobContext");
    await setJobContext(this.id, text);
    this.row.context_text = text;
  }

  async setProvider(provider, modelName = undefined) {
    const updateJobProvider = requireDep(this.deps, "updateJobProvider");
    await updateJobProvider(this.id, provider, modelName);
    this.row.provider = provider;
    if (modelName !== undefined) this.row.model_name = modelName;
  }

  async logEvent(entry = {}) {
    const logEvent = requireDep(this.deps, "logEvent");
    await logEvent({
      work_item_id: this.workItemId,
      job_id: this.id,
      ...entry,
    });
  }

  async refresh() {
    const getJob = requireDep(this.deps, "getJob");
    const row = await getJob(this.id);
    if (row) this.row = row;
    return this.row;
  }
}
