import {
  describe,
  it,
} from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { Worker } from "../lib/domains/worker/classes/Worker.js";
import { EVENT_TYPES } from "../lib/catalog/event.js";
import { createGitWorkflowHelpers } from "../lib/domains/cli/functions/git-workflows.js";
import {
  checkAtlasMainFreshnessGate,
  invalidateAtlasIntegrationConfigCache,
  listPendingAtlasMainWarmJobs,
} from "../lib/domains/integrations/functions/atlas.js";
import {
  acquireLease,
  createJob,
  createWorkItem,
  getEvents,
  getJob,
  releaseLease,
  setSetting,
} from "../lib/domains/queue/functions/index.js";
import { withTempRuntimeDb } from "./helpers/regression-test-harness.js";

function git(projectDir, args) {
  return execFileSync("git", args, {
    cwd: projectDir,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function initMergeRepo(projectDir) {
  git(projectDir, ["init", "-b", "main"]);
  git(projectDir, ["config", "user.email", "posse-test@example.com"]);
  git(projectDir, ["config", "user.name", "Posse Test"]);
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "README.md"), "initial\n", "utf-8");
  git(projectDir, ["add", "README.md"]);
  git(projectDir, ["commit", "-m", "initial"]);
  git(projectDir, ["checkout", "-b", "posse/test-merge"]);
  fs.writeFileSync(path.join(projectDir, "src", "feature.js"), "export const feature = true;\n", "utf-8");
  git(projectDir, ["add", "src/feature.js"]);
  git(projectDir, ["commit", "-m", "feature"]);
  git(projectDir, ["checkout", "main"]);
}

function initBasicRepo(projectDir) {
  fs.mkdirSync(projectDir, { recursive: true });
  git(projectDir, ["init", "-b", "main"]);
  git(projectDir, ["config", "user.email", "posse-test@example.com"]);
  git(projectDir, ["config", "user.name", "Posse Test"]);
  fs.writeFileSync(path.join(projectDir, "README.md"), "initial\n", "utf-8");
  git(projectDir, ["add", "README.md"]);
  git(projectDir, ["commit", "-m", "initial"]);
}

function seedAtlasSettings(projectDir) {
  setSetting("atlas_v2", "on");
  setSetting("atlas_mode", "on");
  setSetting("atlas_phases", "research,planning,assessment,dev");
  setSetting("atlas_v2_view_wait_ms", "1000");
  setSetting("atlas_v2_auto_refresh_stale", "true");
  setSetting("target_branch", "main", { projectDir });
  invalidateAtlasIntegrationConfigCache();
}

function createMainWarmJob() {
  return createJob({
    work_item_id: null,
    job_type: "atlas_warm",
    title: "ATLAS reindex: incremental main refresh",
    priority: "normal",
    payload_json: {
      purpose: "main-incremental",
      branch: "main",
      target_branch: "main",
      paths: ["src/example.js"],
    },
  });
}

describe("ATLAS main freshness gate", () => {
  it("degrades instead of queuing a no-op refresh when project ATLAS runtime is missing", () => withTempRuntimeDb((runtimeDir) => {
    const projectDir = path.join(runtimeDir, "cold-project");
    initBasicRepo(projectDir);
    const config = {
      enabled: true,
      atlasV2Mode: "on",
      normalizedMode: "on",
      phases: ["research", "planning", "assessment", "dev"],
      requestedRepoPath: projectDir,
      autoRefreshStale: true,
    };

    assert.equal(fs.existsSync(path.join(projectDir, ".posse")), false);

    const gate = checkAtlasMainFreshnessGate({
      cwd: projectDir,
      config,
      targetBranch: "main",
      requestRefresh: true,
    });

    assert.equal(gate.ready, false);
    assert.equal(gate.action, "degrade");
    assert.equal(gate.reason, "atlas_warm_runtime_missing");
    assert.equal(gate.pendingWarmJobs.length, 0);

    const pending = listPendingAtlasMainWarmJobs({ cwd: projectDir, config, targetBranch: "main" });
    assert.equal(pending.length, 0);
  }));

  it("detects queued main warm jobs before probing graph readiness", () => withTempRuntimeDb((projectDir) => {
    const warmJob = createMainWarmJob();
    const config = {
      enabled: true,
      atlasV2Mode: "on",
      normalizedMode: "on",
      phases: ["research", "planning", "assessment", "dev"],
      requestedRepoPath: projectDir,
      autoRefreshStale: false,
    };

    const pending = listPendingAtlasMainWarmJobs({ cwd: projectDir, config, targetBranch: "main" });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, warmJob.id);

    const gate = checkAtlasMainFreshnessGate({
      cwd: projectDir,
      config,
      targetBranch: "main",
      requestRefresh: false,
    });
    assert.equal(gate.ready, false);
    assert.equal(gate.action, "defer");
    assert.equal(gate.reason, "atlas_refresh_pending");
    assert.deepEqual(gate.pendingWarmJobs.map((job) => job.id), [warmJob.id]);
  }));

  it("requeues planner jobs behind pending main warm without consuming attempts", () => withTempRuntimeDb(async (projectDir) => {
    seedAtlasSettings(projectDir);
    createMainWarmJob();
    const wi = createWorkItem("Atlas freshness gate", "waits for main refresh");
    const plan = createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan after merge",
      payload_json: { task: "Plan with fresh Atlas" },
    });
    const lease = acquireLease(plan.id, "atlas-freshness-test", 900);
    assert.ok(lease?.leaseToken);

    const worker = new Worker({ projectDir, silent: true });
    const result = await worker._gateAtlasFreshnessBeforePlanningOrDev(getJob(plan.id), lease.leaseToken);

    assert.equal(result.ok, false);
    assert.equal(result.deferred, true);

    const refreshed = getJob(plan.id);
    assert.equal(refreshed.status, "queued");
    assert.equal(refreshed.attempt_count, 0);
    assert.ok(refreshed.ready_at);
    assert.ok(Date.parse(refreshed.ready_at) >= Date.now() - 1000);

    const payload = JSON.parse(refreshed.payload_json);
    assert.equal(payload._atlas_freshness_deferrals, 1);

    const events = getEvents(plan.id, 20);
    assert.ok(events.some((event) => event.event_type === EVENT_TYPES.ATLAS_FRESHNESS_GATE_DEFERRED));
  }));

  it("lets planner jobs proceed degraded instead of requeueing when project ATLAS runtime is missing", () => withTempRuntimeDb(async (runtimeDir) => {
    const projectDir = path.join(runtimeDir, "cold-worker-project");
    initBasicRepo(projectDir);
    seedAtlasSettings(projectDir);
    const wi = createWorkItem("Atlas cold freshness gate", "proceeds without runtime");
    const plan = createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Plan without project atlas runtime",
      payload_json: { task: "Plan degraded" },
    });
    const lease = acquireLease(plan.id, "atlas-cold-freshness-test", 900);
    assert.ok(lease?.leaseToken);

    const worker = new Worker({ projectDir, silent: true });
    const result = await worker._gateAtlasFreshnessBeforePlanningOrDev(getJob(plan.id), lease.leaseToken);

    assert.equal(result.ok, true);
    assert.equal(result.degraded, true);
    assert.equal(result.gate.reason, "atlas_warm_runtime_missing");

    const refreshed = getJob(plan.id);
    assert.equal(refreshed.status, "leased");
    assert.equal(refreshed.attempt_count, 0);
    assert.equal(JSON.parse(refreshed.payload_json)._atlas_freshness_deferrals, undefined);

    const events = getEvents(plan.id, 20);
    assert.equal(events.some((event) => event.event_type === EVENT_TYPES.ATLAS_FRESHNESS_GATE_DEFERRED), false);

    releaseLease(plan.id, lease.leaseToken, "queued");
  }));

  it("queues a main refresh after a successful squash merge", () => withTempRuntimeDb((projectDir) => {
    initMergeRepo(projectDir);
    seedAtlasSettings(projectDir);
    const wi = createWorkItem("Atlas merge refresh", "merge branch and refresh main");
    const helpers = createGitWorkflowHelpers({ projectDir, targetBranch: "main" });

    const result = helpers.gitMergeToTarget("posse/test-merge", projectDir, { wiId: wi.id });
    assert.equal(result.ok, true);
    assert.ok(result.mergeHash);

    const pending = listPendingAtlasMainWarmJobs({ cwd: projectDir, targetBranch: "main" });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].purpose, "main-incremental");
    assert.equal(pending[0].targetBranch, "main");
    assert.deepEqual(pending[0].payload.paths, ["src/feature.js"]);
  }));
});
