import { EXPERIMENT_OPERATIONS as O, EXPERIMENT_OBJECTS as K, EXPERIMENT_STATES as S } from "../../../catalog/experiments.js";
import { ExperimentCampaigns } from "./ExperimentCampaigns.js";
import { ExperimentProgress } from "./ExperimentProgress.js";
import { validateNumericEvaluation } from "../functions/evaluation.js";
import { campaignReport, campaignProgress } from "../functions/campaign-report.js";
import { ExperimentRunner } from "./ExperimentRunner.js";
import { experimentSetupContract, validateExperimentSetup } from "../functions/setup.js";
import { experimentDigest } from "../functions/snapshots.js";

import { ExperimentIntegration } from "./ExperimentIntegration.js";

export class ExperimentService {
  constructor(store, { backend = null, evaluations = {}, assertOwner = () => {}, dispatch, now, integrationWorkspace } = {}) {
    this.campaigns = new ExperimentCampaigns(store); this.backend = backend; this.evaluations = structuredClone(evaluations); this.active = new Map(); this.stopping = false; this.assertOwner = assertOwner;
    this.runner = new ExperimentRunner(this, { dispatch, now });
    this.integration = new ExperimentIntegration(this, { dispatch, now, workspace: integrationWorkspace });
  }
  async request(operation, args = {}) {
    const keys = {
      [O.SETUP_SCHEMA]: [], [O.SETUP_VALIDATE]: ["setup"], [O.LAUNCH]: ["setup", "setup_digest", "idempotency_key"], [O.STOP]: ["id"], [O.INTEGRATE]: ["id", "snapshot_digest", "integration", "idempotency_key"],
      [O.CREATE]: ["idempotency_key", "plan", "files"], [O.GET]: ["id"], [O.LIST]: [], [O.FILES]: ["id"], [O.REPORT]: ["id"], [O.PROGRESS]: ["id"],
      [O.STAGE]: ["id", "idempotency_key", "expected_revision", "changes", "hypothesis"],
      [O.RUN]: ["id", "idempotency_key", "expected_revision", "snapshot_digest"],
      [O.DECIDE]: ["id", "idempotency_key", "expected_revision", "snapshot_digest", "decision", "reason"], [O.CANCEL]: ["id", "run_id"],
    }[operation];
    if (!Array.isArray(keys) || !args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== keys.length || keys.some(key => !Object.hasOwn(args, key))) throw new Error("Invalid experiment operation arguments.");
    if (operation === O.SETUP_SCHEMA) return { ...experimentSetupContract(), runtime: { configured: !!this.backend,
      evaluations: Object.entries(this.evaluations).map(([ref, evaluation]) => ({ ref, digest: experimentDigest(evaluation), cases: evaluation.cases?.length ?? 0, scorers: evaluation.scorers || {} })) } };
    if (operation === O.SETUP_VALIDATE) return validateExperimentSetup(args.setup);
    if (operation === O.LAUNCH) return this.runner.launch(args);
    if (operation === O.INTEGRATE) return this.integration.launch(args);
    if (operation === O.STOP) { await this.integration.stop(args.id); return { ...(this.runner.load(args.id) ? await this.runner.stop(args.id) : { id: args.id }), integration: this.integration.status(args.id) }; }
    if (operation === O.CREATE) return this.campaigns.create(args);
    if (operation === O.GET) return this.campaigns.get(args.id);
    if (operation === O.LIST) return this.campaigns.list().map(c => ({ ...c, runner: this.runner.status(c.id), integration: this.integration.status(c.id) }));
    if (operation === O.FILES) return this.campaigns.files(args.id);
    if (operation === O.REPORT) return { ...campaignReport(this.campaigns.load(args.id)), runner: this.runner.status(args.id), integration: this.integration.status(args.id) };
    if (operation === O.PROGRESS) return { ...campaignProgress(this.campaigns.load(args.id)), runner: this.runner.status(args.id), integration: this.integration.status(args.id) };
    if (operation === O.STAGE) return this.campaigns.stage(args);
    if (operation === O.DECIDE) { const result = this.campaigns.decide(args); this.runner.resume(args.id); return result; }
    if (operation === O.RUN) return this.run(args);
    const active = this.active.get(args.id);
    if (!active || active.runID !== args.run_id) throw new Error("No matching active experiment run.");
    active.controller.abort(); await active.promise; return this.campaigns.get(args.id);
  }
  async run(args) {
    if (this.stopping || !this.backend) throw new Error("Experiment execution backend is unavailable.");
    const before = this.campaigns.load(args.id);
    const evaluation = validateNumericEvaluation(before.plan, this.evaluations[before.plan.evaluation.ref]);
    await this.backend.preflight(before.plan);
    this.assertOwner();
    if (this.stopping) throw new Error("Experiment owner is stopping.");
    // One sandbox per owner, including unresolved runs after a crash.
    if (this.campaigns.store.list(K.CAMPAIGNS).some(c => c.active_run && c.id !== args.id)) throw new Error("Another experiment run needs to finish or be reconciled.");
    const receipt = this.campaigns.reserveRun({ ...args, ...(this.backend.fingerprint ? { environment_digest: this.backend.fingerprint(before.plan) } : {}) });
    const c = this.campaigns.load(args.id);
    // An idempotent replay after completion returns its receipt, never reruns.
    if (c.active_run?.id !== receipt.active_run?.id || c.state !== S.RUNNING || this.active.has(c.id)) return receipt;
    const run = c.active_run; const controller = new AbortController();
    const progress = new ExperimentProgress({ plan: c.plan, runId: run.id, baseline: c.current_baseline.metrics || {}, total: evaluation.cases.length });
    const publish = () => { this.assertOwner(); return this.campaigns.progress(c.id, run.id, progress.snapshot()); };
    const task = { controller, runID: run.id, promise: null };
    this.active.set(c.id, task);
    progress.start(publish, () => controller.abort());
    task.promise = Promise.resolve().then(async () => {
      try {
        const result = await this.backend.run({ runId: run.id, plan: c.plan, files: this.campaigns.snapshot(run.snapshot_digest).files, evaluation,
          signal: controller.signal, onObservation: observation => progress.observe({ ...observation, run_id: run.id }) });
        if (controller.signal.aborted) throw new Error("cancelled");
        this.assertOwner();
        const snapshot = progress.snapshot();
        if (snapshot.completed !== evaluation.cases.length) throw new Error("incomplete_evidence");
        this.campaigns.complete(c.id, run.id, { metrics: Object.fromEntries(snapshot.metrics.map(m => [m.id, m.current])), evidence_digest: result.evidence_digest });
      } catch (error) {
        // Guest diagnostics must not leak private host paths or become policy.
        if (!error.cleanupUnconfirmed) {
          try { this.assertOwner(); this.campaigns.fail(c.id, run.id, controller.signal.aborted ? "cancelled" : "execution_failed", controller.signal.aborted); }
          catch { /* A replacement owner reconciles the durable reservation. */ }
        }
      } finally { progress.stop(); this.active.delete(c.id); }
    });
    return receipt;
  }
  async recover() {
    this.runner.recover();
    await this.integration.recover();
    for (const c of this.campaigns.store.list(K.CAMPAIGNS)) {
      if (!c.active_run) continue;
      // Never reset the allowance or infer completion from an orphan's output.
      if (!this.backend || !await this.backend.cleanup(c.active_run.id).then(() => true, () => false)) continue;
      this.assertOwner();
      this.campaigns.fail(c.id, c.active_run.id, "owner_interrupted");
    }
    // Close a crash window between terminal runner persistence and handoff.
    for (const record of this.campaigns.store.list(K.RUNNERS)) this.runner.integrate(record);
  }
  async shutdown() { this.stopping = true; await this.runner.shutdown(); await this.integration.shutdown(); for (const task of this.active.values()) task.controller.abort(); await Promise.all([...this.active.values()].map(task => task.promise)); }
  activeCount() { return new Set([...this.runner.active.keys(), ...[...this.integration.active.values()].map(t => t.campaignID), ...this.campaigns.store.list(K.CAMPAIGNS).filter(c => c.active_run).map(c => c.id)]).size; }
}
