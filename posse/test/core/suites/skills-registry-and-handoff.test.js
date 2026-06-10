import {
  it,
  beforeEach,
  assert,
  fs,
  os,
  path,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  handoff,
  clearSkillRegistryCache,
  getEnabledSkillsForRole,
  loadSkillManifests,
  validateSkillIds,
  AdminTUI,
} from "../support/core-harness.js";

let db;

suite("Skills registry and handoff", () => {
  beforeEach(() => { resetRuntimeDb(); clearSkillRegistryCache(); });

  it("loads skill manifests, filters by role, and busts cache when SKILL.md changes", () => {
    const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-skills-"));
    try {
      fs.mkdirSync(path.join(skillsDir, "ui"), { recursive: true });
      fs.mkdirSync(path.join(skillsDir, "docs"), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, "ui", "SKILL.md"), [
        "---",
        "id: ui-design",
        "name: UI Design",
        "description: Interface work",
        "applies_to: [dev, artificer]",
        "when_to_use: UI changes",
        "---",
        "Prefer existing components.",
      ].join("\n"), "utf-8");
      fs.writeFileSync(path.join(skillsDir, "docs", "SKILL.md"), [
        "---",
        "id: docs",
        "name: Docs",
        "description: Documentation",
        "applies_to: [artificer]",
        "when_to_use: Writing docs",
        "---",
        "Write clearly.",
      ].join("\n"), "utf-8");

      assert.deepEqual(loadSkillManifests({ skillsDir }).map((skill) => skill.id), ["docs", "ui-design"]);
      assert.deepEqual(getEnabledSkillsForRole("dev", { skillsDir, skillsEnabled: true, disabledIds: new Set() }).map((skill) => skill.id), ["ui-design"]);
      assert.deepEqual(getEnabledSkillsForRole("artificer", { skillsDir, skillsEnabled: true, disabledIds: new Set() }), []);
      assert.deepEqual(
        validateSkillIds(["ui-design", "docs", "missing"], "dev", { skillsDir, skillsEnabled: true, disabledIds: new Set(["docs"]) }),
        { valid: ["ui-design"], invalid: ["missing"], disabled: ["docs"] },
      );
      assert.deepEqual(
        validateSkillIds(["ui-design", "docs", "missing"], "artificer", { skillsDir, skillsEnabled: true, disabledIds: new Set() }),
        { valid: [], invalid: ["missing"], disabled: ["ui-design", "docs"] },
      );

      fs.appendFileSync(path.join(skillsDir, "ui", "SKILL.md"), "\nUpdated guidance.\n", "utf-8");
      const updated = loadSkillManifests({ skillsDir }).find((skill) => skill.id === "ui-design");
      assert.match(updated.body, /Updated guidance/);
    } finally {
      fs.rmSync(skillsDir, { recursive: true, force: true });
    }
  });

  it("stores requested job skills and actual agent-call attachments", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Skill storage", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Use skill",
      skills: ["frontend-design"],
    });
    assert.equal(job.skills, JSON.stringify(["frontend-design"]));

    const call = queueMod.createAgentCall({
      work_item_id: wi.id,
      job_id: job.id,
      role: "dev",
      model_tier: "standard",
      skills: ["frontend-design"],
    });
    queueMod.completeAgentCall(call.id, { status: "succeeded", skills: ["frontend-design"] });
    const stored = runtimeModules.dbMod.getDb().prepare(`SELECT skills FROM agent_calls WHERE id = ?`).get(call.id);
    assert.equal(stored.skills, JSON.stringify(["frontend-design"]));
  });

  it("attaches selected skills in stable handoff context and logs attachment events", async () => {
    const { queueMod, handoffMod, dbMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-skill-handoff-"));
    try {
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "src", "App.jsx"), "export function App() { return null; }\n", "utf-8");
      queueMod.setSetting("skills_enabled", "true");
      queueMod.setSetting("skills_disabled_ids", "");
      const wi = queueMod.createWorkItem("Skill handoff", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Polish UI",
        payload_json: {
          task_spec: "Improve the UI.",
          files_to_modify: ["src/App.jsx"],
          success_criteria: ["UI is improved"],
        },
        skills: ["frontend-design"],
      });
      const packet = await handoffMod.handoff(handoffMod.buildRoutingPacket(job, {
        workItem: wi,
        payload: JSON.parse(job.payload_json),
        role: "dev",
        effectiveTier: "standard",
        cwd: projectDir,
      }));
      const context = handoffMod.packetToContextString(packet);

      assert.deepEqual(packet.skills_attached, ["frontend-design"]);
      assert.match(context, /SKILLS \(planner-selected stable guidance\)/);
      assert.match(context, /=== SKILL: frontend-design/);
      queueMod.flushEventsNow();
      const event = dbMod.getDb().prepare(`SELECT * FROM events WHERE event_type = 'skill_attached'`).get();
      assert.ok(event);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("attaches dev skills for image-adjacent repo-edit handoffs", async () => {
    const { queueMod, handoffMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-skill-image-adjacent-"));
    try {
      fs.mkdirSync(path.join(projectDir, "htdocs/learn"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "htdocs/learn/page.html"), "<main></main>\n", "utf-8");
      queueMod.setSetting("skills_enabled", "true");
      queueMod.setSetting("skills_disabled_ids", "");
      const wi = queueMod.createWorkItem("Skill handoff image wording", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Rework article image layout",
        payload_json: {
          task_spec: "Create a cinematic image layout and card art integration in the existing learn page.",
          task_mode: "code",
          files_to_modify: ["htdocs/learn/page.html"],
          success_criteria: ["Layout is improved"],
          skills: ["frontend-design"],
        },
        skills: ["frontend-design"],
      });
      const packet = await handoffMod.handoff(handoffMod.buildRoutingPacket(job, {
        workItem: wi,
        payload: JSON.parse(job.payload_json),
        role: "dev",
        effectiveTier: "standard",
        cwd: projectDir,
      }));
      const context = handoffMod.packetToContextString(packet);

      assert.equal(packet.recipient, "dev");
      assert.deepEqual(packet.skills_attached, ["frontend-design"]);
      assert.match(context, /=== SKILL: frontend-design/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("does not attach skills to artificer handoffs", async () => {
    const { queueMod, handoffMod, dbMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-skill-artificer-"));
    try {
      queueMod.setSetting("skills_enabled", "true");
      queueMod.setSetting("skills_disabled_ids", "");
      const wi = queueMod.createWorkItem("Artificer skill guard", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "artificer",
        title: "Generate UI mockup",
        payload_json: {
          task_spec: "Generate a UI mockup image.",
          task_mode: "image",
          output_root: path.join(projectDir, "out"),
          create_roots: [path.join(projectDir, "out")],
          skills: ["frontend-design"],
        },
        skills: ["frontend-design"],
      });
      const packet = await handoffMod.handoff(handoffMod.buildRoutingPacket(job, {
        workItem: wi,
        payload: JSON.parse(job.payload_json),
        role: "artificer",
        effectiveTier: "standard",
        cwd: projectDir,
      }));
      const context = handoffMod.packetToContextString(packet);

      assert.equal(packet.recipient, "artificer");
      assert.deepEqual(packet.requested_skills, ["frontend-design"]);
      assert.deepEqual(packet.skills_attached, []);
      assert.deepEqual(packet.skills_skipped.disabled, ["frontend-design"]);
      assert.doesNotMatch(context, /=== SKILL: frontend-design/);
      queueMod.flushEventsNow();
      const event = dbMod.getDb().prepare(`SELECT * FROM events WHERE event_type = 'skill_skipped_disabled'`).get();
      assert.ok(event);
      assert.match(event.message, /frontend-design/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("caps attached skills proportionally when context budget is tight", async () => {
    const { queueMod, handoffMod } = runtimeModules;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-skill-tight-budget-"));
    const previousPromptCap = queueMod.getSetting("handoff_max_prompt_chars");
    const previousContextCap = queueMod.getSetting("handoff_max_context_chars");
    try {
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "src", "App.jsx"), "export function App() { return null; }\n", "utf-8");
      queueMod.setSetting("skills_enabled", "true");
      queueMod.setSetting("skills_disabled_ids", "");
      queueMod.setSetting("handoff_max_prompt_chars", "10000");
      queueMod.setSetting("handoff_max_context_chars", "3000");
      const wi = queueMod.createWorkItem("Tight skill budget", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Polish UI safely",
        payload_json: {
          task_spec: "Improve the UI.",
          files_to_modify: ["src/App.jsx"],
          success_criteria: ["UI is improved"],
        },
        skills: ["frontend-design", "bugfix", "security"],
      });
      const packet = await handoffMod.handoff(handoffMod.buildRoutingPacket(job, {
        workItem: wi,
        payload: JSON.parse(job.payload_json),
        role: "dev",
        effectiveTier: "standard",
        cwd: projectDir,
      }));

      assert.deepEqual(packet.skills_attached, ["frontend-design", "bugfix"]);
      assert.deepEqual(packet.skills_skipped.truncated, ["security"]);
    } finally {
      queueMod.setSetting("handoff_max_prompt_chars", previousPromptCap);
      queueMod.setSetting("handoff_max_context_chars", previousContextCap);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("shows skill toggles in admin settings and persists disabled ids", () => {
    const { queueMod } = runtimeModules;
    queueMod.setSetting("skills_disabled_ids", "");
    const tui = new AdminTUI({ projectDir: path.resolve(__dirname, "..") });
    let skill = tui._getSettingsSnapshot({ maxAgeMs: 0 }).skillSettings.find((entry) => entry.skill_id === "frontend-design");
    assert.ok(skill);
    assert.equal(skill.setting_value, "true");

    assert.equal(tui._saveSettingValue("skill_enabled:frontend-design", "false"), true);
    tui._invalidateSettingsCache();
    skill = tui._getSettingsSnapshot({ maxAgeMs: 0 }).skillSettings.find((entry) => entry.skill_id === "frontend-design");
    assert.equal(skill.setting_value, "false");
    assert.match(queueMod.getSetting("skills_disabled_ids"), /frontend-design/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST: Lease CAS (Compare-And-Swap)
// ═════════════════════════════════════════════════════════════════════════════
