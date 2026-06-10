import {
  it,
  before,
  beforeEach,
  assert,
  suite,
  runtimeModules,
  resetRuntimeDb,
  handoff,
} from "../support/core-harness.js";

let db;

suite("Handoff fallback read budgets", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("uses queue settings to override assessor fallback reads", async () => {
    const { queueMod } = runtimeModules;
    const handoffMod = await import("../../../lib/domains/handoff/functions/index.js");
    queueMod.setSetting("assessor_fallback_reads", "5");

    const packet = await handoffMod.handoff(handoffMod.buildRoutingPacket(
      { id: 1, title: "Assess CSS polish", job_type: "dev", work_item_id: 1 },
      {
        role: "assessor",
        workItem: { id: 1, title: "Assess CSS polish" },
        payload: {
          task_spec: "Verify CSS and HTML changes.",
          files_to_modify: ["htdocs/style.css", "htdocs/index.html"],
        },
        cwd: process.cwd(),
      }
    ));

    assert.equal(packet.budgets?.fallback_reads_remaining, 5);
  });

  it("keeps explicit context-hint fallback read overrides above queue settings", async () => {
    const { queueMod } = runtimeModules;
    const handoffMod = await import("../../../lib/domains/handoff/functions/index.js");
    queueMod.setSetting("assessor_fallback_reads", "5");

    const packet = await handoffMod.handoff(handoffMod.buildRoutingPacket(
      { id: 2, title: "Assess CSS polish", job_type: "dev", work_item_id: 1 },
      {
        role: "assessor",
        workItem: { id: 1, title: "Assess CSS polish" },
        payload: {
          task_spec: "Verify CSS and HTML changes.",
          files_to_modify: ["htdocs/style.css"],
        },
        context_hints: { allow_fallback_reads: 2 },
        cwd: process.cwd(),
      }
    ));

    assert.equal(packet.budgets?.fallback_reads_remaining, 2);
  });

  it("strips needs_image_generation from dev handoff packets", async () => {
    const handoffMod = await import("../../../lib/domains/handoff/functions/index.js");

    const packet = await handoffMod.handoff(handoffMod.buildRoutingPacket(
      { id: 3, title: "Refine viewer styling", job_type: "dev", work_item_id: 1 },
      {
        role: "dev",
        workItem: { id: 1, title: "Refine viewer styling" },
        payload: {
          task_spec: "Refine the repo styling for the real viewer.",
          task_mode: "code",
          needs_image_generation: true,
          files_to_modify: ["htdocs/css/viewer.css"],
        },
        cwd: process.cwd(),
      }
    ));

    assert.equal(packet._raw_payload.needs_image_generation, false);
  });

  it("keeps dev handoff packets on the dev route even when wording is image-adjacent", async () => {
    const handoffMod = await import("../../../lib/domains/handoff/functions/index.js");

    const packet = await handoffMod.handoff(handoffMod.buildRoutingPacket(
      { id: 31, title: "Generate hero image set", job_type: "dev", work_item_id: 1 },
      {
        role: "dev",
        workItem: { id: 1, title: "Generate hero image set" },
        payload: {
          task_spec: "Create a cinematic image layout for the homepage treatment.",
          task_mode: "code",
          files_to_modify: ["htdocs/index.php"],
          files_to_create: [],
        },
        cwd: process.cwd(),
      }
    ));

    assert.equal(packet.recipient, "dev");
    assert.equal(packet._raw_payload.task_mode, "code");
    assert.equal(packet._raw_payload.needs_image_generation, undefined);
  });

  it("keeps code tasks that mention image generation on the dev route", async () => {
    const handoffMod = await import("../../../lib/domains/handoff/functions/index.js");

    const packet = await handoffMod.handoff(handoffMod.buildRoutingPacket(
      { id: 32, title: "Update image generation tests", job_type: "dev", work_item_id: 1 },
      {
        role: "dev",
        workItem: { id: 1, title: "Update image generation tests" },
        payload: {
          task_spec: "Generate code that processes images and update image generation tests.",
          task_mode: "code",
          needs_image_generation: true,
          files_to_modify: ["test/image-generation.test.js"],
        },
        cwd: process.cwd(),
      }
    ));

    assert.equal(packet.recipient, "dev");
    assert.equal(packet._raw_payload.task_mode, "code");
    assert.equal(packet._raw_payload.needs_image_generation, false);
  });

  it("keeps near-timeout ATLAS prefetch results that finish during grace", async () => {
    const handoffMod = await import("../../../lib/domains/handoff/functions/index.js");

    const result = await handoffMod.__testTimeHandoffStep(
      { recipient: "dev" },
      "atlas.prefetch",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "atlas-ready";
      },
      {
        timeoutMs: 5,
        timeoutGraceMs: 50,
        warnMs: Number.MAX_SAFE_INTEGER,
      },
    );

    assert.equal(result, "atlas-ready");
  });

  it("attaches planner ATLAS slice-pruning context when ATLAS planning route is active", async () => {
    const handoffMod = await import("../../../lib/domains/handoff/functions/index.js");
    const { queueMod } = runtimeModules;
    queueMod.setSetting("atlas_mode", "preferred");
    queueMod.setSetting("atlas_phases", "planning");
    queueMod.setSetting("atlas_live_funnel", "true");

    try {
    const packet = await handoffMod.handoff(handoffMod.buildRoutingPacket(
        { id: 4, title: "Plan auth refresh flow", job_type: "plan", work_item_id: 1 },
        {
          role: "planner",
          workItem: { id: 1, title: "Plan auth refresh flow" },
          payload: {
            task_spec: "Plan how auth refresh is handled across middleware and token helpers.",
            files_to_modify: ["src/auth/middleware.js"],
          },
          cwd: process.cwd(),
          jobProvider: "openai",
        }
      ));

      assert.equal(packet.atlas?.active, true);
      assert.ok(packet.atlas_slice_context);
      const context = handoffMod.packetToContextString(packet);
      assert.match(context, /ATLAS(?:v2)? SLICE PRUNING/);
    } finally {
      queueMod.setSetting("atlas_mode", "off");
      queueMod.setSetting("atlas_phases", "research,planning");
      queueMod.setSetting("atlas_live_funnel", "false");
    }
  });

  it("skips planner directory_tree attachment when ATLAS is active", async () => {
    const handoffMod = await import("../../../lib/domains/handoff/functions/index.js");
    const { queueMod } = runtimeModules;
    queueMod.setSetting("atlas_mode", "preferred");
    queueMod.setSetting("atlas_phases", "planning");
    queueMod.setSetting("atlas_live_funnel", "true");

    try {
    const packet = await handoffMod.handoff(handoffMod.buildRoutingPacket(
        { id: 41, title: "Plan cache invalidation", job_type: "plan", work_item_id: 1 },
        {
          role: "planner",
          workItem: { id: 1, title: "Plan cache invalidation" },
          payload: {
            task_spec: "Plan cache invalidation boundaries and touch points.",
            files_to_modify: ["lib/cache.js"],
          },
          cwd: process.cwd(),
          jobProvider: "openai",
        }
      ));

      assert.equal(packet.atlas?.active, true);
      assert.equal(packet.directory_tree, null);
    } finally {
      queueMod.setSetting("atlas_mode", "off");
      queueMod.setSetting("atlas_phases", "research,planning");
      queueMod.setSetting("atlas_live_funnel", "false");
    }
  });

  it("drops optional sections by explicit priority instead of source order", async () => {
    const handoffMod = await import("../../../lib/domains/handoff/functions/index.js");
    const packet = {
      context_render_max_chars: 80,
      pending_merge: null,
      atlas: null,
      atlas_fallback_context: null,
      directory_tree: "a\nb\nc",
      source_files: { "src/main.js": "x".repeat(48) },
      editable_files: {},
      smart_preloads: {},
      dropped_files: [],
      creatable_files: {},
      deleted_files_applied: [],
      deleted_files_absent: [],
      delete_failures: [],
      create_roots: [],
      related_files_content: {},
      related_files_dropped: [],
    };
    const context = handoffMod.packetToContextString(packet);
    assert.match(context, /=== FILE: src\/main\.js ===/);
    assert.doesNotMatch(context, /=== DIRECTORY TREE ===/);
    assert.ok((packet.context_sections_dropped || []).includes("directory_tree"));
    assert.equal(packet.context_overflow_stage, "optional_sections");
  });

});
