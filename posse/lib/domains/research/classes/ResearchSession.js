import { classifyResearchTask } from "../functions/routing.js";
import { createResearchFanoutJobs } from "../functions/fanout.js";
import { buildResearchFanoutReport } from "../functions/fanout-report.js";

export class ResearchSession {
  constructor({
    workItem = null,
    intakeHints = {},
    budget = null,
    projectMap = null,
    mode = null,
    branches = null,
    worker = null,
    parentJob = null,
    options = {},
  } = {}) {
    this.workItem = workItem || null;
    this.intakeHints = intakeHints || {};
    this.budget = budget || null;
    this.projectMap = projectMap || null;
    this.mode = mode || null;
    this.branches = Array.isArray(branches) ? [...branches] : null;
    this.worker = worker || null;
    this.parentJob = parentJob || null;
    this.options = options || {};
    this._routing = null;
    this._fanout = null;
    this._outcomes = [];
  }

  routing() {
    if (this._routing) return this._routing;
    this._routing = classifyResearchTask({
      title: this.workItem?.title || "",
      description: this.workItem?.description || this.workItem?.task_spec || "",
      intakeHints: this.intakeHints,
      projectMap: this.projectMap,
      mode: this.mode,
    });
    return this._routing;
  }

  fanoutBranches() {
    if (this.branches) return [...this.branches];
    const route = this.routing();
    return Array.isArray(route?.branches) ? route.branches : [];
  }

  executeFanout({ source = "session", reason = null, mode = null, branches = null, soloJob = null, preflightJobId = null, extraPayload = {} } = {}) {
    const route = this.routing();
    const selectedBranches = Array.isArray(branches) ? branches : this.fanoutBranches();
    this._fanout = createResearchFanoutJobs({
      workItem: this.workItem,
      parentJob: this.parentJob,
      branches: selectedBranches,
      budget: this.budget || route?.budget || "normal",
      source,
      reason: reason || route?.reason || null,
      mode: mode || this.options.mode || "shadow",
      soloJob,
      actorType: this.options.actorType || "system",
      preflightJobId,
      extraPayload,
    });
    return this._fanout;
  }

  reconcile(branchOutcomes = []) {
    this._outcomes = Array.isArray(branchOutcomes) ? [...branchOutcomes] : [];
    return {
      branchCount: this._outcomes.length,
      successCount: this._outcomes.filter((entry) => entry?.ok === true || entry?.status === "succeeded").length,
      failedCount: this._outcomes.filter((entry) => entry?.ok === false || entry?.status === "failed").length,
    };
  }

  report(opts = {}) {
    return buildResearchFanoutReport({
      ...this.options,
      ...opts,
    });
  }
}
