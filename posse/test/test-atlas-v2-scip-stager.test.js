import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { decideStageAction, describeScipStagingState, ensureScipStaged, extractScipIndexerProgressEvents } from "../lib/domains/atlas/functions/v2/scip/stager.js";
import {
  defaultArgsForCommand,
  describeScipIndexerLookup,
  resolveScipStagePlans,
} from "../lib/domains/atlas/functions/v2/scip/indexers.js";
import { installScipLanguageDependenciesSync } from "../lib/domains/atlas/functions/v2/scip/dependencies.js";
import { DEFAULT_POSSE_ROOT as DEFAULT_RUNTIME_POSSE_ROOT } from "../lib/domains/runtime/functions/python-runtime.js";
import { buildFailedStagerMeta, buildStagerMeta, readStagerMeta, stagerMetaPathForOutput } from "../lib/domains/atlas/functions/v2/scip/stager-meta.js";
import { encodeIndex, encodeToolInfo } from "./helpers/scip-encoder.mjs";

const SCIP_SCRIPT_HELPER = [
  "function scipVarint(value) {",
  "  let v = BigInt(value);",
  "  const out = [];",
  "  while (v > 0x7fn) {",
  "    out.push(Number(v & 0x7fn) | 0x80);",
  "    v >>= 7n;",
  "  }",
  "  out.push(Number(v));",
  "  return out;",
  "}",
  "function scipTag(fieldNumber, wireType) { return scipVarint((fieldNumber << 3) | wireType); }",
  "function scipStrField(fieldNumber, value) {",
  "  const buf = Buffer.from(String(value), 'utf8');",
  "  return [...scipTag(fieldNumber, 2), ...scipVarint(buf.length), ...buf];",
  "}",
  "function scipMsgField(fieldNumber, subBytes) { return [...scipTag(fieldNumber, 2), ...scipVarint(subBytes.length), ...subBytes]; }",
  "function inferScipFixtureLanguage(out) {",
  "  const base = String(out || '').toLowerCase();",
  "  if (base.includes('python')) return 'python';",
  "  if (base.includes('php')) return 'php';",
  "  if (base.includes('go')) return 'go';",
  "  if (base.includes('rust')) return 'rust';",
  "  return 'typescript';",
  "}",
  "function writeScipFixture(out, language = inferScipFixtureLanguage(out), relativePath = null) {",
  "  const ext = language === 'python' ? 'py' : language === 'php' ? 'php' : language === 'go' ? 'go' : language === 'rust' ? 'rs' : 'ts';",
  "  const docPath = relativePath || ('fixture-' + Date.now() + '.' + ext);",
  "  const doc = [...scipStrField(1, docPath), ...scipStrField(4, language), ...scipStrField(5, 'fixture')];",
  "  fs.writeFileSync(out, Buffer.from(scipMsgField(2, doc)));",
  "}",
];

function writeFakeScipIndexer(binDir, names, { inferredTsconfig = '{"compilerOptions":{"allowJs":true}}' } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "fake-indexer.mjs"), [
    "import fs from 'node:fs';",
    ...SCIP_SCRIPT_HELPER,
    "if (process.argv.includes('--infer-tsconfig') && !fs.existsSync('tsconfig.json')) {",
    `  fs.writeFileSync('tsconfig.json', ${JSON.stringify(inferredTsconfig)});`,
    "}",
    "const out = process.argv[process.argv.indexOf('--output') + 1];",
    "writeScipFixture(out);",
  ].join("\n"));
  if (process.platform === "win32") {
    for (const name of names) {
      fs.writeFileSync(path.join(binDir, `${name}.cmd`), "@echo off\r\nnode \"%~dp0fake-indexer.mjs\" %*\r\n");
    }
  } else {
    for (const name of names) {
      const script = path.join(binDir, name);
      fs.writeFileSync(script, "#!/usr/bin/env sh\nnode \"$(dirname \"$0\")/fake-indexer.mjs\" \"$@\"\n");
      fs.chmodSync(script, 0o755);
    }
  }
}

function writeScriptedScipIndexer(binDir, commandName, scriptLines) {
  fs.mkdirSync(binDir, { recursive: true });
  const scriptName = `${commandName}.mjs`;
  const insertAt = scriptLines.findIndex((line) => !/^\s*import\b/u.test(String(line)));
  const prefixLength = insertAt === -1 ? scriptLines.length : insertAt;
  fs.writeFileSync(path.join(binDir, scriptName), [
    ...scriptLines.slice(0, prefixLength),
    ...SCIP_SCRIPT_HELPER,
    ...scriptLines.slice(prefixLength),
  ].join("\n"));
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, `${commandName}.cmd`), `@echo off\r\nnode "%~dp0${scriptName}" %*\r\n`);
  } else {
    const command = path.join(binDir, commandName);
    fs.writeFileSync(command, `#!/usr/bin/env sh\nnode "$(dirname "$0")/${scriptName}" "$@"\n`);
    fs.chmodSync(command, 0o755);
  }
}

function writeFakeNpmInstaller(binDir, { writeBins = true, capturePath = null } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "fake-npm.mjs"), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    capturePath ? `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.env, null, 2));` : "",
    `const writeBins = ${writeBins ? "true" : "false"};`,
    "if (writeBins) {",
    "  const binDir = path.join(process.cwd(), 'node_modules', '.bin');",
    "  fs.mkdirSync(binDir, { recursive: true });",
    "  for (const name of ['scip-typescript', 'scip-python']) {",
    "    if (process.platform === 'win32') {",
    "      fs.writeFileSync(path.join(binDir, `${name}.cmd`), `@echo off\\r\\necho ${name} 0.0.0\\r\\n`);",
    "    } else {",
    "      const file = path.join(binDir, name);",
    "      fs.writeFileSync(file, `#!/usr/bin/env sh\\necho ${name} 0.0.0\\n`);",
    "      fs.chmodSync(file, 0o755);",
    "    }",
    "  }",
    "}",
  ].join("\n"));
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "npm.cmd"), "@echo off\r\nnode \"%~dp0fake-npm.mjs\" %*\r\n");
  } else {
    const npm = path.join(binDir, "npm");
    fs.writeFileSync(npm, "#!/usr/bin/env sh\nnode \"$(dirname \"$0\")/fake-npm.mjs\" \"$@\"\n");
    fs.chmodSync(npm, 0o755);
  }
}

function withPrependedPath(binDir, fn) {
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === "path") || "PATH";
  const old = process.env[key];
  process.env[key] = old ? `${binDir}${path.delimiter}${old}` : binDir;
  try {
    return fn();
  } finally {
    if (old == null) delete process.env[key];
    else process.env[key] = old;
  }
}

