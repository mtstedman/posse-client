import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";

let dbMod;
let queueMod;
let PreflightRole;
let Worker;
let buildClaudeCliToolConfig;
let buildExecutionContract;
let getResearchFanoutMode;
let createResearchFanoutJobs;
let synthBudgetForResearchFanout;
let spawnResearchAfterPreflight;
let spawnPlanAfterResearch;
let parsePreflightRoutingDecision;
let setActivePromptBundleForTest;
let resetActivePromptBundleForTest;
let runtimeDir;
let runtimeDbPath;

const TEST_PROMPT_BUNDLE = {
  schema_version: 1,
  prompt_version: "preflight-role-test",
  roles: {
    researcher: { markdown: "Researcher role prompt." },
    planner: { markdown: "Planner role prompt." },
    dev: { markdown: "Developer role prompt." },
    assessor: { markdown: "Assessor role prompt." },
    artificer: { markdown: "Artificer role prompt." },
    delegator: { markdown: "Delegator role prompt." },
    preflight: { markdown: "Preflight Routing\nReturn strict JSON for the next routing step." },
  },
};

function resetRuntimeDb() {
  dbMod.closeDb();
  try { fs.rmSync(runtimeDbPath, { force: true }); } catch {}
  dbMod.getDb();
}

describe("preflight role", () => {
  before(async () => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-preflight-role-"));
    runtimeDbPath = path.join(runtimeDir, "orchestrator.db");
    setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });

    dbMod = await import("../lib/shared/storage/functions/index.js");
    queueMod = await import("../lib/domains/queue/functions/index.js");
    ({ PreflightRole } = await import("../lib/domains/worker/classes/roles/preflight.js"));
    ({ Worker } = await import("../lib/domains/worker/classes/Worker.js"));
    ({ buildClaudeCliToolConfig, buildExecutionContract } = await import("../lib/functions/tools/contract.js"));
    ({ createResearchFanoutJobs, getResearchFanoutMode, synthBudgetForResearchFanout } = await import("../lib/domains/research/functions/fanout.js"));
    ({ spawnResearchAfterPreflight, spawnPlanAfterResearch, parsePreflightRoutingDecision } = await import("../lib/domains/worker/functions/helpers/pipeline-continuation.js"));
    ({ setActivePromptBundleForTest, resetActivePromptBundleForTest } = await import("../lib/domains/remote/functions/prompt-bundle.js"));
    setActivePromptBundleForTest(TEST_PROMPT_BUNDLE);
    resetRuntimeDb();
  });

  beforeEach(() => {
    resetRuntimeDb();
    queueMod.setSetting("research_fanout", "off");
  });

  after(() => {
    if (dbMod) dbMod.closeDb();
    if (resetActivePromptBundleForTest) resetActivePromptBundleForTest();
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
    setRuntimePathOverridesForTests(null);
  });

  it("registers as a cheap toolless provider role", async () => {
    queueMod.setSetting("provider_preflight", "openai");
    const wi = queueMod.createWorkItem("Diagnose auth queue drift", "Figure out why auth, queue, and worker behavior interact oddly.", "normal", {
      metadata: { intake_hints: { suspected_dirs: ["lib/auth", "lib/queue"] } },
    });
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "preflight",
      title: "Preflight: Diagnose auth queue drift",
      model_tier: "cheap",
      reasoning_effort: "low",
      payload_json: JSON.stringify({
        fallback_budget: "normal",
        routing: { bucket: "ambiguous", budget: "high", reason: "unclear scope" },
      }),
    });

    let captured;
    const role = new PreflightRole({
      context: { projectDir: runtimeDir },
      providerClient: {
        call: async (prompt, opts, meta) => {
          captured = { prompt, opts, meta };
          return { output: '{"mode":"solo","budget":"high","branches":[]}', stats: {} };
        },
      },
    });

    const output = await role.run(job, { tier: "cheap", attemptId: 7 });

    assert.equal(output, '{"mode":"solo","budget":"high","branches":[]}');
    assert.equal(role.getRole(), "preflight");
    assert.equal(role.hasCustomRun(), false);
    assert.equal(typeof role.assembleContext, "function");
    assert.equal(typeof role.buildContract, "function");
    assert.equal(typeof role.composePrompt, "function");
    assert.equal(typeof role.processOutput, "function");
    assert.equal(role.canSpawn("research", "succeeded"), false);
    assert.match(captured.prompt, /Preflight Routing/);
    assert.match(captured.prompt, /PRE-FLIGHT ROUTING CONTEXT/);
    assert.match(captured.prompt, /Project map:/);
    assert.equal(captured.opts.role, "preflight");
    assert.equal(captured.opts.allowWrite, false);
    assert.equal(captured.opts.modelTier, "cheap");
    assert.equal(captured.opts.reasoningEffort, "low");
    assert.equal(captured.opts.maxTurns, 2);
    assert.equal(captured.opts.skipRolePrompt, true);
    assert.equal(captured.meta.cwd, runtimeDir);
    assert.equal(captured.meta.jobProvider, "openai");
  });

  it("keeps preflight out of runtime tools", () => {
    const contract = buildExecutionContract({ role: "preflight", allowWrite: false });
    assert.deepEqual(contract.tools, []);

    const cliTools = buildClaudeCliToolConfig(contract);
    assert.equal(cliTools.tools, "");
    assert.match(cliTools.disallowedTools, /Read/);
    assert.equal(cliTools.dangerouslySkipPermissions, true);
  });

  it("normalizes the research fanout setting", () => {
    assert.equal(getResearchFanoutMode(null, { getSettingFn: () => null }), "off");
    assert.equal(getResearchFanoutMode(null, { getSettingFn: () => "shadow" }), "shadow");
    assert.equal(getResearchFanoutMode(null, { getSettingFn: () => "on" }), "on");
    assert.equal(getResearchFanoutMode(null, { getSettingFn: () => "maybe" }), "off");
    assert.equal(getResearchFanoutMode(null, { getSettingFn: () => { throw new Error("settings unavailable"); } }), "off");
  });

  it("maps fanout synthesis budget by one proportional tier", () => {
    assert.deepEqual(
      ["low", "normal", "high", "xhigh"].map((budget) => [budget, synthBudgetForResearchFanout(budget, [
        { label: "queue", scope_hints: ["lib/queue"] },
        { label: "worker", scope_hints: ["lib/worker"] },
        { label: "provider", scope_hints: ["lib/provider"] },
      ])]),
      [
        ["low", "normal"],
        ["normal", "high"],
        ["high", "high"],
        ["xhigh", "xhigh"],
      ],
    );
  });

  it("keeps two-branch fanout synthesis at the original budget", () => {
    const wi = queueMod.createWorkItem("Two branch fanout", "Audit queue and worker wording.");

    const fanout = createResearchFanoutJobs({
      workItem: wi,
      branches: [
        { label: "queue", scope_hints: ["lib/queue.js"] },
        { label: "worker", scope_hints: ["lib/worker"] },
      ],
      budget: "low",
      mode: "on",
      source: "unit",
    });

    assert.equal(fanout.childJobs.length, 2);
    assert.equal(fanout.synthBudget, "low");
    assert.equal(fanout.synthJob.reasoning_effort, "low");
    const synthPayload = JSON.parse(fanout.synthJob.payload_json);
    assert.equal(synthPayload.deepthink_budget, "low");
    assert.equal(synthPayload.deepthink, false);
  });

  it("bumps three-branch low-budget fanout synthesis to normal effort", () => {
    const wi = queueMod.createWorkItem("Low fanout", "Audit queue and worker wording.");

    const fanout = createResearchFanoutJobs({
      workItem: wi,
      branches: [
        { label: "queue", scope_hints: ["lib/queue.js"] },
        { label: "worker", scope_hints: ["lib/worker"] },
        { label: "provider", scope_hints: ["lib/provider"] },
      ],
      budget: "low",
      mode: "on",
      source: "unit",
    });

    assert.equal(fanout.childJobs.length, 3);
    assert.equal(fanout.synthBudget, "normal");
    assert.equal(fanout.synthJob.reasoning_effort, "medium");
    for (const childJob of fanout.childJobs) {
      assert.equal(childJob.reasoning_effort, "low");
      assert.equal(JSON.parse(childJob.payload_json).deepthink_budget, "low");
    }
    const synthPayload = JSON.parse(fanout.synthJob.payload_json);
    assert.equal(synthPayload.deepthink_budget, "normal");
    assert.equal(synthPayload.deepthink, false);
  });

  it("spawns a single research job from a fanout-clear preflight decision", () => {
    const wi = queueMod.createWorkItem("Audit queue worker provider", "Review all three modules.");
    const preflightJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "preflight",
      title: "Preflight: Audit queue worker provider",
      priority: "high",
      model_tier: "cheap",
      reasoning_effort: "low",
      payload_json: JSON.stringify({
        fallback_budget: "low",
        routing: { bucket: "ambiguous", budget: "normal", reason: "unclear module split" },
      }),
    });
    const worker = {
      parsePayload(job) {
        return JSON.parse(job.payload_json || "{}");
      },
      emit() {},
    };

    const researchJob = spawnResearchAfterPreflight(worker, preflightJob, JSON.stringify({
      mode: "fanout_clear",
      budget: "high",
      reason: "modules are independent",
      branches: [
        { label: "queue", scope_hints: ["lib/queue.js"] },
        { label: "worker", scope_hints: ["lib/worker"] },
        { label: "provider", scope_hints: ["lib/provider"] },
      ],
    }));

    assert.equal(researchJob.job_type, "research");
    assert.equal(researchJob.parent_job_id, preflightJob.id);
    assert.equal(researchJob.priority, "high");
    assert.equal(researchJob.reasoning_effort, "high");
    const payload = JSON.parse(researchJob.payload_json);
    assert.equal(payload.deepthink_budget, "high");
    assert.equal(payload.preflight_job_id, preflightJob.id);
    assert.equal(payload.preflight_mode, "fanout_clear");
    assert.deepEqual(payload.preflight_branches.map((branch) => branch.label), ["queue", "worker", "provider"]);

    const events = queueMod.getEventsByWorkItem(wi.id, 20);
    assert.ok(events.some((event) => event.event_type === "preflight.routed" && event.actor_type === "preflight"));
    const fanoutEvent = events.find((event) => event.event_type === "research.fanout_skipped" && event.actor_type === "preflight");
    assert.ok(fanoutEvent);
    const fanoutJson = JSON.parse(fanoutEvent.event_json);
    assert.equal(fanoutJson.version, 1);
    assert.equal(fanoutJson.actual_budget, "high");
  });

  it("runs preflight fanout in shadow beside the solo researcher", () => {
    queueMod.setSetting("research_fanout", "shadow");
    const wi = queueMod.createWorkItem("Audit queue worker provider", "Review all three modules.");
    const preflightJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "preflight",
      title: "Preflight: Audit queue worker provider",
      priority: "high",
      model_tier: "cheap",
      reasoning_effort: "low",
      payload_json: JSON.stringify({ fallback_budget: "normal" }),
    });
    const worker = { parsePayload: (job) => JSON.parse(job.payload_json || "{}"), emit() {} };

    const primary = spawnResearchAfterPreflight(worker, preflightJob, JSON.stringify({
      mode: "fanout_clear",
      budget: "high",
      reason: "modules are independent",
      branches: [
        { label: "queue", scope_hints: ["lib/queue.js"] },
        { label: "worker", scope_hints: ["lib/worker"] },
        { label: "provider", scope_hints: ["lib/provider"] },
      ],
    }));

    const researchJobs = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.job_type === "research");
    const payloads = researchJobs.map((job) => ({ job, payload: JSON.parse(job.payload_json || "{}") }));
    const children = payloads.filter(({ payload }) => payload.role_mode === "child");
    const synth = payloads.find(({ payload }) => payload.role_mode === "synth");
    const solo = payloads.find(({ payload }) => !payload.role_mode);

    assert.equal(researchJobs.length, 5);
    assert.equal(primary.id, solo.job.id);
    assert.equal(children.length, 3);
    assert.equal(synth.payload.fanout_shadow, true);
    assert.equal(synth.payload.solo_job_id, solo.job.id);
    assert.deepEqual(queueMod.getDependencies(synth.job.id).map((dep) => dep.depends_on_job_id).sort((a, b) => a - b), children.map(({ job }) => job.id).sort((a, b) => a - b));

    const events = queueMod.getEventsByWorkItem(wi.id, 20);
    assert.ok(events.some((event) => event.event_type === "research.fanout_shadowed"));
    const routed = events.find((event) => event.event_type === "preflight.routed");
    assert.equal(JSON.parse(routed.event_json).fanout_execution, "shadow");
  });

  it("uses active preflight fanout synthesis as the live research path", () => {
    queueMod.setSetting("research_fanout", "on");
    const wi = queueMod.createWorkItem("Audit queue worker provider", "Review all three modules.");
    const preflightJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "preflight",
      title: "Preflight: Audit queue worker provider",
      priority: "high",
      model_tier: "cheap",
      reasoning_effort: "low",
      payload_json: JSON.stringify({ fallback_budget: "normal" }),
    });
    const worker = { parsePayload: (job) => JSON.parse(job.payload_json || "{}"), emit() {} };

    const primary = spawnResearchAfterPreflight(worker, preflightJob, JSON.stringify({
      mode: "fanout_clear",
      budget: "high",
      branches: [
        { label: "queue", scope_hints: ["lib/queue.js"] },
        { label: "worker", scope_hints: ["lib/worker"] },
        { label: "provider", scope_hints: ["lib/provider"] },
      ],
    }));

    const researchJobs = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.job_type === "research");
    const payloads = researchJobs.map((job) => ({ job, payload: JSON.parse(job.payload_json || "{}") }));
    const children = payloads.filter(({ payload }) => payload.role_mode === "child");
    const synth = payloads.find(({ payload }) => payload.role_mode === "synth");

    assert.equal(researchJobs.length, 4);
    assert.equal(primary.id, synth.job.id);
    assert.equal(children.length, 3);
    assert.equal(synth.payload.fanout_shadow, false);
    assert.deepEqual(queueMod.getDependencies(synth.job.id).map((dep) => dep.depends_on_job_id).sort((a, b) => a - b), children.map(({ job }) => job.id).sort((a, b) => a - b));
    assert.ok(queueMod.getEventsByWorkItem(wi.id, 20).some((event) => event.event_type === "research.fanout_started"));
  });

  it("keeps fanout children and shadow synthesis off the downstream planner path", () => {
    const wi = queueMod.createWorkItem("Audit queue worker provider", "Review all three modules.");
    const worker = { parsePayload: (job) => JSON.parse(job.payload_json || "{}"), emit() {} };
    const child = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research (queue): Audit queue worker provider",
      payload_json: JSON.stringify({
        role_mode: "child",
        fanout_mode: "on",
        fanout_run_id: "fanout-test",
        fanout_branch: { label: "queue", scope_hints: ["lib/queue.js"] },
        deepthink_budget: "normal",
      }),
    });
    const shadowSynth = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research synthesis: Audit queue worker provider",
      payload_json: JSON.stringify({
        role_mode: "synth",
        fanout_mode: "shadow",
        fanout_shadow: true,
        fanout_run_id: "fanout-test",
        child_job_ids: [child.id],
        deepthink_budget: "high",
      }),
    });
    const activeSynth = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research synthesis: Audit queue worker provider",
      payload_json: JSON.stringify({
        role_mode: "synth",
        fanout_mode: "on",
        fanout_shadow: false,
        fanout_run_id: "fanout-test-2",
        child_job_ids: [child.id],
        deepthink_budget: "high",
      }),
    });

    spawnPlanAfterResearch(worker, child, "child brief");
    spawnPlanAfterResearch(worker, shadowSynth, "shadow synthesis");
    assert.equal(queueMod.listJobsByWorkItem(wi.id).filter((job) => job.job_type === "plan").length, 0);

    spawnPlanAfterResearch(worker, activeSynth, "active synthesis cites lib/queue.js:12 and https://docs.example.test/queue\nQuestions for Human\nQuestion: should not block fanout synth");
    const plans = queueMod.listJobsByWorkItem(wi.id).filter((job) => job.job_type === "plan");
    assert.equal(plans.length, 1);
    assert.equal(plans[0].parent_job_id, activeSynth.id);
    const synthEvent = queueMod.getEventsByWorkItem(wi.id, 20).find((event) => event.event_type === "research.fanout_synth_completed" && event.job_id === activeSynth.id);
    const synthJson = JSON.parse(synthEvent.event_json);
    assert.equal(synthJson.line_ref_count, 1);
    assert.equal(synthJson.url_citation_count, 1);
  });

  it("preserves preflight web branch kind and URL scope hints", () => {
    const decision = parsePreflightRoutingDecision(JSON.stringify({
      mode: "fanout_clear",
      budget: "normal",
      branches: [
        { label: "openai", kind: "web", scope_hints: ["platform.openai.com"] },
        { label: "anthropic", kind: "web", scope_hints: ["docs.anthropic.com"] },
      ],
    }));

    assert.equal(decision.mode, "fanout_clear");
    assert.deepEqual(decision.branches.map((branch) => branch.kind), ["web", "web"]);
    assert.deepEqual(decision.branches.map((branch) => branch.scope_hints[0]), ["platform.openai.com", "docs.anthropic.com"]);
  });

  it("does not let failed shadow fanout jobs block work item completion", () => {
    const wi = queueMod.createWorkItem("Audit queue worker provider", "Review all three modules.");
    const solo = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: Audit queue worker provider",
      payload_json: JSON.stringify({ deepthink_budget: "normal" }),
    });
    const shadowChild = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research (queue): Audit queue worker provider",
      payload_json: JSON.stringify({
        role_mode: "child",
        fanout_mode: "shadow",
        fanout_shadow: true,
        fanout_run_id: "fanout-shadow",
      }),
    });
    queueMod.updateJobStatus(solo.id, "succeeded");
    queueMod.updateJobStatus(shadowChild.id, "dead_letter");

    assert.equal(queueMod.refreshWorkItemStatus(wi.id), "complete");
    assert.equal(queueMod.getWorkItem(wi.id).status, "complete");
  });

  it("worker registry exposes preflight under the preflight job type", () => {
    const worker = new Worker({
      projectDir: runtimeDir,
      silent: true,
      providerClient: {
        call: async () => ({ output: '{"mode":"solo","budget":"normal","branches":[]}', stats: {} }),
      },
    });

    assert.equal(worker.roleRegistry.get("preflight").getRole(), "preflight");
  });
});
