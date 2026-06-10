import {
  it,
  assert,
  fs,
  path,
  __dirname,
  suite,
  runtimeModules,
  handoff,
} from "../support/core-harness.js";

let db;

suite("Handoff path safety", () => {
  it("drops editable file reads that traverse outside the project", async () => {
    const projectDir = path.resolve(__dirname, "..");
    const packet = await handoff({
      recipient: "dev",
      data: {
        cwd: projectDir,
        files_to_modify: ["../package.json"],
        files_to_create: [],
        related_files: [],
      },
    });

    assert.equal(packet.editable_files["../package.json"], null);
    assert.ok(packet.dropped_files.some((entry) => entry.includes("outside project scope")));
  });

  it("caps cumulative related file preload size to avoid oversized prompts", async () => {
    const handoffMod = await import("../../../lib/domains/handoff/functions/index.js");
    const { queueMod } = runtimeModules;
    const previousRelatedCap = queueMod.getSetting("handoff_max_related_files_total_bytes");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-handoff-related-cap-"));
    try {
      queueMod.setSetting("handoff_max_related_files_total_bytes", "100000");
      fs.writeFileSync(path.join(projectDir, "r1.txt"), "a".repeat(40000), "utf-8");
      fs.writeFileSync(path.join(projectDir, "r2.txt"), "b".repeat(40000), "utf-8");
      fs.writeFileSync(path.join(projectDir, "r3.txt"), "c".repeat(40000), "utf-8");

      const packet = await handoffMod.handoff({
        recipient: "assessor",
        data: {
          cwd: projectDir,
          files_to_modify: [],
          files_to_create: [],
          related_files: ["r1.txt", "r2.txt", "r3.txt"],
          disable_atlas: true,
        },
      });

      assert.equal(Object.keys(packet.related_files_content).length, 2);
      assert.ok(packet.related_files_dropped.some((entry) => entry.path === "r3.txt" && entry.reason === "cumulative_size_limit"));
      assert.ok((packet.related_files_total_bytes || 0) <= 100000);
      const contextString = handoffMod.packetToContextString(packet);
      assert.match(contextString, /WARNING - RELATED FILES NOT PRELOADED/);
      assert.match(contextString, /r3\.txt: cumulative_size_limit/);
      assert.ok(queueMod.getEvents(null, 25).some((event) => event.event_type === "packet.files_dropped"));
    } finally {
      queueMod.setSetting("handoff_max_related_files_total_bytes", previousRelatedCap);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("prioritizes source related files over large supporting assets under cap pressure", async () => {
    const handoffMod = await import("../../../lib/domains/handoff/functions/index.js");
    const { queueMod } = runtimeModules;
    const previousRelatedCap = queueMod.getSetting("handoff_max_related_files_total_bytes");
    const previousFileCap = queueMod.getSetting("handoff_max_file_bytes");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-handoff-related-priority-"));
    try {
      queueMod.setSetting("handoff_max_related_files_total_bytes", "100000");
      queueMod.setSetting("handoff_max_file_bytes", "150000");
      fs.mkdirSync(path.join(projectDir, "htdocs"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "htdocs", "app.css"), "a".repeat(90000), "utf-8");
      fs.writeFileSync(path.join(projectDir, "htdocs", "brief.php"), "<?php\n" + "b".repeat(38000), "utf-8");
      fs.writeFileSync(path.join(projectDir, "htdocs", "portal.php"), "<?php\n" + "c".repeat(38000), "utf-8");

      const packet = await handoffMod.handoff({
        recipient: "assessor",
        data: {
          cwd: projectDir,
          title: "Update PHP brief and portal behavior",
          files_to_modify: [],
          files_to_create: [],
          related_files: ["htdocs/app.css", "htdocs/brief.php", "htdocs/portal.php"],
          disable_atlas: true,
        },
      });

      assert.ok(packet.related_files_content["htdocs/brief.php"]);
      assert.ok(packet.related_files_content["htdocs/portal.php"]);
      assert.equal(packet.related_files_content["htdocs/app.css"], undefined);
      assert.ok(packet.related_files_dropped.some((entry) => entry.path === "htdocs/app.css" && entry.reason === "cumulative_size_limit"));
    } finally {
      queueMod.setSetting("handoff_max_related_files_total_bytes", previousRelatedCap);
      queueMod.setSetting("handoff_max_file_bytes", previousFileCap);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST: Job Label Formatting (display.js)
// ═════════════════════════════════════════════════════════════════════════════
