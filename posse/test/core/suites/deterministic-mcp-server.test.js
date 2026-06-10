import {
  it,
  before,
  assert,
  fs,
  os,
  path,
  spawnSync,
  __dirname,
  suite,
  runtimeModules,
  runtimeDbPath,
  createJob,
  resetRuntimeDb,
  withEnv,
  readConfiguredAtlasRepos,
} from "../support/core-harness.js";

suite("Deterministic MCP server", () => {
  it("MCP server tools/list matches deterministic role tool contract", async () => {
    const mcpMod = await import("../../../lib/domains/integrations/functions/deterministic-mcp.js");
    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    for (const role of ["researcher", "planner", "assessor", "dev", "artificer"]) {
      const needsImageGeneration = role === "artificer";
      const expected = [...mcpMod.getDeterministicMcpToolNames(role, { needsImageGeneration })]
        .map((name) => `tools.${name}`)
        .sort();
      const result = spawnSync(process.execPath, [serverScript], {
        input,
        timeout: 10000,
        env: {
          ...process.env,
          POSSE_ATLAS_MODE: "off",
          POSSE_DETERMINISTIC_MCP_CWD: os.tmpdir(),
          POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: role === "dev" || role === "artificer" ? "true" : "false",
          POSSE_DETERMINISTIC_MCP_ALLOW_IMAGE_HELPERS: role === "dev" || role === "artificer" ? "true" : "false",
          POSSE_DETERMINISTIC_MCP_ALLOW_IMAGE_GENERATION: needsImageGeneration ? "true" : "false",
          POSSE_DETERMINISTIC_MCP_ROLE: role,
          POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
        },
      });
      const frames = parseMcpFrames(result.stdout || "");
      const toolsListResponse = frames.find((f) => f.id === 2 && f.result?.tools);
      assert.ok(toolsListResponse, `tools/list response should be present for ${role}`);
      const actual = toolsListResponse.result.tools.map((t) => t.name).sort();
      assert.deepEqual(actual, expected, `${role} tools/list should match getDeterministicMcpToolNames`);
    }
  });

  it("MCP server returns JSON-RPC parse errors for malformed frames", () => {
    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const env = {
      ...process.env,
      POSSE_ATLAS_MODE: "off",
      POSSE_DETERMINISTIC_MCP_CWD: os.tmpdir(),
      POSSE_DETERMINISTIC_MCP_ROLE: "researcher",
      POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
      POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
      POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
      POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
    };

    const jsonlResult = spawnSync(process.execPath, [serverScript], {
      input: "{bad-json\n" + JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
      timeout: 10000,
      env,
    });
    assert.equal(jsonlResult.status, 0, `jsonl mcp server should exit cleanly (stderr: ${jsonlResult.stderr})`);
    const jsonlFrames = String(jsonlResult.stdout || "").trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(jsonlFrames[0].id, null);
    assert.equal(jsonlFrames[0].error?.code, -32700);
    assert.equal(jsonlFrames[0].error?.message, "Parse error");
    assert.equal(jsonlFrames.some((frame) => frame.id === 1 && frame.result?.serverInfo), true);
    assert.match(String(jsonlResult.stderr || ""), /JSON-RPC parse error/);

    const malformedBody = "{bad-json";
    const lspResult = spawnSync(process.execPath, [serverScript], {
      input: `Content-Length: ${Buffer.byteLength(malformedBody)}\r\n\r\n${malformedBody}`
        + mcpFrame({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }),
      timeout: 10000,
      env,
    });
    assert.equal(lspResult.status, 0, `lsp mcp server should exit cleanly (stderr: ${lspResult.stderr})`);
    const lspFrames = parseMcpFrames(lspResult.stdout || "");
    assert.equal(lspFrames[0].id, null);
    assert.equal(lspFrames[0].error?.code, -32700);
    assert.equal(lspFrames[0].error?.message, "Parse error");
    assert.equal(lspFrames.some((frame) => frame.id === 2 && frame.result?.serverInfo), true);
    assert.match(String(lspResult.stderr || ""), /JSON-RPC parse error/);
  });

  it("MCP server rejects oversized Content-Length frames without waiting for the body", () => {
    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }

    const result = spawnSync(process.execPath, [serverScript], {
      input: "Content-Length: 999999999\r\n\r\n",
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_CWD: os.tmpdir(),
        POSSE_DETERMINISTIC_MCP_ROLE: "researcher",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
    const frames = parseMcpFrames(result.stdout || "");
    assert.equal(frames[0].id, null);
    assert.equal(frames[0].error?.code, -32700);
    assert.equal(frames[0].error?.message, "Parse error");
  });

  it("MCP server exposes enriched ATLAS route tools and denies disallowed gateway actions", () => {
    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      + mcpFrame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "atlas.code.needWindow", arguments: { file: "src/app.js", reason: "not routed to planner", expectedLines: 20 } } })
      + mcpFrame({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "atlas.memory.remove", arguments: { key: "x" } } });

    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_ATLAS_V2: "on",
        POSSE_DETERMINISTIC_MCP_CWD: os.tmpdir(),
        POSSE_DETERMINISTIC_MCP_ROLE: "planner",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
        POSSE_DETERMINISTIC_MCP_ATLAS_AVAILABLE: "true",
        POSSE_DETERMINISTIC_MCP_ATLAS_GATE_ENABLED: "false",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });

    assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
    const frames = parseMcpFrames(result.stdout || "");
    const toolsListResponse = frames.find((f) => f.id === 2 && f.result?.tools);
    assert.ok(toolsListResponse, "tools/list response should be present");
    const names = toolsListResponse.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("atlas.context.summary"));
    assert.ok(names.includes("atlas.memory.query"));
    assert.equal(names.includes("atlas.info"), false);
    assert.equal(names.includes("atlas.repo.status"), false);
    assert.equal(names.includes("atlas.repo.quality"), false);
    assert.equal(names.includes("atlas.buffer.status"), false);
    assert.equal(names.includes("atlas.usage.stats"), false);
    assert.equal(names.includes("atlas.query"), false);
    assert.equal(names.includes("atlas.repo"), false);
    assert.equal(names.includes("atlas.repo.overview"), true);
    assert.equal(names.includes("atlas.memory.surface"), false);
    assert.equal(names.includes("atlas.manual"), false);
    assert.equal(names.includes("atlas.code.needWindow"), false);
    assert.equal(names.includes("atlas.workflow"), false);
    assert.equal(names.includes("manual"), false);

    const denied = frames.find((f) => f.id === 3);
    assert.equal(denied?.result?.isError, true);
    assert.match(denied?.result?.content?.[0]?.text || "", /code\.needWindow is not allowed/);
    const blockedMutation = frames.find((f) => f.id === 4);
    assert.equal(blockedMutation?.result?.isError, true);
    assert.match(blockedMutation?.result?.content?.[0]?.text || "", /Memory persistence is managed by Posse/);
    assert.doesNotMatch(blockedMutation?.result?.content?.[0]?.text || "", /write_file\/edit_file/);
  });

  it("MCP server keeps ATLAS file.read hidden so raw reads are deterministic fallback", () => {
    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      + mcpFrame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "atlas.file.read", arguments: { filePath: "README.md", limit: 5 } } });

    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_ATLAS_V2: "on",
        POSSE_DETERMINISTIC_MCP_CWD: os.tmpdir(),
        POSSE_DETERMINISTIC_MCP_ROLE: "researcher",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
        POSSE_DETERMINISTIC_MCP_ATLAS_AVAILABLE: "true",
        POSSE_DETERMINISTIC_MCP_ATLAS_GATE_ENABLED: "false",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });

    assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
    const frames = parseMcpFrames(result.stdout || "");
    const toolsListResponse = frames.find((f) => f.id === 2 && f.result?.tools);
    assert.ok(toolsListResponse, "tools/list response should be present");
    const names = toolsListResponse.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("atlas.context.summary"));
    assert.ok(names.includes("tools.chain_read"));
    assert.equal(names.includes("atlas.context"), false);
    assert.equal(names.includes("atlas.file.read"), false);

    const denied = frames.find((f) => f.id === 3);
    assert.equal(denied?.result?.isError, true);
    assert.match(denied?.result?.content?.[0]?.text || "", /intentionally not exposed/);
    assert.match(denied?.result?.content?.[0]?.text || "", /read_file\/chain_read/);
  });

  it("MCP server keeps OCR unavailable when image helpers are disabled", () => {
    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_CWD: os.tmpdir(),
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
        POSSE_DETERMINISTIC_MCP_ALLOW_IMAGE_HELPERS: "false",
        POSSE_DETERMINISTIC_MCP_ROLE: "dev",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    const frames = parseMcpFrames(result.stdout || "");
    const toolsListResponse = frames.find((f) => f.id === 2 && f.result?.tools);
    assert.ok(toolsListResponse, "tools/list response should be present in stdout");
    const toolNames = toolsListResponse.result.tools.map((t) => t.name);
    assert.equal(toolNames.includes("tools.extract_image_text"), false);
    assert.equal(toolNames.includes("tools.read_image_metadata"), false);
  });

  it("MCP generate_image enforces the per-job call cap before provider access", () => {
    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.generate_image", arguments: { prompt: "test image", path: "out.png" } } });
    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        OPENAI_API_KEY: "",
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_CWD: os.tmpdir(),
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
        POSSE_DETERMINISTIC_MCP_ALLOW_IMAGE_GENERATION: "true",
        POSSE_DETERMINISTIC_MCP_IMAGE_GENERATION_MAX_CALLS: "0",
        POSSE_DETERMINISTIC_MCP_ROLE: "artificer",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: JSON.stringify(["out.png"]),
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    const frames = parseMcpFrames(result.stdout || "");
    const response = frames.find((f) => f.id === 2 && f.result?.content);
    const text = response?.result?.content?.[0]?.text || "";
    assert.match(text, /generate_image call limit reached/);
  });

  it("MCP generate_image accepts the Claude provider-visible gateway surface name", () => {
    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mcp__posse-gateway__tools_generate_image", arguments: { prompt: "test image", path: "out.png" } } });
    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        OPENAI_API_KEY: "",
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_CWD: os.tmpdir(),
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
        POSSE_DETERMINISTIC_MCP_ALLOW_IMAGE_GENERATION: "true",
        POSSE_DETERMINISTIC_MCP_IMAGE_GENERATION_MAX_CALLS: "0",
        POSSE_DETERMINISTIC_MCP_ROLE: "artificer",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: JSON.stringify(["out.png"]),
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    const frames = parseMcpFrames(result.stdout || "");
    const response = frames.find((f) => f.id === 2 && f.result?.content);
    const text = response?.result?.content?.[0]?.text || "";
    assert.match(text, /generate_image call limit reached/);
    assert.doesNotMatch(text, /Unknown tool|No such tool/i);
  });

  it("MCP generate_image does not spend the per-job call cap on validation failures", () => {
    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.generate_image", arguments: { prompt: "test image" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tools.generate_image", arguments: { prompt: "test image" } } });
    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        OPENAI_API_KEY: "",
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_CWD: os.tmpdir(),
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
        POSSE_DETERMINISTIC_MCP_ALLOW_IMAGE_GENERATION: "true",
        POSSE_DETERMINISTIC_MCP_IMAGE_GENERATION_MAX_CALLS: "1",
        POSSE_DETERMINISTIC_MCP_ROLE: "artificer",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: JSON.stringify(["out.png"]),
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    const frames = parseMcpFrames(result.stdout || "");
    const first = frames.find((f) => f.id === 2)?.result?.content?.[0]?.text || "";
    const second = frames.find((f) => f.id === 3)?.result?.content?.[0]?.text || "";
    assert.match(first, /path is required/);
    assert.match(second, /path is required/);
    assert.doesNotMatch(second, /call limit reached/);
  });

  it("MCP move errors do not expose resolved absolute paths", () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-path-errors-"));
    try {
      fs.writeFileSync(path.join(scratchDir, "source.txt"), "source", "utf-8");
      fs.writeFileSync(path.join(scratchDir, "dest.txt"), "dest", "utf-8");

      const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
      function mcpFrame(obj) {
        const body = JSON.stringify(obj);
        return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      }
      function parseMcpFrames(raw) {
        const results = [];
        const text = raw.toString();
        const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const len = parseInt(m[1], 10);
          const start = m.index + m[0].length;
          try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
        }
        return results;
      }
      const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
        + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.move_file", arguments: { source: "source.txt", destination: "dest.txt" } } });
      const result = spawnSync(process.execPath, [serverScript], {
        input,
        timeout: 10000,
        env: {
          ...process.env,
          POSSE_ATLAS_MODE: "off",
          POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
          POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
          POSSE_DETERMINISTIC_MCP_ROLE: "dev",
          POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: JSON.stringify(["source.txt", "dest.txt"]),
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
        },
      });
      const frames = parseMcpFrames(result.stdout || "");
      const response = frames.find((f) => f.id === 2 && f.result?.content);
      const text = response?.result?.content?.[0]?.text || "";
      assert.match(text, /Destination already exists: dest\.txt/);
      assert.equal(text.includes(scratchDir), false);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("MCP copy_file blocks sensitive env sources", () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-env-copy-"));
    try {
      fs.writeFileSync(path.join(scratchDir, ".env"), "SECRET=1\n", "utf-8");

      const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
      function mcpFrame(obj) {
        const body = JSON.stringify(obj);
        return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      }
      function parseMcpFrames(raw) {
        const results = [];
        const text = raw.toString();
        const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const len = parseInt(m[1], 10);
          const start = m.index + m[0].length;
          try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
        }
        return results;
      }
      const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
        + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.copy_file", arguments: { source: ".env", destination: "copied.txt" } } });
      const result = spawnSync(process.execPath, [serverScript], {
        input,
        timeout: 10000,
        env: {
          ...process.env,
          POSSE_ATLAS_MODE: "off",
          POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
          POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
          POSSE_DETERMINISTIC_MCP_ROLE: "dev",
          POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: JSON.stringify([".env"]),
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: JSON.stringify(["copied.txt"]),
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
        },
      });
      const frames = parseMcpFrames(result.stdout || "");
      const response = frames.find((f) => f.id === 2 && f.result?.content);
      const text = response?.result?.content?.[0]?.text || "";
      assert.match(text, /copy_file blocked - reading \.env files is blocked/);
      assert.equal(fs.existsSync(path.join(scratchDir, "copied.txt")), false);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("MCP copy_file blocks protected prompt sources", () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-protected-copy-source-"));
    try {
      const source = path.join(scratchDir, "prompts", "contracts", "dev.md");
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, "protected prompt\n", "utf-8");

      const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
      function mcpFrame(obj) {
        const body = JSON.stringify(obj);
        return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      }
      function parseMcpFrames(raw) {
        const results = [];
        const text = raw.toString();
        const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const len = parseInt(m[1], 10);
          const start = m.index + m[0].length;
          try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
        }
        return results;
      }
      const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
        + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.copy_file", arguments: { source: "prompts/contracts/dev.md", destination: "copied.md" } } });
      const result = spawnSync(process.execPath, [serverScript], {
        input,
        timeout: 10000,
        env: {
          ...process.env,
          POSSE_ATLAS_MODE: "off",
          POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
          POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
          POSSE_DETERMINISTIC_MCP_ROLE: "dev",
          POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: JSON.stringify(["prompts/contracts/dev.md"]),
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: JSON.stringify(["copied.md"]),
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
        },
      });
      assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
      const frames = parseMcpFrames(result.stdout || "");
      const response = frames.find((f) => f.id === 2 && f.result?.content);
      const text = response?.result?.content?.[0]?.text || "";
      assert.match(text, /copy_file blocked - prompts\/contracts\/dev\.md is protected/);
      assert.equal(fs.existsSync(path.join(scratchDir, "copied.md")), false);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("MCP copy_file and move_file block symlinked env sources", (t) => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-env-link-"));
    try {
      fs.writeFileSync(path.join(scratchDir, ".env"), "SECRET=1\n", "utf-8");
      try {
        fs.symlinkSync(".env", path.join(scratchDir, "linked-config.txt"), "file");
      } catch (err) {
        t.skip(`symlink creation is unavailable in this environment: ${err?.code || err?.message || err}`);
        return;
      }

      const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
      function mcpFrame(obj) {
        const body = JSON.stringify(obj);
        return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      }
      function parseMcpFrames(raw) {
        const results = [];
        const text = raw.toString();
        const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const len = parseInt(m[1], 10);
          const start = m.index + m[0].length;
          try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
        }
        return results;
      }
      const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
        + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.copy_file", arguments: { source: "linked-config.txt", destination: "copied.txt" } } })
        + mcpFrame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tools.move_file", arguments: { source: "linked-config.txt", destination: "moved.txt" } } });
      const result = spawnSync(process.execPath, [serverScript], {
        input,
        timeout: 10000,
        env: {
          ...process.env,
          POSSE_ATLAS_MODE: "off",
          POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
          POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
          POSSE_DETERMINISTIC_MCP_ROLE: "dev",
          POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: JSON.stringify(["linked-config.txt"]),
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: JSON.stringify(["copied.txt", "moved.txt"]),
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
        },
      });
      assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
      const frames = parseMcpFrames(result.stdout || "");
      const copyText = frames.find((f) => f.id === 2)?.result?.content?.[0]?.text || "";
      const moveText = frames.find((f) => f.id === 3)?.result?.content?.[0]?.text || "";
      assert.match(copyText, /copy_file blocked - reading \.env files is blocked/);
      assert.match(moveText, /move_file blocked - reading \.env files is blocked/);
      assert.equal(fs.existsSync(path.join(scratchDir, "copied.txt")), false);
      assert.equal(fs.existsSync(path.join(scratchDir, "moved.txt")), false);
      assert.equal(fs.lstatSync(path.join(scratchDir, "linked-config.txt")).isSymbolicLink(), true);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("MCP delete-only scope still blocks write_file and edit_file outside writable scope", () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-delete-only-"));
    try {
      fs.writeFileSync(path.join(scratchDir, "delete-me.txt"), "delete me\n", "utf8");
      fs.writeFileSync(path.join(scratchDir, "keep.txt"), "keep me\n", "utf8");

      const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
      function mcpFrame(obj) {
        const body = JSON.stringify(obj);
        return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      }
      function parseMcpFrames(raw) {
        const results = [];
        const text = raw.toString();
        const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const len = parseInt(m[1], 10);
          const start = m.index + m[0].length;
          try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
        }
        return results;
      }
      const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
        + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.write_file", arguments: { path: "outside.txt", content: "nope\n" } } })
        + mcpFrame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tools.edit_file", arguments: { path: "keep.txt", old_string: "keep", new_string: "mutated" } } });

      const result = spawnSync(process.execPath, [serverScript], {
        input,
        timeout: 10000,
        env: {
          ...process.env,
          POSSE_ATLAS_MODE: "off",
          POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
          POSSE_DETERMINISTIC_MCP_ROLE: "dev",
          POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
          POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
          POSSE_DETERMINISTIC_MCP_SCOPE_DELETE_FILES: JSON.stringify(["delete-me.txt"]),
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
        },
      });
      assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
      const frames = parseMcpFrames(result.stdout || "");
      const writeText = frames.find((f) => f.id === 2)?.result?.content?.[0]?.text || "";
      const editText = frames.find((f) => f.id === 3)?.result?.content?.[0]?.text || "";
      assert.match(writeText, /outside the allowed creation scope/i);
      assert.match(editText, /outside the allowed edit scope/i);
      assert.equal(fs.existsSync(path.join(scratchDir, "outside.txt")), false);
      assert.equal(fs.readFileSync(path.join(scratchDir, "keep.txt"), "utf8"), "keep me\n");
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("MCP write_file and edit_file refuse .env targets even when they are scoped", () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-env-write-"));
    try {
      fs.writeFileSync(path.join(scratchDir, ".env.local"), "SECRET=old\n", "utf8");

      const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
      function mcpFrame(obj) {
        const body = JSON.stringify(obj);
        return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      }
      function parseMcpFrames(raw) {
        const results = [];
        const text = raw.toString();
        const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const len = parseInt(m[1], 10);
          const start = m.index + m[0].length;
          try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
        }
        return results;
      }
      const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
        + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.write_file", arguments: { path: ".env", content: "SECRET=new\n" } } })
        + mcpFrame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tools.edit_file", arguments: { path: ".env.local", old_string: "old", new_string: "new" } } });

      const result = spawnSync(process.execPath, [serverScript], {
        input,
        timeout: 10000,
        env: {
          ...process.env,
          POSSE_ATLAS_MODE: "off",
          POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
          POSSE_DETERMINISTIC_MCP_ROLE: "dev",
          POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
          POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: JSON.stringify([".env.local"]),
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: JSON.stringify([".env"]),
          POSSE_DETERMINISTIC_MCP_SCOPE_DELETE_FILES: "[]",
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
        },
      });
      assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
      const frames = parseMcpFrames(result.stdout || "");
      const writeText = frames.find((f) => f.id === 2)?.result?.content?.[0]?.text || "";
      const editText = frames.find((f) => f.id === 3)?.result?.content?.[0]?.text || "";
      assert.match(writeText, /Writing \.env files is blocked/);
      assert.match(editText, /Editing \.env files is blocked/);
      assert.equal(fs.existsSync(path.join(scratchDir, ".env")), false);
      assert.equal(fs.readFileSync(path.join(scratchDir, ".env.local"), "utf8"), "SECRET=old\n");
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("MCP write_file and edit_file block protected paths even when they are scoped", () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-protected-write-"));
    try {
      fs.mkdirSync(path.join(scratchDir, "prompts"), { recursive: true });
      fs.writeFileSync(path.join(scratchDir, "prompts", "researcher.md"), "original role prompt\n", "utf8");

      const protectedCreateTargets = [
        "node_modules/pkg/injected.js",
        "prompts/contracts/file-scope.md",
      ];
      const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
      function mcpFrame(obj) {
        const body = JSON.stringify(obj);
        return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      }
      function parseMcpFrames(raw) {
        const results = [];
        const text = raw.toString();
        const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const len = parseInt(m[1], 10);
          const start = m.index + m[0].length;
          try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
        }
        return results;
      }
      const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
        + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.write_file", arguments: { path: protectedCreateTargets[0], content: "nope\n" } } })
        + mcpFrame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tools.write_file", arguments: { path: protectedCreateTargets[1], content: "nope\n" } } })
        + mcpFrame({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "tools.edit_file", arguments: { path: "prompts/researcher.md", old_string: "original", new_string: "mutated" } } });

      const result = spawnSync(process.execPath, [serverScript], {
        input,
        timeout: 10000,
        env: {
          ...process.env,
          POSSE_ATLAS_MODE: "off",
          POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
          POSSE_DETERMINISTIC_MCP_ROLE: "dev",
          POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
          POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: JSON.stringify(["prompts/researcher.md"]),
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: JSON.stringify(protectedCreateTargets),
          POSSE_DETERMINISTIC_MCP_SCOPE_DELETE_FILES: "[]",
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
        },
      });
      assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
      const frames = parseMcpFrames(result.stdout || "");
      for (const id of [2, 3, 4]) {
        const text = frames.find((f) => f.id === id)?.result?.content?.[0]?.text || "";
        assert.match(text, /protected/i, `expected protected-path rejection for call ${id}`);
      }
      assert.equal(fs.existsSync(path.join(scratchDir, protectedCreateTargets[0])), false);
      assert.equal(fs.existsSync(path.join(scratchDir, protectedCreateTargets[1])), false);
      assert.equal(fs.readFileSync(path.join(scratchDir, "prompts", "researcher.md"), "utf8"), "original role prompt\n");
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("MCP bash rejects shell env expansion and does not echo synthetic secrets", () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-bash-env-"));
    try {
      const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
      function mcpFrame(obj) {
        const body = JSON.stringify(obj);
        return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      }
      function parseMcpFrames(raw) {
        const results = [];
        const text = raw.toString();
        const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const len = parseInt(m[1], 10);
          const start = m.index + m[0].length;
          try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
        }
        return results;
      }
      const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
        + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.bash", arguments: { command: "echo %POSSE_SYNTHETIC_SECRET%" } } })
        + mcpFrame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tools.bash", arguments: { command: "echo $POSSE_SYNTHETIC_SECRET" } } });

      const result = spawnSync(process.execPath, [serverScript], {
        input,
        timeout: 10000,
        env: {
          ...process.env,
          POSSE_ATLAS_MODE: "off",
          POSSE_SYNTHETIC_SECRET: "mcp-synthetic-secret-value",
          POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
          POSSE_DETERMINISTIC_MCP_ROLE: "dev",
          POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
          POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
          POSSE_DETERMINISTIC_MCP_SCOPE_DELETE_FILES: "[]",
          POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
        },
      });
      assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
      const frames = parseMcpFrames(result.stdout || "");
      for (const id of [2, 3]) {
        const text = frames.find((f) => f.id === id)?.result?.content?.[0]?.text || "";
        assert.match(text, /Shell variable expansion is not allowed/);
        assert.doesNotMatch(text, /mcp-synthetic-secret-value/);
      }
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("marks ATLAS availability from merged ATLAS config (env + DB) for deterministic MCP", async () => {
    const mcpMod = await import("../../../lib/domains/integrations/functions/deterministic-mcp.js");
    runtimeModules.queueMod.setSetting("atlas_mode", "preferred");
    try {
      const config = withEnv({ POSSE_ATLAS_MODE: null }, () => mcpMod.buildDeterministicReadMcpServerConfig("researcher", {
        cwd: os.tmpdir(),
      }));
      assert.equal(config.env.POSSE_DETERMINISTIC_MCP_ATLAS_AVAILABLE, "true");
      assert.equal(config.env.POSSE_DETERMINISTIC_MCP_ATLAS_GATE_ENABLED, "true");
    } finally {
      runtimeModules.queueMod.setSetting("atlas_mode", "off");
    }
  });

  it("allows per-run ATLAS availability override for deterministic MCP gate env", async () => {
    const mcpMod = await import("../../../lib/domains/integrations/functions/deterministic-mcp.js");
    runtimeModules.queueMod.setSetting("atlas_mode", "preferred");
    try {
      const config = withEnv({ POSSE_ATLAS_MODE: null }, () => mcpMod.buildDeterministicReadMcpServerConfig("researcher", {
        cwd: os.tmpdir(),
        atlasAvailable: false,
      }));
      assert.equal(config.env.POSSE_DETERMINISTIC_MCP_ATLAS_AVAILABLE, "false");
      assert.equal(config.env.POSSE_DETERMINISTIC_MCP_ATLAS_GATE_ENABLED, "true");
    } finally {
      runtimeModules.queueMod.setSetting("atlas_mode", "off");
    }
  });

  it("passes the explicit ATLAS native-tool gate flag to deterministic MCP", async () => {
    const mcpMod = await import("../../../lib/domains/integrations/functions/deterministic-mcp.js");
    const config = mcpMod.buildDeterministicReadMcpServerConfig("researcher", {
      cwd: os.tmpdir(),
      atlasAvailable: true,
      atlasGateEnabled: true,
    });
    assert.equal(config.env.POSSE_DETERMINISTIC_MCP_ATLAS_AVAILABLE, "true");
    assert.equal(config.env.POSSE_DETERMINISTIC_MCP_ATLAS_GATE_ENABLED, "true");
  });

  it("allows explicit ATLAS native-tool gate disablement for deterministic MCP", async () => {
    const mcpMod = await import("../../../lib/domains/integrations/functions/deterministic-mcp.js");
    const config = mcpMod.buildDeterministicReadMcpServerConfig("researcher", {
      cwd: os.tmpdir(),
      atlasAvailable: true,
      atlasGateEnabled: false,
    });
    assert.equal(config.env.POSSE_DETERMINISTIC_MCP_ATLAS_AVAILABLE, "true");
    assert.equal(config.env.POSSE_DETERMINISTIC_MCP_ATLAS_GATE_ENABLED, "false");
  });

  it("passes WI-scoped ATLAS config through the single deterministic MCP env", async () => {
    const mcpMod = await import("../../../lib/domains/integrations/functions/deterministic-mcp.js");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-deterministic-atlas-env-"));
    try {
      const worktreePath = path.join(tmpRoot, "worktree");
      const graphDbPath = path.join(tmpRoot, ".posse", "atlas", "work-items", "wi-40", "repo.lbug");
      fs.mkdirSync(worktreePath, { recursive: true });

      const config = mcpMod.buildDeterministicReadMcpServerConfig("researcher", {
        cwd: worktreePath,
        atlasAvailable: true,
        atlasConfig: {
          requestedRepoPath: worktreePath,
          requestedRepoId: "repo",
          requestedGraphDbPath: graphDbPath,
        },
      });

      assert.equal(config.env.POSSE_DETERMINISTIC_MCP_ATLAS_REPO_PATH, worktreePath);
      assert.equal(config.env.POSSE_DETERMINISTIC_MCP_ATLAS_REPO_ID, "repo");
      assert.equal(config.env.POSSE_DETERMINISTIC_MCP_ATLAS_GRAPH_DB_PATH, graphDbPath);
      assert.equal(config.env.POSSE_DETERMINISTIC_MCP_ATLAS_SHARED_RUNTIME, undefined);
      assert.equal(config.env.POSSE_DETERMINISTIC_MCP_ATLAS_AVAILABLE, "true");
      assert.equal(config.env.POSSE_DETERMINISTIC_MCP_ATLAS_GATE_ENABLED, "true");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("returns an empty repo list without an external ATLAS config", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-atlas-catalog-bad-"));

    try {
      const repos = readConfiguredAtlasRepos({ installPath: tmpRoot });
      assert.deepEqual(repos, []);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("MCP server tools/list includes edit_file and bash for dev role with write enabled", () => {
    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_DETERMINISTIC_MCP_CWD: os.tmpdir(),
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
        POSSE_DETERMINISTIC_MCP_ROLE: "dev",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    const frames = parseMcpFrames(result.stdout || "");
    const toolsListResponse = frames.find((f) => f.id === 2 && f.result?.tools);
    assert.ok(toolsListResponse, "tools/list response should be present in stdout");
    const toolNames = toolsListResponse.result.tools.map((t) => t.name);
    assert.ok(toolNames.includes("tools.edit_file"), "dev+write should expose edit_file");
    assert.ok(toolNames.includes("tools.bash"), "dev+write should expose bash");
    assert.ok(toolNames.includes("tools.write_file"), "dev+write should expose write_file");
    assert.ok(toolNames.includes("tools.read_file"), "dev+write should expose read_file");
  });

  it("MCP server disables write tools when scope env JSON is malformed", () => {
    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_DETERMINISTIC_MCP_CWD: os.tmpdir(),
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
        POSSE_DETERMINISTIC_MCP_ROLE: "dev",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    const frames = parseMcpFrames(result.stdout || "");
    const toolsListResponse = frames.find((f) => f.id === 2 && f.result?.tools);
    assert.ok(toolsListResponse, "tools/list response should be present in stdout");
    const toolNames = toolsListResponse.result.tools.map((t) => t.name);
    assert.equal(toolNames.includes("tools.write_file"), false, "malformed scope should suppress write_file");
    assert.equal(toolNames.includes("tools.edit_file"), false, "malformed scope should suppress edit_file");
    assert.ok(toolNames.includes("tools.read_file"), "read_file should remain available");
  });

  it("MCP server tools/list includes bash but not edit_file for assessor role", () => {
    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_DETERMINISTIC_MCP_CWD: os.tmpdir(),
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
        POSSE_DETERMINISTIC_MCP_ROLE: "assessor",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    const frames = parseMcpFrames(result.stdout || "");
    const toolsListResponse = frames.find((f) => f.id === 2 && f.result?.tools);
    assert.ok(toolsListResponse, "tools/list response should be present in stdout");
    const toolNames = toolsListResponse.result.tools.map((t) => t.name);
    assert.ok(toolNames.includes("tools.bash"), "assessor should expose bash");
    assert.ok(toolNames.includes("tools.read_file"), "assessor should expose read_file");
    assert.ok(toolNames.includes("tools.run_scoped_checks"), "assessor should expose scoped lint/typecheck");
    assert.ok(toolNames.includes("tools.create_test_suite"), "assessor should expose registered test suite creation");
    assert.ok(toolNames.includes("tools.create_test"), "assessor should expose registered test creation");
    assert.ok(toolNames.includes("tools.run_test"), "assessor should expose registered test execution");
    assert.ok(toolNames.includes("tools.run_test_suite"), "assessor should expose registered suite execution");
    assert.equal(toolNames.includes("tools.edit_file"), false, "assessor should not expose edit_file");
    assert.equal(toolNames.includes("tools.write_file"), false, "assessor should not expose write_file");
  });

  it("MCP server tool descriptors advertise destructiveHint=false so Codex exec does not auto-cancel", () => {
    // Codex 0.119 exec mode cancels any MCP tool call whose descriptor has
    // destructiveHint=true (the default when annotations are absent) under
    // approval_policy=never. Posse's MCP server enforces scope internally,
    // so every tool is advertised as non-destructive to Codex's approval gate.
    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_DETERMINISTIC_MCP_CWD: os.tmpdir(),
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
        POSSE_DETERMINISTIC_MCP_ROLE: "dev",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    const frames = parseMcpFrames(result.stdout || "");
    const toolsListResponse = frames.find((f) => f.id === 2 && f.result?.tools);
    assert.ok(toolsListResponse, "tools/list response should be present in stdout");
    const tools = toolsListResponse.result.tools;
    assert.ok(tools.length > 0, "expected at least one tool");
    for (const tool of tools) {
      assert.ok(tool.annotations, `tool ${tool.name} must carry annotations`);
      assert.equal(tool.annotations.destructiveHint, false,
        `tool ${tool.name} must set destructiveHint=false (Codex exec cancels destructive MCP calls)`);
    }
  });

  it("MCP server tool invocations record observations tagged with job_id and work_item_id", () => {
    resetRuntimeDb();
    const wi = runtimeModules.queueMod.createWorkItem("MCP observation tagging", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Observation tagging job",
    });

    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-obs-"));
    const targetFile = path.join(scratchDir, "hello.txt");
    fs.writeFileSync(targetFile, "hi from mcp observation test");

    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.read_file", arguments: { path: "hello.txt" } } });

    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_DETERMINISTIC_MCP_DB_PATH: runtimeDbPath,
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "planner",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
        POSSE_DETERMINISTIC_MCP_JOB_ID: String(job.id),
        POSSE_DETERMINISTIC_MCP_WORK_ITEM_ID: String(wi.id),
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }

    assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
    const rows = runtimeModules.observationsMod.getObservationsByJob(job.id, 10);
    const toolRow = rows.find((row) => row.observation_type === "tool.read");
    assert.ok(toolRow, "tool.read observation should be recorded for MCP read_file call");
    assert.equal(toolRow.work_item_id, wi.id, "observation should carry work_item_id from MCP env");
    assert.equal(toolRow.job_id, job.id, "observation should carry job_id from MCP env");
  });

  it("MCP edit_file ties ATLAS live rebuffer telemetry to the edit observation without counting it as a tool", async () => {
    resetRuntimeDb();
    const wi = runtimeModules.queueMod.createWorkItem("MCP ATLAS rebuffer", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "ATLAS rebuffer job",
    });

    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-atlas-rebuffer-"));
    fs.writeFileSync(path.join(scratchDir, "app.txt"), "alpha\n", "utf8");

    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "tools.edit_file", arguments: { path: "app.txt", old_string: "alpha", new_string: "beta" } },
      });

    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [serverScript], {
      env: {
        ...process.env,
        POSSE_ATLAS_V2: "on",
        POSSE_ATLAS_LIVE_BUFFERS: "deterministic-writes",
        POSSE_DETERMINISTIC_MCP_ATLAS_LIVE_BUFFER_TOOL_WAIT_MS: "15000",
        POSSE_DETERMINISTIC_MCP_DB_PATH: runtimeDbPath,
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "dev",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
        POSSE_DETERMINISTIC_MCP_JOB_ID: String(job.id),
        POSSE_DETERMINISTIC_MCP_WORK_ITEM_ID: String(wi.id),
        POSSE_DETERMINISTIC_MCP_ATLAS_AVAILABLE: "true",
        POSSE_DETERMINISTIC_MCP_ATLAS_GATE_ENABLED: "false",
        POSSE_DETERMINISTIC_MCP_ATLAS_REPO_PATH: scratchDir,
        POSSE_DETERMINISTIC_MCP_ATLAS_REPO_ID: "test-repo",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: JSON.stringify(["app.txt"]),
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdin.write(input);

    const waitStarted = Date.now();
    let frames = [];
    while (Date.now() - waitStarted < 15000) {
      frames = parseMcpFrames(Buffer.from(stdout));
      if (frames.some((frame) => frame.id === 2 && frame.result?.content)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.stdin.end();
    const exitCode = await new Promise((resolve) => {
      child.once("exit", (code) => resolve(code));
      setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve(-1);
      }, 15000).unref();
    });
    frames = parseMcpFrames(Buffer.from(stdout));

    assert.equal(exitCode, 0, `mcp server should exit cleanly (stderr: ${stderr})`);
    const response = frames.find((frame) => frame.id === 2 && frame.result?.content);
    assert.match(response?.result?.content?.[0]?.text || "", /File edited:/);
    assert.equal(fs.readFileSync(path.join(scratchDir, "app.txt"), "utf8"), "beta\n");
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }

    const rows = runtimeModules.observationsMod.getObservationsByJob(job.id, 20);
    const editRow = rows.find((row) => row.observation_type === "tool.edit");
    assert.ok(editRow, "edit_file should record one tool.edit observation");
    const editDetail = JSON.parse(editRow.detail_json);
    assert.equal(editDetail.atlas_live_buffer?.action, "buffer.push");
    assert.equal(editDetail.atlas_live_buffer?.path, "app.txt");
    assert.equal(editDetail.atlas_live_buffer?.ok, true);
    assert.equal(editDetail.atlas_live_buffer?.refresh?.action, "index.refresh");
    assert.equal(editDetail.atlas_live_buffer?.refresh?.path, "app.txt");
    assert.equal(editDetail.atlas_live_buffer?.refresh?.attempted, true);

    const bufferRow = rows.find((row) => row.observation_type === "atlas.buffer_push");
    assert.ok(bufferRow, "ATLAS rebuffer should be retained as non-tool telemetry");
    const refreshRow = rows.find((row) => row.observation_type === "atlas.index_refresh");
    assert.ok(refreshRow, "ATLAS live index refresh should be retained as non-tool telemetry");
    assert.equal(rows.some((row) => row.observation_type === "tool.atlas" && /buffer\.push/.test(row.summary)), false);

    const countRow = runtimeModules.observationsMod.getToolInvocationCountsByJob({ limit: 10 })
      .find((row) => row.job_id === job.id);
    assert.equal(countRow?.total, 1);
    assert.equal(countRow?.tool_types, "tool.edit");
  });

  it("MCP edit_file returns promptly when ATLAS live rebuffer is queued", async () => {
    const wi = runtimeModules.queueMod.createWorkItem("MCP ATLAS rebuffer timeout", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "ATLAS rebuffer queued job",
    });
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-atlas-queued-"));
    fs.writeFileSync(path.join(scratchDir, "app.txt"), "alpha\n", "utf8");
    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "tools.edit_file", arguments: { path: "app.txt", old_string: "alpha", new_string: "beta" } },
      });

    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [serverScript], {
      env: {
        ...process.env,
        POSSE_ATLAS_V2: "on",
        POSSE_ATLAS_LIVE_BUFFERS: "deterministic-writes",
        POSSE_DETERMINISTIC_MCP_ATLAS_LIVE_BUFFER_TOOL_WAIT_MS: "0",
        POSSE_DETERMINISTIC_MCP_DB_PATH: runtimeDbPath,
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "dev",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
        POSSE_DETERMINISTIC_MCP_JOB_ID: String(job.id),
        POSSE_DETERMINISTIC_MCP_WORK_ITEM_ID: String(wi.id),
        POSSE_DETERMINISTIC_MCP_ATLAS_AVAILABLE: "true",
        POSSE_DETERMINISTIC_MCP_ATLAS_GATE_ENABLED: "false",
        POSSE_DETERMINISTIC_MCP_ATLAS_REPO_PATH: scratchDir,
        POSSE_DETERMINISTIC_MCP_ATLAS_REPO_ID: "test-repo",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: JSON.stringify(["app.txt"]),
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdin.write(input);

    const waitStarted = Date.now();
    let frames = [];
    while (Date.now() - waitStarted < 5000) {
      frames = parseMcpFrames(Buffer.from(stdout));
      if (frames.some((frame) => frame.id === 2 && frame.result?.content)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const responseMs = Date.now() - waitStarted;
    child.stdin.end();
    const exitCode = await new Promise((resolve) => {
      child.once("exit", (code) => resolve(code));
      setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve(-1);
      }, 5000).unref();
    });
    frames = parseMcpFrames(Buffer.from(stdout));

    assert.equal(exitCode, 0, `mcp server should exit cleanly (stderr: ${stderr})`);
    const response = frames.find((frame) => frame.id === 2 && frame.result?.content);
    assert.match(response?.result?.content?.[0]?.text || "", /File edited:/);
    assert.ok(responseMs < 5000, `edit_file response should be prompt, took ${responseMs}ms`);
    assert.equal(fs.readFileSync(path.join(scratchDir, "app.txt"), "utf8"), "beta\n");
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }

    const rows = runtimeModules.observationsMod.getObservationsByJob(job.id, 20);
    const editRow = rows.find((row) => row.observation_type === "tool.edit");
    assert.ok(editRow, "edit_file should record one tool.edit observation");
    const editDetail = JSON.parse(editRow.detail_json);
    assert.equal(editDetail.atlas_live_buffer?.action, "buffer.push");
    assert.equal(editDetail.atlas_live_buffer?.path, "app.txt");
    assert.equal(editDetail.atlas_live_buffer?.queued, true);
    assert.equal(editDetail.atlas_live_buffer?.reason, "background");
    assert.equal(editDetail.atlas_live_buffer?.timeout_ms, 0);

    const countRow = runtimeModules.observationsMod.getToolInvocationCountsByJob({ limit: 10 })
      .find((row) => row.job_id === job.id);
    assert.equal(countRow?.total, 1);
    assert.equal(countRow?.tool_types, "tool.edit");
  });

  it("read_file supports structured search and jsonPath extraction", () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-read-"));
    fs.writeFileSync(path.join(scratchDir, "settings.json"), JSON.stringify({
      templates: [{ id: "default", label: "Default" }],
      nested: { flag: true },
    }, null, 2));

    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.read_file", arguments: { path: "settings.json", search: "label", searchContext: 1, jsonPath: "templates.0.label" } } });

    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "planner",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }

    assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
    const frames = parseMcpFrames(result.stdout || "");
    const call = frames.find((f) => f.id === 2);
    const payload = JSON.parse(call.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.jsonPathValue, "Default");
    assert.equal(payload.matches.length, 1);
    assert.match(payload.numberedContent, /label/);
  });

  it("chain_read routes structured extraction through the research audit chain", () => {
    resetRuntimeDb();
    const wi = runtimeModules.queueMod.createWorkItem("Structured chain read", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Structured chain read job",
    });
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-chain-"));
    fs.mkdirSync(path.join(scratchDir, ".posse"), { recursive: true });
    fs.writeFileSync(path.join(scratchDir, "settings.json"), JSON.stringify({ nested: { answer: 42 } }, null, 2));

    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.chain_read", arguments: { path: "settings.json", jsonPath: "nested.answer" } } });

    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_DB_PATH: runtimeDbPath,
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "researcher",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
        POSSE_DETERMINISTIC_MCP_JOB_ID: String(job.id),
        POSSE_DETERMINISTIC_MCP_WORK_ITEM_ID: String(wi.id),
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }

    assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
    const frames = parseMcpFrames(result.stdout || "");
    const text = frames.find((f) => f.id === 2).result.content[0].text;
    assert.match(text, /\[audit ledger:/);
    assert.match(text, /"jsonPathValue": 42/);
    assert.match(text, /chain locked/);
  });

  it("chain_verdict records research evidence for later over-reading diagnostics", () => {
    resetRuntimeDb();
    const wi = runtimeModules.queueMod.createWorkItem("Research evidence", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research evidence job",
    });
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-evidence-"));
    fs.mkdirSync(path.join(scratchDir, ".posse"), { recursive: true });
    fs.writeFileSync(path.join(scratchDir, "notes.txt"), "important evidence\n", "utf8");

    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.chain_read", arguments: { path: "notes.txt" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tools.chain_verdict", arguments: { verdict: "relevant", summary: "contains the core evidence" } } });

    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_DB_PATH: runtimeDbPath,
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "researcher",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
        POSSE_DETERMINISTIC_MCP_JOB_ID: String(job.id),
        POSSE_DETERMINISTIC_MCP_WORK_ITEM_ID: String(wi.id),
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }

    assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
    const frames = parseMcpFrames(result.stdout || "");
    const verdict = JSON.parse(frames.find((f) => f.id === 3).result.content[0].text);
    assert.equal(verdict.evidence.novel_relevant_file, true);

    const rows = runtimeModules.dbMod.getDb().prepare(`
      SELECT observation_type, summary, detail_json
      FROM job_observations
      WHERE job_id = ? AND observation_type = 'research.evidence'
    `).all(job.id);
    assert.equal(rows.length, 1);
    assert.match(rows[0].summary, /notes\.txt -> relevant/);
    const detail = JSON.parse(rows[0].detail_json);
    assert.equal(detail.path, "notes.txt");
    assert.equal(detail.verdict, "relevant");
    assert.equal(detail.novel_relevant_file, true);
    assert.equal(detail.ledger.relevant, 1);
  });

  it("blocks further research tool calls after stale exploration requires synthesis", () => {
    resetRuntimeDb();
    const wi = runtimeModules.queueMod.createWorkItem("Research synth cap", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research synth cap job",
    });
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-synth-cap-"));
    fs.mkdirSync(path.join(scratchDir, ".posse"), { recursive: true });
    fs.writeFileSync(path.join(scratchDir, "notes.txt"), "some context\n", "utf8");

    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    let input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } });
    for (let i = 0; i < 12; i++) {
      input += mcpFrame({ jsonrpc: "2.0", id: 2 + i, method: "tools/call", params: { name: "tools.list_files", arguments: { path: "." } } });
    }
    input += mcpFrame({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "tools.search_files", arguments: { pattern: "context" } } });

    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_DB_PATH: runtimeDbPath,
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "researcher",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
        POSSE_DETERMINISTIC_MCP_JOB_ID: String(job.id),
        POSSE_DETERMINISTIC_MCP_WORK_ITEM_ID: String(wi.id),
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }

    assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
    const frames = parseMcpFrames(result.stdout || "");
    const blocked = frames.find((f) => f.id === 14);
    assert.equal(blocked.result.isError, true);
    assert.match(blocked.result.content[0].text, /RESEARCH SYNTHESIS REQUIRED/);
    assert.match(blocked.result.content[0].text, /partial planner-ready brief/);

    const rows = runtimeModules.dbMod.getDb().prepare(`
      SELECT observation_type, detail_json
      FROM job_observations
      WHERE job_id = ? AND observation_type = 'research.synthesis_required'
    `).all(job.id);
    assert.equal(rows.length, 1);
    const detail = JSON.parse(rows[0].detail_json);
    assert.equal(detail.exploration_steps, 12);
    assert.equal(detail.stale_steps, 12);
  });

  it("rolls up researcher guardrail stats by job", () => {
    resetRuntimeDb();
    const wi = runtimeModules.queueMod.createWorkItem("Research guardrails", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research guardrail stats job",
    });
    const call = runtimeModules.queueMod.createAgentCall({
      work_item_id: wi.id,
      job_id: job.id,
      role: "researcher",
      model_tier: "standard",
      provider: "openai",
    });
    runtimeModules.queueMod.completeAgentCall(call.id, {
      status: "failed",
      input_tokens: 14400000,
      output_tokens: 2000,
      cached_input_tokens: 4000000,
      cost_estimate_usd: 8.5,
    });
    runtimeModules.dbMod.getDb().prepare(`
      INSERT INTO job_observations (work_item_id, job_id, observation_type, summary, detail_json)
      VALUES (?, ?, 'research.evidence', 'Evidence', ?),
             (?, ?, 'research.synthesis_required', 'Synthesis required', ?)
    `).run(
      wi.id,
      job.id,
      JSON.stringify({ novel_relevant_file: true }),
      wi.id,
      job.id,
      JSON.stringify({ exploration_steps: 12, stale_steps: 4 }),
    );

    const stats = runtimeModules.queueMod.getResearcherGuardrailStats();
    assert.equal(stats.totals.jobs, 1);
    assert.equal(stats.totals.call_count, 1);
    assert.equal(stats.totals.input_tokens, 14400000);
    assert.equal(stats.totals.cached_input_tokens, 4000000);
    assert.equal(stats.totals.cost_usd, 8.5);
    assert.equal(stats.totals.evidence_count, 1);
    assert.equal(stats.totals.novel_relevant_files, 1);
    assert.equal(stats.totals.synthesis_required_count, 1);
    assert.equal(stats.by_job[0].job_id, job.id);
  });

  it("chain_read rejects an offset past EOF without locking the chain or recording content", () => {
    resetRuntimeDb();
    const wi = runtimeModules.queueMod.createWorkItem("EOF chain read", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "EOF chain read job",
    });
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-eof-"));
    fs.mkdirSync(path.join(scratchDir, ".posse"), { recursive: true });
    fs.writeFileSync(path.join(scratchDir, "settings.json"), JSON.stringify({ nested: { answer: 42 } }, null, 2));

    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    // First read: offset past EOF -> execReadFile returns the "beyond end of
    // file" sentinel. Second read: a valid read of the same file, which must
    // NOT be blocked by the chain lock — proving the sentinel read never set
    // currentlyReading (which chain_verdict would otherwise persist as content).
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.chain_read", arguments: { path: "settings.json", offset: 9999 } } })
      + mcpFrame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tools.chain_read", arguments: { path: "settings.json" } } });

    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_DB_PATH: runtimeDbPath,
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "researcher",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
        POSSE_DETERMINISTIC_MCP_JOB_ID: String(job.id),
        POSSE_DETERMINISTIC_MCP_WORK_ITEM_ID: String(wi.id),
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }

    assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
    const frames = parseMcpFrames(result.stdout || "");
    const first = frames.find((f) => f.id === 2).result.content[0].text;
    assert.match(first, /AUDIT ERROR/);
    assert.match(first, /beyond end of file/);
    const second = frames.find((f) => f.id === 3).result.content[0].text;
    // The gate error "Chain is locked" would appear only if the sentinel read
    // had wrongly locked the chain. It must not.
    assert.doesNotMatch(second, /Chain is locked/);
    assert.match(second, /\[audit ledger:/);
  });

  it("chain_read allows explicit continuation pages after a verdict", () => {
    resetRuntimeDb();
    const wi = runtimeModules.queueMod.createWorkItem("Paged chain read", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Paged chain read job",
    });
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-chain-paged-"));
    fs.writeFileSync(path.join(scratchDir, "notes.txt"), "line1\nline2\nline3\nline4\nline5\n", "utf8");
    const stateDir = path.join(scratchDir, ".posse", "research-state");
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, `job-${job.id}.json`);
    fs.writeFileSync(statePath, JSON.stringify({
      jobId: job.id,
      workItemId: wi.id,
      currentlyReading: null,
      relevant: {
        "notes.txt": {
          summary: "first page",
          content: "line1\nline2\n",
        },
      },
      irrelevant: [],
      readOrder: ["notes.txt"],
    }, null, 2), "utf8");

    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const env = {
      ...process.env,
      POSSE_ATLAS_MODE: "off",
      POSSE_DETERMINISTIC_MCP_DB_PATH: runtimeDbPath,
      POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
      POSSE_DETERMINISTIC_MCP_ROLE: "researcher",
      POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
      POSSE_DETERMINISTIC_MCP_JOB_ID: String(job.id),
      POSSE_DETERMINISTIC_MCP_WORK_ITEM_ID: String(wi.id),
      POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
      POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
      POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
    };
    const readInput = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.chain_read", arguments: { path: "notes.txt", offset: 3, limit: 2 } } });

    const readResult = spawnSync(process.execPath, [serverScript], {
      input: readInput,
      timeout: 10000,
      env,
    });

    assert.equal(readResult.status, 0, `mcp server should exit cleanly (stderr: ${readResult.stderr})`);
    const readFrames = parseMcpFrames(readResult.stdout || "");
    assert.match(readFrames.find((f) => f.id === 2).result.content[0].text, /line3/);
    assert.doesNotMatch(readFrames.find((f) => f.id === 2).result.content[0].text, /already read/);

    const verdictInput = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.chain_verdict", arguments: { verdict: "relevant", summary: "second page" } } });
    const verdictResult = spawnSync(process.execPath, [serverScript], {
      input: verdictInput,
      timeout: 10000,
      env,
    });
    assert.equal(verdictResult.status, 0, `mcp server should exit cleanly (stderr: ${verdictResult.stderr})`);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.match(state.relevant["notes.txt"].content, /line1/);
    assert.match(state.relevant["notes.txt"].content, /line3/);
    assert.match(state.relevant["notes.txt"].summary, /continuation: second page/);
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("move_file performs case-only renames on Windows", () => {
    if (process.platform !== "win32") return;
    resetRuntimeDb();
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-case-rename-"));
    fs.writeFileSync(path.join(scratchDir, "Readme.md"), "hello\n", "utf8");

    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.move_file", arguments: { source: "Readme.md", destination: "README.md" } } });

    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_DB_PATH: runtimeDbPath,
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "dev",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: JSON.stringify(["Readme.md", "README.md"]),
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });

    assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
    const frames = parseMcpFrames(result.stdout || "");
    const payload = JSON.parse(frames.find((f) => f.id === 2).result.content[0].text);
    assert.equal(payload.ok, true);
    assert.deepEqual(fs.readdirSync(scratchDir), ["README.md"]);
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("chain_read surfaces read failures as audit errors without locking the chain", () => {
    resetRuntimeDb();
    const wi = runtimeModules.queueMod.createWorkItem("Failed chain read", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Failed chain read job",
    });
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-read-fail-"));
    fs.writeFileSync(path.join(scratchDir, "settings.json"), JSON.stringify({ ok: true }, null, 2));

    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.chain_read", arguments: { path: "missing.json" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tools.chain_read", arguments: { path: "settings.json" } } });

    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_DB_PATH: runtimeDbPath,
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "researcher",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
        POSSE_DETERMINISTIC_MCP_JOB_ID: String(job.id),
        POSSE_DETERMINISTIC_MCP_WORK_ITEM_ID: String(wi.id),
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
      },
    });
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }

    assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
    const frames = parseMcpFrames(result.stdout || "");
    const first = frames.find((f) => f.id === 2).result.content[0].text;
    assert.match(first, /^AUDIT ERROR:/);
    assert.doesNotMatch(first, /\[chain locked/);
    assert.doesNotMatch(first, /\[audit ledger:/);
    const second = frames.find((f) => f.id === 3).result.content[0].text;
    assert.doesNotMatch(second, /Chain is locked/);
    assert.match(second, /\[audit ledger:/);
  });

  it("chain_read uses effective scope after malformed scope JSON disables external roots", () => {
    resetRuntimeDb();
    const wi = runtimeModules.queueMod.createWorkItem("Malformed chain read scope", "desc");
    const job = runtimeModules.queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Malformed chain read scope job",
    });
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-chain-malformed-"));
    const scratchDir = path.join(tmpRoot, "worktree");
    const externalRoot = path.join(tmpRoot, ".posse", "resources", "artifacts", `wi-${wi.id}`, "research");
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.mkdirSync(externalRoot, { recursive: true });
    fs.writeFileSync(path.join(externalRoot, "secret.txt"), "external artifact content\n", "utf8");

    const serverScript = path.resolve(__dirname, "..", "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js");
    function mcpFrame(obj) {
      const body = JSON.stringify(obj);
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    }
    function parseMcpFrames(raw) {
      const results = [];
      const text = raw.toString();
      const re = /Content-Length:\s*(\d+)\r\n\r\n/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        try { results.push(JSON.parse(text.slice(start, start + len))); } catch { /* skip */ }
      }
      return results;
    }
    const input = mcpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } })
      + mcpFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tools.chain_read", arguments: { path: path.join(externalRoot, "secret.txt") } } });

    const result = spawnSync(process.execPath, [serverScript], {
      input,
      timeout: 10000,
      env: {
        ...process.env,
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_DB_PATH: runtimeDbPath,
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "researcher",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
        POSSE_DETERMINISTIC_MCP_JOB_ID: String(job.id),
        POSSE_DETERMINISTIC_MCP_WORK_ITEM_ID: String(wi.id),
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: JSON.stringify([externalRoot]),
      },
    });
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }

    assert.equal(result.status, 0, `mcp server should exit cleanly (stderr: ${result.stderr})`);
    const frames = parseMcpFrames(result.stdout || "");
    const text = frames.find((f) => f.id === 2).result.content[0].text;
    assert.match(text, /Path escapes working directory/);
    assert.doesNotMatch(text, /external artifact content/);
  });
});
