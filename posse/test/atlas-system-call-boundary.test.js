import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ParseEngine } from "../lib/domains/atlas/classes/v2/ParseEngine.js";
import { Warmer } from "../lib/domains/atlas/classes/v2/Warmer.js";
import { ingestScip as systemAtlasIngestScip, refresh as systemAtlasRefresh, merge as systemAtlasMerge } from "../lib/domains/system/functions/atlas.js";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { system } from "../lib/domains/system/functions/index.js";
import {
  getAtlasRouteDefinitionForRole,
  isBlockedFoldedAtlasTool,
} from "../lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js";
import { ledgerDbPath, mainViewPath } from "../lib/domains/atlas/functions/v2/runtime-paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(__dirname, "..");

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("Atlas system ownership boundary", () => {
  it("keeps Warmer as a compatibility alias for ParseEngine", () => {
    assert.equal(Object.getPrototypeOf(Warmer.prototype), ParseEngine.prototype);
  });

  it("exports trusted system namespaces for Atlas and git mutations", () => {
    assert.equal(typeof system.atlas.refresh, "function");
    assert.equal(typeof system.git.gitCommitAll, "function");
  });

  it("exposes refresh as a system call that owns ledger/view mutation", async () => {
    const repoRoot = makeTmp("atlas-system-refresh-");
    try {
      const result = await systemAtlasRefresh({
        reason: "test",
        repoRoot,
        mode: "full",
        branch: "main",
        wait: true,
        config: { scipMode: "off" },
      });
      assert.equal(result.ok, true);
      assert.equal(result.operation, "refresh");
      assert.equal(result.reason, "test");
      assert.equal(result.versionId, "main@0");
      assert.ok(fs.existsSync(ledgerDbPath(repoRoot)));
      assert.ok(fs.existsSync(mainViewPath(repoRoot)));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("merge does not close a caller-supplied ledger", async () => {
    const repoRoot = makeTmp("atlas-system-merge-");
    const ledger = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      const result = await systemAtlasMerge({
        reason: "test",
        repoRoot,
        branch: "main",
        ledger,
        config: { scipMode: "off" },
      });
      assert.equal(result.ok, true);
      assert.equal(result.operation, "merge");
      // openEngine only owns (and may close) the ledger it created. A
      // caller-supplied ledger must remain open and usable after merge returns.
      assert.doesNotThrow(() => ledger.headSeq("main"));
    } finally {
      try { ledger.close(); } catch { /* a throw here would mean merge double-closed it */ }
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("ingestScip does not close a caller-supplied ledger when ingestion fails", async () => {
    const repoRoot = makeTmp("atlas-system-ingest-scip-");
    const ledger = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      await assert.rejects(() => systemAtlasIngestScip({
        reason: "test",
        repoRoot,
        branch: "main",
        ledger,
        stagedPath: "missing.scip",
        config: { scipMode: "off" },
      }));
      assert.doesNotThrow(() => ledger.headSeq("main"));
    } finally {
      try { ledger.close(); } catch { /* a throw here would mean ingestScip double-closed it */ }
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not route index mutation actions to agent Atlas tool contracts", () => {
    const forbidden = new Set([
      "index.refresh",
      "scip.ingest",
      "rebuild",
      "purge",
      "onnx.refresh",
      "file.read",
    ]);
    for (const role of ["researcher", "planner", "dev", "assessor"]) {
      const route = getAtlasRouteDefinitionForRole(role);
      for (const action of forbidden) {
        assert.equal(route.tools.includes(action), false, `${role} route exposes ${action}`);
      }
    }
    assert.equal(isBlockedFoldedAtlasTool("atlas.index.refresh"), true);
    assert.equal(isBlockedFoldedAtlasTool("atlas.scip.ingest"), true);
  });

  it("keeps prefetch-only actions routed internally but never advertised", () => {
    // tree.scope is the prefetch's discovery pass: the handoff executes it on
    // the agent's behalf via internalTools, so it must stay in the role route
    // while being stripped from the agent-advertised list. Filtering it out
    // of the route entirely silently broke tree-first prefetch (the prefetch
    // fell back to slice.build on every handoff).
    for (const role of ["researcher", "planner", "dev", "assessor"]) {
      const route = getAtlasRouteDefinitionForRole(role);
      assert.equal(route.tools.includes("tree.scope"), false, `${role} advertises tree.scope`);
      assert.equal(route.internalTools.includes("tree.scope"), true, `${role} internal route lost tree.scope`);
      assert.equal(route.internalTools.includes("tree.grow"), true, `${role} internal route lost tree.grow`);
      assert.equal(route.internalTools.includes("index.refresh"), false, `${role} internal route exposes mutation`);
      assert.equal(route.internalTools.includes("file.read"), false, `${role} internal route exposes fallback-only action`);
    }
  });

  it("refreshes deterministic live writes through system.atlas.refresh instead of MCP forwarding", () => {
    const source = fs.readFileSync(
      path.join(repoDir, "lib", "domains", "integrations", "functions", "deterministic-mcp-server.js"),
      "utf8",
    );
    assert.match(source, /systemAtlasRefresh\(\{/);
    assert.doesNotMatch(source, /toolName:\s*["']atlas\.index\.refresh["']/);
  });
});
