import {
  it,
  before,
  assert,
  fs,
  os,
  path,
  execFileSync,
  __dirname,
  suite,
} from "../support/core-harness.js";

let db;

suite("Agent loader (memory isolation)", () => {
  it("provisions an empty per-job loader dir", async () => {
    const { provisionAgentLoader, loaderPathForJob, cleanupAgentLoader } = await import(
      "../../../lib/domains/worker/functions/helpers/agent-loader.js"
    );
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-loader-test-"));
    try {
      const dir = provisionAgentLoader(projectDir, 42);
      assert.equal(dir, loaderPathForJob(projectDir, 42));
      assert.ok(fs.existsSync(dir));
      assert.deepEqual(fs.readdirSync(dir), []);
      const relToProject = path.relative(projectDir, dir);
      assert.ok(
        relToProject.startsWith("..") || path.isAbsolute(relToProject),
        "loader dir must not live under the target project tree"
      );
      cleanupAgentLoader(dir);
      assert.equal(fs.existsSync(dir), false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("provisions a stable loader dir for a recyclable session lane", async () => {
    const {
      provisionSessionLaneLoader,
      loaderPathForSessionLane,
      cleanupAgentLoader,
    } = await import("../../../lib/domains/worker/functions/helpers/agent-loader.js");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-loader-test-"));
    const sessionKey = {
      workItemId: 12,
      lane: "dev",
      provider: "claude",
      skillKey: "",
    };
    try {
      const dir = provisionSessionLaneLoader(projectDir, sessionKey);
      assert.equal(dir, loaderPathForSessionLane(projectDir, sessionKey));
      assert.equal(provisionSessionLaneLoader(projectDir, sessionKey), dir);
      assert.ok(fs.existsSync(dir));
      assert.deepEqual(fs.readdirSync(dir), []);
      assert.match(path.basename(dir), /^session-wi-12-dev-claude-[a-f0-9]{12}$/);
      const relToProject = path.relative(projectDir, dir);
      assert.ok(
        relToProject.startsWith("..") || path.isAbsolute(relToProject),
        "session loader dir must not live under the target project tree"
      );
      cleanupAgentLoader(dir);
      assert.equal(fs.existsSync(dir), false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("keeps loader cwd outside a parent git repo", async () => {
    const { provisionAgentLoader, cleanupAgentLoader } = await import(
      "../../../lib/domains/worker/functions/helpers/agent-loader.js"
    );
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-loader-parent-git-"));
    const projectDir = path.join(repoDir, "mike");
    fs.mkdirSync(projectDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    let dir = null;
    try {
      dir = provisionAgentLoader(projectDir, 9);
      const relToRepo = path.relative(repoDir, dir);
      assert.ok(
        relToRepo.startsWith("..") || path.isAbsolute(relToRepo),
        "loader dir must not live under the parent git repo"
      );

      let detectedGitRoot = null;
      try {
        detectedGitRoot = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        detectedGitRoot = null;
      }
      assert.notEqual(
        detectedGitRoot && path.resolve(detectedGitRoot),
        path.resolve(repoDir),
        "loader cwd must not let Claude discover the target's parent git repo"
      );
    } finally {
      if (dir) cleanupAgentLoader(dir);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("assertLoaderClean throws when .md files are present", async () => {
    const { provisionAgentLoader, assertLoaderClean, cleanupAgentLoader } = await import(
      "../../../lib/domains/worker/functions/helpers/agent-loader.js"
    );
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-loader-test-"));
    try {
      const dir = provisionAgentLoader(projectDir, 7);
      assertLoaderClean(dir); // empty — should pass
      fs.writeFileSync(path.join(dir, "CLAUDE.md"), "leak");
      assert.throws(() => assertLoaderClean(dir), /\.md files/);
      fs.unlinkSync(path.join(dir, "CLAUDE.md"));
      fs.writeFileSync(path.join(dir, "AGENTS.md"), "leak");
      assert.throws(() => assertLoaderClean(dir), /\.md files/);
      cleanupAgentLoader(dir);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("claude provider isolates runtime harness context", async () => {
    // Static check: the flag must be pushed into args before spawn. We inspect
    // the args list via a stubbed spawn.
    const claudeSrc = fs.readFileSync(
      path.resolve(__dirname, "..", "lib", "domains", "providers", "functions", "claude.js"),
      "utf-8"
    );
    assert.match(
      claudeSrc,
      /args\.push\(\s*["']--setting-sources["']\s*,\s*["']local["']\s*\)/,
      "claude.js must only load the empty per-job local settings source"
    );
    assert.match(
      claudeSrc,
      /args\.push\(\s*["']--disable-slash-commands["']\s*\)/,
      "claude.js must disable slash-command skills for runtime agents"
    );
    assert.match(
      claudeSrc,
      /args\.push\(\s*["']--strict-mcp-config["']\s*\)/,
      "claude.js must ignore user/global MCP servers"
    );
    assert.match(
      claudeSrc,
      /args\.push\(\s*["']--system-prompt-file["']\s*,\s*systemPromptPath\s*\)/,
      "claude.js must replace the default Claude Code system prompt"
    );
  });

  it("codex provider includes project_doc_max_bytes=0 override", () => {
    const codexSrc = fs.readFileSync(
      path.resolve(__dirname, "..", "lib", "domains", "providers", "functions", "codex.js"),
      "utf-8"
    );
    assert.match(
      codexSrc,
      /project_doc_max_bytes=0/,
      "codex.js must disable AGENTS.md via project_doc_max_bytes=0"
    );
  });
});
