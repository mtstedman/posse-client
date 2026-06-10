import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "url";

import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";
import { setAccountSettingsPathForTests, closeAccountSettingsDb } from "../lib/domains/settings/functions/account-settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const orchestratorPath = path.join(projectRoot, "orchestrator.js");

let dbMod;
let queueMod;
let buildResearchFanoutReport;
let runtimeDir;
let runtimeDbPath;
let accountDbPath;

function resetRuntimeDb() {
  dbMod.closeDb();
  closeAccountSettingsDb();
  try { fs.rmSync(runtimeDbPath, { force: true }); } catch {}
  try { fs.rmSync(accountDbPath, { force: true }); } catch {}
  dbMod.getDb();
}

function insertCall({ workItemId, jobId, costUsd, inputTokens = 100, outputTokens = 50 }) {
  dbMod.getDb().prepare(`
    INSERT INTO agent_calls (
      work_item_id, job_id, role, model_tier, input_tokens, output_tokens,
      cost_estimate_usd, status
    ) VALUES (?, ?, 'researcher', 'standard', ?, ?, ?, 'succeeded')
  `).run(workItemId, jobId, inputTokens, outputTokens, costUsd);
}

function insertObservation({ workItemId, jobId, type, summary = "tool use", detail = null }) {
  dbMod.getDb().prepare(`
    INSERT INTO job_observations (work_item_id, job_id, observation_type, summary, detail_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(workItemId, jobId, type, summary, detail == null ? null : JSON.stringify(detail));
}

// The report's currentMode is read from the research_fanout account setting
// (not from POSSE_RESEARCH_FANOUT env), so translate the test's mode hint into
// a setting write. The account DB is redirected to a temp file in before(), so
// this does not touch the real user settings.
function setFanoutMode(env) {
  const mode = env?.POSSE_RESEARCH_FANOUT;
  if (mode) queueMod.setSetting("research_fanout", mode);
}

// logEvent() buffers events in-process and flushes them asynchronously, so the
// synchronous report query won't see freshly logged events until they're
// drained. Flush before building the report (and before closing the DB for the
// CLI subprocess) so the SELECT observes them in the same tick.
function buildReport({ env, ...opts } = {}) {
  setFanoutMode(env);
  queueMod.flushEventsNow();
  return buildResearchFanoutReport(opts);
}

describe("research fanout report", () => {
  before(async () => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-fanout-report-"));
    runtimeDbPath = path.join(runtimeDir, ".posse", "db", "orchestrator.db");
    accountDbPath = path.join(runtimeDir, "account.db");
    setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });
    setAccountSettingsPathForTests(accountDbPath);

    dbMod = await import("../lib/shared/storage/functions/index.js");
    queueMod = await import("../lib/domains/queue/functions/index.js");
    ({ buildResearchFanoutReport } = await import("../lib/domains/research/functions/fanout-report.js"));
    resetRuntimeDb();
  });

  beforeEach(() => {
    resetRuntimeDb();
  });

  after(() => {
    if (dbMod) dbMod.closeDb();
    closeAccountSettingsDb();
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
    setRuntimePathOverridesForTests(null);
    setAccountSettingsPathForTests(null);
  });

  it("summarizes shadow quality, cost, and readiness from fanout events", () => {
    const wi = queueMod.createWorkItem("Audit queue worker provider", "Review all three modules.");
    const solo = queueMod.createJob({ work_item_id: wi.id, job_type: "research", title: "Research: Audit queue worker provider" });
    const childA = queueMod.createJob({ work_item_id: wi.id, job_type: "research", title: "Research (queue): Audit queue worker provider" });
    const childB = queueMod.createJob({ work_item_id: wi.id, job_type: "research", title: "Research (worker): Audit queue worker provider" });
    const childC = queueMod.createJob({ work_item_id: wi.id, job_type: "research", title: "Research (provider): Audit queue worker provider" });
    const synth = queueMod.createJob({ work_item_id: wi.id, job_type: "research", title: "Research synthesis: Audit queue worker provider" });
    const plan = queueMod.createJob({ work_item_id: wi.id, job_type: "plan", title: "Plan: Audit queue worker provider", parent_job_id: solo.id });
    queueMod.updateJobStatus(plan.id, "succeeded");

    queueMod.logEvent({
      work_item_id: wi.id,
      job_id: synth.id,
      event_type: "research.fanout_shadowed",
      actor_type: "system",
      message: "Shadow fanout created",
      event_json: {
        version: 1,
        mode: "shadow",
        source: "routing",
        budget: "high",
        synth_budget: "high",
        fanout_run_id: "fanout-test",
        branch_count: 3,
        branches: [{ label: "queue" }, { label: "worker" }, { label: "provider" }],
        child_job_ids: [childA.id, childB.id, childC.id],
        synth_job_id: synth.id,
        solo_job_id: solo.id,
      },
    });

    for (const child of [childA, childB, childC]) {
      queueMod.logEvent({
        work_item_id: wi.id,
        job_id: child.id,
        event_type: "research.fanout_child_completed",
        actor_type: "researcher",
        message: "Fanout child completed",
        event_json: {
          version: 1,
          mode: "shadow",
          shadow: true,
          fanout_run_id: "fanout-test",
          line_ref_count: 2,
        },
      });
    }

    queueMod.logEvent({
      work_item_id: wi.id,
      job_id: synth.id,
      event_type: "research.fanout_synth_completed",
      actor_type: "researcher",
      message: "Shadow fanout synthesis completed",
      event_json: {
        version: 1,
        mode: "shadow",
        shadow: true,
        fanout_run_id: "fanout-test",
        child_job_ids: [childA.id, childB.id, childC.id],
        solo_job_id: solo.id,
        line_ref_count: 7,
        url_citation_count: 2,
        contradiction_signal_count: 1,
        needs_review: false,
        output_chars: 1200,
      },
    });

    queueMod.logEvent({
      work_item_id: wi.id,
      job_id: solo.id,
      event_type: "research.fanout_skipped",
      actor_type: "system",
      message: "Fanout candidate kept on single researcher",
      event_json: {
        version: 1,
        source: "routing",
        bucket: "fanout_clear",
        budget: "high",
        actual_budget: "high",
        branch_count: 3,
      },
    });

    insertCall({ workItemId: wi.id, jobId: solo.id, costUsd: 1.0 });
    insertCall({ workItemId: wi.id, jobId: childA.id, costUsd: 0.4 });
    insertCall({ workItemId: wi.id, jobId: childB.id, costUsd: 0.5 });
    insertCall({ workItemId: wi.id, jobId: childC.id, costUsd: 0.6 });
    insertCall({ workItemId: wi.id, jobId: synth.id, costUsd: 0.7 });
    insertObservation({ workItemId: wi.id, jobId: solo.id, type: "tool.web_fetch", detail: { url: "https://docs.example.test/solo" } });
    insertObservation({ workItemId: wi.id, jobId: childA.id, type: "tool.web_search", detail: { query: "queue docs" } });
    insertObservation({ workItemId: wi.id, jobId: childA.id, type: "tool.web_fetch", detail: { url: "https://docs.example.test/queue" } });
    insertObservation({ workItemId: wi.id, jobId: childB.id, type: "tool.web_fetch", detail: { url: "https://docs.example.test/queue" } });
    insertObservation({ workItemId: wi.id, jobId: childC.id, type: "tool.web_search", detail: { query: "provider docs" } });
    insertObservation({ workItemId: wi.id, jobId: synth.id, type: "tool.web_fetch", detail: { url: "https://docs.example.test/synth" } });

    const report = buildReport({
      limit: 5,
      minShadowRuns: 1,
      maxNeedsReviewRate: 0.5,
      firstPassPlanSampleMin: 1,
      env: { POSSE_RESEARCH_FANOUT: "shadow" },
    });

    assert.equal(report.currentMode, "shadow");
    assert.equal(report.totals.skippedCandidates, 1);
    assert.equal(report.totals.shadowRuns, 1);
    assert.equal(report.totals.completedSynthRuns, 1);
    assert.equal(report.totals.childCompleted, 3);
    assert.equal(report.totals.lineRefCount, 7);
    assert.equal(report.totals.urlCitationCount, 2);
    assert.equal(report.totals.urlCitationRuns, 1);
    assert.equal(report.rates.lineRefCoverageRate, 1);
    assert.equal(report.rates.urlCitationCoverageRate, 1);
    assert.equal(report.rates.needsReviewRate, 0);
    assert.equal(report.rates.contradictionSignalRate, 1);
    assert.equal(report.rates.firstPassPlanRate, 1);
    assert.equal(report.cost.comparableShadowRuns, 1);
    assert.equal(report.cost.soloCostUsd, 1);
    assert.equal(report.cost.fanoutCostUsd, 2.2);
    assert.equal(report.cost.childCostUsd, 1.5);
    assert.equal(report.cost.synthCostUsd, 0.7);
    assert.equal(report.totals.fanoutWebFetchCalls, 3);
    assert.equal(report.totals.fanoutWebSearchCalls, 2);
    assert.equal(report.totals.fanoutWebToolCalls, 5);
    assert.equal(report.totals.fanoutDuplicateFetchedUrlsWithinRuns, 1);
    assert.equal(report.totals.fanoutUniqueFetchedUrls, 2);
    assert.equal(report.totals.fanoutUniqueFetchedUrlsAcrossRuns, 2);
    assert.equal(report.runs[0].soloWebTools.fetches, 1);
    assert.equal(report.runs[0].childWebTools.total, 4);
    assert.equal(report.runs[0].synthWebTools.fetches, 1);
    assert.equal(report.runs[0].fanoutWebTools.uniqueFetchedUrls, 2);
    assert.equal(report.readiness.defaultOnReady, true);
  });

  it("does not count in-flight plans as first-pass plan success", () => {
    const wi = queueMod.createWorkItem("Audit queue worker provider", "Review all three modules.");
    const solo = queueMod.createJob({ work_item_id: wi.id, job_type: "research", title: "Research: Audit queue worker provider" });
    const child = queueMod.createJob({ work_item_id: wi.id, job_type: "research", title: "Research (queue): Audit queue worker provider" });
    const synth = queueMod.createJob({ work_item_id: wi.id, job_type: "research", title: "Research synthesis: Audit queue worker provider" });
    queueMod.createJob({ work_item_id: wi.id, job_type: "plan", title: "Plan: Audit queue worker provider", parent_job_id: solo.id });

    queueMod.logEvent({
      work_item_id: wi.id,
      job_id: synth.id,
      event_type: "research.fanout_shadowed",
      actor_type: "system",
      message: "Shadow fanout created",
      event_json: {
        version: 1,
        mode: "shadow",
        fanout_run_id: "fanout-inflight",
        child_job_ids: [child.id],
        synth_job_id: synth.id,
        solo_job_id: solo.id,
      },
    });
    queueMod.logEvent({
      work_item_id: wi.id,
      job_id: synth.id,
      event_type: "research.fanout_synth_completed",
      actor_type: "researcher",
      message: "Shadow fanout synthesis completed",
      event_json: {
        version: 1,
        mode: "shadow",
        shadow: true,
        fanout_run_id: "fanout-inflight",
        child_job_ids: [child.id],
        solo_job_id: solo.id,
        line_ref_count: 1,
      },
    });

    const report = buildReport({
      minShadowRuns: 1,
      firstPassPlanSampleMin: 1,
      env: { POSSE_RESEARCH_FANOUT: "shadow" },
    });

    assert.equal(report.runs[0].firstPlanStatus, "queued");
    assert.equal(report.runs[0].firstPassPlan, false);
    assert.equal(report.rates.firstPassPlanRate, 0);
  });

  it("reports readiness blockers when there is not enough shadow evidence", () => {
    const report = buildReport({
      minShadowRuns: 2,
      env: { POSSE_RESEARCH_FANOUT: "off" },
    });

    assert.equal(report.totals.fanoutRuns, 0);
    assert.equal(report.readiness.defaultOnReady, false);
    assert.match(report.readiness.blockers.join("\n"), /more completed shadow synthesis/);
  });

  it("filters old fanout events with since", () => {
    const oldWi = queueMod.createWorkItem("Old audit", "Old audit.");
    const newWi = queueMod.createWorkItem("New audit", "New audit.");
    queueMod.logEvent({
      work_item_id: oldWi.id,
      event_type: "research.fanout_skipped",
      actor_type: "system",
      message: "Old skipped candidate",
      event_json: { version: 1, branch_count: 3 },
    });
    queueMod.logEvent({
      work_item_id: newWi.id,
      event_type: "research.fanout_skipped",
      actor_type: "system",
      message: "New skipped candidate",
      event_json: { version: 1, branch_count: 3 },
    });
    // Events are buffered; flush so the rows exist before backdating one of them.
    queueMod.flushEventsNow();
    dbMod.getDb().prepare("UPDATE events SET created_at = ? WHERE work_item_id = ?")
      .run("2020-01-01T00:00:00.000Z", oldWi.id);

    const report = buildReport({ since: "1d" });
    assert.equal(report.totals.skippedCandidates, 1);
    assert.equal(report.skipped[0].workItemId, newWi.id);
  });

  it("renders not-ready CLI output with blockers and skipped candidates", () => {
    const wi = queueMod.createWorkItem("Audit queue worker provider", "Review all three modules.");
    queueMod.logEvent({
      work_item_id: wi.id,
      event_type: "research.fanout_skipped",
      actor_type: "system",
      message: "Fanout candidate kept on single researcher",
      event_json: {
        version: 1,
        source: "routing",
        bucket: "fanout_clear",
        budget: "high",
        actual_budget: "high",
        branch_count: 3,
      },
    });
    // currentMode is read from the research_fanout account setting; set it in
    // the redirected temp account DB so the subprocess reports active mode.
    queueMod.setSetting("research_fanout", "on");
    queueMod.flushEventsNow();
    closeAccountSettingsDb();
    dbMod.closeDb();

    const result = spawnSync(process.execPath, [orchestratorPath, "fanout", "--min-runs", "2"], {
      cwd: runtimeDir,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, POSSE_ACCOUNT_DB_PATH: accountDbPath },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /not ready yet/);
    assert.match(result.stdout, /need 2 more completed shadow synthesis run/);
    assert.match(result.stdout, /Recent Skipped Candidates/);
    assert.match(result.stdout, /active mode: cost comparison requires shadow runs/);

    dbMod.getDb();
  });
});
