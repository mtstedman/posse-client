import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";

let dbMod;
let queueMod;
let ResearcherRole;
let resetAtlasRuntimeDisabledForTests;
let runtimeDir;
let runtimeDbPath;

function resetRuntimeDb() {
  dbMod.closeDb();
  try { fs.rmSync(runtimeDbPath, { force: true }); } catch {}
  dbMod.getDb();
}

function createRemoteComposerForTest(calls = []) {
  return {
    composePrompt: async (packet, instructions) => {
      calls.push({ packet, instructions });
      return {
        prompt: `REMOTE SYSTEM\n\nREMOTE STABLE\n\nREMOTE USER\n${instructions}`,
        systemPrompt: "REMOTE SYSTEM",
        stableContext: "REMOTE STABLE",
        userPrompt: `REMOTE USER\n${instructions}`,
        latencyMs: 1,
        metadata: { prompt_version: "test" },
        response: {
          prompt_version: "test",
          system_prompt: "REMOTE SYSTEM",
          stable_context: "REMOTE STABLE",
          user_prompt: `REMOTE USER\n${instructions}`,
          metadata: { prompt_chars: String(instructions || "").length },
        },
      };
    },
  };
}

describe("ResearcherRole", () => {
  before(async () => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-researcher-role-"));
    runtimeDbPath = path.join(runtimeDir, "orchestrator.db");
    setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });

    dbMod = await import("../lib/shared/storage/functions/index.js");
    queueMod = await import("../lib/domains/queue/functions/index.js");
    const atlasConfigMod = await import("../lib/domains/integrations/functions/atlas/config.js");
    atlasConfigMod.disableAtlasForRun("researcher-role-unit-test");
    resetAtlasRuntimeDisabledForTests = atlasConfigMod.__resetAtlasRuntimeDisabledForTests;
    ({ ResearcherRole } = await import("../lib/domains/worker/classes/roles/researcher.js"));
    resetRuntimeDb();
  });

  beforeEach(() => {
    resetRuntimeDb();
  });

  after(() => {
    if (dbMod) dbMod.closeDb();
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
    if (resetAtlasRuntimeDisabledForTests) resetAtlasRuntimeDisabledForTests();
    setRuntimePathOverridesForTests(null);
  });

  it("instructs researchers to synthesize before exhausting turn budget", () => {
    const role = new ResearcherRole({
      providerClient: { call: async () => ({ output: "", stats: {} }) },
    });
    const contract = role.buildContract();

    assert.match(contract, /Do not spend the whole turn budget on discovery/);
    assert.match(contract, /synthesize after 8-12 meaningful repo tool calls/);
    assert.match(contract, /partial but evidence-backed brief/i);
    assert.match(contract, /stop_reason/);
  });

  it("runs through the BaseRole template with injected provider and role identity", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-research-project-"));
    try {
      fs.writeFileSync(path.join(projectDir, "README.md"), "# Test project\n", "utf-8");
      const wi = queueMod.createWorkItem("Research role WI", "Understand the repo shape", "normal", {
        metadata: { deepthink: true },
      });
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: "Research: repo shape",
        model_tier: "cheap",
        provider: "openai",
        payload_json: { task_spec: "Map the important files" },
      });
      const lease = queueMod.acquireLease(job.id, "test-worker", 900);
      const { attempt } = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "researcher", null, "medium");
      const calls = [];
      const emitted = [];
      const remoteCalls = [];
      const providerClient = {
        call: async (prompt, opts, meta) => {
          calls.push({ prompt, opts, meta });
          return { output: "Research summary\nSecond line", stats: { inputTokens: 10 } };
        },
      };
      const role = new ResearcherRole({
        providerClient,
        context: {
          projectDir,
          parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
          emit: (jobId, message) => emitted.push({ jobId, message }),
        },
        deps: {
          remoteComposer: createRemoteComposerForTest(remoteCalls),
          isDeepthinkTask: () => true,
          loadNudges: () => "NUDGE: stay focused",
          shortJobTitle: (row) => row.title,
        },
      });

      const output = await role.run(job, { tier: "cheap", attemptId: attempt.id });

      assert.equal(role.getRole(), "researcher");
      assert.equal(role.hasCustomRun(), false);
      assert.equal(output, "Research summary\nSecond line");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].opts.role, "researcher");
      assert.equal(calls[0].opts.roleMode, "solo");
      assert.equal(calls[0].opts.modelTier, "cheap");
      assert.equal(calls[0].opts.deepthink, true);
      assert.equal(calls[0].opts.skipRolePrompt, true);
      assert.equal(calls[0].opts.remoteSystemPrompt, "REMOTE SYSTEM");
      assert.equal(calls[0].opts.stableContext, "REMOTE STABLE");
      assert.equal(calls[0].meta.jobProvider, "openai");
      assert.equal(calls[0].meta.cwd, projectDir);
      assert.equal(remoteCalls.length, 1);
      assert.equal(remoteCalls[0].packet.recipient, "researcher");
      assert.match(remoteCalls[0].instructions, /Return your findings in the required researcher output format/);
      assert.match(remoteCalls[0].instructions, /Do not spend the whole turn budget on discovery/);
      assert.match(calls[0].prompt, /WORK ITEM \(literal JSON string\):\n"Research role WI"/);
      assert.match(calls[0].prompt, /NUDGE: stay focused/);

      const stored = queueMod.getArtifacts(job.id, "summary");
      assert.equal(stored.length, 1);
      assert.equal(stored[0].attempt_id, attempt.id);
      assert.equal(stored[0].content_long, "Research summary\nSecond line");
      assert.ok(emitted.some((entry) => entry.jobId === job.id && entry.message.includes("[researcher]")));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("passes the xhigh max-turn override to the provider call", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-research-xhigh-"));
    try {
      fs.writeFileSync(path.join(projectDir, "README.md"), "# Test project\n", "utf-8");
      const wi = queueMod.createWorkItem("Xhigh research", "Deeply inspect the repo", "normal", {
        metadata: { deepthink_budget: "normal" },
      });
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: "Research: xhigh",
        model_tier: "standard",
        provider: "openai",
        payload_json: { deepthink_budget: "xhigh" },
      });
      const lease = queueMod.acquireLease(job.id, "test-worker", 900);
      const { attempt } = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "researcher", null, "high");
      const calls = [];
      const role = new ResearcherRole({
        providerClient: {
          call: async (prompt, opts, meta) => {
            calls.push({ prompt, opts, meta });
            return { output: "Xhigh summary", stats: { inputTokens: 10 } };
          },
        },
        context: {
          projectDir,
          parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
        },
        deps: {
          remoteComposer: createRemoteComposerForTest(),
        },
      });

      await role.run(job, { tier: "standard", attemptId: attempt.id });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].opts.reasoningEffort, "high");
      assert.equal(calls[0].opts.deepthink, true);
      assert.equal(calls[0].opts.maxTurns, 46);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("halves the xhigh max-turn override for scoped fanout children", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-research-xhigh-child-"));
    try {
      fs.writeFileSync(path.join(projectDir, "README.md"), "# Test project\n", "utf-8");
      const wi = queueMod.createWorkItem("Research child", "Inspect one branch", "normal");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: "Research (queue): xhigh",
        model_tier: "standard",
        provider: "openai",
        payload_json: {
          role_mode: "child",
          fanout_run_id: "fanout-xhigh-child",
          fanout_branch: { label: "queue", scope_hints: ["lib/queue.js"] },
          deepthink_budget: "xhigh",
        },
      });
      const lease = queueMod.acquireLease(job.id, "test-worker", 900);
      const { attempt } = queueMod.incrementAndCreateAttempt(job.id, lease.leaseToken, "researcher", null, "high");
      const calls = [];
      const role = new ResearcherRole({
        providerClient: {
          call: async (prompt, opts, meta) => {
            calls.push({ prompt, opts, meta });
            return { output: "Child summary", stats: { inputTokens: 10 } };
          },
        },
        context: {
          projectDir,
          parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
        },
        deps: {
          remoteComposer: createRemoteComposerForTest(),
        },
      });

      await role.run(job, { tier: "standard", attemptId: attempt.id });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].opts.roleMode, "child");
      assert.equal(calls[0].opts.maxTurns, 24);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("adds web budget guidance to fanout child context", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-research-child-"));
    try {
      fs.mkdirSync(path.join(projectDir, "lib"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "README.md"), "# Test project\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "lib", "queue.js"), "export const queue = true;\n", "utf-8");
      const wi = queueMod.createWorkItem("Fanout child", "Inspect queue branch.", "normal");
      const child = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: "Research (queue): Fanout child",
        payload_json: {
          role_mode: "child",
          fanout_run_id: "fanout-child-guidance",
          fanout_branch: { label: "queue", scope_hints: ["lib/queue.js"] },
          deepthink_budget: "normal",
        },
      });
      const role = new ResearcherRole({
        providerClient: { call: async () => ({ output: "", stats: {} }) },
        context: {
          projectDir,
          parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
        },
      });

      const context = await role.assembleContext(child, { tier: "standard", attemptId: 1 });

      assert.match(context, /RESEARCH FANOUT CHILD MODE:/);
      assert.match(context, /Branch: queue/);
      assert.match(context, /WebSearch for discovery first/);
      assert.match(context, /WebSearch to at most 2 queries/);
      assert.match(context, /WebFetch to at most 3 URLs/);
      assert.match(context, /if you exceed either cap/);
      assert.match(context, /naming the prior query or URL/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("uses web-specific fanout child guidance for web branches", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-research-web-child-"));
    try {
      fs.writeFileSync(path.join(projectDir, "README.md"), "# Test project\n", "utf-8");
      const wi = queueMod.createWorkItem("Fanout web child", "Compare vendor docs.", "normal");
      const child = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: "Research (openai): Fanout web child",
        payload_json: {
          role_mode: "child",
          fanout_run_id: "fanout-web-child",
          fanout_branch: { label: "openai", kind: "web", scope_hints: ["platform.openai.com"] },
          deepthink_budget: "normal",
        },
      });
      const role = new ResearcherRole({
        providerClient: { call: async () => ({ output: "", stats: {} }) },
        context: {
          projectDir,
          parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
        },
      });

      const context = await role.assembleContext(child, { tier: "standard", attemptId: 1 });

      assert.match(context, /Branch kind: web/);
      assert.match(context, /domains, URLs, or vendor documentation/);
      assert.match(context, /Domain\/URL hints:/);
      assert.match(context, /platform\.openai\.com/);
      assert.match(context, /Emit exact URLs/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("adds compact web-only answer context and lower max turns", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-research-web-only-"));
    try {
      fs.writeFileSync(path.join(projectDir, "README.md"), "# Test project\n", "utf-8");
      const wi = queueMod.createWorkItem("Latest OpenAI model", "What is the latest OpenAI API model?", "normal");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: "Research: Latest OpenAI model",
        payload_json: {
          web_only_answer: true,
          web_scope_hints: ["platform.openai.com"],
          deepthink_budget: "normal",
        },
      });
      const role = new ResearcherRole({
        providerClient: { call: async () => ({ output: "", stats: {} }) },
        context: {
          projectDir,
          parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
        },
      });

      const ctx = { tier: "standard", attemptId: 1 };
      const context = await role.assembleContext(job, ctx);
      const opts = role.buildOpts(job, ctx);

      assert.match(context, /WEB-ONLY ANSWER MODE:/);
      assert.match(context, /platform\.openai\.com/);
      assert.doesNotMatch(context, /PIPELINE ROUTING CONTEXT/);
      assert.equal(opts.maxTurns, 8);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("caches fetched URLs as work-item artifacts and preloads them for later research", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-research-web-cache-"));
    try {
      fs.writeFileSync(path.join(projectDir, "README.md"), "# Test project\n", "utf-8");
      const wi = queueMod.createWorkItem("Cache docs", "Research docs once.", "normal");
      const first = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: "Research: Cache docs",
        payload_json: { deepthink_budget: "normal" },
      });
      dbMod.getDb().prepare(`
        INSERT INTO job_observations (work_item_id, job_id, observation_type, summary, detail_json)
        VALUES (?, ?, 'tool.web_fetch', 'WebFetch', ?)
      `).run(wi.id, first.id, JSON.stringify({ url: "https://docs.example.test/rate-limits#section" }));

      const role = new ResearcherRole({
        providerClient: { call: async () => ({ output: "", stats: {} }) },
        context: {
          projectDir,
          parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
        },
      });
      await role.processOutput("Fetched evidence from https://docs.example.test/rate-limits for limits.", {}, first, { attemptId: null });

      const cached = queueMod.getArtifactsByWorkItem(wi.id, "web_fetch_cache");
      assert.equal(cached.length, 1);
      assert.match(cached[0].content_long, /Fetched evidence/);

      const second = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: "Research: Cache docs again",
        payload_json: { deepthink_budget: "normal" },
      });
      const context = await role.assembleContext(second, { tier: "standard", attemptId: 8 });
      assert.match(context, /PREVIOUSLY FETCHED URLS FOR THIS WORK ITEM:/);
      assert.match(context, /https:\/\/docs\.example\.test\/rate-limits/);
      assert.match(context, /artifact #/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("uses child briefs as synth input without pulling unrelated prior research", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-research-synth-"));
    try {
      fs.mkdirSync(path.join(projectDir, "lib"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "README.md"), "# Test project\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "lib", "queue.js"), "export const queue = true;\n", "utf-8");
      const wi = queueMod.createWorkItem("Synthesize fanout", "Merge branch research into one brief.", "normal", {
        metadata: { intake_hints: { suspected_files: ["lib/queue.js"] } },
      });
      const prior = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: "Research: old unrelated path",
        payload_json: { deepthink_budget: "normal" },
      });
      const child = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: "Research (queue): Synthesize fanout",
        payload_json: {
          role_mode: "child",
          fanout_run_id: "fanout-unit",
          fanout_branch: { label: "queue", scope_hints: ["lib/queue.js"] },
          deepthink_budget: "normal",
        },
      });
      const synth = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: "Research synthesis: Synthesize fanout",
        payload_json: {
          role_mode: "synth",
          fanout_run_id: "fanout-unit",
          child_job_ids: [child.id],
          deepthink_budget: "high",
        },
      });
      queueMod.storeArtifact({
        work_item_id: wi.id,
        job_id: prior.id,
        artifact_type: "response",
        content_long: "PRIOR ONLY: should not reach the synth prompt.",
      });
      queueMod.storeArtifact({
        work_item_id: wi.id,
        job_id: child.id,
        artifact_type: "response",
        content_long: "CHILD ONLY: queue evidence cites lib/queue.js:12.",
      });

      const role = new ResearcherRole({
        providerClient: { call: async () => ({ output: "", stats: {} }) },
        context: {
          projectDir,
          parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
        },
      });

      const ctx = { tier: "standard", attemptId: 1 };
      const context = await role.assembleContext(synth, ctx);

      assert.match(context, /RESEARCH FANOUT SYNTHESIS MODE:/);
      assert.match(context, /CHILD RESEARCH BRIEFS:/);
      assert.match(context, /CHILD ONLY: queue evidence cites lib\/queue\.js:12\./);
      assert.doesNotMatch(context, /PIPELINE ROUTING CONTEXT/);
      assert.doesNotMatch(context, /INTAKE HINTS/);
      assert.doesNotMatch(context, /HINTED FILE PREVIEW/);
      assert.doesNotMatch(context, /PRIOR RESEARCH BRIEF:/);
      assert.doesNotMatch(context, /PRIOR ONLY: should not reach the synth prompt/);
      assert.equal(ctx.researcherPacket?.recipient, "researcher");
      assert.equal(ctx.researcherPacket?.atlas, null);
      assert.deepEqual(ctx.researcherPacket?.files_to_modify, []);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("compacts oversized child briefs for synthesis while preserving citations and JSON", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-research-synth-compact-"));
    try {
      fs.writeFileSync(path.join(projectDir, "README.md"), "# Test project\n", "utf-8");
      const wi = queueMod.createWorkItem("Compact fanout", "Merge large branch research into one brief.");
      const child = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: "Research (queue): Compact fanout",
        payload_json: {
          role_mode: "child",
          fanout_run_id: "fanout-compact",
          fanout_branch: { label: "queue", scope_hints: ["lib/queue.js"] },
          deepthink_budget: "normal",
        },
      });
      const synth = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: "Research synthesis: Compact fanout",
        payload_json: {
          role_mode: "synth",
          fanout_run_id: "fanout-compact",
          child_job_ids: [child.id],
          deepthink_budget: "high",
        },
      });
      const longBody = [
        "Opening summary should survive compaction.",
        ...Array.from({ length: 700 }, (_, index) => `Verbose detail ${index}: repeated branch notes without citations.`),
        "Important preserved citation: lib/queue.js:12 shows the lock handoff.",
        "TAIL SHOULD BE OMITTED FROM COMPACTED SYNTH INPUT.",
        "```json",
        JSON.stringify({
          key_files: ["lib/queue.js"],
          patterns: { queue: "Lock handoff uses queue-scoped helpers." },
          constraints: ["Preserve queue ordering."],
          questions_for_human: false,
          questions: [],
        }, null, 2),
        "```",
      ].join("\n");
      queueMod.storeArtifact({
        work_item_id: wi.id,
        job_id: child.id,
        artifact_type: "response",
        content_long: longBody,
      });

      const role = new ResearcherRole({
        providerClient: { call: async () => ({ output: "", stats: {} }) },
        context: {
          projectDir,
          parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
        },
      });

      const context = await role.assembleContext(synth, { tier: "standard", attemptId: 1 });

      assert.match(context, /BRIEF EXCERPT \(compacted from \d+ chars\):/);
      assert.match(context, /Opening summary should survive compaction/);
      assert.match(context, /CITATION LINES PRESERVED:/);
      assert.match(context, /Important preserved citation: lib\/queue\.js:12 shows the lock handoff\./);
      assert.match(context, /STRUCTURED JSON APPENDIX:/);
      assert.match(context, /"key_files": \[/);
      assert.doesNotMatch(context, /TAIL SHOULD BE OMITTED FROM COMPACTED SYNTH INPUT/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("preloads prior failed-attempt context for research retries", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-research-retry-salvage-"));
    try {
      fs.writeFileSync(path.join(projectDir, "README.md"), "# Test project\n", "utf-8");
      const wi = queueMod.createWorkItem("Retry research", "Avoid cold-starting after a turn budget failure.", "normal");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: "Research: retry salvage",
        payload_json: { deepthink_budget: "normal" },
      });
      const db = dbMod.getDb();
      const priorAttempt = Number(db.prepare(`
        INSERT INTO job_attempts (job_id, attempt_number, worker_type, status, error_text)
        VALUES (?, 1, 'researcher', 'interrupted', ?)
      `).run(job.id, "exhausted turn budget after useful reads").lastInsertRowid);
      const currentAttempt = Number(db.prepare(`
        INSERT INTO job_attempts (job_id, attempt_number, worker_type, status)
        VALUES (?, 2, 'researcher', 'running')
      `).run(job.id).lastInsertRowid);
      db.prepare(`
        INSERT INTO job_observations (work_item_id, job_id, attempt_id, observation_type, summary, detail_json)
        VALUES (?, ?, ?, 'tool.read', 'Read: lib/run-session.js', ?)
      `).run(wi.id, job.id, priorAttempt, JSON.stringify({ path: "lib/run-session.js" }));
      queueMod.storeArtifact({
        work_item_id: wi.id,
        job_id: job.id,
        attempt_id: priorAttempt,
        artifact_type: "response",
        content_long: "Partial finding: lib/run-session.js:42 owns retry scheduling.",
      });

      const role = new ResearcherRole({
        providerClient: { call: async () => ({ output: "", stats: {} }) },
        context: {
          projectDir,
          parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
        },
      });

      const ctx = { tier: "standard", attemptId: currentAttempt };
      const context = await role.assembleContext(job, ctx);
      const opts = role.buildOpts(job, ctx);

      assert.match(context, /RESEARCH RETRY SALVAGE:/);
      assert.match(context, /RESEARCH RETRY SHAPE BREAKER:/);
      assert.match(context, /bounded synthesis/);
      assert.match(context, /Do not repeat broad directory walks/);
      assert.match(context, /attempt 1: interrupted - exhausted turn budget/);
      assert.match(context, /tool\.read: Read: lib\/run-session\.js/);
      assert.match(context, /PRIOR PARTIAL RESEARCH OUTPUT \(literal JSON string\):/);
      assert.match(context, /lib\/run-session\.js:42 owns retry scheduling/);
      assert.equal(opts.maxTurns, 10);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("uses bounded retry synthesis mode from the retry payload flag", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-research-retry-flag-"));
    try {
      fs.writeFileSync(path.join(projectDir, "README.md"), "# Test project\n", "utf-8");
      const wi = queueMod.createWorkItem("Retry research flag", "Synthesize instead of over-reading.", "normal");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "research",
        title: "Research: retry flag",
        payload_json: {
          deepthink_budget: "normal",
          _research_retry_synthesis: true,
        },
      });

      const role = new ResearcherRole({
        providerClient: { call: async () => ({ output: "", stats: {} }) },
        context: {
          projectDir,
          parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
        },
      });

      const ctx = { tier: "cheap", attemptId: 1 };
      const context = await role.assembleContext(job, ctx);
      const opts = role.buildOpts(job, ctx);

      assert.match(context, /RESEARCH RETRY SHAPE BREAKER:/);
      assert.match(context, /TURN-BUDGET RETRY MODE:/);
      assert.match(context, /partial planner-ready brief/);
      assert.equal(opts.maxTurns, 10);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
