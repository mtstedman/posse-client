import {
  it,
  beforeEach,
  assert,
  path,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  withEnv,
  dispatchWorker,
  makeWorker,
} from "../support/core-harness.js";

let db;

suite("Delegator repair normalization", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("prefers deterministic multi-provider routing over repaired delegator output", async () => {
    const { queueMod, workerMod } = runtimeModules;
    const previousClaudeSessionLimit = queueMod.getSetting("claude_limit_tokens_session");
    const previousClaudeWeekLimit = queueMod.getSetting("claude_limit_tokens_week");
    const previousClaudeObservedSession = queueMod.getSetting("claude_observed_pct_session");
    const previousClaudeObservedWeek = queueMod.getSetting("claude_observed_pct_week");
    const previousDelegationMode = queueMod.getSetting("delegation_mode");
    const previousProviderDev = queueMod.getSetting("provider_dev");
    const wi = queueMod.createWorkItem("Delegator repair", "desc");
    const target = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Dev target",
      model_tier: "cheap",
    });
    const delegatorJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "delegate",
      title: "Delegate providers",
      payload_json: JSON.stringify({
        pending_jobs: [{ job_id: target.id, title: target.title, job_type: target.job_type }],
        provider_map: { dev: ["claude", "openai"], assessor: ["claude"] },
      }),
    });

    const worker = makeWorker(workerMod, {
      projectDir: path.resolve(__dirname, ".."),
      silent: true,
    }, async () => ({ output: "not json" }));
    queueMod.setSetting("claude_limit_tokens_session", null);
    queueMod.setSetting("claude_limit_tokens_week", null);
    queueMod.setSetting("claude_observed_pct_session", null);
    queueMod.setSetting("claude_observed_pct_week", null);
    queueMod.setSetting("delegation_mode", "js");
    queueMod.setSetting("provider_dev", "claude,openai");
    try {
      await withEnv({ OPENAI_API_KEY: "test-key" }, async () => {
        worker.repairJson = async () => ({
          assignments: [
            { job_id: target.id, provider: "codex", model_tier: "standard", reason: "faster fit" },
          ],
        });

        await dispatchWorker(worker, delegatorJob, "cheap", null);
        const refreshed = queueMod.getJob(target.id);
        assert.equal(["claude", "openai"].includes(refreshed.provider), true);
        assert.equal(refreshed.model_tier, "cheap");
      });
    } finally {
      queueMod.setSetting("claude_limit_tokens_session", previousClaudeSessionLimit);
      queueMod.setSetting("claude_limit_tokens_week", previousClaudeWeekLimit);
      queueMod.setSetting("claude_observed_pct_session", previousClaudeObservedSession);
      queueMod.setSetting("claude_observed_pct_week", previousClaudeObservedWeek);
      queueMod.setSetting("delegation_mode", previousDelegationMode ?? "js");
      queueMod.setSetting("provider_dev", previousProviderDev ?? "claude");
    }
  });
});
