import {
  it,
  assert,
  fs,
  os,
  path,
  suite,
  getAtlasIntegrationConfig,
  buildAtlasSmokeConfig,
  readConfiguredAtlasRepos,
  runAtlasSmokeTest,
} from "../support/core-harness.js";

let db;

suite("ATLAS smoke helpers", () => {
  it("does not read external ATLAS checkout configs", () => {
    assert.deepEqual(readConfiguredAtlasRepos(), []);
  });

  it("builds a smoke config that enables research routing for an explicit repo", () => {
    const config = buildAtlasSmokeConfig({
      repoPath: "C:/development/claude/spirit",
      baseConfig: getAtlasIntegrationConfig({}),
    });

    assert.equal(config.enabled, true);
    assert.equal(config.mode, "preferred");
    assert.equal(config.liveFunnel, true);
    assert.ok(config.phases.includes("research"));
    assert.ok(config.phases.includes("planning"));
    assert.equal(config.requestedRepoId, "spirit");
    assert.equal(config.requestedRepoPath, path.resolve("C:/development/claude/spirit"));
  });

  it("runs the local ATLAS smoke helper through native v2 embedded execution", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-atlas-smoke-"));
    const repoPath = path.join(tmpRoot, "spirit");
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "router.js"), [
      "export function router(input = {}) {",
      "  return input.route || 'home';",
      "}",
      "",
    ].join("\n"), "utf8");

    try {
      const calls = [];
      const report = await runAtlasSmokeTest({
        repoPath,
        query: "router",
        config: buildAtlasSmokeConfig({
          repoPath,
          baseConfig: getAtlasIntegrationConfig({
            POSSE_ATLAS_V2: "on",
          }),
        }),
        execImpl(command, args, options, done) {
          const call = { command, args, input: "" };
          calls.push(call);
          done(new Error("external ATLAS CLI should not be used by native v2 smoke"), "", "");
          return {
            stdin: {
              on() {},
              end(value) { call.input = String(value || ""); },
            },
          };
        },
      });

      assert.equal(report.capability.repo.repoId, "spirit");
      assert.equal(report.capability.backend, "atlas-v2");
      assert.equal(report.providerSupport.transport, "embedded");
      assert.equal(report.configuredRepo, null);
      assert.equal(calls.length, 0);

      const indexRefresh = JSON.parse(report.indexRefresh);
      assert.equal(indexRefresh.repoRoot, repoPath);
      assert.equal(indexRefresh.mode, "full");
      assert.match(indexRefresh.versionId, /^main@\d+$/);

      const symbolSearch = JSON.parse(report.symbolSearch);
      assert.equal(symbolSearch.items[0].name, "router");
      assert.match(symbolSearch.items[0].location.repo_rel_path, /router\.js$/);

      const context = JSON.parse(report.context);
      assert.equal(context.taskType, "explain");
      assert.match(context.generatedContext, /Identify the main entry points/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
