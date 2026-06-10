import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), "..");

function withTemporaryEnv(updates, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(updates || {})) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("tools class contract", () => {
  it("keeps tool stateful classes in lib/classes/tools", () => {
    const expected = [
      path.join(repoDir, "lib", "classes", "tools", "ToolCatalog.js"),
      path.join(repoDir, "lib", "classes", "tools", "ToolContract.js"),
      path.join(repoDir, "lib", "classes", "tools", "ToolExecutor.js"),
      path.join(repoDir, "lib", "classes", "tools", "ToolGate.js"),
      path.join(repoDir, "lib", "classes", "tools", "McpServer.js"),
      path.join(repoDir, "lib", "classes", "tools", "McpServerConfig.js"),
    ];
    for (const target of expected) {
      assert.equal(fs.existsSync(target), true, `missing class module: ${target}`);
    }
  });

  it("keeps deterministic MCP server config wrapper aligned with McpServerConfig class", async () => {
    const mcpFns = await import("../lib/domains/integrations/functions/deterministic-mcp.js");
    const { McpServerConfig } = await import("../lib/classes/tools/McpServerConfig.js");
    const opts = {
      cwd: process.cwd(),
      scopedFiles: ["src/a.js"],
      createFiles: ["src/new.js"],
      createRoots: ["src"],
      needsImageGeneration: true,
      providerName: "claude",
      disableSystemTools: true,
      jobId: 41,
      workItemId: 7,
      atlasPrefetchStatus: "ok",
      atlasAvailable: true,
    };
    const wrapped = mcpFns.buildDeterministicReadMcpServerConfig("dev", opts);
    const viaClass = McpServerConfig.forDeterministicRead("dev", opts).toSpawnArgs();
    assert.equal(wrapped.ready, true);
    assert.equal(viaClass.ready, true);
    assert.equal(wrapped.command, viaClass.command);
    assert.deepEqual(wrapped.args, viaClass.args);
    const configIndex = wrapped.args.indexOf("--config-json");
    assert.ok(configIndex >= 0);
    const bootConfig = JSON.parse(Buffer.from(wrapped.args[configIndex + 1], "base64").toString("utf8"));
    assert.equal(bootConfig.providerName, "claude");
    assert.equal(bootConfig.disableSystemTools, true);
    assert.equal(bootConfig.allowWrite, true);
    assert.equal(bootConfig.allowImageHelpers, true);
    assert.equal(bootConfig.allowImageGeneration, false);
  });

  it("keeps Node preload environment out of deterministic MCP children", async () => {
    const { McpServerConfig } = await import("../lib/classes/tools/McpServerConfig.js");
    const config = withTemporaryEnv({
      NODE_OPTIONS: "--require ./preload.cjs",
      NODE_PATH: "/tmp/preload-path",
      NODE_EXTRA_CA_CERTS: path.join(os.tmpdir(), "cert.pem"),
    }, () => McpServerConfig.forDeterministicRead("dev", {
      cwd: process.cwd(),
      atlasAvailable: false,
      atlasConfig: { enabled: false },
    }).toSpawnArgs());

    assert.equal(config.env.NODE_OPTIONS, undefined);
    assert.equal(config.env.NODE_PATH, undefined);
    assert.equal(config.env.NODE_EXTRA_CA_CERTS, path.join(os.tmpdir(), "cert.pem"));
  });

  it("scrubs npm credentials and proxy userinfo from deterministic MCP children", async () => {
    const { McpServerConfig } = await import("../lib/classes/tools/McpServerConfig.js");
    const config = withTemporaryEnv({
      NPM_TOKEN: "npm-secret-token",
      POSSE_KEY: "remote-secret",
      NPM_CONFIG_REGISTRY: "https://registry-user:registry-pass@registry.example.test/npm/",
      NPM_CONFIG_USERCONFIG: path.join(os.tmpdir(), ".npmrc"),
      NPM_CONFIG_CACHE: path.join(os.tmpdir(), "npm-cache"),
      HTTPS_PROXY: "http://proxy-user:proxy-pass@proxy.example.test:8080",
      HTTP_PROXY: "http://proxy.example.test:8081",
      NO_PROXY: "localhost,127.0.0.1",
    }, () => McpServerConfig.forDeterministicRead("dev", {
      cwd: process.cwd(),
      atlasAvailable: false,
      atlasConfig: { enabled: false },
    }).toSpawnArgs());

    assert.equal(config.env.NPM_TOKEN, undefined);
    assert.equal(config.env.POSSE_KEY, "remote-secret");
    assert.equal(config.env.POSSE_REMOTE_API_KEY, undefined);
    assert.equal(config.env.NPM_CONFIG_USERCONFIG, undefined);
    assert.equal(config.env.NPM_CONFIG_CACHE, undefined);
    assert.equal(config.env.NPM_CONFIG_REGISTRY, "https://registry.example.test/npm/");
    assert.equal(config.env.HTTPS_PROXY, "http://proxy.example.test:8080/");
    assert.equal(config.env.HTTP_PROXY, "http://proxy.example.test:8081");
    assert.equal(config.env.NO_PROXY, "localhost,127.0.0.1");
  });

  it("preserves scoped npm registry paths in deterministic MCP children", async () => {
    const { McpServerConfig } = await import("../lib/classes/tools/McpServerConfig.js");
    const config = withTemporaryEnv({
      NPM_CONFIG_REGISTRY: "https://registry.example.test/@scope/",
    }, () => McpServerConfig.forDeterministicRead("dev", {
      cwd: process.cwd(),
      atlasAvailable: false,
      atlasConfig: { enabled: false },
    }).toSpawnArgs());

    assert.equal(config.env.NPM_CONFIG_REGISTRY, "https://registry.example.test/@scope/");
  });

  it("enforces ToolGate lifecycle invariants", async () => {
    const { ToolGate } = await import("../lib/classes/tools/ToolGate.js");
    const gate = new ToolGate({
      role: "researcher",
      atlasAvailable: true,
      gatedRoles: new Set(["researcher"]),
      meaningfulAtlasActions: new Set(["symbol.search"]),
      gatedTools: new Set(["read_file"]),
      fallbackStrikeLimit: 3,
      requiredMeaningfulAtlasCalls: 3,
    });
    assert.equal(gate.isActive(), true);
    assert.equal(gate.isGatedTool("read_file"), true);
    assert.equal(gate.isUnlocked(), false);
    gate.noteAtlasCall({ action: "symbol.search", ok: true, empty: true });
    assert.equal(gate.isUnlocked(), false);
    gate.noteAtlasCall({ action: "symbol.search", ok: false, empty: false });
    assert.equal(gate.isUnlocked(), false);
    gate.noteAtlasCall({ action: "symbol.search", ok: false, empty: false });
    assert.equal(gate.isUnlocked(), true);
    assert.equal(gate.getUnlockReason(), "fallback");
    const before = gate.snapshot();
    gate.noteAtlasCall({ action: "symbol.search", ok: true, empty: false });
    assert.deepEqual(gate.snapshot(), before);
    gate.release();
    assert.equal(gate.isActive(), false);
    assert.equal(gate.isUnlocked(), false);
  });

  it("renders ToolGate locked errors from the role-routed ATLAS catalog", async () => {
    const { ToolGate } = await import("../lib/classes/tools/ToolGate.js");
    const gate = new ToolGate({
      role: "assessor",
      atlasAvailable: true,
      gatedRoles: new Set(["assessor"]),
      meaningfulAtlasActions: new Set(["symbol.getCard", "pr.risk"]),
      gatedTools: new Set(["read_file"]),
      fallbackStrikeLimit: 3,
      requiredMeaningfulAtlasCalls: 3,
    });
    const message = gate.buildLockedToolError("read_file");
    assert.match(message, /Replacement hint:/);
    assert.match(message, /atlas\.pr\.risk/);
    assert.doesNotMatch(message, /atlas\.file\.read/);
    assert.doesNotMatch(message, /atlas\.file\.write/);
    assert.doesNotMatch(message, /atlas\.delta\.get/);
    assert.doesNotMatch(message, /atlas\.pr\.risk\.analyze/);

    gate.configure({ role: "assessor", atlasAvailable: true, atlasLabel: "ATLASv2" });
    const v2Message = gate.buildLockedToolError("read_file");
    assert.match(v2Message, /\[ATLASv2-first\]/);
    assert.match(v2Message, /Always prefer ATLASv2/);
    assert.doesNotMatch(v2Message, /ATLAS\/Iris/);
  });

  it("keeps ToolExecutor stateless across execute calls", async () => {
    const { ToolExecutor } = await import("../lib/classes/tools/ToolExecutor.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-tool-executor-contract-"));
    try {
      const sourcePath = path.join(tmpDir, "sample.txt");
      fs.writeFileSync(sourcePath, "line one\nline two\n", "utf8");
      const exec = new ToolExecutor({
        cwd: tmpDir,
        allowWrite: false,
        scope: { modifyFiles: [], createFiles: [], createRoots: [] },
      });
      const before = exec.snapshot();
      const first = exec.execute("read_file", { path: "sample.txt" });
      const second = exec.execute("read_file", { path: "sample.txt" });
      const after = exec.snapshot();
      assert.equal(typeof first, "string");
      assert.equal(first, second);
      assert.deepEqual(before, after);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("blocks ToolExecutor copy/move reads from sensitive env files", async () => {
    const { ToolExecutor } = await import("../lib/classes/tools/ToolExecutor.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-tool-executor-env-"));
    try {
      fs.writeFileSync(path.join(tmpDir, ".env"), "SECRET=1\n", "utf8");
      const exec = new ToolExecutor({
        cwd: tmpDir,
        allowWrite: true,
        scope: {
          modifyFiles: [".env"],
          createFiles: ["copied.txt", "moved.txt"],
          createRoots: [],
        },
      });

      const copy = exec.execute("copy_file", { source: ".env", destination: "copied.txt" });
      const move = exec.execute("move_file", { source: ".env", destination: "moved.txt" });

      assert.match(copy, /copy_file blocked - reading \.env files is blocked/);
      assert.match(move, /move_file blocked - reading \.env files is blocked/);
      assert.equal(fs.existsSync(path.join(tmpDir, "copied.txt")), false);
      assert.equal(fs.existsSync(path.join(tmpDir, "moved.txt")), false);
      assert.equal(fs.existsSync(path.join(tmpDir, ".env")), true);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("blocks ToolExecutor copy/move reads from agent-hidden config and gitignore paths", async () => {
    const { ToolExecutor } = await import("../lib/classes/tools/ToolExecutor.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-tool-executor-hidden-source-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "config"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "config", "secret.json"), "{\"token\":\"hidden\"}\n", "utf8");
      fs.writeFileSync(path.join(tmpDir, ".gitignore"), "config/\n", "utf8");
      const exec = new ToolExecutor({
        cwd: tmpDir,
        allowWrite: true,
        scope: {
          modifyFiles: ["config/secret.json", ".gitignore"],
          createFiles: ["copied.json", "moved-ignore.txt"],
          createRoots: [],
        },
      });

      const copy = exec.execute("copy_file", {
        source: "config/secret.json",
        destination: "copied.json",
      });
      const move = exec.execute("move_file", {
        source: ".gitignore",
        destination: "moved-ignore.txt",
      });

      assert.match(copy, /copy_file blocked - config\/secret\.json is hidden from agent file tools/);
      assert.match(move, /move_file blocked - \.gitignore is hidden from agent file tools/);
      assert.equal(fs.existsSync(path.join(tmpDir, "copied.json")), false);
      assert.equal(fs.existsSync(path.join(tmpDir, "moved-ignore.txt")), false);
      assert.equal(fs.existsSync(path.join(tmpDir, "config", "secret.json")), true);
      assert.equal(fs.existsSync(path.join(tmpDir, ".gitignore")), true);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("blocks ToolExecutor copy/move writes to sensitive env files", async () => {
    const { ToolExecutor } = await import("../lib/classes/tools/ToolExecutor.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-tool-executor-env-target-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "source.txt"), "SECRET=1\n", "utf8");
      fs.writeFileSync(path.join(tmpDir, ".env.local"), "SECRET=old\n", "utf8");
      const exec = new ToolExecutor({
        cwd: tmpDir,
        allowWrite: true,
        scope: {
          modifyFiles: ["source.txt", ".env.local"],
          createFiles: [".env"],
          createRoots: [],
        },
      });

      const copy = exec.execute("copy_file", { source: "source.txt", destination: ".env" });
      const move = exec.execute("move_file", {
        source: "source.txt",
        destination: ".env.local",
        overwrite: true,
      });

      assert.match(copy, /copy_file blocked - writing \.env files is blocked/);
      assert.match(move, /move_file blocked - writing \.env files is blocked/);
      assert.equal(fs.existsSync(path.join(tmpDir, ".env")), false);
      assert.equal(fs.readFileSync(path.join(tmpDir, ".env.local"), "utf8"), "SECRET=old\n");
      assert.equal(fs.readFileSync(path.join(tmpDir, "source.txt"), "utf8"), "SECRET=1\n");
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("blocks ToolExecutor copy reads from protected prompt sources", async () => {
    const { ToolExecutor } = await import("../lib/classes/tools/ToolExecutor.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-tool-executor-protected-source-"));
    try {
      const protectedSource = path.join(tmpDir, "prompts", "contracts", "dev.md");
      fs.mkdirSync(path.dirname(protectedSource), { recursive: true });
      fs.writeFileSync(protectedSource, "protected prompt\n", "utf8");
      const exec = new ToolExecutor({
        cwd: tmpDir,
        allowWrite: true,
        scope: {
          modifyFiles: ["prompts/contracts/dev.md"],
          createFiles: ["copied.md"],
          createRoots: [],
        },
      });

      const copy = exec.execute("copy_file", {
        source: "prompts/contracts/dev.md",
        destination: "copied.md",
      });

      assert.match(copy, /copy_file blocked - prompts\/contracts\/dev\.md is protected/);
      assert.equal(fs.existsSync(path.join(tmpDir, "copied.md")), false);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("blocks ToolExecutor copy/move through symbolic links", async (t) => {
    const { ToolExecutor } = await import("../lib/classes/tools/ToolExecutor.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-tool-executor-symlink-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "source.txt"), "new content\n", "utf8");
      fs.writeFileSync(path.join(tmpDir, "target.txt"), "old content\n", "utf8");
      try {
        fs.symlinkSync("target.txt", path.join(tmpDir, "dest-link.txt"), "file");
        fs.symlinkSync("source.txt", path.join(tmpDir, "source-link.txt"), "file");
      } catch (err) {
        t.skip(`symlink creation is unavailable in this environment: ${err?.code || err?.message || err}`);
        return;
      }

      const exec = new ToolExecutor({
        cwd: tmpDir,
        allowWrite: true,
        scope: {
          modifyFiles: ["source.txt", "target.txt", "dest-link.txt", "source-link.txt"],
          createFiles: ["copy.txt"],
          createRoots: [],
        },
      });

      const copyToLink = exec.execute("copy_file", {
        source: "source.txt",
        destination: "dest-link.txt",
        overwrite: true,
      });
      const moveToLink = exec.execute("move_file", {
        source: "source.txt",
        destination: "dest-link.txt",
        overwrite: true,
      });
      const copyFromLink = exec.execute("copy_file", {
        source: "source-link.txt",
        destination: "copy.txt",
      });

      assert.match(copyToLink, /copy_file blocked - dest-link\.txt is a symbolic link/);
      assert.match(moveToLink, /move_file blocked - dest-link\.txt is a symbolic link/);
      assert.match(copyFromLink, /copy_file blocked - source-link\.txt is a symbolic link/);
      assert.equal(fs.readFileSync(path.join(tmpDir, "target.txt"), "utf8"), "old content\n");
      assert.equal(fs.readFileSync(path.join(tmpDir, "source.txt"), "utf8"), "new content\n");
      assert.equal(fs.existsSync(path.join(tmpDir, "copy.txt")), false);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("renders MCP surface names from the same descriptors used by provider attachment", async () => {
    const { ToolCatalog } = await import("../lib/classes/tools/ToolCatalog.js");
    const { ToolContract } = await import("../lib/classes/tools/ToolContract.js");
    const { buildMcpAtlasSurfaceToolDescriptors, buildMcpSurfaceToolDescriptors, buildSurfaceNameMap } = await import("../lib/functions/tools/mcp-surface.js");
    const { renderAtlasRoleContract } = await import("../lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js");

    const descriptors = buildMcpSurfaceToolDescriptors(
      ["read_file", "list_files", "search_files"],
      { providerName: "codex", serverName: "posse_gateway" },
    );
    const claudeImageDescriptors = buildMcpSurfaceToolDescriptors(
      ["generate_image"],
      { providerName: "claude", serverName: "posse-gateway" },
    );
    const atlasDescriptors = buildMcpAtlasSurfaceToolDescriptors(
      ["context.summary", "symbol.search"],
      { providerName: "codex", serverName: "posse_gateway" },
    );
    assert.equal(
      atlasDescriptors.find((tool) => tool.name === "symbol.search")?.surfaceName,
      "mcp__posse_gateway__atlas_symbol_search",
    );
    assert.deepEqual(
      (({ canonicalName, mcpName, providerSurfaceName, surfaceName }) => ({ canonicalName, mcpName, providerSurfaceName, surfaceName }))(
        atlasDescriptors.find((tool) => tool.name === "symbol.search"),
      ),
      {
        canonicalName: "symbol.search",
        mcpName: "atlas.symbol.search",
        providerSurfaceName: "mcp__posse_gateway__atlas_symbol_search",
        surfaceName: "mcp__posse_gateway__atlas_symbol_search",
      },
    );
    assert.equal(
      atlasDescriptors.find((tool) => tool.name === "context.summary")?.surfaceName,
      "mcp__posse_gateway__atlas_context_summary",
    );
    assert.equal(
      descriptors.find((tool) => tool.name === "read_file")?.surfaceName,
      "mcp__posse_gateway__tools_read_file",
    );
    assert.deepEqual(
      (({ canonicalName, mcpName, providerSurfaceName, surfaceName }) => ({ canonicalName, mcpName, providerSurfaceName, surfaceName }))(
        descriptors.find((tool) => tool.name === "read_file"),
      ),
      {
        canonicalName: "read_file",
        mcpName: "tools.read_file",
        providerSurfaceName: "mcp__posse_gateway__tools_read_file",
        surfaceName: "mcp__posse_gateway__tools_read_file",
      },
    );
    assert.equal(
      claudeImageDescriptors.find((tool) => tool.name === "generate_image")?.surfaceName,
      "mcp__posse-gateway__tools_generate_image",
    );
    assert.deepEqual(
      (({ canonicalName, mcpName, providerSurfaceName, surfaceName }) => ({ canonicalName, mcpName, providerSurfaceName, surfaceName }))(
        claudeImageDescriptors.find((tool) => tool.name === "generate_image"),
      ),
      {
        canonicalName: "generate_image",
        mcpName: "tools.generate_image",
        providerSurfaceName: "mcp__posse-gateway__tools_generate_image",
        surfaceName: "mcp__posse-gateway__tools_generate_image",
      },
    );
    const atlasContract = renderAtlasRoleContract("planner", {
      providerName: "codex",
      atlasGateEnabled: true,
      atlasAttachment: {
        active: true,
        provider: "codex",
        transport: "mcp",
        surfaceToolNames: buildSurfaceNameMap(atlasDescriptors),
      },
    });
    assert.match(atlasContract, /mcp__posse_gateway__atlas_context_summary/);
    assert.match(atlasContract, /mcp__posse_gateway__atlas_symbol_search/);
    assert.doesNotMatch(atlasContract, /mcp__posse_gateway__atlas_repo_status/);
    assert.match(atlasContract, /native read_file\/chain_read fallback unlocks file by file/);
    assert.match(atlasContract, /\.tsx/);
    assert.match(atlasContract, /\.php/);

    const base = ToolContract.build({
      provider: "codex",
      role: "planner",
      allowWrite: false,
    }).toJSON();
    const merged = ToolContract.append(base, descriptors, ToolCatalog);
    const rendered = new ToolContract(ToolContract.adaptForProvider(merged, "codex")).renderBlock();

    assert.match(rendered, /Name rule: call the exact Available tools name/i);
    assert.match(rendered, /mcp__posse_gateway__tools_read_file \(canonical: read_file\) \[tools\/read\]/);
    assert.match(rendered, /mcp__posse_gateway__tools_list_files \(canonical: list_files\) \[tools\/read\]/);
    assert.match(rendered, /mcp__posse_gateway__tools_search_files \(canonical: search_files\) \[tools\/read\]/);
    assert.doesNotMatch(rendered, /  - read_file \[read\]/);
    assert.match(rendered, /File content path: use mcp__posse_gateway__tools_read_file\/mcp__posse_gateway__tools_list_files\/mcp__posse_gateway__tools_search_files/);
  });

  it("renders explicit provider MCP surface names instead of recomputing aliases", async () => {
    const { ToolCatalog } = await import("../lib/classes/tools/ToolCatalog.js");
    const { ToolContract } = await import("../lib/classes/tools/ToolContract.js");

    const base = ToolContract.build({
      provider: "claude",
      role: "artificer",
      allowWrite: true,
      includeBaseTools: false,
    }).toJSON();
    const merged = ToolContract.append(base, [{
      name: "generate_image",
      canonicalName: "generate_image",
      mcpName: "tools.generate_image",
      providerSurfaceName: "mcp__posse-gateway__tools_generate_image",
      surfaceName: "mcp__posse-gateway__tools.generate_image",
      suite: "tools",
      transport: "mcp",
      serverName: "posse-gateway",
    }], ToolCatalog);
    const rendered = new ToolContract(merged).renderBlock();

    assert.match(rendered, /mcp__posse-gateway__tools_generate_image \(canonical: generate_image\)/);
    assert.doesNotMatch(rendered, /mcp__posse-gateway__tools\.generate_image/);
  });

  it("blocks ToolExecutor image writes through symbolic links", async (t) => {
    const { ToolExecutor } = await import("../lib/classes/tools/ToolExecutor.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-tool-executor-image-symlink-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "source.png"), "not a real png\n", "utf8");
      fs.writeFileSync(path.join(tmpDir, "target.png"), "old content\n", "utf8");
      try {
        fs.symlinkSync("target.png", path.join(tmpDir, "dest-link.png"), "file");
      } catch (err) {
        t.skip(`symlink creation is unavailable in this environment: ${err?.code || err?.message || err}`);
        return;
      }

      const exec = new ToolExecutor({
        cwd: tmpDir,
        allowWrite: true,
        scope: {
          modifyFiles: ["source.png", "target.png", "dest-link.png"],
          createFiles: [],
          createRoots: [],
        },
      });

      const result = exec.execute("optimize_image", {
        path: "source.png",
        output_path: "dest-link.png",
        overwrite: true,
      });

      assert.match(result, /optimize_image blocked - dest-link\.png is a symbolic link/);
      assert.equal(fs.readFileSync(path.join(tmpDir, "target.png"), "utf8"), "old content\n");
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("can build an execution contract without catalogue base tools for strict MCP runs", async () => {
    const { ToolContract } = await import("../lib/classes/tools/ToolContract.js");
    const contract = ToolContract.build({
      provider: "claude",
      role: "planner",
      allowWrite: false,
      includeBaseTools: false,
    }).toJSON();
    assert.deepEqual(contract.tools, []);
    const block = new ToolContract(contract).renderBlock();
    assert.match(block, /Runtime tools: none/);
    assert.doesNotMatch(block, /read_file/);
  });

  it("keeps ToolContract and ToolCatalog composition stable", async () => {
    const { ToolCatalog } = await import("../lib/classes/tools/ToolCatalog.js");
    const { ToolContract } = await import("../lib/classes/tools/ToolContract.js");

    const contract = ToolContract.fromCatalog(ToolCatalog, {
      providerName: "claude",
      role: "dev",
      allowWrite: true,
      needsImageGeneration: false,
      scopedFiles: ["src/a.js"],
      createFiles: [],
      createRoots: [],
      deleteFiles: [],
    }).toJSON();
    assert.equal(contract.role, "dev");
    assert.equal(Array.isArray(contract.tools), true);
    assert.equal(contract.tools.some((tool) => tool.name === "read_file"), true);

    const withAtlas = ToolContract.append(contract, ["symbol.search"], ToolCatalog);
    assert.equal(withAtlas.tools.some((tool) => tool.name === "symbol.search"), true);
    const withAtlasBlock = new ToolContract(withAtlas).renderBlock();
    assert.match(withAtlasBlock, /Use ATLAS retrieval tools first/);
    assert.doesNotMatch(withAtlasBlock, /Use deterministic tools first/);
    const codex = ToolContract.adaptForProvider(withAtlas, "codex");
    assert.equal(codex.provider, "codex");
    assert.equal(codex.tools.some((tool) => tool.name === "symbol.search"), true);
  });
});