function writeFakeGoInstaller(binDir, capturePath) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "fake-go.mjs"), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.env, null, 2));`,
    "const outDir = process.env.GOBIN;",
    "if (!outDir) process.exit(3);",
    "fs.mkdirSync(outDir, { recursive: true });",
    "if (process.platform === 'win32') {",
    "  fs.writeFileSync(path.join(outDir, 'scip-go.cmd'), '@echo off\\r\\necho scip-go fixture\\r\\n');",
    "} else {",
    "  const file = path.join(outDir, 'scip-go');",
    "  fs.writeFileSync(file, '#!/usr/bin/env sh\\necho scip-go fixture\\n');",
    "  fs.chmodSync(file, 0o755);",
    "}",
  ].filter(Boolean).join("\n"));
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "go.cmd"), "@echo off\r\nnode \"%~dp0fake-go.mjs\" %*\r\n");
  } else {
    const go = path.join(binDir, "go");
    fs.writeFileSync(go, "#!/usr/bin/env sh\nnode \"$(dirname \"$0\")/fake-go.mjs\" \"$@\"\n");
    fs.chmodSync(go, 0o755);
  }
}

function withTemporaryEnv(updates, fn) {
  const previous = new Map();
  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  };
  for (const [key, value] of Object.entries(updates || {})) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    const result = fn();
    if (result && typeof result.then === "function") return result.finally(restore);
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function readCallLog(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean);
  } catch {
    return [];
  }
}

function legacyCommandArgsHash(plan, timeoutMs) {
  const payload = {
    command: String(plan?.command || ""),
    args: Array.isArray(plan?.args) ? plan.args.map((arg) => String(arg)) : [],
    label: String(plan?.label || ""),
    indexer_id: String(plan?.indexerId || ""),
    command_source: String(plan?.commandSource || ""),
    timeout_ms: Number(timeoutMs) || 0,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

describe("ATLAS v2 SCIP stager indexer registry", () => {
  it("resolves matching indexers from Posse-managed bins before repo-local bins", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-indexers-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const posseBin = path.join(posseRoot, "node_modules", ".bin");
      const repoBin = path.join(repoRoot, "node_modules", ".bin");
      fs.mkdirSync(posseBin, { recursive: true });
      fs.mkdirSync(repoBin, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      fs.writeFileSync(path.join(repoRoot, "composer.json"), "{}\n");
      fs.writeFileSync(path.join(repoRoot, "index.php"), "<?php echo 'fixture';\n");
      const ext = process.platform === "win32" ? ".cmd" : "";
      fs.writeFileSync(path.join(posseBin, `scip-python${ext}`), "");
      fs.writeFileSync(path.join(posseBin, `scip-php${ext}`), "");
      fs.writeFileSync(path.join(repoBin, `scip-python${ext}`), "");

      const lookup = resolveScipStagePlans({
        repoRoot,
        posseRoot,
        scipDir: path.join(repoRoot, ".posse", "atlas", "scip"),
      });

      assert.deepEqual(lookup.projectKinds.sort(), ["php", "python"]);
      assert.deepEqual(lookup.plans.map((plan) => plan.indexerId).sort(), ["php", "python"]);
      assert.ok(lookup.plans.every((plan) => path.dirname(plan.command) === path.resolve(posseBin)));
      assert.ok(lookup.plans.every((plan) => plan.commandSource === "posse node_modules/.bin"));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("names the central missing indexers when no matching command is installed", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-indexers-missing-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      fs.writeFileSync(path.join(repoRoot, "composer.json"), "{}\n");
      fs.writeFileSync(path.join(repoRoot, "index.php"), "<?php echo 'fixture';\n");

      const lookup = resolveScipStagePlans({
        repoRoot,
        posseRoot: path.join(tmpRoot, "posse"),
        scipDir: path.join(repoRoot, ".posse", "atlas", "scip"),
      });
      const message = describeScipIndexerLookup(lookup);

      assert.equal(lookup.plans.length, 0);
      assert.match(message, /python/);
      assert.match(message, /php/);
      assert.match(message, /scip-python/);
      assert.match(message, /scip-php/);
      assert.match(message, /Posse-managed bins/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("filters auto-detected indexers through the enabled language selector", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-language-filter-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const binDir = path.join(posseRoot, "scip", "node", "node_modules", ".bin");
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "package.json"), "{}\n", { flag: "w" });
      fs.writeFileSync(path.join(repoRoot, "server.js"), "export const fixture = true;\n", { flag: "w" });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n", { flag: "w" });
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n", { flag: "w" });
      const ext = process.platform === "win32" ? ".cmd" : "";
      fs.writeFileSync(path.join(binDir, `scip-typescript${ext}`), "");
      fs.writeFileSync(path.join(binDir, `scip-python${ext}`), "");

      const lookup = resolveScipStagePlans({
        repoRoot,
        posseRoot,
        scipDir: path.join(repoRoot, ".posse", "atlas", "scip"),
        languages: "python",
      });

      assert.deepEqual(lookup.projectKinds, ["python"]);
      assert.deepEqual(lookup.plans.map((plan) => plan.indexerId), ["python"]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("detects vanilla JavaScript repos by source extension and infers tsconfig", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-js-source-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const binDir = path.join(posseRoot, "scip", "node", "node_modules", ".bin");
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "server.js"), "export const fixture = true;\n");
      const ext = process.platform === "win32" ? ".cmd" : "";
      fs.writeFileSync(path.join(binDir, `scip-typescript${ext}`), "");

      const lookup = resolveScipStagePlans({
        repoRoot,
        posseRoot,
        scipDir: path.join(repoRoot, ".posse", "atlas", "scip"),
        languages: "typescript",
      });

      assert.deepEqual(lookup.projectKinds, ["typescript"]);
      assert.deepEqual(lookup.plans[0].sourceLanguages, ["js"]);
      assert.deepEqual(lookup.plans[0].args.slice(0, 2), ["index", "--infer-tsconfig"]);
      assert.deepEqual(defaultArgsForCommand("scip-typescript"), ["index", "--infer-tsconfig", "--output", "{output}"]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("cleans up tsconfig generated by inferred vanilla JavaScript indexing", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-js-clean-tsconfig-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "node", "node_modules", ".bin");
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "server.js"), "export const fixture = true;\n");
      writeFakeScipIndexer(binDir, ["scip-typescript"]);

      const result = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "always", scipLanguages: ["typescript"] },
      });

      assert.equal(result.reason, "staged");
      assert.ok(fs.statSync(path.join(scipDir, "typescript.scip")).size > 0);
      assert.equal(fs.existsSync(path.join(repoRoot, "tsconfig.json")), false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("cleans up empty tsconfig generated by inferred TypeScript indexing", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-ts-clean-tsconfig-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "node", "node_modules", ".bin");
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "app.ts"), "export const fixture = true;\n");
      writeFakeScipIndexer(binDir, ["scip-typescript"], { inferredTsconfig: "{}" });

      const result = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "always", scipLanguages: ["typescript"] },
      });

      assert.equal(result.reason, "staged");
      assert.ok(fs.statSync(path.join(scipDir, "typescript.scip")).size > 0);
      assert.equal(fs.existsSync(path.join(repoRoot, "tsconfig.json")), false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("scrubs Posse secrets and Node preload env before launching SCIP indexers", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-env-scrub-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      const preloadPath = path.join(tmpRoot, "preload.cjs");
      const preloadSentinel = path.join(tmpRoot, "preload-ran.txt");
      const envSnapshotPath = path.join(tmpRoot, "env-snapshot.json");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      fs.writeFileSync(preloadPath, [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(preloadSentinel)}, 'ran');`,
      ].join("\n"));
      writeScriptedScipIndexer(binDir, "scip-python", [
        "import fs from 'node:fs';",
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        `fs.writeFileSync(${JSON.stringify(envSnapshotPath)}, JSON.stringify({`,
        "  POSSE_KEY: process.env.POSSE_KEY || null,",
        "  POSSE_SCIP_SECRET: process.env.POSSE_SCIP_SECRET || null,",
        "  NODE_OPTIONS: process.env.NODE_OPTIONS || null,",
        "  NODE_PATH: process.env.NODE_PATH || null,",
        "  PATH_PRESENT: Boolean(process.env.PATH || process.env.Path),",
        "}));",
        "writeScipFixture(out, 'python', 'app.py');",
      ]);

      const result = await withTemporaryEnv({
        NODE_OPTIONS: `--require=${preloadPath.replace(/\\/g, "/")}`,
        NODE_PATH: tmpRoot,
        POSSE_KEY: "remote-secret",
        POSSE_SCIP_SECRET: "synthetic-scip-secret-1234567890",
      }, () => ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "always", scipLanguages: ["python"] },
      }));

      assert.equal(result.reason, "staged");
      const snapshot = JSON.parse(fs.readFileSync(envSnapshotPath, "utf8"));
      assert.equal(snapshot.POSSE_KEY, null);
      assert.equal(snapshot.POSSE_SCIP_SECRET, null);
      assert.equal(snapshot.NODE_OPTIONS, null);
      assert.equal(snapshot.NODE_PATH, null);
      assert.equal(snapshot.PATH_PRESENT, true);
      assert.equal(fs.existsSync(preloadSentinel), false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("ignores Posse runtime directories when detecting SCIP source extensions", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-ignore-runtime-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const binDir = path.join(posseRoot, "scip", "node", "node_modules", ".bin");
      fs.mkdirSync(path.join(repoRoot, ".posse", "resources"), { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, ".posse", "resources", "artifact.js"), "export const ignored = true;\n");
      const ext = process.platform === "win32" ? ".cmd" : "";
      fs.writeFileSync(path.join(binDir, `scip-typescript${ext}`), "");

      const lookup = resolveScipStagePlans({
        repoRoot,
        posseRoot,
        scipDir: path.join(repoRoot, ".posse", "atlas", "scip"),
        languages: "typescript",
      });

      assert.deepEqual(lookup.projectKinds, []);
      assert.deepEqual(lookup.plans, []);
      assert.match(describeScipIndexerLookup(lookup), /no recognized SCIP source files/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("dry-runs language dependency setup without requiring host toolchains", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-install-dry-"));
    try {
      const posseRoot = path.join(tmpRoot, "posse");
      fs.mkdirSync(path.join(posseRoot, "scip", "node"), { recursive: true });
      fs.writeFileSync(path.join(posseRoot, "scip", "node", "package.json"), "{}\n");

      const result = installScipLanguageDependenciesSync({
        posseRoot,
        languages: "typescript,python",
        dryRun: true,
      });

      assert.equal(result.ok, true);
      assert.deepEqual(result.languages, ["typescript", "python"]);
      assert.deepEqual(result.results.map((row) => row.status), ["dry-run", "dry-run"]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("resolves default Posse SCIP roots from the checkout root", () => {
    const repoRoot = path.resolve(process.cwd());
    const lookup = resolveScipStagePlans({
      repoRoot,
      scipDir: path.join(repoRoot, ".posse", "atlas", "scip"),
      languages: "typescript",
    });
    const dependencyResult = installScipLanguageDependenciesSync({
      languages: "typescript,php",
      dryRun: true,
    });

    const scipNodeRoot = lookup.searchRoots.find((entry) => entry.source === "posse scip/node")?.dir;
    const scipPhpRoot = lookup.searchRoots.find((entry) => entry.source === "posse scip/php")?.dir;

    assert.equal(DEFAULT_RUNTIME_POSSE_ROOT, repoRoot);
    assert.equal(scipNodeRoot, path.join(repoRoot, "scip", "node", "node_modules", ".bin"));
    assert.equal(scipPhpRoot, path.join(repoRoot, "scip", "php", "vendor", "bin"));
    assert.equal(dependencyResult.ok, true);
    assert.deepEqual(dependencyResult.results.map((row) => row.ok), [true, true]);
    assert.doesNotMatch(dependencyResult.results.map((row) => row.message).join("\n"), /[\\/]lib[\\/]scip[\\/]/);
  });

  it("installs Node SCIP deps through the selected npm command and validates the binaries", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-install-node-"));
    try {
      const posseRoot = path.join(tmpRoot, "posse");
      const nodeDir = path.join(posseRoot, "scip", "node");
      const fakeBin = path.join(tmpRoot, "fake-bin");
      fs.mkdirSync(nodeDir, { recursive: true });
      fs.writeFileSync(path.join(nodeDir, "package.json"), "{}\n");
      writeFakeNpmInstaller(fakeBin);

      const result = withPrependedPath(fakeBin, () => installScipLanguageDependenciesSync({
        posseRoot,
        languages: "typescript",
        force: true,
      }));

      assert.equal(result.ok, true);
      assert.deepEqual(result.results.map((row) => row.status), ["installed"]);
      const ext = process.platform === "win32" ? ".cmd" : "";
      assert.equal(fs.existsSync(path.join(nodeDir, "node_modules", ".bin", `scip-typescript${ext}`)), true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("scrubs secrets before launching SCIP dependency installers", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-install-env-"));
    try {
      const posseRoot = path.join(tmpRoot, "posse");
      const nodeDir = path.join(posseRoot, "scip", "node");
      const fakeBin = path.join(tmpRoot, "fake-bin");
      const npmCapture = path.join(tmpRoot, "npm-env.json");
      const goCapture = path.join(tmpRoot, "go-env.json");
      fs.mkdirSync(nodeDir, { recursive: true });
      fs.writeFileSync(path.join(nodeDir, "package.json"), "{}\n");
      writeFakeNpmInstaller(fakeBin, { capturePath: npmCapture });
      writeFakeGoInstaller(fakeBin, goCapture);

      const result = withTemporaryEnv({
        POSSE_KEY: "remote-secret",
        POSSE_SCIP_INSTALL_SECRET: "synthetic-scip-install-secret",
        NPM_TOKEN: "npm-secret-token",
        NODE_OPTIONS: "--require ./preload.cjs",
        HTTPS_PROXY: "http://proxy.example.test:8080",
        SSL_CERT_FILE: path.join(tmpRoot, "ca.pem"),
      }, () => withPrependedPath(fakeBin, () => installScipLanguageDependenciesSync({
        posseRoot,
        languages: "typescript,go",
        force: true,
      })));

      const npmEnv = JSON.parse(fs.readFileSync(npmCapture, "utf8"));
      const goEnv = JSON.parse(fs.readFileSync(goCapture, "utf8"));
      const npmPathKey = Object.keys(npmEnv).find((key) => key.toLowerCase() === "path");
      const goPathKey = Object.keys(goEnv).find((key) => key.toLowerCase() === "path");

      assert.equal(result.ok, true);
      for (const captured of [npmEnv, goEnv]) {
        assert.equal(captured.POSSE_KEY, undefined);
        assert.equal(captured.POSSE_SCIP_INSTALL_SECRET, undefined);
        assert.equal(captured.NPM_TOKEN, undefined);
        assert.equal(captured.NODE_OPTIONS, undefined);
        assert.equal(captured.HTTPS_PROXY, "http://proxy.example.test:8080");
        assert.equal(captured.SSL_CERT_FILE, path.join(tmpRoot, "ca.pem"));
      }
      assert.ok(npmPathKey);
      assert.ok(goPathKey);
      assert.match(npmEnv[npmPathKey], new RegExp(fakeBin.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
      assert.match(goEnv[goPathKey], new RegExp(fakeBin.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
      assert.equal(goEnv.GOBIN, path.join(posseRoot, "scip", "bin"));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("does not report Node SCIP deps installed when npm leaves the selected binary missing", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-install-node-missing-"));
    try {
      const posseRoot = path.join(tmpRoot, "posse");
      const nodeDir = path.join(posseRoot, "scip", "node");
      const fakeBin = path.join(tmpRoot, "fake-bin");
      fs.mkdirSync(nodeDir, { recursive: true });
      fs.writeFileSync(path.join(nodeDir, "package.json"), "{}\n");
      writeFakeNpmInstaller(fakeBin, { writeBins: false });

      const result = withPrependedPath(fakeBin, () => installScipLanguageDependenciesSync({
        posseRoot,
        languages: "typescript",
        force: true,
      }));

      assert.equal(result.ok, false);
      assert.match(result.results[0].message, /validation failed/i);
      assert.match(result.results[0].message, /scip-typescript/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("stages missing language outputs when another SCIP file is already present", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-stage-missing-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      fs.writeFileSync(path.join(repoRoot, "composer.json"), "{}\n");
      fs.writeFileSync(path.join(repoRoot, "index.php"), "<?php echo 'fixture';\n");
      fs.writeFileSync(path.join(scipDir, "python.scip"), "existing");
      writeFakeScipIndexer(binDir, ["scip-python", "scip-php"]);

      const result = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
      });

      assert.equal(result.reason, "staged");
      assert.equal(fs.readFileSync(path.join(scipDir, "python.scip"), "utf8"), "existing");
      assert.ok(fs.statSync(path.join(scipDir, "php.scip")).size > 0);
      assert.equal(fs.existsSync(stagerMetaPathForOutput(path.join(scipDir, "php.scip"))), true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("notifies staged files as each parallel indexer finishes", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-stage-ready-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      fs.writeFileSync(path.join(repoRoot, "composer.json"), "{}\n");
      fs.writeFileSync(path.join(repoRoot, "index.php"), "<?php echo 'fixture';\n");
      writeScriptedScipIndexer(binDir, "scip-python", [
        "import fs from 'node:fs';",
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        "writeScipFixture(out, 'python', 'app.py');",
      ]);
      writeScriptedScipIndexer(binDir, "scip-php", [
        "import fs from 'node:fs';",
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        "await new Promise((resolve) => setTimeout(resolve, 150));",
        "writeScipFixture(out, 'php', 'index.php');",
      ]);

      const ready = [];
      const result = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "always", scipLanguages: ["python", "php"] },
        onFileReady: (file) => {
          ready.push({
            name: path.basename(file),
            phpExists: fs.existsSync(path.join(scipDir, "php.scip")),
          });
        },
      });

      assert.equal(result.reason, "staged");
      assert.deepEqual(ready.map((row) => row.name), ["python.scip", "php.scip"]);
      assert.equal(ready[0].phpExists, false);
      assert.equal(fs.existsSync(path.join(scipDir, "python.scip")), true);
      assert.equal(fs.existsSync(path.join(scipDir, "php.scip")), true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("requires a root project marker for indexers that cannot run without one", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-marker-gate-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const binDir = path.join(posseRoot, "scip", "bin");
      fs.mkdirSync(path.join(repoRoot, "fixtures"), { recursive: true });
      // A stray vendored/fixture .rs file without a Cargo workspace must not
      // summon scip-rust — it deterministically fails with "no projects".
      fs.writeFileSync(path.join(repoRoot, "fixtures", "sample.rs"), "fn main() {}\n");
      writeFakeScipIndexer(binDir, ["scip-rust"]);

      const without = resolveScipStagePlans({ repoRoot, posseRoot, scipDir: path.join(repoRoot, ".posse", "atlas", "scip"), languages: "rust" });
      assert.deepEqual(without.plans, []);
      assert.deepEqual(without.projectKinds, []);

      fs.writeFileSync(path.join(repoRoot, "Cargo.toml"), "[workspace]\n");
      const withMarker = resolveScipStagePlans({ repoRoot, posseRoot, scipDir: path.join(repoRoot, ".posse", "atlas", "scip"), languages: "rust" });
      assert.deepEqual(withMarker.plans.map((plan) => plan.indexerId), ["rust"]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("keeps JavaScript and TypeScript source buckets separate for the TypeScript indexer", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-js-ts-source-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const binDir = path.join(posseRoot, "scip", "node", "node_modules", ".bin");
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "server.js"), "export const fixture = true;\n");
      fs.writeFileSync(path.join(repoRoot, "client.ts"), "export const typed = true;\n");
      const ext = process.platform === "win32" ? ".cmd" : "";
      fs.writeFileSync(path.join(binDir, `scip-typescript${ext}`), "");

      const lookup = resolveScipStagePlans({
        repoRoot,
        posseRoot,
        scipDir: path.join(repoRoot, ".posse", "atlas", "scip"),
        languages: "typescript",
      });

      assert.deepEqual(lookup.plans.map((plan) => plan.indexerId), ["typescript"]);
      assert.deepEqual(lookup.plans[0].sourceLanguages, ["ts", "js"]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("preserves per-language failures when another SCIP language stages successfully", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-stage-partial-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      fs.writeFileSync(path.join(repoRoot, "composer.json"), "{}\n");
      fs.writeFileSync(path.join(repoRoot, "index.php"), "<?php echo 'fixture';\n");
      writeScriptedScipIndexer(binDir, "scip-python", [
        "console.error('python timed out in fixture');",
        "process.exit(1);",
      ]);
      writeScriptedScipIndexer(binDir, "scip-php", [
        "import fs from 'node:fs';",
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        "writeScipFixture(out, 'php', 'index.php');",
      ]);

      const result = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "missing", scipLanguages: ["python", "php"] },
      });

      assert.equal(result.reason, "partial_failure");
      assert.match(result.error, /scip-python/);
      assert.deepEqual(result.failedLanguages, ["py"]);
      assert.equal(fs.existsSync(path.join(scipDir, "php.scip")), true);
      assert.equal(fs.existsSync(path.join(scipDir, "python.scip")), false);
      const pythonMeta = await readStagerMeta(path.join(scipDir, "python.scip"));
      assert.equal(pythonMeta?.status, "failed");
      assert.equal(pythonMeta?.language, "python");
      assert.match(pythonMeta?.error || "", /python timed out/);
      const phpResult = result.results.find((row) => row.language === "php");
      const pythonResult = result.results.find((row) => row.language === "python");
      assert.equal(phpResult?.ok, true);
      assert.equal(pythonResult?.ok, false);

      writeScriptedScipIndexer(binDir, "scip-python", [
        "import fs from 'node:fs';",
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        "writeScipFixture(out, 'python', 'app.py');",
      ]);
      const retry = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: {
          scipRestagePolicy: "missing",
          scipLanguages: ["python", "php"],
          scipIndexTimeoutMs: 1000,
          scipColdIndexTimeoutMs: 5000,
        },
      });
      const retriedPython = retry.results.find((row) => row.language === "python");
      assert.equal(retry.reason, "staged");
      assert.equal(retriedPython?.reason, "previous_failure");
      assert.equal(retriedPython?.cold, true);
      assert.equal(retriedPython?.timeoutMs, 5000);
      assert.equal(fs.existsSync(path.join(scipDir, "python.scip")), true);
      const retriedMeta = await readStagerMeta(path.join(scipDir, "python.scip"));
      assert.equal(retriedMeta?.status, "staged");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("fails freshly staged empty SCIP output when the language matched source files", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-empty-output-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      writeScriptedScipIndexer(binDir, "scip-python", [
        "import fs from 'node:fs';",
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        "fs.writeFileSync(out, Buffer.alloc(0));",
      ]);

      const result = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "always", scipLanguages: ["python"] },
      });

      assert.equal(result.reason, "indexer_failed");
      assert.match(result.error, /empty \.scip output/);
      assert.deepEqual(result.failedLanguages, ["py"]);
      assert.equal(fs.existsSync(path.join(scipDir, "python.scip")), false);
      const meta = await readStagerMeta(path.join(scipDir, "python.scip"));
      assert.equal(meta?.status, "failed");
      assert.match(meta?.error || "", /empty \.scip output/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("fails freshly staged corrupt SCIP output when the language matched source files", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-corrupt-output-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      writeScriptedScipIndexer(binDir, "scip-python", [
        "import fs from 'node:fs';",
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        "fs.writeFileSync(out, Buffer.from([0x12, 0xff]));",
      ]);

      const result = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "always", scipLanguages: ["python"] },
      });

      assert.equal(result.reason, "indexer_failed");
      assert.match(result.error, /corrupt \.scip output/);
      assert.deepEqual(result.failedLanguages, ["py"]);
      assert.equal(fs.existsSync(path.join(scipDir, "python.scip")), false);
      const meta = await readStagerMeta(path.join(scipDir, "python.scip"));
      assert.equal(meta?.status, "failed");
      assert.match(meta?.error || "", /corrupt \.scip output/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("uses the cold timeout for missing or previously failed language outputs", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-cold-timeout-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      writeFakeScipIndexer(binDir, ["scip-python"]);

      const result = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: {
          scipRestagePolicy: "missing",
          scipLanguages: ["python"],
          scipIndexTimeoutMs: 1000,
          scipColdIndexTimeoutMs: 5000,
        },
      });

      assert.equal(result.reason, "staged");
      assert.equal(result.results[0].cold, true);
      assert.equal(result.results[0].timeoutMs, 5000);
      const state = await describeScipStagingState({
        repoRoot,
        posseRoot,
        scipDir,
        config: {
          scipRestagePolicy: "missing",
          scipLanguages: ["python"],
          scipIndexTimeoutMs: 1000,
          scipColdIndexTimeoutMs: 5000,
        },
      });
      assert.equal(state.rows[0].timeout_ms, 1000);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("cleans up stale atomic staging temp files before restaging", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-clean-staging-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      const stale = path.join(scipDir, ".python.scip.123.456.abcdef.staging");
      fs.writeFileSync(stale, "stale");
      const old = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(stale, old, old);
      writeFakeScipIndexer(binDir, ["scip-python"]);

      const result = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "missing", scipLanguages: ["python"] },
      });

      assert.equal(result.reason, "staged");
      assert.equal(result.orphanStagingRemoved, 1);
      assert.equal(fs.existsSync(stale), false);
      assert.equal(fs.existsSync(path.join(scipDir, "python.scip")), true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("recovers valid stale atomic staging temp files before restaging", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-recover-staging-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      const staged = encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-python", version: "0.6.6", arguments: [] }),
          project_root: repoRoot,
        },
        documents: [{
          language: "Python",
          relative_path: "app.py",
          text: "print('fixture')\n",
          occurrences: [],
          symbols: [],
        }],
      });
      const stale = path.join(scipDir, ".python.scip.123.456.abcdef.staging");
      fs.writeFileSync(stale, staged);
      const old = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(stale, old, old);

      const progress = [];
      const result = await ensureScipStaged({
        repoRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "missing", scipLanguages: ["python"] },
        onProgress: (event) => progress.push(event),
      });

      const outputPath = path.join(scipDir, "python.scip");
      assert.equal(result.reason, "already_staged");
      assert.equal(result.orphanStagingRemoved, 0);
      assert.equal(fs.existsSync(stale), false);
      assert.equal(fs.readFileSync(outputPath).equals(staged), true);
      assert.ok(progress.some((event) => event.kind === "atlas.scip.orphan_staging_recovered"));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("restages dead-owner atomic staging temp files instead of marking recovered metadata fresh under smart policy", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-recover-dead-owner-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });
      const head = git(repoRoot, ["rev-parse", "HEAD"]);
      writeFakeScipIndexer(binDir, ["scip-python"]);

      const staged = encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-python", version: "0.6.6", arguments: [] }),
          project_root: repoRoot,
        },
        documents: [{
          language: "Python",
          relative_path: "app.py",
          text: "print('fixture')\n",
          occurrences: [],
          symbols: [],
        }],
      });
      const stale = path.join(scipDir, ".python.scip.99999999.456.abcdef.staging");
      fs.writeFileSync(stale, staged);

      const progress = [];
      const result = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "smart", scipLanguages: ["python"] },
        onProgress: (event) => progress.push(event),
      });

      const outputPath = path.join(scipDir, "python.scip");
      assert.equal(result.reason, "staged");
      assert.equal(result.staged, true);
      assert.equal(fs.existsSync(stale), false);
      assert.equal(fs.readFileSync(outputPath).equals(staged), false);
      const meta = await readStagerMeta(outputPath);
      assert.equal(meta?.status, "staged");
      assert.equal(meta?.language, "python");
      assert.equal(meta?.head, head);
      assert.notEqual(meta?.fileset_hash, null);
      assert.ok(progress.some((event) => event.kind === "atlas.scip.orphan_staging_recovered"));
      assert.ok(progress.some((event) => event.kind === "atlas.scip.restage_started" && event.reason === "status_recovered"));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("preserves skip-if-present behavior when restage policy is missing", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-policy-missing-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "package.json"), "{}\n");
      fs.writeFileSync(path.join(scipDir, "typescript.scip"), "existing");
      writeFakeScipIndexer(binDir, ["scip-typescript"]);

      const result = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "missing", scipLanguages: ["typescript"] },
      });

      assert.equal(result.reason, "already_staged");
      assert.equal(fs.readFileSync(path.join(scipDir, "typescript.scip"), "utf8"), "existing");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("smart restages when the language fileset changes and skips when fresh", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-policy-smart-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "package.json"), "{}\n");
      fs.writeFileSync(path.join(repoRoot, "server.js"), "export const fixture = true;\n");
      writeFakeScipIndexer(binDir, ["scip-typescript"]);
      git(repoRoot, ["init"]);
      git(repoRoot, ["config", "user.email", "test@example.com"]);
      git(repoRoot, ["config", "user.name", "Test"]);
      git(repoRoot, ["add", "package.json", "server.js"]);
      git(repoRoot, ["commit", "-m", "initial"]);
      const firstHead = git(repoRoot, ["rev-parse", "HEAD"]);

      const first = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "smart", scipLanguages: ["typescript"] },
      });
      assert.equal(first.reason, "staged");
      const outputPath = path.join(scipDir, "typescript.scip");
      const firstContent = fs.readFileSync(outputPath);
      const firstMeta = await readStagerMeta(outputPath);
      assert.equal(firstMeta?.head, firstHead);

      fs.writeFileSync(path.join(repoRoot, "package.json"), "{\"changed\":true}\n");
      fs.writeFileSync(path.join(repoRoot, "server.js"), "export const fixture = false;\n");
      git(repoRoot, ["add", "package.json", "server.js"]);
      git(repoRoot, ["commit", "-m", "change"]);
      const secondHead = git(repoRoot, ["rev-parse", "HEAD"]);
      await new Promise((resolve) => setTimeout(resolve, 5));

      const second = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "smart", scipLanguages: ["typescript"] },
      });
      assert.equal(second.reason, "staged");
      const secondContent = fs.readFileSync(outputPath);
      const secondMeta = await readStagerMeta(outputPath);
      assert.equal(secondContent.equals(firstContent), false);
      assert.equal(secondMeta?.head, secondHead);

      const third = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "smart", scipLanguages: ["typescript"] },
      });
      assert.equal(third.reason, "already_staged");
      assert.equal(fs.readFileSync(outputPath).equals(secondContent), true);

      const state = await describeScipStagingState({
        repoRoot,
        posseRoot,
        scipDir,
        config: { scipRestagePolicy: "smart", scipLanguages: ["typescript"] },
      });
      assert.equal(state.rows[0].fresh, true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("smart does not rebuild Python or PHP SCIP artifacts for docs-only commits", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-smart-docs-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      const callsPath = path.join(tmpRoot, "calls.log");
      fs.mkdirSync(path.join(repoRoot, "docs"), { recursive: true });
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      fs.writeFileSync(path.join(repoRoot, "composer.json"), "{}\n");
      fs.writeFileSync(path.join(repoRoot, "index.php"), "<?php echo 'fixture';\n");
      writeScriptedScipIndexer(binDir, "scip-python", [
        "import fs from 'node:fs';",
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        `fs.appendFileSync(${JSON.stringify(callsPath)}, 'python\\n');`,
        "writeScipFixture(out, 'python', 'app-' + process.hrtime.bigint() + '.py');",
      ]);
      writeScriptedScipIndexer(binDir, "scip-php", [
        "import fs from 'node:fs';",
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        `fs.appendFileSync(${JSON.stringify(callsPath)}, 'php\\n');`,
        "writeScipFixture(out, 'php', 'index-' + process.hrtime.bigint() + '.php');",
      ]);
      git(repoRoot, ["init"]);
      git(repoRoot, ["config", "user.email", "test@example.com"]);
      git(repoRoot, ["config", "user.name", "Test"]);
      git(repoRoot, ["add", "pyproject.toml", "app.py", "composer.json", "index.php"]);
      git(repoRoot, ["commit", "-m", "initial"]);

      const config = { scipRestagePolicy: "smart", scipLanguages: ["python", "php"] };
      const first = await ensureScipStaged({ repoRoot, posseRoot, scipDir, mode: "on", config });
      assert.equal(first.reason, "staged");
      assert.deepEqual(readCallLog(callsPath).sort(), ["php", "python"]);
      const pythonOutput = path.join(scipDir, "python.scip");
      const phpOutput = path.join(scipDir, "php.scip");
      const firstPython = fs.readFileSync(pythonOutput);
      const firstPhp = fs.readFileSync(phpOutput);

      fs.writeFileSync(path.join(repoRoot, "docs", "note.md"), "docs only\n");
      git(repoRoot, ["add", "docs/note.md"]);
      git(repoRoot, ["commit", "-m", "docs only"]);
      const docsHead = git(repoRoot, ["rev-parse", "HEAD"]);

      const second = await ensureScipStaged({ repoRoot, posseRoot, scipDir, mode: "on", config });
      assert.equal(second.reason, "already_staged");
      assert.deepEqual(readCallLog(callsPath).sort(), ["php", "python"]);
      assert.equal(fs.readFileSync(pythonOutput).equals(firstPython), true);
      assert.equal(fs.readFileSync(phpOutput).equals(firstPhp), true);
      assert.equal((await readStagerMeta(pythonOutput))?.head, docsHead);
      assert.equal((await readStagerMeta(phpOutput))?.head, docsHead);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("smart rebuilds only the SCIP language whose fileset changed", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-smart-language-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      const callsPath = path.join(tmpRoot, "calls.log");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      fs.writeFileSync(path.join(repoRoot, "composer.json"), "{}\n");
      fs.writeFileSync(path.join(repoRoot, "index.php"), "<?php echo 'fixture';\n");
      writeScriptedScipIndexer(binDir, "scip-python", [
        "import fs from 'node:fs';",
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        `fs.appendFileSync(${JSON.stringify(callsPath)}, 'python\\n');`,
        "writeScipFixture(out, 'python', 'app-' + process.hrtime.bigint() + '.py');",
      ]);
      writeScriptedScipIndexer(binDir, "scip-php", [
        "import fs from 'node:fs';",
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        `fs.appendFileSync(${JSON.stringify(callsPath)}, 'php\\n');`,
        "writeScipFixture(out, 'php', 'index-' + process.hrtime.bigint() + '.php');",
      ]);
      git(repoRoot, ["init"]);
      git(repoRoot, ["config", "user.email", "test@example.com"]);
      git(repoRoot, ["config", "user.name", "Test"]);
      git(repoRoot, ["add", "pyproject.toml", "app.py", "composer.json", "index.php"]);
      git(repoRoot, ["commit", "-m", "initial"]);

      const config = { scipRestagePolicy: "smart", scipLanguages: ["python", "php"] };
      await ensureScipStaged({ repoRoot, posseRoot, scipDir, mode: "on", config });
      const initialCalls = readCallLog(callsPath);
      assert.deepEqual([...initialCalls].sort(), ["php", "python"]);
      const pythonOutput = path.join(scipDir, "python.scip");
      const phpOutput = path.join(scipDir, "php.scip");
      const initialPhp = fs.readFileSync(phpOutput);

      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('python changed')\n");
      git(repoRoot, ["add", "app.py"]);
      git(repoRoot, ["commit", "-m", "python change"]);
      const afterPython = await ensureScipStaged({ repoRoot, posseRoot, scipDir, mode: "on", config });
      assert.equal(afterPython.reason, "staged");
      const pythonCalls = readCallLog(callsPath);
      assert.deepEqual(pythonCalls.slice(initialCalls.length), ["python"]);
      assert.equal(fs.readFileSync(phpOutput).equals(initialPhp), true);
      assert.equal(afterPython.results.find((row) => row.language === "python")?.staged, true);
      assert.equal(afterPython.results.find((row) => row.language === "php")?.skipped, true);

      const afterPythonOutput = fs.readFileSync(pythonOutput);
      fs.writeFileSync(path.join(repoRoot, "composer.lock"), "{}\n");
      git(repoRoot, ["add", "composer.lock"]);
      git(repoRoot, ["commit", "-m", "php dependency change"]);
      const afterPhp = await ensureScipStaged({ repoRoot, posseRoot, scipDir, mode: "on", config });
      assert.equal(afterPhp.reason, "staged");
      assert.deepEqual(readCallLog(callsPath).slice(pythonCalls.length), ["php"]);
      assert.equal(fs.readFileSync(pythonOutput).equals(afterPythonOutput), true);
      assert.equal(afterPhp.results.find((row) => row.language === "python")?.skipped, true);
      assert.equal(afterPhp.results.find((row) => row.language === "php")?.staged, true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("smart restages PHP when a nested PHP source file changes", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-smart-nested-php-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      const callsPath = path.join(tmpRoot, "calls.log");
      fs.mkdirSync(path.join(repoRoot, "src", "Domain"), { recursive: true });
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "composer.json"), "{}\n");
      fs.writeFileSync(path.join(repoRoot, "src", "Domain", "Thing.php"), "<?php echo 'fixture';\n");
      writeScriptedScipIndexer(binDir, "scip-php", [
        "import fs from 'node:fs';",
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        `fs.appendFileSync(${JSON.stringify(callsPath)}, 'php\\n');`,
        "writeScipFixture(out, 'php', 'src/Domain/Thing-' + process.hrtime.bigint() + '.php');",
      ]);
      git(repoRoot, ["init"]);
      git(repoRoot, ["config", "user.email", "test@example.com"]);
      git(repoRoot, ["config", "user.name", "Test"]);
      git(repoRoot, ["add", "composer.json", "src/Domain/Thing.php"]);
      git(repoRoot, ["commit", "-m", "initial"]);

      const config = { scipRestagePolicy: "smart", scipLanguages: ["php"] };
      const first = await ensureScipStaged({ repoRoot, posseRoot, scipDir, mode: "on", config });
      assert.equal(first.reason, "staged");
      assert.deepEqual(readCallLog(callsPath), ["php"]);

      fs.writeFileSync(path.join(repoRoot, "src", "Domain", "Thing.php"), "<?php echo 'nested changed';\n");
      git(repoRoot, ["add", "src/Domain/Thing.php"]);
      git(repoRoot, ["commit", "-m", "nested php change"]);
      const second = await ensureScipStaged({ repoRoot, posseRoot, scipDir, mode: "on", config });
      assert.equal(second.reason, "staged");
      assert.deepEqual(readCallLog(callsPath), ["php", "php"]);
      assert.equal(second.results.find((row) => row.language === "php")?.staged, true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("smart migrates legacy HEAD-only metadata without rebuilding on docs-only drift", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-smart-legacy-meta-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      const callsPath = path.join(tmpRoot, "calls.log");
      fs.mkdirSync(path.join(repoRoot, "docs"), { recursive: true });
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      writeScriptedScipIndexer(binDir, "scip-python", [
        "import fs from 'node:fs';",
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        `fs.appendFileSync(${JSON.stringify(callsPath)}, 'python\\n');`,
        "writeScipFixture(out, 'python', 'app-' + process.hrtime.bigint() + '.py');",
      ]);
      git(repoRoot, ["init"]);
      git(repoRoot, ["config", "user.email", "test@example.com"]);
      git(repoRoot, ["config", "user.name", "Test"]);
      git(repoRoot, ["add", "pyproject.toml", "app.py"]);
      git(repoRoot, ["commit", "-m", "initial"]);

      const config = { scipRestagePolicy: "smart", scipLanguages: ["python"] };
      await ensureScipStaged({ repoRoot, posseRoot, scipDir, mode: "on", config });
      const outputPath = path.join(scipDir, "python.scip");
      const metaPath = stagerMetaPathForOutput(outputPath);
      const legacyMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      delete legacyMeta.fileset_hash;
      fs.writeFileSync(metaPath, `${JSON.stringify(legacyMeta, null, 2)}\n`);

      fs.writeFileSync(path.join(repoRoot, "docs", "note.md"), "docs only\n");
      git(repoRoot, ["add", "docs/note.md"]);
      git(repoRoot, ["commit", "-m", "docs only"]);
      const docsHead = git(repoRoot, ["rev-parse", "HEAD"]);
      const before = fs.readFileSync(outputPath);

      const result = await ensureScipStaged({ repoRoot, posseRoot, scipDir, mode: "on", config });
      const migratedMeta = await readStagerMeta(outputPath);
      assert.equal(result.reason, "already_staged");
      assert.deepEqual(readCallLog(callsPath), ["python"]);
      assert.equal(fs.readFileSync(outputPath).equals(before), true);
      assert.equal(migratedMeta?.head, docsHead);
      assert.match(String(migratedMeta?.fileset_hash || ""), /^sha256:/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("covers the SCIP restage policy decision table", () => {
    const plan = { command: "scip-typescript", args: ["index"], outputPath: "typescript.scip", label: "scip-typescript", source: "auto", timeoutMs: 1000 };
    assert.deepEqual(decideStageAction({ plan, policy: "never", existingOutput: false }), { action: "skip", reason: "policy_never_missing" });
    assert.deepEqual(decideStageAction({ plan, policy: "missing", existingOutput: false }), { action: "stage", reason: "missing_output" });
    assert.deepEqual(decideStageAction({ plan, policy: "missing", existingOutput: true }), { action: "skip", reason: "already_staged" });
    assert.deepEqual(decideStageAction({ plan, policy: "always", existingOutput: true }), { action: "stage", reason: "policy_always" });
    assert.deepEqual(decideStageAction({ plan, policy: "smart", existingOutput: true, currentHead: null }), { action: "stage", reason: "missing_meta" });
    const meta = buildStagerMeta(plan);
    assert.deepEqual(decideStageAction({ plan, policy: "smart", existingOutput: true, currentHead: null, meta }), { action: "skip", reason: "fresh" });
    assert.deepEqual(decideStageAction({
      plan: { ...plan, timeoutMs: 2000 },
      policy: "smart",
      existingOutput: true,
      currentHead: null,
      meta,
    }), { action: "skip", reason: "fresh" });
    assert.deepEqual(decideStageAction({
      plan: { ...plan, timeoutMs: 360000 },
      policy: "smart",
      existingOutput: true,
      currentHead: null,
      meta: { ...meta, command_args_hash: legacyCommandArgsHash(plan, 120000) },
    }), { action: "skip", reason: "fresh" });
    assert.deepEqual(decideStageAction({
      plan: { ...plan, args: ["index", "--changed"] },
      policy: "smart",
      existingOutput: true,
      currentHead: null,
      meta,
    }), { action: "stage", reason: "command_changed" });
    assert.deepEqual(decideStageAction({
      plan,
      policy: "smart",
      existingOutput: true,
      currentHead: null,
      meta: { ...meta, staged_at: "2000-01-01T00:00:00.000Z" },
      maxAgeHours: 1,
    }), { action: "stage", reason: "max_age" });
    assert.deepEqual(decideStageAction({ plan, policy: "smart", existingOutput: false, currentHead: null }), { action: "stage", reason: "missing_output" });
  });

  it("backs off repeat failures with unchanged inputs and retries on new evidence", () => {
    const plan = { command: "scip-python", args: ["index"], outputPath: "python.scip", label: "scip-python", source: "auto", timeoutMs: 1000 };
    const now = Date.now();
    const failedOnce = buildFailedStagerMeta(plan, { head: "abc", filesetHash: "sha256:f1" });
    // A first failure retries freely — transient errors and fixed environments
    // must not wait out a backoff window.
    assert.deepEqual(
      decideStageAction({ plan, policy: "smart", existingOutput: false, currentHead: "abc", filesetHash: "sha256:f1", meta: failedOnce, nowMs: now }),
      { action: "stage", reason: "previous_failure" },
    );
    const failedTwice = buildFailedStagerMeta(plan, { head: "abc", filesetHash: "sha256:f1", previousMeta: failedOnce });
    assert.equal(failedTwice.attempt_count, 2);
    // A second failure with identical inputs backs off instead of paying a
    // doomed indexer launch on every warm.
    assert.deepEqual(
      decideStageAction({ plan, policy: "smart", existingOutput: false, currentHead: "abc", filesetHash: "sha256:f1", meta: failedTwice, nowMs: now }),
      { action: "skip", reason: "failure_backoff" },
    );
    // Policy "missing" computes no fileset hash; the backoff still applies on
    // command-hash + age evidence alone.
    assert.deepEqual(
      decideStageAction({ plan, policy: "missing", existingOutput: false, meta: failedTwice, nowMs: now }),
      { action: "skip", reason: "failure_backoff" },
    );
    // New evidence unlocks an immediate retry: a changed fileset...
    assert.deepEqual(
      decideStageAction({ plan, policy: "smart", existingOutput: false, currentHead: "def", filesetHash: "sha256:f2", meta: failedTwice, nowMs: now }),
      { action: "stage", reason: "previous_failure" },
    );
    // ...or a changed indexer command.
    assert.deepEqual(
      decideStageAction({ plan: { ...plan, args: ["index", "--strict"] }, policy: "smart", existingOutput: false, currentHead: "abc", filesetHash: "sha256:f1", meta: failedTwice, nowMs: now }),
      { action: "stage", reason: "previous_failure" },
    );
    // The window expires (second attempt backs off five minutes).
    const afterBackoff = Date.parse(String(failedTwice.failed_at)) + 5 * 60_000 + 1;
    assert.deepEqual(
      decideStageAction({ plan, policy: "smart", existingOutput: false, currentHead: "abc", filesetHash: "sha256:f1", meta: failedTwice, nowMs: afterBackoff }),
      { action: "stage", reason: "previous_failure" },
    );
    // policy=always is an operator override and ignores the backoff.
    assert.deepEqual(
      decideStageAction({ plan, policy: "always", existingOutput: false, meta: failedTwice, nowMs: now }),
      { action: "stage", reason: "missing_output" },
    );
  });

  it("gives fileset-changed restages the full-index timeout and stretches it by recorded duration", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-restage-timeout-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      writeFakeScipIndexer(binDir, ["scip-python"]);
      git(repoRoot, ["init"]);
      git(repoRoot, ["config", "user.email", "test@example.com"]);
      git(repoRoot, ["config", "user.name", "Test"]);
      git(repoRoot, ["add", "pyproject.toml", "app.py"]);
      git(repoRoot, ["commit", "-m", "initial"]);
      const config = {
        scipRestagePolicy: "smart",
        scipLanguages: ["python"],
        scipIndexTimeoutMs: 1000,
        scipColdIndexTimeoutMs: 5000,
      };

      const first = await ensureScipStaged({ repoRoot, posseRoot, scipDir, mode: "on", config });
      assert.equal(first.reason, "staged");
      const outputPath = path.join(scipDir, "python.scip");
      const firstMeta = await readStagerMeta(outputPath);
      // The run's real duration lands in the meta as timeout evidence.
      assert.ok(Number(firstMeta?.staged_duration_ms) > 0);

      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('changed')\n");
      git(repoRoot, ["add", "app.py"]);
      git(repoRoot, ["commit", "-m", "change"]);
      const second = await ensureScipStaged({ repoRoot, posseRoot, scipDir, mode: "on", config });
      const row = second.results.find((r) => r.language === "python");
      // A restage is a whole-project index run: it must get the cold timeout,
      // not the short incremental one that used to kill long indexer runs.
      assert.equal(row?.reason, "fileset_changed");
      assert.equal(row?.cold, true);
      assert.equal(row?.timeoutMs, 5000);

      // A recorded long duration stretches the stage timeout past the cold
      // floor (2.5x headroom over the last full index).
      const metaPath = stagerMetaPathForOutput(outputPath);
      const staged = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      fs.writeFileSync(metaPath, JSON.stringify({ ...staged, fileset_hash: "sha256:stale", staged_duration_ms: 60_000 }));
      const state = await describeScipStagingState({ repoRoot, posseRoot, scipDir, config });
      assert.equal(state.rows[0]?.decision?.action, "stage");
      assert.equal(state.rows[0]?.timeout_ms, 150_000);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("ATLAS v2 SCIP indexer progress extraction", () => {
  const freshCtx = (over = {}) => ({ seenPaths: new Set(), syntheticTotal: 0, pathRe: null, last: { current: -1, percent: -1 }, ...over });

  it("splits carriage-return progress bars and advances only on movement", () => {
    // scip-typescript redraws its "N / M" bar with \r and no newlines — a
    // \n-only split would swallow all of it and the bar would jump 0→100.
    const chunk = "[==>     ] 45/238\r[==>     ] 45/238\r[===>    ] 46/238\r[====>   ] 90/238";
    const events = extractScipIndexerProgressEvents(chunk, freshCtx());
    const ratios = events.filter((e) => e.progress).map((e) => `${e.progress.current}/${e.progress.total}`);
    // The duplicate 45/238 redraw is suppressed; only forward motion emits.
    assert.deepEqual(ratios, ["45/238", "46/238", "90/238"]);
    assert.equal(events.at(-1).progress.percent, (90 / 238) * 100);
  });

  it("synthesizes per-file progress from filename lines against an up-front total", () => {
    const ctx = freshCtx({ syntheticTotal: 3, pathRe: /\S+\.php\b/i });
    const events = extractScipIndexerProgressEvents("src/a.php\rsrc/a.php\nsrc/b.php\n", ctx);
    const counts = events.filter((e) => e.progress?.synthetic).map((e) => e.progress.current);
    assert.deepEqual(counts, [1, 2]); // a.php counted once (dup suppressed), then b.php
    assert.equal(events.at(-1).progress.percent, (2 / 3) * 100);
  });

  it("passes non-progress diagnostic lines through unchanged", () => {
    const events = extractScipIndexerProgressEvents("Visiting project\nDone.\n", freshCtx());
    assert.deepEqual(events.map((e) => e.text), ["Visiting project", "Done."]);
    assert.ok(events.every((e) => e.progress === null));
  });

  it("emits incremental SCIP generation progress end-to-end from a \\r bar", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-gen-progress-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "bin");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "pyproject.toml"), "[project]\nname = 'fixture'\n");
      fs.writeFileSync(path.join(repoRoot, "app.py"), "print('fixture')\n");
      // Redraw a progress bar with carriage returns only (no \n) before writing
      // the output — mirrors how `progress`-bar indexers report.
      writeScriptedScipIndexer(binDir, "scip-python", [
        "import fs from 'node:fs';",
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        "for (let i = 1; i <= 5; i++) process.stderr.write(\"\\r[bar] \" + i + \"/5 files\");",
        "writeScipFixture(out, 'python', 'app.py');",
      ]);

      const events = [];
      const result = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "always", scipLanguages: ["python"] },
        onProgress: (event) => events.push(event),
      });

      assert.equal(result.reason, "staged");
      const percents = events
        .filter((e) => e.stage === "scip.indexing" && Number.isFinite(e.percent))
        .map((e) => Math.round(e.percent));
      // Not a single 0→100 jump: mid-progress values must be present.
      assert.ok(percents.some((p) => p > 0 && p < 100), `expected mid-progress, got ${JSON.stringify(percents)}`);
      assert.ok(new Set(percents).size >= 3, `expected several distinct steps, got ${JSON.stringify(percents)}`);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("synthesizes SCIP generation progress from quiet streaming .scip output", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-scip-output-progress-"));
    try {
      const repoRoot = path.join(tmpRoot, "repo");
      const posseRoot = path.join(tmpRoot, "posse");
      const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
      const binDir = path.join(posseRoot, "scip", "node", "node_modules", ".bin");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "package.json"), "{}\n");
      for (let i = 1; i <= 4; i++) {
        fs.writeFileSync(path.join(repoRoot, `file${i}.ts`), `export const value${i} = ${i};\n`);
      }

      const chunks = [1, 2, 3, 4].map((i) => encodeIndex({
        metadata: i === 1
          ? {
              tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.0.0" }),
              project_root: repoRoot,
            }
          : undefined,
        documents: [{
          language: "typescript",
          relative_path: `file${i}.ts`,
          text: `export const value${i} = ${i};\n`,
        }],
      }).toString("base64"));

      writeScriptedScipIndexer(binDir, "scip-typescript", [
        "import fs from 'node:fs';",
        "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
        "const out = process.argv[process.argv.indexOf('--output') + 1];",
        `const chunks = ${JSON.stringify(chunks)};`,
        "for (const chunk of chunks) {",
        "  fs.appendFileSync(out, Buffer.from(chunk, 'base64'));",
        "  await sleep(650);",
        "}",
      ]);

      const events = [];
      const result = await ensureScipStaged({
        repoRoot,
        posseRoot,
        scipDir,
        mode: "on",
        config: { scipRestagePolicy: "always", scipLanguages: ["typescript"] },
        onProgress: (event) => events.push(event),
      });

      assert.equal(result.reason, "staged");
      const percents = events
        .filter((e) => e.stage === "scip.indexing" && e.progress_source === "scip-output" && Number.isFinite(e.percent))
        .map((e) => Math.round(e.percent));
      assert.ok(percents.some((p) => p > 0 && p < 100), `expected output-derived mid-progress, got ${JSON.stringify(percents)}`);
      assert.ok(percents.includes(100), `expected final output-derived progress, got ${JSON.stringify(percents)}`);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
