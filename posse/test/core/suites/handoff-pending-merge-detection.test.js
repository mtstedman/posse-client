import {
  it,
  assert,
  fs,
  path,
  execFileSync,
  __dirname,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  handoff,
} from "../support/core-harness.js";

let db;

suite("Handoff pending-merge detection", () => {
  it("detectPendingMerge returns null outside a merge", async () => {
    const { detectPendingMerge } = await import("../../../lib/domains/handoff/functions/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-handoff-nomerge-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "a.txt"), "a\n", "utf-8");
      execFileSync("git", ["add", "a.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
      assert.equal(detectPendingMerge(projectDir), null);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("sanitizes pending-merge conflict paths before adding writable scope", async () => {
    const { sanitizePendingMergeConflicts } = await import("../../../lib/domains/handoff/functions/index.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-handoff-conflict-sanitize-"));

    try {
      const result = sanitizePendingMergeConflicts(projectDir, [
        "shared.txt",
        "nested\\file.txt",
        "../outside.txt",
        path.join(projectDir, "absolute-inside.txt"),
      ]);

      assert.deepEqual(result.safe, ["shared.txt", "nested/file.txt"]);
      assert.ok(result.invalid.includes("../outside.txt"));
      assert.ok(result.invalid.some((entry) => entry.replace(/\\/g, "/").endsWith("absolute-inside.txt")));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("detectPendingMerge reports conflicts and MERGE_HEAD inside a linked worktree", async () => {
    const { detectPendingMerge } = await import("../../../lib/domains/handoff/functions/index.js");
    const { mergeTargetIntoWorktree, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-handoff-merge-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "base\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir), "wi-7");
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-7", wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "main change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "main edits"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "shared.txt"), "wi change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: wtDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "wi edits"], { cwd: wtDir, stdio: "ignore" });

      mergeTargetIntoWorktree(wtDir, projectDir, "main", { leaveOnConflict: true });

      const pending = detectPendingMerge(wtDir);
      assert.ok(pending);
      assert.ok(pending.targetHash && pending.targetHash.length >= 7);
      assert.ok(pending.conflicts.includes("shared.txt"));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("handoff() adds conflicted paths to files_to_modify and populates pending_merge", async () => {
    const { handoff, packetToContextString } = await import("../../../lib/domains/handoff/functions/index.js");
    const { mergeTargetIntoWorktree, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-handoff-packet-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "base\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "other.txt"), "orig\n", "utf-8");
      execFileSync("git", ["add", "shared.txt", "other.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir), "wi-8");
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-8", wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "main change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "main edits"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "shared.txt"), "wi change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: wtDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "wi edits"], { cwd: wtDir, stdio: "ignore" });

      mergeTargetIntoWorktree(wtDir, projectDir, "main", { leaveOnConflict: true });

      const packet = {
        recipient: "dev",
        job_type: "dev",
        work_item_id: 8,
        job_id: 99,
        title: "Unrelated task",
        mode: "build",
        model_tier: "standard",
        attempt: { count: 1, max: 3, last_error: null, escalated: false },
        cwd: wtDir,
        files_to_modify: ["other.txt"],
        files_to_create: [],
        files_to_delete: [],
        create_roots: [],
        related_files: [],
        success_criteria: [],
        risk: { mutating: true, assessable: true },
        editable_files: {},
        creatable_files: {},
        related_files_content: {},
        source_files: {},
        dropped_files: [],
        context_hints: {},
      };

      const enriched = await handoff(packet);
      assert.ok(enriched.pending_merge);
      assert.ok(enriched.pending_merge.conflicts.includes("shared.txt"));
      assert.ok(enriched.files_to_modify.includes("shared.txt"));
      assert.ok(enriched.files_to_modify.includes("other.txt"));
      assert.ok(enriched.editable_files["shared.txt"], "conflicted file should be preloaded with markers");
      assert.match(enriched.editable_files["shared.txt"], /<<<<<<</);

      const context = packetToContextString(enriched);
      assert.match(context, /MERGE IN PROGRESS/);
      assert.match(context, /shared\.txt/);

      const artificerPacket = {
        ...packet,
        recipient: "artificer",
        job_type: "artificer",
        files_to_modify: ["other.txt"],
        pending_merge: null,
        editable_files: {},
        creatable_files: {},
        related_files_content: {},
        source_files: {},
      };
      const artificerEnriched = await handoff(artificerPacket);
      assert.equal(artificerEnriched.pending_merge, null);
      assert.deepEqual(artificerEnriched.files_to_modify, ["other.txt"]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("keeps all pending-merge conflicts editable when preload is capped", async () => {
    const { handoff, packetToContextString } = await import("../../../lib/domains/handoff/functions/index.js");
    const { mergeTargetIntoWorktree, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-handoff-large-merge-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      for (let i = 0; i < 55; i++) {
        fs.writeFileSync(path.join(projectDir, `conflict-${String(i).padStart(2, "0")}.txt`), "base\n", "utf-8");
      }
      execFileSync("git", ["add", "."], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir), "wi-81");
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-81", wtDir], { cwd: projectDir, stdio: "ignore" });
      for (let i = 0; i < 55; i++) {
        fs.writeFileSync(path.join(projectDir, `conflict-${String(i).padStart(2, "0")}.txt`), `main ${i}\n`, "utf-8");
      }
      execFileSync("git", ["add", "."], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "main edits"], { cwd: projectDir, stdio: "ignore" });
      for (let i = 0; i < 55; i++) {
        fs.writeFileSync(path.join(wtDir, `conflict-${String(i).padStart(2, "0")}.txt`), `wi ${i}\n`, "utf-8");
      }
      execFileSync("git", ["add", "."], { cwd: wtDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "wi edits"], { cwd: wtDir, stdio: "ignore" });

      mergeTargetIntoWorktree(wtDir, projectDir, "main", { leaveOnConflict: true });

      const packet = {
        recipient: "dev",
        job_type: "dev",
        work_item_id: 81,
        job_id: 199,
        title: "Resolve large merge",
        mode: "build",
        model_tier: "standard",
        attempt: { count: 1, max: 3, last_error: null, escalated: false },
        cwd: wtDir,
        files_to_modify: [],
        files_to_create: [],
        files_to_delete: [],
        create_roots: [],
        related_files: [],
        success_criteria: [],
        risk: { mutating: true, assessable: true },
        editable_files: {},
        creatable_files: {},
        related_files_content: {},
        source_files: {},
        dropped_files: [],
        context_hints: {},
      };

      const enriched = await handoff(packet);
      const conflicts = enriched.pending_merge.conflicts;
      const unpreloaded = enriched.pending_merge.unpreloaded_conflicts;
      const firstUnpreloaded = unpreloaded[0];

      assert.equal(enriched.pending_merge.truncated, true);
      assert.equal(conflicts.length, 55);
      assert.equal(enriched.pending_merge.preloaded_conflict_count, 50);
      assert.equal(enriched.pending_merge.unpreloaded_conflict_count, 5);
      for (const conflict of conflicts) {
        assert.ok(enriched.files_to_modify.includes(conflict), `${conflict} should remain editable`);
      }
      assert.ok(enriched.editable_files[conflicts[0]], "first conflict body should be preloaded");
      assert.match(enriched.editable_files[conflicts[0]], /<<<<<<</);
      assert.equal(enriched.editable_files[firstUnpreloaded], null);
      assert.equal(enriched.editable_file_metadata[firstUnpreloaded].reason, "preload_capped");

      const context = packetToContextString(enriched);
      assert.match(context, /IMPORTANT: conflict preloading was capped/);
      assert.match(context, /Conflicted files not preloaded/);
      assert.match(context, new RegExp(firstUnpreloaded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("developer runtime scope includes handoff-expanded merge conflicts", async () => {
    const { DeveloperRole } = await import("../../../lib/domains/worker/classes/roles/developer.js");
    const { mergeTargetIntoWorktree, worktreeRoot } = await import("../../../lib/domains/git/functions/worktree.js");
    const { queueMod } = runtimeModules;
    resetRuntimeDb();

    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-handoff-dev-scope-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "base\n", "utf-8");
      fs.writeFileSync(path.join(projectDir, "other.txt"), "orig\n", "utf-8");
      execFileSync("git", ["add", "shared.txt", "other.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });

      const wtDir = path.join(worktreeRoot(projectDir), "wi-9");
      execFileSync("git", ["worktree", "add", "-b", "posse/wi-9", wtDir], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(projectDir, "shared.txt"), "main change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "main edits"], { cwd: projectDir, stdio: "ignore" });
      fs.writeFileSync(path.join(wtDir, "shared.txt"), "wi change\n", "utf-8");
      execFileSync("git", ["add", "shared.txt"], { cwd: wtDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "wi edits"], { cwd: wtDir, stdio: "ignore" });

      mergeTargetIntoWorktree(wtDir, projectDir, "main", { leaveOnConflict: true });

      const wi = queueMod.createWorkItem("Merge scope", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Resolve merge",
        payload_json: JSON.stringify({
          task_spec: "Resolve the pending merge.",
          files_to_modify: ["other.txt"],
          files_to_create: [],
          success_criteria: ["merge resolves"],
        }),
      });
      job._worktreePath = wtDir;

      const role = new DeveloperRole({
        providerClient: { call: async () => ({ output: "unused", stats: {} }) },
        context: {
          projectDir,
          parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
          detectDrift: () => "",
          primeCreatableFiles: () => [],
          emit: () => {},
        },
      });
      const ctx = { tier: "standard", attemptId: 1 };

      await role.assembleContext(job, ctx);
      const opts = role.buildOpts(job, ctx);

      assert.ok(ctx.packet.pending_merge);
      assert.ok(ctx.packet.files_to_modify.includes("shared.txt"));
      assert.ok(ctx.editableScope.includes("shared.txt"));
      assert.ok(opts.scopedFiles.includes("shared.txt"));
      assert.ok(opts.scopedFiles.includes("other.txt"));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
