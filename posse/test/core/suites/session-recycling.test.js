import {
  assert,
  beforeEach,
  fs,
  it,
  os,
  path,
  suite,
  resetRuntimeDb,
  runtimeModules,
  withQueueSettings,
} from "../support/core-harness.js";
import {
  acquireSessionHandle,
  advanceSessionHandle,
  aggregateSessionRecycleSavings,
  ensureSessionLane,
  expireStaleSessionLeases,
  getActiveSessionForLane,
  invalidateSessionLane,
  listSessionLanes,
  listSessionRecycleSavings,
  recordInitialSessionHandle,
  recordSessionRecycleSavings,
  releaseSessionHandle,
  sessionLeaseTtlSec,
} from "../../../lib/domains/queue/functions/sessions.js";
import {
  canonicalSkillKey,
  deriveSessionKey,
  providerRoleForJobType,
} from "../../../lib/domains/session/functions/keys.js";
import {
  providerCoverageForReuse,
  requiredCoverageRolesForMode,
  transitionAllowsRecycling,
} from "../../../lib/domains/session/functions/eligibility.js";
import {
  computeOverlap,
  shouldRecycleSiblingDevJobs,
} from "../../../lib/domains/session/functions/overlap.js";
import { SessionManager } from "../../../lib/domains/session/classes/SessionManager.js";
import { validateAdminSettingValue } from "../../../lib/domains/ui/classes/admin/settings-controller.js";
import {
  getCatalogEntry,
  isAdminVisibleCatalogKey,
} from "../../../lib/domains/settings/functions/catalog.js";
import {
  getSessionManager,
  resetSessionManagerForTests,
  resolveGlobalSessionRecycleMode,
  resolveSessionRecycleModeForWorkItem,
} from "../../../lib/domains/session/functions/manager-singleton.js";
import { skillRecyclePolicyForJob } from "../../../lib/domains/session/functions/skill-policy.js";
import {
  clearSkillRegistryCache,
  loadSkillManifests,
} from "../../../lib/shared/skills/functions/registry.js";
import { buildResumeHandoff } from "../../../lib/domains/handoff/functions/index.js";
import { parseSessionRecycleFlagFromArgv } from "../../../lib/domains/cli/functions/flags.js";
import {
  isSessionResumeCapableProvider,
  getSessionResumeCapableProviders,
} from "../../../lib/domains/providers/functions/provider.js";
import {
  __testExtractClaudeSessionHandleFromStreamMessage,
  __testIsClaudeResumeHandleExpiredError,
} from "../../../lib/domains/providers/functions/claude.js";
import { __testExtractCodexSessionHandleFromStreamMessage } from "../../../lib/domains/providers/functions/codex.js";

function payload(value) {
  return JSON.stringify(value);
}

function makeWorkItemAndJob({ jobType = "dev", provider = "openai", skills = null, payloadJson = null } = {}) {
  const { queueMod } = runtimeModules;
  const wi = queueMod.createWorkItem("Session recycle", "desc");
  const job = queueMod.createJob({
    work_item_id: wi.id,
    job_type: jobType,
    title: `${jobType} job`,
    provider,
    skills,
    payload_json: payloadJson,
  });
  return { wi, job };
}

