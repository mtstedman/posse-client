import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const orchestratorPath = path.join(projectRoot, "orchestrator.js");

function git(cwd, args) {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 60_000,
  });
}

function initProject(projectDir) {
  fs.mkdirSync(path.join(projectDir, "lib", "worker"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "lib", "provider"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "lib", "queue.js"), "export const queue = true;\n", "utf8");
  fs.writeFileSync(path.join(projectDir, "lib", "worker", "index.js"), "export const worker = true;\n", "utf8");
  fs.writeFileSync(path.join(projectDir, "lib", "provider", "index.js"), "export const provider = true;\n", "utf8");
  git(projectDir, ["init", "-b", "main"]);
  git(projectDir, ["config", "user.email", "posse-test@example.com"]);
  git(projectDir, ["config", "user.name", "Posse Test"]);
  git(projectDir, ["add", "."]);
  git(projectDir, ["commit", "-m", "init"]);
}

function fakeClaudeBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-fake-claude-"));
  const isWin = process.platform === "win32";
  const binPath = path.join(binDir, isWin ? "claude.cmd" : "claude");
  fs.writeFileSync(binPath, isWin ? "@echo off\r\necho fake claude\r\n" : "#!/bin/sh\necho fake claude\n", "utf8");
  if (!isWin) fs.chmodSync(binPath, 0o755);
  return { binDir, binPath };
}

function testAccountDbPath(projectDir) {
  return path.join(projectDir, ".posse", "account-test.db");
}

function runPosse(projectDir, fakeBinDir, args, envOverride = {}) {
  return spawnSync(process.execPath, [orchestratorPath, ...args], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      POSSE_ACCOUNT_DB_PATH: testAccountDbPath(projectDir),
      ...envOverride,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH || ""}`,
    },
  });
}

function runPosseWithInput(projectDir, fakeBinDir, args, input, envOverride = {}) {
  return spawnSync(process.execPath, [orchestratorPath, ...args], {
    cwd: projectDir,
    encoding: "utf8",
    input,
    timeout: 120_000,
    env: {
      ...process.env,
      POSSE_ACCOUNT_DB_PATH: testAccountDbPath(projectDir),
      ...envOverride,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH || ""}`,
    },
  });
}

function openProjectDb(projectDir) {
  return new Database(path.join(projectDir, ".posse", "db", "orchestrator.db"), { readonly: true });
}

function artifactContentLong(row) {
  if (!row) return null;
  if (row.content_long != null) return row.content_long;
  if (!row.file_path) return null;
  try {
    return JSON.parse(fs.readFileSync(row.file_path, "utf8"))?.content_long ?? null;
  } catch {
    return null;
  }
}

