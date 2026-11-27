import { randomUUID } from "node:crypto";
import { EXPERIMENT_OBJECTS as K, EXPERIMENT_STATES as S, EXPERIMENT_DECISIONS } from "../../../catalog/experiments.js";
import { validateExperimentPlan } from "../functions/plan.js";
import { experimentDigest, snapshotFiles } from "../functions/snapshots.js";
import { assessExperimentImprovement } from "../functions/acceptance.js";

// Uses the owner's existing SQLite object store. All counters, decision guards,
// accepted-file pointers and idempotency receipts commit in one transaction.
export class ExperimentCampaigns {
  constructor(store, { now = Date.now } = {}) { this.store = store; this.now = now; }
  load(id) { const value = this.store.get(K.CAMPAIGNS, id); if (!value) throw new Error("Unknown experiment campaign."); return value; }
  snapshot(digest) { const value = this.store.get(K.SNAPSHOTS, digest); if (!value || experimentDigest(value.files) !== digest) throw new Error("Snapshot integrity failure."); return value; }
  saveSnapshot(snapshot) { if (!this.store.get(K.SNAPSHOTS, snapshot.digest)) this.store.put(K.SNAPSHOTS, snapshot.digest, snapshot); return snapshot.digest; }
  save(campaign) { campaign.revision++; campaign.updated_at = this.now(); this.store.put(K.CAMPAIGNS, campaign.id, campaign); return this.public(campaign); }
  public(c) {
    const { plan: _plan, request_key: _request, ...result } = c;
    return { ...result, max_iterations: c.plan.max_iterations, iterations_used: c.iterations.length, iterations_remaining: c.plan.max_iterations - c.iterations.length, acceptance: c.plan.acceptance || { mode: "human" } };
  }
  get(id) { return this.public(this.load(id)); }
  list() { return this.store.list(K.CAMPAIGNS).sort((a, b) => b.updated_at - a.updated_at).slice(0, 100).map(c => ({ id: c.id, objective: c.plan.objective, state: c.state, revision: c.revision, iterations_used: c.iterations.length, max_iterations: c.plan.max_iterations })); }
  files(id) { const c = this.load(id); return { campaign_id: id, revision: c.revision, snapshot_digest: c.current_baseline.snapshot_digest, files: this.snapshot(c.current_baseline.snapshot_digest).files }; }
  guard(c, revision) { if (!Number.isSafeInteger(revision) || c.revision !== revision) throw new Error("Campaign changed; reload before acting."); }
  request(operation, args, fn) {
    if (typeof args.idempotency_key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(args.idempotency_key)) throw new Error("A bounded idempotency key is required.");
    const key = experimentDigest([operation, args.id || "", args.idempotency_key]); const digest = experimentDigest(args);
    return this.store.transaction(() => {
      const prior = this.store.get(K.REQUESTS, key);
      if (prior) { if (prior.digest !== digest) throw new Error("Idempotency conflict."); return prior.result; }
      const { iterations, ...result } = fn();
      // Bounded receipts avoid copying the complete history per mutation.
      result.latest_iteration = iterations.at(-1) ?? null;
      this.store.put(K.REQUESTS, key, { digest, result }); return result;
    });
  }
  create(args) {
    const { plan, files } = args;
    if (!validateExperimentPlan(plan).ok || plan.baseline.mode !== "capture") throw new Error("A valid plan with baseline capture is required.");
    const snapshot = snapshotFiles(plan, files);
    return this.request("create", args, () => {
      this.saveSnapshot(snapshot);
      const c = { id: randomUUID(), revision: 0, plan: structuredClone(plan), state: S.BASELINE, created_at: this.now(),
        starting_baseline: { snapshot_digest: snapshot.digest, metrics: null }, current_baseline: { snapshot_digest: snapshot.digest, metrics: null },
        iterations: [], active_run: null, baseline_attempted: false };
      return this.save(c);
    });
  }
  stage(args) {
    return this.request("stage", args, () => {
      const c = this.load(args.id); this.guard(c, args.expected_revision);
      if (c.state !== S.READY || c.iterations.length >= c.plan.max_iterations) throw new Error("Campaign is not ready for another iteration.");
      if (typeof args.hypothesis !== "string" || !args.hypothesis.trim() || args.hypothesis.length > 2000) throw new Error("A bounded hypothesis is required.");
      const snapshot = snapshotFiles(c.plan, args.changes, this.snapshot(c.current_baseline.snapshot_digest).files);
      if (snapshot.digest === c.current_baseline.snapshot_digest) throw new Error("Candidate must change the accepted files.");
      this.saveSnapshot(snapshot);
      c.iterations.push({ number: c.iterations.length + 1, hypothesis: args.hypothesis, snapshot_digest: snapshot.digest,
        parent_snapshot: c.current_baseline.snapshot_digest, status: S.STAGED, metrics: null, decision: null });
      c.state = S.STAGED; return this.save(c);
    });
  }
  reserveRun(args) {
    return this.request("run", args, () => {
      const c = this.load(args.id); this.guard(c, args.expected_revision);
      const baseline = c.state === S.BASELINE;
      if (c.environment_digest && c.environment_digest !== args.environment_digest) throw new Error("Execution environment changed; start a new baseline comparison.");
      if (args.environment_digest) c.environment_digest = args.environment_digest;
      if ((!baseline && c.state !== S.STAGED) || (baseline && c.baseline_attempted)) throw new Error("No runnable test is staged.");
      const row = baseline ? c.starting_baseline : c.iterations.at(-1);
      if (args.snapshot_digest !== row.snapshot_digest) throw new Error("Candidate changed since review.");
      c.active_run = { id: randomUUID(), snapshot_digest: row.snapshot_digest, baseline, started_at: this.now(), progress: null };
      if (baseline) c.baseline_attempted = true; else row.status = S.RUNNING;
      c.state = S.RUNNING;
      return this.save(c);
    });
  }
  progress(id, runID, progress) {
    return this.store.transaction(() => {
      const c = this.load(id);
      if (c.state !== S.RUNNING || c.active_run?.id !== runID) return false;
      c.active_run.progress = progress; this.store.put(K.CAMPAIGNS, id, c); return true;
    });
  }
  // Private owner callback: deliberately not exposed as an operator/agent API.
  complete(id, runID, { metrics, evidence_digest, field_summary }) {
    return this.store.transaction(() => {
      const c = this.load(id);
      if (c.state !== S.RUNNING || c.active_run?.id !== runID) throw new Error("Run is no longer active.");
      if (!/^[a-f0-9]{64}$/.test(evidence_digest || "") || Object.keys(metrics || {}).length !== c.plan.metrics.length
        || c.plan.metrics.some(m => !Object.hasOwn(metrics, m.id) || !Number.isFinite(metrics[m.id]))) throw new Error("Complete owner-scored evidence is required.");
      const run = c.active_run; c.active_run = null;
      if (run.baseline) {
        c.starting_baseline = { ...c.starting_baseline, metrics, evidence_digest, run_id: runID, ...(field_summary ? { field_summary } : {}) };
        c.current_baseline = structuredClone(c.starting_baseline);
        const assessment = assessExperimentImprovement(c.plan, metrics, metrics);
        if (assessment.tradeoff?.valid === false) {
          c.starting_baseline.failure_reason = assessment.reason;
          c.state = S.BLOCKED;
        } else c.state = assessment.goal_reached ? S.GOAL : S.READY;
      } else {
        const row = c.iterations.at(-1);
        if (field_summary) row.field_summary = field_summary;
        row.status = "completed"; row.metrics = metrics; row.evidence_digest = evidence_digest; row.run_id = runID;
        row.assessment = assessExperimentImprovement(c.plan, c.current_baseline.metrics, metrics, c.starting_baseline.metrics);
        c.state = S.REVIEW;
        if (c.plan.acceptance?.mode === "automatic") this.applyDecision(c, row.assessment.iteration_passed ? "accept" : "reject", "automatic", row.assessment.reason);
      }
      return this.save(c);
    });
  }
  fail(id, runID, reason, cancelled = false) {
    return this.store.transaction(() => {
      const c = this.load(id);
      if (c.state !== S.RUNNING || c.active_run?.id !== runID) return this.public(c);
      const run = c.active_run; c.active_run = null;
      if (!run.baseline) Object.assign(c.iterations.at(-1), { status: cancelled ? "cancelled" : "failed", failure_reason: reason, run_id: runID });
      c.state = cancelled ? S.CANCELLED : run.baseline ? S.BLOCKED : c.iterations.length >= c.plan.max_iterations ? S.EXHAUSTED : S.READY;
      return this.save(c);
    });
  }
  applyDecision(c, decision, actor, reason) {
    const row = c.iterations.at(-1);
    if (c.state !== S.REVIEW || row.status !== "completed" || row.decision) throw new Error("No completed iteration awaits a decision.");
    if (decision === "accept") {
      if (!row.assessment.guardrails_passed) throw new Error("Cannot accept a candidate that violates guardrails.");
      this.snapshot(row.snapshot_digest);
      c.current_baseline = { snapshot_digest: row.snapshot_digest, metrics: row.metrics, evidence_digest: row.evidence_digest, run_id: row.run_id, iteration: row.number, ...(row.field_summary ? { field_summary: row.field_summary } : {}) };
    }
    row.decision = { value: decision, actor, reason, at: this.now() };
    c.state = decision === "accept" && row.assessment.goal_reached ? S.GOAL : c.iterations.length >= c.plan.max_iterations ? S.EXHAUSTED : S.READY;
  }
  decide(args) {
    if (!EXPERIMENT_DECISIONS.includes(args.decision) || typeof args.reason !== "string" || args.reason.length > 1000) throw new Error("Invalid acceptance decision.");
    return this.request("decide", args, () => {
      const c = this.load(args.id); this.guard(c, args.expected_revision);
      if (args.snapshot_digest !== c.iterations.at(-1)?.snapshot_digest) throw new Error("Decision does not match the candidate.");
      this.applyDecision(c, args.decision, "human", args.reason); return this.save(c);
    });
  }
  cancelIdle(id) {
    return this.store.transaction(() => {
      const c = this.load(id);
      if (c.active_run || [S.GOAL, S.EXHAUSTED, S.CANCELLED].includes(c.state)) return this.public(c);
      c.state = S.CANCELLED; return this.save(c);
    });
  }
}
