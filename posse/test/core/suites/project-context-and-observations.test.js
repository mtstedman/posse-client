import {
  it,
  beforeEach,
  assert,
  fs,
  os,
  path,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
  setRuntimePathOverridesForTests,
} from "../support/core-harness.js";
import {
  getRuntimeDbPath,
  getRuntimeResourcesDir,
  getRuntimeRoot,
  normalizeProjectDir,
} from "../../../lib/domains/runtime/functions/paths.js";

let db;

suite("Project context and observations", () => {
  beforeEach(() => {
    resetRuntimeDb();
  });

  it("records deterministic job observations", () => {
    const wi = runtimeModules.queueMod.createWorkItem("Observe me", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Observation job",
    });

    runtimeModules.observationsMod.recordObservation({
      work_item_id: wi.id,
      job_id: job.id,
      observation_type: "attempt.start",
      summary: "started",
      detail: { cwd: "C:/tmp/project" },
    });

    const rows = runtimeModules.observationsMod.getObservationsByJob(job.id, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].observation_type, "attempt.start");
    assert.match(rows[0].detail_json, /C:\/tmp\/project/);
  });

  it("records compact tool-use observations for bash and write/edit activity", () => {
    const wi = runtimeModules.queueMod.createWorkItem("Observe tools", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Tool observation job",
    });

    runtimeModules.observationsMod.recordToolUseObservations({
      work_item_id: wi.id,
      job_id: job.id,
      tool_uses: [
        { tool: "Bash", input: { command: "npm test -- --runInBand" } },
        { tool: "Write", input: { file_path: "C:/tmp/project/src/app.js" } },
        { tool: "Edit", input: { file_path: "C:/tmp/project/src/app.js", old_string: "const oldValue = 1;" } },
        { tool: "Bash", input: { command: "npm test -- --runInBand" } },
      ],
      cwd: "C:/tmp/project",
    });

    const rows = runtimeModules.observationsMod.getObservationsByJob(job.id, 10);
    const summaries = rows.map((row) => `${row.observation_type}:${row.summary}`);
    assert.ok(summaries.some((s) => /tool\.bash:Bash: npm test/.test(s)));
    assert.ok(summaries.some((s) => /tool\.write:Write: src\/app\.js/.test(s)));
    assert.ok(summaries.some((s) => /tool\.edit:Edit: src\/app\.js/.test(s)));
    assert.equal(summaries.filter((s) => /tool\.bash:Bash: npm test/.test(s)).length, 1);
  });

  it("records provider toolkit observations and flags raw bash calls distinctly", () => {
    const wi = runtimeModules.queueMod.createWorkItem("Observe provider tools", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "artificer",
      title: "Provider tool observation job",
    });

    runtimeModules.observationsMod.recordToolUseObservations({
      work_item_id: wi.id,
      job_id: job.id,
      tool_uses: [
        { tool: "read_file", input: { path: "C:/tmp/project/htdocs/index.html" } },
        { tool: "inspect_file", input: { path: "C:/tmp/project/htdocs/images/logo.png" } },
        { tool: "resize_image", input: { path: "C:/tmp/project/htdocs/images/logo.png", output_path: "C:/tmp/project/htdocs/images/logo-wide.png", width: 1200, height: 300 } },
        { tool: "generate_image", input: { path: "C:/tmp/project/htdocs/images/hero.png", size: "1536x1024" } },
        { tool: "WebSearch", input: { query: "OpenAI API rate limits" } },
        { tool: "WebFetch", input: { url: "https://platform.openai.com/docs/guides/rate-limits" } },
        { tool: "web_search_preview", input: { search_query: "Codex web search docs" } },
        { tool: "bash", input: { command: "magick convert logo.png -resize 1200x300 logo-wide.png" } },
      ],
      cwd: "C:/tmp/project",
    });

    const rows = runtimeModules.observationsMod.getObservationsByJob(job.id, 20);
    const summaries = rows.map((row) => `${row.observation_type}:${row.summary}`);
    assert.ok(summaries.some((s) => /tool\.read:Read: htdocs\/index\.html/.test(s)));
    assert.ok(summaries.some((s) => /tool\.inspect:Inspect: htdocs\/images\/logo\.png/.test(s)));
    assert.ok(summaries.some((s) => /tool\.resize_image:Resize image: htdocs\/images\/logo\.png -> 1200x300/.test(s)));
    assert.ok(summaries.some((s) => /tool\.generate_image:Generate image: htdocs\/images\/hero\.png \(1536x1024\)/.test(s)));
    assert.ok(summaries.some((s) => /tool\.web_search:WebSearch: OpenAI API rate limits/.test(s)));
    assert.ok(summaries.some((s) => /tool\.web_search:WebSearch: Codex web search docs/.test(s)));
    assert.ok(summaries.some((s) => /tool\.web_fetch:WebFetch: https:\/\/platform\.openai\.com\/docs\/guides\/rate-limits/.test(s)));
    assert.ok(summaries.some((s) => /tool\.bash:Bash: magick convert logo\.png/.test(s)));

    const bashRow = rows.find((row) => row.observation_type === "tool.bash");
    assert.ok(bashRow);
    assert.match(bashRow.detail_json, /"kind":"system_call"/);

    const inspectRow = rows.find((row) => row.observation_type === "tool.inspect");
    assert.ok(inspectRow);
    assert.match(inspectRow.detail_json, /"kind":"deterministic"/);

    const webFetchRow = rows.find((row) => row.observation_type === "tool.web_fetch");
    assert.ok(webFetchRow);
    assert.match(webFetchRow.detail_json, /"kind":"web"/);
  });

  it("records live web-tool observations from ambient context and suppresses replay duplicates", () => {
    const wi = runtimeModules.queueMod.createWorkItem("Observe live web tools", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Live web observation job",
    });
    const toolUse = { tool: "web_search_call", input: { query: "live web query" } };

    runtimeModules.observationsMod.runWithObservationContext({ work_item_id: wi.id, job_id: job.id }, () => {
      runtimeModules.observationsMod.recordToolUseObservations({
        tool_uses: [toolUse],
        cwd: "C:/tmp/project",
      });
    });
    runtimeModules.observationsMod.recordToolUseObservations({
      work_item_id: wi.id,
      job_id: job.id,
      tool_uses: [toolUse],
      cwd: "C:/tmp/project",
    });

    const rows = runtimeModules.observationsMod.getObservationsByJob(job.id, 10)
      .filter((row) => row.observation_type === "tool.web_search");
    assert.equal(rows.length, 1);
    assert.match(rows[0].summary, /live web query/);
  });

  it("records ATLAS MCP tool uses as per-invocation tool.atlas observations", () => {
    const wi = runtimeModules.queueMod.createWorkItem("Observe ATLAS tools", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "ATLAS observation job",
    });

    runtimeModules.observationsMod.recordToolUseObservations({
      work_item_id: wi.id,
      job_id: job.id,
      tool_uses: [
        { tool: "mcp__atlas-v2__symbol.search", input: { query: "auth login", limit: 5 } },
        { tool: "mcp__atlas-v2__slice.build", input: { taskText: "debug login regression" } },
        { tool: "mcp__atlas-v2__atlas.code.Getskeleton", input: { file: "src/app.js" } },
        { tool: "atlas_code", input: { action: "code.getSkeleton", file: "src/router.js" } },
        { tool: "ATLAS atlas.getskeleton", input: { file: "src/legacy.js" } },
      ],
      cwd: "C:/tmp/project",
    });

    const rows = runtimeModules.observationsMod.getObservationsByJob(job.id, 10);
    const atlasRows = rows.filter((row) => row.observation_type === "tool.atlas");
    assert.equal(atlasRows.length, 5);
    assert.ok(atlasRows.some((row) => /atlas symbol\.search/.test(row.summary)));
    assert.ok(atlasRows.some((row) => /atlas slice\.build/.test(row.summary)));
    assert.equal(atlasRows.filter((row) => /atlas code\.getSkeleton/.test(row.summary)).length, 3);
    assert.ok(atlasRows.every((row) => !/\bATLAS\b/.test(row.summary)));
    assert.ok(atlasRows.every((row) => !/atlas atlas/i.test(row.summary)));
    assert.ok(atlasRows.every((row) => /"kind":"atlas"/.test(row.detail_json)));
    assert.ok(atlasRows.filter((row) => /"tool_name":"atlas_code"/.test(row.detail_json)).length === 1);
    assert.ok(atlasRows.filter((row) => /"transport":"mcp"/.test(row.detail_json)).length >= 3);
  });

  it("records gateway Codex ATLAS cancellations without replaying successful proxy calls", () => {
    const wi = runtimeModules.queueMod.createWorkItem("Observe gateway ATLAS tools", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Gateway ATLAS observation job",
    });

    runtimeModules.observationsMod.recordToolUseObservations({
      work_item_id: wi.id,
      job_id: job.id,
      tool_uses: [
        { tool: "mcp__posse_gateway__atlas_symbol_search", input: { query: "workshop save", limit: 5 } },
        {
          tool: "mcp__posse_gateway__atlas_symbol_search",
          input: { query: "workshop save", limit: 5 },
          status: "cancelled",
          error: "user cancelled MCP tool call",
        },
        {
          tool: "mcp__posse_gateway__read_file",
          input: { path: "htdocs/js/workshop.js" },
          status: "cancelled",
          error: "user cancelled MCP tool call",
        },
      ],
      cwd: "C:/tmp/project",
    });

    const rows = runtimeModules.observationsMod.getObservationsByJob(job.id, 10);
    const atlasRows = rows.filter((row) => row.observation_type === "tool.atlas");
    assert.equal(atlasRows.length, 1);
    assert.match(atlasRows[0].summary, /atlas symbol\.search \(workshop save\) cancelled: user cancelled MCP tool call/);
    assert.match(atlasRows[0].detail_json, /"transport":"mcp"/);
    assert.match(atlasRows[0].detail_json, /"status":"cancelled"/);
    assert.match(atlasRows[0].detail_json, /"ok":false/);
  });

  it("records ATLAS buffer pushes as non-tool telemetry", () => {
    const wi = runtimeModules.queueMod.createWorkItem("Observe ATLAS rebuffer", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "ATLAS rebuffer observation job",
    });

    runtimeModules.observationsMod.recordToolUseObservations({
      work_item_id: wi.id,
      job_id: job.id,
      tool_uses: [{
        tool: "mcp__posse_gateway__atlas_buffer_push",
        input: { filePath: "src/app.js" },
        status: "cancelled",
        error: "provider cancelled replay",
      }],
      cwd: "C:/tmp/project",
    });

    const rows = runtimeModules.observationsMod.getObservationsByJob(job.id, 10);
    const bufferRows = rows.filter((row) => row.observation_type === "atlas.buffer_push");
    assert.equal(bufferRows.length, 1);
    assert.equal(rows.filter((row) => row.observation_type === "tool.atlas").length, 0);
    assert.match(bufferRows[0].summary, /atlas buffer\.push \(src\/app\.js\) cancelled/);

    const counts = runtimeModules.observationsMod.getToolInvocationCountsByJob({ limit: 10 });
    assert.equal(counts.some((row) => row.job_id === job.id), false);
  });

  it("filters provider replay for every deterministic tool through the catalog", () => {
    const filtered = runtimeModules.observationsMod.filterProviderToolUseReplay([
      { tool: "Read", input: { file_path: "src/app.js" } },
      { tool: "read_file", input: { path: "src/app.js" } },
      { tool: "pull_brief", input: { mode: "job" } },
      { tool: "mcp__posse-gateway__read_file", input: { path: "src/app.js" } },
      { tool: "mcp__atlas-v2__repo.status", input: {} },
    ], { skipToolkitDeterministic: true });

    assert.deepEqual(filtered.map((toolUse) => toolUse.tool), ["mcp__atlas-v2__repo.status"]);
  });

  it("builds and stores a startup context digest", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-project-context-"));
    try {
      const wi = runtimeModules.queueMod.createWorkItem("Blocked WI", "desc");
      const blockedJob = runtimeModules.queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Blocked job",
      });
      runtimeModules.queueMod.updateJobStatus(blockedJob.id, "blocked");

      const result = runtimeModules.projectContextMod.refreshProjectContext(projectDir, { writeDigest: true });
      const row = runtimeModules.projectContextMod.getProjectContextRow();

      assert.equal(fs.existsSync(result.digestPath), true);
      assert.ok(result.digest.includes("Blocked Jobs"));
      assert.ok(row);
      assert.match(row.blocked_summary, /Blocked job/);
    } finally {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("refreshProjectContextAsync honors runtime path overrides inside its worker", async () => {
    const originalOverrides = {
      projectDir: normalizeProjectDir(),
      runtimeRoot: getRuntimeRoot(),
      dbPath: getRuntimeDbPath(),
      resourcesDir: getRuntimeResourcesDir(),
    };
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-project-context-async-"));
    const runtimeRoot = path.join(projectDir, "custom-runtime");
    const dbPath = path.join(runtimeRoot, "db", "orchestrator.db");
    try {
      runtimeModules.dbMod.closeDb();
      setRuntimePathOverridesForTests({
        projectDir,
        runtimeRoot,
        dbPath,
        resourcesDir: path.join(runtimeRoot, "resources"),
      });
      runtimeModules.dbMod.getDb();

      const wi = runtimeModules.queueMod.createWorkItem("Async context WI", "desc");
      const blockedJob = runtimeModules.queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Async blocked job",
      });
      runtimeModules.queueMod.updateJobStatus(blockedJob.id, "blocked");

      const result = await runtimeModules.projectContextMod.refreshProjectContextAsync(projectDir, { writeDigest: true });
      const row = runtimeModules.projectContextMod.getProjectContextRow();

      assert.equal(result.digestPath, path.join(runtimeRoot, "startup-context.md"));
      assert.equal(fs.existsSync(result.digestPath), true);
      assert.ok(row);
      assert.match(row.blocked_summary, /Async blocked job/);
    } finally {
      runtimeModules.dbMod.closeDb();
      setRuntimePathOverridesForTests(originalOverrides);
      resetRuntimeDb();
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