describe("orchestrator research routing", () => {
  it("logs live routing, preserves broad research, and skips tight no-research tasks", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-routing-shadow-"));
    const fake = fakeClaudeBin();
    try {
      initProject(projectDir);

      const first = runPosse(projectDir, fake.binDir, [
        "inject",
        "Review all queue, worker, and provider behavior.",
        "--deepthink-budget=xhigh",
      ]);
      assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

      const mapPath = path.join(projectDir, ".posse", "project-map.json");
      assert.ok(fs.existsSync(mapPath));
      assert.match(fs.readFileSync(path.join(projectDir, ".git", "hooks", "post-commit"), "utf8"), /POSSE PROJECT MAP/);

      let db = openProjectDb(projectDir);
      try {
        const jobs = db.prepare("SELECT * FROM jobs WHERE job_type = 'research'").all();
        assert.equal(jobs.length, 1);
        const payload = JSON.parse(jobs[0].payload_json);
        assert.equal(payload.deepthink_budget, "xhigh");

        const event = db.prepare("SELECT * FROM events WHERE event_type = 'research.routing'").get();
        assert.ok(event, "expected a live routing event");
        const eventJson = JSON.parse(event.event_json);
        assert.equal(eventJson.live, true);
        assert.equal(eventJson.bucket, "fanout_clear");
        assert.equal(eventJson.budget, "high");
        assert.equal(eventJson.branches.length, 3);

        const fanoutEvent = db.prepare("SELECT * FROM events WHERE event_type = 'research.fanout_skipped'").get();
        assert.ok(fanoutEvent, "expected a fanout-skipped v1 metric");
        assert.equal(fanoutEvent.job_id, jobs[0].id);
        const fanoutJson = JSON.parse(fanoutEvent.event_json);
        assert.equal(fanoutJson.version, 1);
        assert.equal(fanoutJson.execution, "single_researcher");
        assert.equal(fanoutJson.actual_budget, "xhigh");
        assert.equal(fanoutJson.branch_count, 3);
        assert.deepEqual(fanoutJson.branches.map((branch) => branch.label).sort(), ["provider", "queue", "worker"]);
      } finally {
        db.close();
      }

      const second = runPosse(projectDir, fake.binDir, [
        "inject",
        "Fix typo in lib/queue.js",
        "--deepthink",
        "--deepthink-budget=low",
      ]);
      assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
      assert.match(second.stderr, /--deepthink raises --deepthink-budget=low to high/);

      db = openProjectDb(projectDir);
      try {
        const researchJobs = db.prepare("SELECT * FROM jobs WHERE job_type = 'research' ORDER BY id").all();
        assert.equal(researchJobs.length, 1, "no_research task should not add another research job");
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'research.fanout_skipped'").get().count, 1);

        const planJob = db.prepare("SELECT * FROM jobs WHERE job_type = 'plan' ORDER BY id DESC LIMIT 1").get();
        assert.ok(planJob, "expected a plan job after skipped research");
        const planPayload = JSON.parse(planJob.payload_json);
        assert.equal(planPayload.deepthink_budget, "high");
        assert.equal(planPayload.research_skipped, true);

        const skippedWorkItem = db.prepare("SELECT * FROM work_items ORDER BY id DESC LIMIT 1").get();
        assert.equal(skippedWorkItem.research_skipped, 1);
        assert.match(skippedWorkItem.research_skip_reason, /single-file low-risk/);

        const synthetic = db.prepare(`
          SELECT * FROM artifacts
          WHERE work_item_id = ? AND artifact_type = 'response' AND job_id IS NULL
          ORDER BY id DESC LIMIT 1
        `).get(skippedWorkItem.id);
        assert.ok(synthetic, "expected a synthetic response artifact");
        assert.match(artifactContentLong(synthetic), /"research_skipped": true/);

        const skippedEvent = db.prepare("SELECT * FROM events WHERE event_type = 'research.skipped'").get();
        assert.ok(skippedEvent, "expected a research.skipped event");
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(fake.binDir, { recursive: true, force: true });
    }
  });

  it("queues preflight instead of research for live ambiguous routing", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-routing-preflight-"));
    const fake = fakeClaudeBin();
    try {
      initProject(projectDir);

      const result = runPosse(projectDir, fake.binDir, [
        "inject",
        "Investigate why state disappears during normal use.\n\nThe symptoms are intermittent and there is no clear module signal yet. Diagnose the likely direction before doing deeper research.",
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

      const db = openProjectDb(projectDir);
      try {
        const preflightJobs = db.prepare("SELECT * FROM jobs WHERE job_type = 'preflight'").all();
        assert.equal(preflightJobs.length, 1);
        assert.equal(preflightJobs[0].model_tier, "cheap");
        assert.equal(preflightJobs[0].reasoning_effort, "low");
        const payload = JSON.parse(preflightJobs[0].payload_json);
        assert.equal(payload.routing.bucket, "ambiguous");
        assert.equal(payload.fallback_budget, "normal");
        assert.ok(payload.project_map?.modules, "preflight should receive staged project map");

        const researchJobs = db.prepare("SELECT * FROM jobs WHERE job_type = 'research'").all();
        assert.equal(researchJobs.length, 0, "ambiguous routing should wait for preflight before research");

        const event = db.prepare("SELECT * FROM events WHERE event_type = 'research.routing'").get();
        assert.ok(event, "expected a live routing event");
        const eventJson = JSON.parse(event.event_json);
        assert.equal(eventJson.live, true);
        assert.equal(eventJson.bucket, "ambiguous");
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(fake.binDir, { recursive: true, force: true });
    }
  });

  it("routes ask web-only questions into compact web research", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-ask-web-only-"));
    const fake = fakeClaudeBin();
    try {
      initProject(projectDir);

      const result = runPosse(projectDir, fake.binDir, [
        "ask",
        "What is the latest Stripe API version?",
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

      const db = openProjectDb(projectDir);
      try {
        const researchJobs = db.prepare("SELECT * FROM jobs WHERE job_type = 'research'").all();
        assert.equal(researchJobs.length, 1);
        assert.equal(researchJobs[0].model_tier, "strong");
        const payload = JSON.parse(researchJobs[0].payload_json);
        assert.equal(payload.web_only_answer, true);
        assert.deepEqual(payload.web_scope_hints, ["docs.stripe.com", "stripe.com"]);

        const event = db.prepare("SELECT * FROM events WHERE event_type = 'research.routing'").get();
        assert.ok(event, "expected a live routing event");
        const eventJson = JSON.parse(event.event_json);
        assert.equal(eventJson.bucket, "web_only_answer");
        assert.equal(eventJson.live, true);
        assert.equal(eventJson.web_targets.length, 1);
        assert.equal(eventJson.web_targets[0].kind, "web");

        const wi = db.prepare("SELECT * FROM work_items ORDER BY id DESC LIMIT 1").get();
        const metadata = JSON.parse(wi.metadata_json);
        assert.ok(metadata.research_project_map?.modules, "routing should stage the project map once");
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(fake.binDir, { recursive: true, force: true });
    }
  });

  it("routes bare --iterate through add and stores iterative metadata", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-iterate-add-route-"));
    const fake = fakeClaudeBin();
    try {
      initProject(projectDir);

      const add = runPosseWithInput(projectDir, fake.binDir, [
        "--iterate",
        "Fix typo in lib/queue.js",
      ], "\n");
      assert.equal(add.status, 0, `${add.stdout}\n${add.stderr}`);
      assert.match(add.stdout, /\[iterate:bugfix\]/);

      const db = openProjectDb(projectDir);
      try {
        const wi = db.prepare("SELECT * FROM work_items ORDER BY id DESC LIMIT 1").get();
        assert.ok(wi, "expected work item");
        assert.equal(wi.title, "Fix typo in lib/queue.js");

        const metadata = JSON.parse(wi.metadata_json);
        assert.equal(metadata.iterate, true);
        assert.equal(metadata.workflow_mode, "bugfix");
        assert.equal(metadata.iteration.active, true);
        assert.equal(metadata.iteration.pass_count, 0);
        assert.equal(metadata.iteration.max_passes, 3);
        assert.equal(metadata.intake_hints.intent_type, "bugfix");
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(fake.binDir, { recursive: true, force: true });
    }
  });

  it("persists iterative red-team planning and applies it when queued work is planned", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-iterate-redteam-"));
    const fake = fakeClaudeBin();
    try {
      initProject(projectDir);

      const add = runPosseWithInput(projectDir, fake.binDir, [
        "add",
        "Fix typo in lib/queue.js",
        "--iterate",
        "--iterate-red-team",
      ], "\n");
      assert.equal(add.status, 0, `${add.stdout}\n${add.stderr}`);

      let db = openProjectDb(projectDir);
      try {
        const wi = db.prepare("SELECT * FROM work_items ORDER BY id DESC LIMIT 1").get();
        assert.ok(wi, "expected work item");
        const metadata = JSON.parse(wi.metadata_json);
        assert.equal(metadata.iteration.red_team_plan, true);
      } finally {
        db.close();
      }

      const plan = runPosse(projectDir, fake.binDir, ["plan"]);
      assert.equal(plan.status, 0, `${plan.stdout}\n${plan.stderr}`);

      db = openProjectDb(projectDir);
      try {
        const plans = db.prepare("SELECT * FROM jobs WHERE job_type = 'plan' ORDER BY id").all();
        assert.equal(plans.length, 3);
        const payloads = plans.map((job) => JSON.parse(job.payload_json || "{}"));
        assert.deepEqual(payloads.map((payload) => payload.planner_role_mode), ["primary", "redteam", "synth"]);
        assert.ok(payloads.every((payload) => payload.planning_mode === "dual_redteam"));
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(fake.binDir, { recursive: true, force: true });
    }
  });

  it("honors deterministic fanout shadow and active modes", () => {
    for (const mode of ["shadow", "on"]) {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `posse-routing-fanout-${mode}-`));
      const fake = fakeClaudeBin();
      try {
        initProject(projectDir);

        const setFanout = runPosse(projectDir, fake.binDir, ["admin", "set", "research_fanout", mode]);
        assert.equal(setFanout.status, 0, `${setFanout.stdout}\n${setFanout.stderr}`);

        const result = runPosse(projectDir, fake.binDir, [
          "inject",
          "Review all queue, worker, and provider behavior.",
        ]);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

        const db = openProjectDb(projectDir);
        try {
          const researchJobs = db.prepare("SELECT * FROM jobs WHERE job_type = 'research' ORDER BY id").all();
          assert.ok(researchJobs.every((job) => job.model_tier === "strong"), "research fanout jobs should default to strong");
          const payloads = researchJobs.map((job) => ({ job, payload: JSON.parse(job.payload_json || "{}") }));
          const children = payloads.filter(({ payload }) => payload.role_mode === "child");
          const synth = payloads.find(({ payload }) => payload.role_mode === "synth");
          const solo = payloads.find(({ payload }) => !payload.role_mode);

          assert.equal(children.length, 3);
          assert.ok(synth, "expected synthesis research job");
          assert.equal(synth.payload.fanout_mode, mode);

          if (mode === "shadow") {
            assert.equal(researchJobs.length, 5);
            assert.ok(solo, "shadow mode should keep the solo researcher");
            assert.equal(synth.payload.fanout_shadow, true);
            assert.equal(synth.payload.solo_job_id, solo.job.id);
            assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'research.fanout_shadowed'").get().count, 1);
            assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'research.fanout_skipped'").get().count, 0);
          } else {
            assert.equal(researchJobs.length, 4);
            assert.equal(solo, undefined);
            assert.equal(synth.payload.fanout_shadow, false);
            assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'research.fanout_started'").get().count, 1);
          }

          const deps = db.prepare("SELECT depends_on_job_id FROM job_dependencies WHERE job_id = ? ORDER BY depends_on_job_id").all(synth.job.id);
          assert.deepEqual(deps.map((dep) => dep.depends_on_job_id), children.map(({ job }) => job.id).sort((a, b) => a - b));
        } finally {
          db.close();
        }
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
        fs.rmSync(fake.binDir, { recursive: true, force: true });
      }
    }
  });
});