suite("Session Recycling", () => {
  beforeEach(() => {
    resetRuntimeDb();
    resetSessionManagerForTests();
    clearSkillRegistryCache();
  });

  it("resets a strict reuse lane instead of resuming across a provider switch", () => {
    const { queueMod } = runtimeModules;
    const { job } = makeWorkItemAndJob({ provider: "openai" });
    const fixJob = queueMod.createJob({
      work_item_id: job.work_item_id,
      job_type: "fix",
      title: "fix job",
      provider: "claude",
    });
    const manager = new SessionManager({
      recycleMode: "dev-fix",
      providerMap: { dev: "openai,claude", assessor: "openai,claude" },
    });

    const created = manager.recordFreshHandleForJob(job, {
      provider: "openai",
      handle: "resp-1",
    });
    assert.equal(created.lane.provider, "openai");
    assert.equal(created.session.handle, "resp-1");

    const switched = manager.acquireForJob(fixJob, {
      provider: "claude",
      jobId: fixJob.id,
    });
    assert.equal(switched.providerLocked, false);
    assert.equal(switched.requestedProvider, "claude");
    assert.equal(switched.provider, "claude");
    assert.equal(switched.recyclingMode, "fresh");
    assert.equal(switched.reason, "provider_switch_reset");
    assert.equal(switched.sessionHandle, null);

    const lanes = listSessionLanes({ workItemId: job.work_item_id, status: null });
    assert.equal(lanes.some((lane) => lane.provider === "openai" && lane.status === "invalidated"), true);
    assert.equal(lanes.some((lane) => lane.provider === "claude" && lane.status === "active"), true);
  });

  it("falls through on lock contention without double-leasing a session", () => {
    const { job } = makeWorkItemAndJob();
    const lane = ensureSessionLane({
      workItemId: job.work_item_id,
      lane: "dev",
      provider: "openai",
    }).lane;
    const session = recordInitialSessionHandle({
      laneId: lane.id,
      handle: "resp-1",
      parentJobId: job.id,
    });

    const first = acquireSessionHandle({ laneId: lane.id, jobId: job.id, leaseTtlSec: 60 });
    const second = acquireSessionHandle({ laneId: lane.id, jobId: job.id, leaseTtlSec: 60 });
    assert.equal(first.id, session.id);
    assert.ok(first.leaseToken);
    assert.equal(second, null);

    assert.equal(releaseSessionHandle(first.id, first.leaseToken), 1);
    const afterRelease = acquireSessionHandle({ laneId: lane.id, jobId: job.id, leaseTtlSec: 60 });
    assert.equal(afterRelease.id, session.id);
  });

  it("advances handles by CAS token and increments hop count", () => {
    const { job } = makeWorkItemAndJob();
    const lane = ensureSessionLane({
      workItemId: job.work_item_id,
      lane: "dev",
      provider: "openai",
    }).lane;
    const session = recordInitialSessionHandle({ laneId: lane.id, handle: "resp-1", parentJobId: job.id });
    const lease = acquireSessionHandle({ laneId: lane.id, jobId: job.id });

    assert.equal(advanceSessionHandle({
      sessionId: session.id,
      leaseToken: "wrong",
      newHandle: "resp-2",
      jobId: job.id,
    }), null);

    const advanced = advanceSessionHandle({
      sessionId: session.id,
      leaseToken: lease.leaseToken,
      newHandle: "resp-2",
      jobId: job.id,
    });
    assert.equal(advanced.handle, "resp-2");
    assert.equal(advanced.hop_count, 1);
    assert.equal(advanced.leased_by, null);
  });

  it("invalidates the lane and its active session together", () => {
    const { job } = makeWorkItemAndJob();
    const lane = ensureSessionLane({
      workItemId: job.work_item_id,
      lane: "dev",
      provider: "openai",
    }).lane;
    const session = recordInitialSessionHandle({ laneId: lane.id, handle: "resp-1", parentJobId: job.id });

    assert.equal(invalidateSessionLane(lane.id, "needs_replan"), 1);
    const { dbMod } = runtimeModules;
    const db = dbMod.getDb();
    const laneRow = db.prepare(`SELECT * FROM session_lanes WHERE id = ?`).get(lane.id);
    const sessionRow = db.prepare(`SELECT * FROM job_sessions WHERE id = ?`).get(session.id);
    assert.equal(laneRow.status, "invalidated");
    assert.equal(laneRow.reason, "needs_replan");
    assert.equal(sessionRow.status, "invalidated");
    assert.equal(sessionRow.reason, "needs_replan");
  });

  it("invalidates active lanes when a work item reaches a terminal state", () => {
    const { queueMod, dbMod } = runtimeModules;
    const { wi, job } = makeWorkItemAndJob();
    const lane = ensureSessionLane({
      workItemId: wi.id,
      lane: "dev",
      provider: "openai",
    }).lane;
    const session = recordInitialSessionHandle({ laneId: lane.id, handle: "resp-1", parentJobId: job.id });

    assert.equal(queueMod.updateJobStatus(job.id, "succeeded"), true);
    assert.equal(queueMod.updateWorkItemStatus(wi.id, "complete"), true);
    const laneRow = dbMod.getDb().prepare(`SELECT * FROM session_lanes WHERE id = ?`).get(lane.id);
    const sessionRow = dbMod.getDb().prepare(`SELECT * FROM job_sessions WHERE id = ?`).get(session.id);
    const event = dbMod.getDb().prepare(`
      SELECT * FROM events WHERE work_item_id = ? AND event_type = 'session_invalidated'
    `).get(wi.id);
    assert.equal(laneRow.status, "invalidated");
    assert.equal(laneRow.reason, "work_item_complete");
    assert.equal(sessionRow.status, "invalidated");
    assert.equal(event.message.includes("work_item_complete"), true);
  });

  it("releases stale leases without expiring resumable provider session state", () => {
    const { job } = makeWorkItemAndJob();
    const lane = ensureSessionLane({
      workItemId: job.work_item_id,
      lane: "dev",
      provider: "openai",
    }).lane;
    const session = recordInitialSessionHandle({ laneId: lane.id, handle: "resp-1", parentJobId: job.id });
    const lease = acquireSessionHandle({ laneId: lane.id, jobId: job.id });
    const { dbMod } = runtimeModules;
    dbMod.getDb().prepare(`
      UPDATE job_sessions SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?
    `).run(session.id);

    assert.equal(expireStaleSessionLeases(), 1);
    const active = getActiveSessionForLane(lane.id);
    assert.equal(active.id, session.id);
    assert.equal(active.status, "active");
    assert.equal(active.leased_by, null);
    assert.equal(active.lease_token, null);
    assert.equal(advanceSessionHandle({
      sessionId: session.id,
      leaseToken: lease.leaseToken,
      newHandle: "resp-2",
      jobId: job.id,
    }), null);
    const reacquired = acquireSessionHandle({ laneId: lane.id, jobId: job.id, leaseTtlSec: 60 });
    assert.equal(reacquired.id, session.id);
  });

  it("records token savings separately from event telemetry", () => {
    const { job } = makeWorkItemAndJob();
    const lane = ensureSessionLane({
      workItemId: job.work_item_id,
      lane: "dev",
      provider: "openai",
    }).lane;
    const session = recordInitialSessionHandle({ laneId: lane.id, handle: "resp-1", parentJobId: job.id });

    const row = recordSessionRecycleSavings({
      jobId: job.id,
      workItemId: job.work_item_id,
      laneId: lane.id,
      sessionId: session.id,
      role: "dev",
      provider: "openai",
      hopCount: 2,
      tokensResume: 120,
      tokensFreshEstimate: 100,
      estimateMethod: "baseline",
    });
    assert.equal(row.tokens_saved, -20);
    assert.equal(listSessionRecycleSavings({ workItemId: job.work_item_id }).length, 1);
    const aggregate = aggregateSessionRecycleSavings({ workItemId: job.work_item_id });
    assert.equal(aggregate[0].tokens_saved, -20);
    assert.equal(aggregate[0].negative_samples, 1);
  });

  it("canonicalizes session keys and maps fix jobs back onto the dev lane", () => {
    const { job } = makeWorkItemAndJob({
      jobType: "fix",
      provider: "openai",
      skills: ["migration", "frontend-design"],
    });
    const key = deriveSessionKey(job);

    assert.equal(providerRoleForJobType("fix"), "dev");
    assert.equal(key.lane, "dev");
    assert.equal(key.skillKey, canonicalSkillKey(["frontend-design", "migration"]));
  });

  it("gates skill-bound jobs on recycle_session frontmatter", () => {
    const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-recycle-skills-"));
    try {
      fs.mkdirSync(path.join(skillsDir, "ui"), { recursive: true });
      fs.mkdirSync(path.join(skillsDir, "security"), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, "ui", "SKILL.md"), [
        "---",
        "id: ui",
        "name: UI",
        "applies_to: [dev]",
        "recycle_session: true",
        "---",
        "UI guidance.",
      ].join("\n"));
      fs.writeFileSync(path.join(skillsDir, "security", "SKILL.md"), [
        "---",
        "id: security",
        "name: Security",
        "applies_to: [dev]",
        "recycle_session: false",
        "---",
        "Security guidance.",
      ].join("\n"));

      const manifests = loadSkillManifests({ skillsDir, force: true });
      assert.equal(manifests.find((skill) => skill.id === "ui")?.recycle_session, true);
      assert.equal(manifests.find((skill) => skill.id === "security")?.recycle_session, false);
      assert.equal(skillRecyclePolicyForJob({ skills: ["ui"] }, { skillsDir }).ok, true);
      const blocked = skillRecyclePolicyForJob({ skills: ["security"] }, { skillsDir });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.reason, "skill_recycle_disabled");
      assert.deepEqual(blocked.deniedSkills, ["security"]);
    } finally {
      fs.rmSync(skillsDir, { recursive: true, force: true });
      clearSkillRegistryCache();
    }
  });

  it("denies session acquisition when a selected skill is not recycle-safe", () => {
    const { job } = makeWorkItemAndJob({ provider: "openai", skills: ["security"] });
    const manager = new SessionManager({
      recycleMode: "dev-fix",
      providerMap: { dev: "openai", assessor: "openai" },
      skillPolicyResolver: () => ({
        ok: false,
        reason: "skill_recycle_disabled",
        skillIds: ["security"],
        deniedSkills: ["security"],
      }),
    });

    const result = manager.acquireForJob(job, { provider: "openai", jobId: job.id });
    assert.equal(result.recyclingMode, "fresh");
    assert.equal(result.reason, "skill_recycle_not_allowed");
  });

  it("gates reuse on provider coverage across the required reuse lane roles", () => {
    assert.deepEqual(requiredCoverageRolesForMode("dev-fix"), ["dev", "assessor"]);
    assert.deepEqual(requiredCoverageRolesForMode("full"), ["dev", "planner", "assessor"]);
    assert.equal(providerCoverageForReuse({
      providerName: "openai",
      providerMap: { dev: "openai,claude", assessor: "openai" },
      mode: "dev-fix",
    }).ok, true);

    const missing = providerCoverageForReuse({
      providerName: "openai",
      providerMap: { dev: "openai", assessor: "claude" },
      mode: "dev-fix",
    });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.missingRoles, ["assessor"]);
  });

  it("keeps session resume capability explicit per provider", () => {
    const capable = getSessionResumeCapableProviders();
    assert.equal(isSessionResumeCapableProvider("openai"), true);
    assert.equal(isSessionResumeCapableProvider("claude"), true);
    assert.equal(isSessionResumeCapableProvider("grok"), false);
    assert.equal(isSessionResumeCapableProvider("codex"), true);
    assert.equal(capable.has("openai"), true);
    assert.equal(capable.has("claude"), true);
    assert.equal(capable.has("codex"), true);
  });

  it("extracts Claude resume session handles from stream-json messages", () => {
    assert.equal(__testExtractClaudeSessionHandleFromStreamMessage({ session_id: "abc" }), "abc");
    assert.equal(__testExtractClaudeSessionHandleFromStreamMessage({ result: { sessionId: "nested" } }), "nested");
    assert.equal(__testExtractClaudeSessionHandleFromStreamMessage({ type: "result", message: { conversation_id: "conv" } }), "conv");
    assert.equal(__testExtractClaudeSessionHandleFromStreamMessage({ type: "result" }), null);
  });

  it("extracts Codex resume session handles from JSONL stream messages", () => {
    assert.equal(__testExtractCodexSessionHandleFromStreamMessage({ msg: { type: "session_configured", session_id: "codex-session" } }), "codex-session");
    assert.equal(__testExtractCodexSessionHandleFromStreamMessage({ type: "thread.started", thread_id: "thread-1" }), "thread-1");
    assert.equal(__testExtractCodexSessionHandleFromStreamMessage({ result: { sessionId: "nested" } }), "nested");
    assert.equal(__testExtractCodexSessionHandleFromStreamMessage({ type: "agent_message", message: "hello" }), null);
  });

  it("registers session recycle settings in the admin catalog with validation", () => {
    assert.equal(isAdminVisibleCatalogKey("session_recycle_mode"), true);
    assert.equal(isAdminVisibleCatalogKey("session_recycle_strict_provider"), true);
    assert.equal(isAdminVisibleCatalogKey("posse_session_lease_ttl"), true);

    assert.deepEqual(validateAdminSettingValue("session_recycle_mode", "DEV-FIX"), {
      ok: true,
      storageKey: "session_recycle_mode",
      value: "dev-fix",
    });
    assert.equal(validateAdminSettingValue("session_recycle_mode", "maybe").ok, false);
    assert.deepEqual(validateAdminSettingValue("session_recycle_strict_provider", "false"), {
      ok: true,
      storageKey: "session_recycle_strict_provider",
      value: "false",
    });
    assert.deepEqual(validateAdminSettingValue("posse_session_lease_ttl", "45"), {
      ok: true,
      storageKey: "posse_session_lease_ttl",
      value: "45",
    });
    assert.equal(validateAdminSettingValue("posse_session_lease_ttl", "0").ok, false);
  });

  it("honors the session lease TTL admin setting", () => {
    withQueueSettings({ posse_session_lease_ttl: "45" }, () => {
      assert.equal(sessionLeaseTtlSec(), 45);
    });
  });

  it("constructs the session manager singleton from mode settings and work-item overrides", () => {
    withQueueSettings({
      session_recycle_mode: "full",
      provider_dev: "openai",
      provider_planner: "openai",
      provider_assessor: "openai",
      provider_artificer: "openai",
    }, () => {
      resetSessionManagerForTests();
      assert.equal(resolveGlobalSessionRecycleMode(), "full");
      const manager = getSessionManager();
      assert.equal(manager.recycleMode, "full");
      assert.deepEqual(manager.requiredRoles, ["dev", "planner", "assessor"]);

      const { queueMod } = runtimeModules;
      const wi = queueMod.createWorkItem("Override", "desc");
      assert.equal(resolveSessionRecycleModeForWorkItem(wi, { fallbackMode: "full" }), "full");
    });
  });

  it("honors account recycle mode and per-work-item overrides", () => {
    withQueueSettings({ session_recycle_mode: "off" }, () => {
      resetSessionManagerForTests();
      assert.equal(resolveGlobalSessionRecycleMode(), "off");
    });

    const { queueMod, dbMod } = runtimeModules;
    const on = queueMod.createWorkItem("On", "desc");
    const off = queueMod.createWorkItem("Off", "desc");
    dbMod.getDb().prepare(`UPDATE work_items SET session_recycle = 'on' WHERE id = ?`).run(on.id);
    dbMod.getDb().prepare(`UPDATE work_items SET session_recycle = 'off' WHERE id = ?`).run(off.id);

    assert.equal(queueMod.getWorkItemRecycleOverride(on.id), "dev-fix");
    assert.equal(queueMod.getWorkItemRecycleOverride(off.id), "off");
    assert.equal(resolveSessionRecycleModeForWorkItem(on.id, { fallbackMode: "full" }), "dev-fix");
    assert.equal(resolveSessionRecycleModeForWorkItem(off.id, { fallbackMode: "full" }), "off");
  });

  it("persists per-work-item session recycling overrides from queue creation options", () => {
    const { queueMod } = runtimeModules;
    const on = queueMod.createWorkItem("On", "desc", "normal", { session_recycle: "on" });
    const off = queueMod.createWorkItem("Off", "desc", "normal", { session_recycle: "off" });
    const invalid = queueMod.createWorkItem("Invalid", "desc", "normal", { session_recycle: "maybe" });

    assert.equal(queueMod.getWorkItem(on.id).session_recycle, "on");
    assert.equal(queueMod.getWorkItem(off.id).session_recycle, "off");
    assert.equal(queueMod.getWorkItem(invalid.id).session_recycle, null);
  });

  it("parses session recycling intake flags without environment configuration", () => {
    const originalArgv = process.argv;
    try {
      process.argv = ["node", "orchestrator.js", "add", "--session-recycle", "task"];
      assert.equal(parseSessionRecycleFlagFromArgv(), "on");
      process.argv = ["node", "orchestrator.js", "add", "--session-recycle=off", "task"];
      assert.equal(parseSessionRecycleFlagFromArgv(), "off");
      process.argv = ["node", "orchestrator.js", "add", "--no-session-recycle", "task"];
      assert.equal(parseSessionRecycleFlagFromArgv(), "off");
      process.argv = ["node", "orchestrator.js", "add", "task"];
      assert.equal(parseSessionRecycleFlagFromArgv(), null);
    } finally {
      process.argv = originalArgv;
    }
  });

  it("blocks recycle acquisition when the provider lacks resume capability", () => {
    const { job } = makeWorkItemAndJob({ provider: "grok" });
    const manager = new SessionManager({
      recycleMode: "dev-fix",
      providerMap: { dev: "grok", assessor: "grok" },
    });

    const result = manager.acquireForJob(job, { provider: "grok", jobId: job.id });
    assert.equal(result.recyclingMode, "fresh");
    assert.equal(result.reason, "provider_capability_gap");
  });

  it("keeps artificer jobs out of session recycling", () => {
    const { job } = makeWorkItemAndJob({ jobType: "artificer", provider: "claude" });
    const manager = new SessionManager({
      recycleMode: "full",
      providerMap: {
        dev: "claude",
        planner: "claude",
        assessor: "claude",
        artificer: "claude",
      },
    });

    const result = manager.acquireForJob(job, { provider: "claude", jobId: job.id });
    assert.equal(result.recyclingMode, "fresh");
    assert.equal(result.reason, "non_recyclable_lane");
    assert.equal(result.sessionHandle, undefined);
    assert.deepEqual(listSessionLanes({ workItemId: job.work_item_id, status: null }), []);
  });

  it("uses Jaccard overlap for dev sibling recycling boundaries", () => {
    const base = {
      payload_json: payload({
        files_to_modify: ["src/a.js", "src/b.js"],
        files_to_create: ["src/c.js"],
      }),
    };
    const high = {
      payload_json: payload({
        files_to_modify: ["src/a.js", "src/b.js"],
        files_to_create: ["src/d.js"],
      }),
    };
    const low = {
      payload_json: payload({
        files_to_modify: ["src/a.js", "src/d.js"],
        files_to_create: ["src/e.js"],
      }),
    };

    assert.equal(computeOverlap(base, high), 0.5);
    assert.equal(shouldRecycleSiblingDevJobs(base, high), true);
    assert.equal(computeOverlap(base, low), 0.2);
    assert.equal(shouldRecycleSiblingDevJobs(base, low), false);
    assert.equal(computeOverlap(base, { payload_json: "{}" }), 0);

    const caseVariantA = { payload_json: payload({ files_to_modify: ["Lib/File.js"] }) };
    const caseVariantB = { payload_json: payload({ files_to_modify: ["lib/file.js"] }) };
    assert.equal(computeOverlap(caseVariantA, caseVariantB), process.platform === "win32" ? 1 : 0);
  });

  it("counts create_roots when computing sibling overlap", () => {
    const base = {
      payload_json: payload({
        files_to_modify: [],
        files_to_create: [],
        create_roots: ["assets/generated"],
      }),
    };
    const sameRoot = {
      payload_json: payload({
        files_to_modify: [],
        files_to_create: [],
        create_roots: ["assets/generated"],
      }),
    };
    const nestedRoot = {
      payload_json: payload({
        files_to_modify: [],
        files_to_create: [],
        create_roots: ["assets/generated/icons"],
      }),
    };
    const fileInsideRoot = {
      payload_json: payload({
        files_to_modify: ["assets/generated/icon.svg"],
      }),
    };

    assert.equal(computeOverlap(base, sameRoot), 1);
    assert.equal(computeOverlap(base, nestedRoot), 0.5);
    assert.equal(computeOverlap(base, fileInsideRoot), 0.5);
  });

  it("computes large scoped overlaps without pairwise path scans", () => {
    const generatedFiles = Array.from(
      { length: 300 },
      (_, index) => `assets/generated/chunk-${index}/icon.svg`,
    );
    const unrelatedFiles = Array.from(
      { length: 300 },
      (_, index) => `src/unrelated-${index}.js`,
    );
    const base = {
      payload_json: payload({
        files_to_modify: generatedFiles,
      }),
    };
    const largeScopedRoot = {
      payload_json: payload({
        files_to_modify: unrelatedFiles,
        create_roots: ["assets/generated"],
      }),
    };

    assert.equal(computeOverlap(base, largeScopedRoot), 300 / 601);
  });

  it("allows only explicit same-lane transitions", () => {
    assert.equal(transitionAllowsRecycling("dev", "fix"), true);
    assert.equal(transitionAllowsRecycling("fix", "fix"), true);
    assert.equal(transitionAllowsRecycling("plan", "plan"), true);
    assert.equal(transitionAllowsRecycling("dev", "dev", { overlap: 0.51 }), true);
    assert.equal(transitionAllowsRecycling("dev", "dev", { overlap: 0.49 }), false);
    assert.equal(transitionAllowsRecycling("fix", "dev", { overlap: 1 }), false);
    assert.equal(transitionAllowsRecycling("dev", "assess"), false);
    assert.equal(transitionAllowsRecycling("artificer", "artificer"), false);
  });

  it("detects Claude missing conversation resume errors", () => {
    assert.equal(
      __testIsClaudeResumeHandleExpiredError("No conversation found with session ID: 51ca1322-a108-40e4-a8cd-68f1df7a7d7f"),
      true,
    );
    assert.equal(__testIsClaudeResumeHandleExpiredError("claude exited 1"), false);
  });

  it("resets the active lineage when a same-lane transition is denied", () => {
    const { queueMod, dbMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Transition reset", "desc");
    const first = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "first",
      provider: "openai",
      payload_json: payload({ files_to_modify: ["src/a.js"], files_to_create: [] }),
    });
    const second = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "second",
      provider: "openai",
      payload_json: payload({ files_to_modify: ["src/b.js"], files_to_create: [] }),
    });
    const manager = new SessionManager({
      recycleMode: "dev-fix",
      providerMap: { dev: "openai", assessor: "openai" },
    });
    const initial = manager.recordFreshHandleForJob(first, {
      provider: "openai",
      handle: "resp-1",
    });

    const decision = manager.acquireForJob(second, { provider: "openai", jobId: second.id });
    assert.equal(decision.recyclingMode, "fresh");
    assert.equal(decision.reason, "transition_reset");
    assert.equal(decision.transition.from, "dev");
    assert.equal(decision.transition.to, "dev");
    assert.equal(decision.transition.overlap, 0);
    assert.notEqual(decision.lane.id, initial.lane.id);

    const oldLane = dbMod.getDb().prepare(`SELECT * FROM session_lanes WHERE id = ?`).get(initial.lane.id);
    const oldSession = dbMod.getDb().prepare(`SELECT * FROM job_sessions WHERE id = ?`).get(initial.session.id);
    assert.equal(oldLane.status, "invalidated");
    assert.equal(oldSession.status, "invalidated");
  });

  it("stores provider session handles on agent call telemetry", () => {
    const { queueMod, dbMod } = runtimeModules;
    const { job } = makeWorkItemAndJob();
    const call = queueMod.createAgentCall({
      work_item_id: job.work_item_id,
      job_id: job.id,
      role: "dev",
      model_tier: "standard",
      provider: "openai",
      prior_session_handle: "resp-1",
    });
    queueMod.completeAgentCall(call.id, {
      status: "succeeded",
      session_handle: "resp-2",
    });
    const stored = dbMod.getDb().prepare(`
      SELECT prior_session_handle, session_handle FROM agent_calls WHERE id = ?
    `).get(call.id);
    assert.equal(stored.prior_session_handle, "resp-1");
    assert.equal(stored.session_handle, "resp-2");
  });

  it("builds a resume handoff delta and records lineage metadata on the packet", () => {
    const packet = {
      job_id: 42,
      prompt_dynamic_context: "DYNAMIC FILE CONTEXT",
    };
    const prompt = buildResumeHandoff({
      packet,
      instructions: "Fix only the failing assertion.",
      priorSession: { id: 7, hop_count: 1, parent_job_id: 41 },
      role: "dev",
    });

    assert.match(prompt, /SESSION RESUME DELTA/);
    assert.match(prompt, /Fix only the failing assertion/);
    assert.match(prompt, /DYNAMIC FILE CONTEXT/);
    assert.deepEqual(packet.resumed_from, { session_id: 7, hop_count: 1 });
  });
});
