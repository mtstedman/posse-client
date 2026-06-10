import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), "..");
const libDir = path.join(repoDir, "lib");

function listJsFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(fullPath);
    }
  };
  walk(dir);
  return files;
}

function resolveImport(file, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(file), spec);
  const candidates = [base];
  if (!path.extname(base)) {
    candidates.push(`${base}.js`);
    candidates.push(path.join(base, "index.js"));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function importSpecifiers(text) {
  const specs = [];
  const patterns = [
    /from\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /export\s+[^"';]*?from\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (let match; (match = pattern.exec(text));) specs.push(match[1]);
  }
  return specs;
}

describe("lib layout", () => {
  it("keeps lib rooted only by classes, functions, catalog, domains, and shared", () => {
    const entries = fs.readdirSync(libDir, { withFileTypes: true });
    // .posse (runtime) and bin (vendored native binaries) are non-source dirs.
    const sourceEntries = entries.filter((entry) => entry.name !== ".posse" && entry.name !== "bin");
    assert.deepEqual(sourceEntries.map((entry) => entry.name).sort(), ["catalog", "classes", "domains", "functions", "shared"]);
    assert.equal(sourceEntries.every((entry) => entry.isDirectory()), true);
    assert.deepEqual(fs.readdirSync(path.join(libDir, "classes")).filter((name) => name.endsWith(".js")), []);
    assert.deepEqual(fs.readdirSync(path.join(libDir, "functions")).filter((name) => name.endsWith(".js")), []);
    // catalog/ is intentionally flat — each domain enum is one top-level
    // file. Assert no subdirectories sneak in.
    const catalogEntries = fs.readdirSync(path.join(libDir, "catalog"), { withFileTypes: true });
    assert.equal(catalogEntries.every((entry) => entry.isFile() && entry.name.endsWith(".js")), true);
  });

  it("keeps legacy classes/functions roots limited to active tools areas", () => {
    const classRoots = fs.readdirSync(path.join(libDir, "classes"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const functionRoots = fs.readdirSync(path.join(libDir, "functions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(classRoots, ["tools"]);
    assert.deepEqual(functionRoots, ["toolkit", "tools"]);
  });

  it("keeps domain packages split by classes and functions", () => {
    const domainsDir = path.join(libDir, "domains");
    const expectedDomains = [
      "artifacts",
      "assessment",
      "atlas",
      "billing",
      "bridge",
      "cleanup",
      "cli",
      "git",
      "handoff",
      "integrations",
      "observability",
      "planning",
      "project",
      "providers",
      "queue",
      "remote",
      "research",
      "runtime",
      "scheduler",
      "session",
      "settings",
      "system",
      "ui",
      "worker",
    ];
    const domainEntries = fs.readdirSync(domainsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(domainEntries, expectedDomains);
    assert.equal(domainEntries.includes("concurrency"), false);
    assert.equal(domainEntries.includes("logging"), false);
    assert.equal(domainEntries.includes("storage"), false);
    assert.equal(domainEntries.includes("tools"), false);
    assert.equal(domainEntries.includes("toolkit"), false);

    for (const domain of expectedDomains) {
      const domainDir = path.join(domainsDir, domain);
      assert.equal(fs.existsSync(path.join(domainDir, "index.js")), true, `${domain}/index.js`);
      assert.equal(fs.existsSync(path.join(domainDir, "classes", "index.js")), true, `${domain}/classes/index.js`);
      assert.equal(fs.existsSync(path.join(domainDir, "functions", "index.js")), true, `${domain}/functions/index.js`);
    }
  });

  it("keeps shared split by classes and functions", () => {
    const sharedDir = path.join(libDir, "shared");
    assert.equal(fs.existsSync(path.join(sharedDir, "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "classes", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "functions", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "concurrency", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "concurrency", "classes", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "concurrency", "functions", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "telemetry", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "telemetry", "classes", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "telemetry", "classes", "logging", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "telemetry", "functions", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "telemetry", "functions", "logging", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "storage", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "storage", "classes", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "storage", "functions", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "format", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "format", "classes", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "format", "functions", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "scope", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "scope", "classes", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "scope", "functions", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "skills", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "skills", "classes", "index.js")), true);
    assert.equal(fs.existsSync(path.join(sharedDir, "skills", "functions", "index.js")), true);
  });

  it("keeps class modules in domain and shared folders", () => {
    const expected = [
      "domains/ui/classes/admin/AdminTUI.js",
      "domains/ui/classes/display/Display.js",
      "domains/git/classes/Repo.js",
      "domains/queue/classes/job/Job.js",
      "domains/providers/classes/ProviderRegistry.js",
      "domains/scheduler/classes/Scheduler.js",
      "domains/worker/classes/Worker.js",
      "domains/worker/classes/roles/planner.js",
      "shared/scope/classes/Scope.js",
      "shared/telemetry/classes/logging/PromptLog.js",
    ];
    for (const rel of expected) {
      assert.equal(fs.existsSync(path.join(libDir, ...rel.split("/"))), true, rel);
    }
  });

  it("keeps function modules in domain, shared, and active toolkit folders", () => {
    const expected = [
      "domains/artifacts/functions/index.js",
      "shared/storage/functions/index.js",
      "domains/git/functions/worktree.js",
      "domains/handoff/functions/index.js",
      "domains/integrations/functions/atlas.js",
      "domains/providers/functions/provider.js",
      "domains/queue/functions/index.js",
      "domains/runtime/functions/paths.js",
      "functions/toolkit/index.js",
      "domains/worker/functions/helpers/assessment-pipeline.js",
    ];
    for (const rel of expected) {
      assert.equal(fs.existsSync(path.join(libDir, ...rel.split("/"))), true, rel);
    }
  });

  it("does not import removed lib domain roots", () => {
    const offenders = [];
    for (const file of listJsFiles(repoDir)) {
      const text = fs.readFileSync(file, "utf-8");
      for (const spec of importSpecifiers(text)) {
        const resolved = resolveImport(file, spec);
        if (!resolved) continue;
        const rel = path.relative(repoDir, resolved).replace(/\\/g, "/");
        const removedClassRoot = rel.startsWith("lib/classes/") && !rel.startsWith("lib/classes/tools/");
        const removedFunctionRoot = rel.startsWith("lib/functions/")
          && !rel.startsWith("lib/functions/tools/")
          && !rel.startsWith("lib/functions/toolkit/");
        if (
          removedClassRoot
          || removedFunctionRoot
          || (
            rel.startsWith("lib/")
            && !rel.startsWith("lib/classes/tools/")
            && !rel.startsWith("lib/functions/tools/")
            && !rel.startsWith("lib/functions/toolkit/")
            && !rel.startsWith("lib/catalog/")
            && !rel.startsWith("lib/domains/")
            && !rel.startsWith("lib/shared/")
          )
        ) {
          offenders.push(`${path.relative(repoDir, file).replace(/\\/g, "/")} -> ${rel}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});
