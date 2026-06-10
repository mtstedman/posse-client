import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withTempRuntimeDb } from "./helpers/regression-test-harness.js";
import { Job } from "../lib/domains/queue/classes/job/Job.js";
import { Worker } from "../lib/domains/worker/classes/Worker.js";
import { FixRole } from "../lib/domains/worker/classes/roles/fix.js";
import { processVerdict } from "../lib/domains/worker/classes/roles/assessor.js";
import { MutationPolicy, inferGeneratedArtifactDeletionTargets, scopedDeleteTargets } from "../lib/shared/scope/classes/MutationPolicy.js";
import {
  createJob,
  createWorkItem,
  getJob,
  listJobsByWorkItem,
  setSetting,
  updateJobStatus,
  addDependency,
  getDependencies,
} from "../lib/domains/queue/functions/index.js";
import { artifactsDir, wiScopeId } from "../lib/domains/artifacts/functions/index.js";
import { applyFixScopeHandoffGuard } from "../lib/domains/handoff/functions/index.js";

describe("Fix role scope inheritance", () => {
  it("grants generated artifact cleanup fix jobs delete scope for the offending file", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("Signals", "desc");
    const current = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Implement trend.py signals",
      payload_json: JSON.stringify({
        task_spec: "Implement trend signals",
        files_to_modify: [],
        files_to_create: ["src/mike/trend.py", "tests/test_trend.py"],
        files_to_delete: [],
        create_roots: [],
        task_mode: "code",
      }),
    });

    const { spawnedJobs } = processVerdict(current, {
      verdict: "fail",
      confidence: "high",
      reasons: [
        "File-scope contract violation: committed file `tests/__pycache__/test_trend.cpython-314-pytest-9.0.3.pyc` is out of scope.",
      ],
      spawn_jobs: [{
        job_type: "fix",
        title: "Remove out-of-scope bytecode artifact",
        payload: {
          instructions: "Delete `tests/__pycache__/test_trend.cpython-314-pytest-9.0.3.pyc` from the commit and keep source files unchanged.",
        },
      }],
      human_questions: [],
    }, { emit: () => {} });

    const fixJob = spawnedJobs.find((job) => job.job_type === "fix");
    assert.ok(fixJob, "expected a fix job to be spawned");
    const payload = JSON.parse(getJob(fixJob.id).payload_json);
    assert.deepEqual(payload.files_to_delete, ["tests/__pycache__/test_trend.cpython-314-pytest-9.0.3.pyc"]);
    assert.deepEqual(
      payload.files_to_modify.sort(),
      ["src/mike/trend.py", "tests/test_trend.py"].sort(),
    );
  }));

  it("reroutes failed image artifact repair through the artificer image route", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("Mermaid imagery", "Generate themed PNG assets");
    const outputRoot = ".posse/resources/artifacts/wi-40/task-01-generate-on-theme-png-assets-for-favicon";
    const original = createJob({
      work_item_id: wi.id,
      job_type: "artificer",
      title: "Generate on-theme PNG assets",
      payload_json: JSON.stringify({
        task_spec: "Create favicon-shell.png plus three decorative PNG assets.",
        task_mode: "image",
        output_root: outputRoot,
        create_roots: [outputRoot],
        needs_image_generation: true,
        success_criteria: [
          "favicon-shell.png exists and is a 512x512 PNG",
          "All generated files are visually on-theme and contain no text",
        ],
      }),
    });
    const promote = createJob({
      work_item_id: wi.id,
      job_type: "promote",
      title: "Promote PNG assets",
      payload_json: JSON.stringify({ instructions: "Use the generated PNG assets." }),
    });
    addDependency(promote.id, original.id, "hard");

    const { spawnedJobs } = processVerdict(original, {
      verdict: "fail",
      confidence: "high",
      reasons: [
        "The output root contains _generate.py and CLEANUP-NOTES.md instead of only image deliverables.",
      ],
      spawn_jobs: [{
        job_type: "fix",
        title: "Remove generated helpers and repair images",
        payload: {
          instructions: "Regenerate missing PNGs and remove helper files from the artifact directory.",
        },
      }],
      human_questions: [],
    }, { emit: () => {} });

    const imageJob = spawnedJobs.find((candidate) => candidate.job_type === "artificer");
    assert.ok(imageJob, "expected an artificer image repair job");
    assert.equal(spawnedJobs.some((candidate) => candidate.job_type === "fix"), false);

    const imagePayload = JSON.parse(getJob(imageJob.id).payload_json);
    assert.equal(imagePayload.task_mode, "image");
    assert.equal(imagePayload.needs_image_generation, true);
    assert.deepEqual(imagePayload.create_roots, [outputRoot]);
    assert.match(imagePayload.task_spec, /generate_image/);
    assert.match(imagePayload.task_spec, /Do not create Python\/Pillow scripts/);

    const deps = getDependencies(promote.id);
    assert.equal(deps.some((dep) => dep.depends_on_job_id === original.id), false);
    assert.equal(deps.some((dep) => dep.depends_on_job_id === imageJob.id), true);
  }));

  it("uses distinct artifact filenames for structured-data recovery files with duplicate basenames", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("Normalize datasets", "desc");
    const original = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Normalize regional data",
      payload_json: JSON.stringify({
        task_spec: "Normalize JSON data records in both datasets.",
        task_mode: "code",
        files_to_modify: ["src/data.json", "lib/data.json"],
        files_to_create: [],
        create_roots: [],
        success_criteria: ["Both data files are normalized"],
      }),
    });

    const { spawnedJobs } = processVerdict(original, {
      verdict: "fail",
      confidence: "high",
      reasons: ["The generated data records are still stale."],
      spawn_jobs: [{
        job_type: "fix",
        title: "Normalize data outputs",
        payload: {
          instructions: "Regenerate and normalize the JSON data outputs.",
        },
      }],
      human_questions: [],
    }, { emit: () => {} });

    const artifactJob = spawnedJobs.find((job) => job.job_type === "artificer");
    const promoteJob = spawnedJobs.find((job) => job.job_type === "promote");
    assert.ok(artifactJob, "expected structured-data artifact repair job");
    assert.ok(promoteJob, "expected deterministic promote job");

    const artifactPayload = JSON.parse(getJob(artifactJob.id).payload_json);
    const promotePayload = JSON.parse(getJob(promoteJob.id).payload_json);
    assert.equal(new Set(artifactPayload.files_to_create).size, 2);
    assert.equal(new Set(promotePayload.mappings.map((mapping) => mapping.pattern)).size, 2);
    assert.deepEqual(
      promotePayload.mappings.map((mapping) => mapping.dest).sort(),
      ["lib/data.json", "src/data.json"],
    );
    assert.ok(promotePayload.mappings.every((mapping) => mapping.destination_type === "file"));
  }));

  it("does not infer cache directories as deterministic file deletes", () => {
    const job = { title: "Fix: Remove out-of-scope pycache artifact" };
    const payload = {
      fix_instructions: "Delete `tests/__pycache__` and `tests/__pycache__/test_trend.cpython-314-pytest-9.0.3.pyc` from the commit.",
      files_to_delete: [],
    };

    assert.deepEqual(inferGeneratedArtifactDeletionTargets(job, payload), [
      "tests/__pycache__/test_trend.cpython-314-pytest-9.0.3.pyc",
    ]);
    assert.deepEqual(scopedDeleteTargets(job, payload), [
      "tests/__pycache__/test_trend.cpython-314-pytest-9.0.3.pyc",
    ]);
  });

  it("fix role persists inferred generated delete scope through Job mutation APIs", () => withTempRuntimeDb(async (root) => {
    const wi = createWorkItem("Signals", "desc");
    const fixJobRow = createJob({
      work_item_id: wi.id,
      job_type: "fix",
      title: "Fix: Remove Out-of-Scope Pycache Artifact",
      payload_json: JSON.stringify({
        fix_instructions: "Delete `tests/__pycache__/test_trend.cpython-314-pytest-9.0.3.pyc` from the commit.",
        files_to_modify: [],
        files_to_create: [],
        files_to_delete: [],
        create_roots: [],
        task_mode: "code",
      }),
    });
    const job = new Job({
      row: fixJobRow,
      deps: {
        getDependencies: () => [],
        getJob: () => null,
      },
    });
    const role = new FixRole({
      providerClient: { call: async () => ({ output: "", stats: {} }) },
      context: {
        projectDir: root,
        parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
        emit() {},
        detectDrift: () => "",
        primeCreatableFiles: () => [],
      },
    });

    await role.assembleContext(job, { tier: "standard", attemptId: 1 });

    const persisted = JSON.parse(getJob(fixJobRow.id).payload_json || "{}");
    assert.deepEqual(persisted.files_to_delete, ["tests/__pycache__/test_trend.cpython-314-pytest-9.0.3.pyc"]);
    assert.deepEqual(JSON.parse(job.payload_json || "{}").files_to_delete, persisted.files_to_delete);
  }));

  it("fix role turns out-of-scope new-file cleanup into deterministic delete scope", () => withTempRuntimeDb(async (root) => {
    fs.writeFileSync(path.join(root, "FlowInspector.tsx"), "export default function FlowInspector() { return null; }\n", "utf8");
    const wi = createWorkItem("Flow inspector", "desc");
    const fixJobRow = createJob({
      work_item_id: wi.id,
      job_type: "fix",
      title: "Fix: Remove out-of-scope root FlowInspector.tsx from commit",
      payload_json: JSON.stringify({
        fix_instructions: "Ensure the final commit contains no new root-level `FlowInspector.tsx` file. Use true deletion (`git rm`) rather than emptying it.",
        assessor_feedback: [
          "FlowInspector.tsx was created out-of-scope. The file still exists in the git tree; removal from the change set entirely is required.",
        ],
        files_to_modify: [],
        files_to_create: [],
        files_to_delete: [],
        create_roots: [],
        task_mode: "code",
      }),
    });
    const job = new Job({
      row: fixJobRow,
      deps: {
        getDependencies: () => [],
        getJob: () => null,
      },
    });
    const ctx = { tier: "standard", attemptId: 1 };
    const role = new FixRole({
      providerClient: { call: async () => ({ output: "", stats: {} }) },
      context: {
        projectDir: root,
        parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
        emit() {},
        detectDrift: () => "",
        primeCreatableFiles: () => [],
      },
    });

    await role.assembleContext(job, ctx);

    const persisted = JSON.parse(getJob(fixJobRow.id).payload_json || "{}");
    assert.deepEqual(persisted.files_to_delete, ["FlowInspector.tsx"]);
    assert.deepEqual(persisted.files_to_modify, []);
    assert.deepEqual(persisted.files_to_create, []);
    assert.deepEqual(persisted.create_roots, []);
    assert.equal(fs.existsSync(path.join(root, "FlowInspector.tsx")), false);
    assert.match(ctx.providerResult.output, /Deterministic delete handoff completed/);
  }));

  it("fix handoff guard persists existing edit targets named in fix instructions", () => withTempRuntimeDb(async (root) => {
    fs.mkdirSync(path.join(root, "src", "workers"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "workers", "payloads.py"), "def dataframe_from_payload(payload):\n    return payload\n", "utf8");
    setSetting("fix_scope_handoff_guard", "warn");

    const wi = createWorkItem("Payload validation", "desc");
    const fixJobRow = createJob({
      work_item_id: wi.id,
      job_type: "fix",
      title: "Fix: Reject invalid payload data",
      payload_json: JSON.stringify({
        fix_instructions: "Update `src/workers/payloads.py` in `dataframe_from_payload` so string data returns None.",
        files_to_modify: [],
        files_to_create: [],
        files_to_delete: [],
        create_roots: [],
        task_mode: "code",
      }),
    });
    const job = new Job({
      row: fixJobRow,
      deps: {
        getDependencies: () => [],
        getJob: () => null,
      },
    });
    const role = new FixRole({
      providerClient: { call: async () => ({ output: "", stats: {} }) },
      context: {
        projectDir: root,
        parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
        emit() {},
        detectDrift: () => "",
        primeCreatableFiles: () => [],
      },
    });
    const ctx = { tier: "standard", attemptId: 1 };

    await role.assembleContext(job, ctx);

    const persisted = JSON.parse(getJob(fixJobRow.id).payload_json || "{}");
    assert.deepEqual(persisted.files_to_modify, ["src/workers/payloads.py"]);
    assert.deepEqual(ctx.fixEditableScope, ["src/workers/payloads.py"]);
    assert.deepEqual(JSON.parse(job.payload_json || "{}").files_to_modify, ["src/workers/payloads.py"]);
  }));

  it("fix handoff guard can be disabled for inferred edit targets", () => withTempRuntimeDb((root) => {
    fs.mkdirSync(path.join(root, "src", "workers"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "workers", "payloads.py"), "def f():\n    pass\n", "utf8");
    setSetting("fix_scope_handoff_guard", "off");

    const packet = {
      job_type: "fix",
      cwd: root,
      files_to_modify: [],
      files_to_create: [],
      files_to_delete: [],
      _raw_payload: {
        fix_instructions: "Update `src/workers/payloads.py` so invalid strings return None.",
        files_to_modify: [],
      },
    };

    assert.deepEqual(applyFixScopeHandoffGuard(packet), []);
    assert.deepEqual(packet.files_to_modify, []);
  }));

  it("fix handoff guard enforce mode blocks inferred scope broadening", () => withTempRuntimeDb((root) => {
    fs.mkdirSync(path.join(root, "src", "workers"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "workers", "payloads.py"), "def f():\n    pass\n", "utf8");
    setSetting("fix_scope_handoff_guard", "enforce");

    const packet = {
      job_type: "fix",
      cwd: root,
      work_item_id: null,
      job_id: null,
      files_to_modify: [],
      files_to_create: [],
      files_to_delete: [],
      _raw_payload: {
        fix_instructions: "Update `src/workers/payloads.py` so invalid strings return None.",
        files_to_modify: [],
      },
    };

    assert.throws(
      () => applyFixScopeHandoffGuard(packet),
      /blocked inferred write-scope expansion.*src\/workers\/payloads\.py/,
    );
    assert.deepEqual(packet.files_to_modify, []);
    assert.deepEqual(packet.fix_scope_guard_blocked, ["src/workers/payloads.py"]);
  }));

  it("fix role narrows generated artifact cleanup to deterministic delete-only scope", () => withTempRuntimeDb(async (root) => {
    fs.mkdirSync(path.join(root, "src", "mike"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests", "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "mike", "trend.py"), "class Trend:\n    pass\n", "utf8");
    fs.writeFileSync(path.join(root, "tests", "test_trend.py"), "def test_trend():\n    assert True\n", "utf8");
    fs.writeFileSync(path.join(root, "tests", "__pycache__", "test_trend.cpython-314-pytest-9.0.3.pyc"), "bytecode", "utf8");

    const wi = createWorkItem("Signals", "desc");
    const fixJobRow = createJob({
      work_item_id: wi.id,
      job_type: "fix",
      title: "Retry: Fix: Remove Out-of-Scope Pycache Artifact",
      payload_json: JSON.stringify({
        fix_instructions: "Delete the out-of-scope pyc artifact and keep source files unchanged.",
        files_to_modify: ["src/mike/trend.py", "tests/test_trend.py"],
        files_to_create: ["src/mike/trend.py", "tests/test_trend.py"],
        files_to_delete: [
          "tests/__pycache__/test_trend.cpython-314-pytest-9.0.3.pyc",
          "tests/__pycache__",
        ],
        create_roots: [],
        task_mode: "code",
      }),
    });
    const job = new Job({
      row: { ...fixJobRow, _worktreePath: root },
      deps: {
        getDependencies: () => [],
        getJob: () => null,
      },
    });
    const role = new FixRole({
      providerClient: { call: async () => { throw new Error("delete-only cleanup should not call provider"); } },
      context: {
        projectDir: root,
        parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
        emit() {},
        detectDrift: () => "",
        primeCreatableFiles: () => [],
      },
    });
    const ctx = { tier: "standard", attemptId: 1 };

    await role.assembleContext(job, ctx);

    assert.equal(ctx.fixDeleteOnlyTask, true);
    assert.match(ctx.providerResult.output, /Deleted 1 file/);
    assert.equal(fs.existsSync(path.join(root, "tests", "__pycache__", "test_trend.cpython-314-pytest-9.0.3.pyc")), false);
    const persisted = JSON.parse(getJob(fixJobRow.id).payload_json || "{}");
    assert.deepEqual(persisted.files_to_delete, ["tests/__pycache__/test_trend.cpython-314-pytest-9.0.3.pyc"]);
    assert.deepEqual(persisted.files_to_modify, []);
    assert.deepEqual(persisted.files_to_create, []);
    assert.deepEqual(persisted.create_roots, []);
  }));
});
