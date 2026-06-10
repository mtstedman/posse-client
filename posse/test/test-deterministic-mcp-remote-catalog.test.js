import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoDir = path.resolve(__dirname, "..");

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function createJsonLineClient(child) {
  let stdout = "";
  let stderr = "";
  let buffer = "";
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout += text;
    buffer += text;
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  child.on("exit", (code, signal) => {
    const err = new Error(`MCP server exited before response (code=${code}, signal=${signal}, stderr=${stderr})`);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(err);
    }
    pending.clear();
  });

  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    waitFor(id) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for response ${id}; stdout=${stdout}; stderr=${stderr}`));
        }, 10_000);
        pending.set(id, { resolve, reject, timeout });
      });
    },
    async stop() {
      if (child.exitCode != null || child.signalCode != null) return;
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.stdin.end();
      const timeout = setTimeout(() => child.kill("SIGTERM"), 2_000);
      await closed;
      clearTimeout(timeout);
    },
  };
}

describe("deterministic MCP remote tool catalog", () => {
  it("refuses to send bearer credentials to non-loopback HTTP catalog URLs", async () => {
    let requestCount = 0;
    const authorizationHeaders = [];
    const remote = http.createServer((req, res) => {
      requestCount += 1;
      authorizationHeaders.push(req.headers.authorization || "");
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          suites: [{ id: "tools", name: "tools" }],
          tools: [{ suite: "tools", name: "tools.read_file", local_name: "read_file" }],
        }));
      });
    });
    const address = await listen(remote, "0.0.0.0");
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-remote-catalog-http-auth-"));
    const child = spawn(process.execPath, [path.join(repoDir, "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js")], {
      cwd: repoDir,
      env: {
        ...process.env,
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "planner",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_ENABLED: "true",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_MODE: "optional",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_SUITES: "tools",
        POSSE_KEY: "catalog-secret",
        POSSE_REMOTE_TIMEOUT_MS: "1000",
        POSSE_REMOTE_URL: `http://0.0.0.0:${address.port}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = createJsonLineClient(child);

    try {
      client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
      await client.waitFor(1);

      client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const listed = await client.waitFor(2);
      assert.equal(requestCount, 0);
      assert.deepEqual(authorizationHeaders, []);
      assert.ok(listed.result.tools.length > 1, "optional insecure catalog should fall back to local tools");
    } finally {
      await client.stop();
      fs.rmSync(scratchDir, { recursive: true, force: true });
      await closeServer(remote);
    }
  });

  it("retries after an initial optional failure, then caches the successful catalog", async () => {
    let requestCount = 0;
    const remote = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString("utf8"); });
      req.on("end", () => {
        requestCount += 1;
        if (req.method !== "POST" || req.url !== "/v1/catalog/tool-surface") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        if (requestCount === 1) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "temporary" }));
          return;
        }
        assert.doesNotThrow(() => JSON.parse(body));
        const tool = requestCount === 2
          ? { suite: "tools", name: "tools.read_file", local_name: "read_file" }
          : { suite: "tools", name: "tools.search_files", local_name: "search_files" };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          suites: [{ id: "tools", name: "tools" }],
          tools: [tool],
        }));
      });
    });
    const address = await listen(remote);
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-remote-catalog-"));
    const child = spawn(process.execPath, [path.join(repoDir, "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js")], {
      cwd: repoDir,
      env: {
        ...process.env,
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "planner",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_ENABLED: "true",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_MODE: "optional",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_SUITES: "tools",
        POSSE_KEY: "test-key",
        POSSE_REMOTE_TIMEOUT_MS: "1000",
        POSSE_REMOTE_URL: `http://127.0.0.1:${address.port}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = createJsonLineClient(child);

    try {
      client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
      await client.waitFor(1);

      client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const first = await client.waitFor(2);
      const firstNames = first.result.tools.map((tool) => tool.name).sort();
      assert.equal(requestCount, 1);
      assert.ok(firstNames.length > 1, "first optional failure should fall back to the local role catalog");

      client.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
      const second = await client.waitFor(3);
      const secondNames = second.result.tools.map((tool) => tool.name).sort();
      assert.equal(requestCount, 2);
      assert.deepEqual(secondNames, ["tools.read_file"]);

      client.send({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
      const third = await client.waitFor(4);
      const thirdNames = third.result.tools.map((tool) => tool.name).sort();
      assert.equal(requestCount, 2);
      assert.deepEqual(thirdNames, ["tools.read_file"]);
    } finally {
      await client.stop();
      fs.rmSync(scratchDir, { recursive: true, force: true });
      await closeServer(remote);
    }
  });

  it("keeps a required successful catalog stable across list and call requests", async () => {
    let requestCount = 0;
    const remote = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        requestCount += 1;
        if (req.method !== "POST" || req.url !== "/v1/catalog/tool-surface") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        if (requestCount > 1) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "should_use_cached_catalog" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          suites: [{ id: "tools", name: "tools" }],
          tools: [{ suite: "tools", name: "tools.read_file", local_name: "read_file" }],
        }));
      });
    });
    const address = await listen(remote);
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-remote-required-cache-"));
    fs.writeFileSync(path.join(scratchDir, "fixture.txt"), "cached surface stayed stable\n", "utf8");
    const child = spawn(process.execPath, [path.join(repoDir, "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js")], {
      cwd: repoDir,
      env: {
        ...process.env,
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "dev",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_ENABLED: "true",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_MODE: "required",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_SUITES: "tools",
        POSSE_KEY: "test-key",
        POSSE_REMOTE_TIMEOUT_MS: "1000",
        POSSE_REMOTE_URL: `http://127.0.0.1:${address.port}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = createJsonLineClient(child);

    try {
      client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
      await client.waitFor(1);

      client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const first = await client.waitFor(2);
      assert.deepEqual(first.result.tools.map((tool) => tool.name), ["tools.read_file"]);
      assert.equal(requestCount, 1);

      client.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
      const second = await client.waitFor(3);
      assert.deepEqual(second.result.tools.map((tool) => tool.name), ["tools.read_file"]);
      assert.equal(requestCount, 1);

      client.send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "tools.read_file",
          arguments: { path: "fixture.txt", offset: 1, limit: 5 },
        },
      });
      const response = await client.waitFor(4);
      assert.equal(response.result.isError, undefined);
      assert.match(response.result.content[0].text, /cached surface stayed stable/);
      assert.equal(requestCount, 1);
    } finally {
      await client.stop();
      fs.rmSync(scratchDir, { recursive: true, force: true });
      await closeServer(remote);
    }
  });

  it("fails required tools/list loudly when the initial remote catalog is unavailable", async () => {
    let requestCount = 0;
    const remote = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        requestCount += 1;
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "temporary" }));
      });
    });
    const address = await listen(remote);
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-remote-required-fail-"));
    const child = spawn(process.execPath, [path.join(repoDir, "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js")], {
      cwd: repoDir,
      env: {
        ...process.env,
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "dev",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_ENABLED: "true",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_MODE: "required",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_SUITES: "tools",
        POSSE_KEY: "test-key",
        POSSE_REMOTE_TIMEOUT_MS: "1000",
        POSSE_REMOTE_URL: `http://127.0.0.1:${address.port}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = createJsonLineClient(child);

    try {
      client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
      await client.waitFor(1);

      client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const listed = await client.waitFor(2);
      assert.equal(requestCount, 1);
      assert.equal(listed.error.code, -32040);
      assert.match(listed.error.message, /Required remote tool catalog unavailable/);
      assert.equal(listed.result, undefined);
    } finally {
      await client.stop();
      fs.rmSync(scratchDir, { recursive: true, force: true });
      await closeServer(remote);
    }
  });

  it("filters fallback-only ATLAS reads from the remote catalog path", async () => {
    const remote = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString("utf8"); });
      req.on("end", () => {
        if (req.method !== "POST" || req.url !== "/v1/catalog/tool-surface") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        assert.doesNotThrow(() => JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          suites: [{ id: "atlas", name: "atlas" }],
          tools: [
            { suite: "atlas", name: "atlas.context.summary", local_name: "context.summary" },
            { suite: "atlas", name: "atlas.file.read", local_name: "file.read" },
            { suite: "atlas", name: "atlas.file.write", local_name: "file.write" },
          ],
        }));
      });
    });
    const address = await listen(remote);
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-remote-atlas-catalog-"));
    const child = spawn(process.execPath, [path.join(repoDir, "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js")], {
      cwd: repoDir,
      env: {
        ...process.env,
        POSSE_ATLAS_V2: "on",
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "researcher",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "false",
        POSSE_DETERMINISTIC_MCP_ATLAS_AVAILABLE: "true",
        POSSE_DETERMINISTIC_MCP_ATLAS_GATE_ENABLED: "false",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_ENABLED: "true",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_MODE: "required",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_SUITES: "atlas",
        POSSE_KEY: "test-key",
        POSSE_REMOTE_TIMEOUT_MS: "1000",
        POSSE_REMOTE_URL: `http://127.0.0.1:${address.port}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = createJsonLineClient(child);

    try {
      client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
      await client.waitFor(1);

      client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const listed = await client.waitFor(2);
      const names = listed.result.tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, ["atlas.context.summary"]);
    } finally {
      await client.stop();
      fs.rmSync(scratchDir, { recursive: true, force: true });
      await closeServer(remote);
    }
  });

  it("denies remembered native tool calls outside the remote-issued surface", async () => {
    let requestCount = 0;
    const remote = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        requestCount += 1;
        if (req.method !== "POST" || req.url !== "/v1/catalog/tool-surface") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          suites: [{ id: "tools", name: "tools" }],
          tools: [{ suite: "tools", name: "tools.read_file", local_name: "read_file" }],
        }));
      });
    });
    const address = await listen(remote);
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-mcp-remote-deny-"));
    const child = spawn(process.execPath, [path.join(repoDir, "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js")], {
      cwd: repoDir,
      env: {
        ...process.env,
        POSSE_ATLAS_MODE: "off",
        POSSE_DETERMINISTIC_MCP_CWD: scratchDir,
        POSSE_DETERMINISTIC_MCP_ROLE: "dev",
        POSSE_DETERMINISTIC_MCP_ALLOW_WRITE: "true",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_ENABLED: "true",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_CATALOG_MODE: "required",
        POSSE_DETERMINISTIC_MCP_REMOTE_TOOL_SUITES: "tools",
        POSSE_DETERMINISTIC_MCP_SCOPE_MODIFY_FILES: "[]",
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_FILES: JSON.stringify(["blocked.txt"]),
        POSSE_DETERMINISTIC_MCP_SCOPE_CREATE_ROOTS: "[]",
        POSSE_KEY: "test-key",
        POSSE_REMOTE_TIMEOUT_MS: "1000",
        POSSE_REMOTE_URL: `http://127.0.0.1:${address.port}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = createJsonLineClient(child);

    try {
      client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
      await client.waitFor(1);

      client.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "tools.write_file",
          arguments: { path: "blocked.txt", content: "should not write\n" },
        },
      });
      const response = await client.waitFor(2);
      assert.equal(requestCount, 1);
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /not allowed/i);
      assert.equal(fs.existsSync(path.join(scratchDir, "blocked.txt")), false);
    } finally {
      await client.stop();
      fs.rmSync(scratchDir, { recursive: true, force: true });
      await closeServer(remote);
    }
  });
});
