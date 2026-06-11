// Native binary manager + wrapper tests.
//
// Covers platform/os/arch mapping, manifest-driven path resolution (arch-first
// with os-level fallback), availability, protocol-agnostic invocation (injected
// spawn impls), feature-flag gating, and the ATLAS strict native mirror
// boundary used by the Rust migration.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import {
  osKey,
  archKey,
  exeSuffix,
  isWindows,
  platformTokens,
  UnsupportedPlatformError,
} from "../lib/shared/platform/functions/native-platform.js";
import {
  NATIVE_BINARIES,
  BINARY_NAMES,
  nativeBinaryPlatform,
} from "../lib/catalog/binary.js";
import { NativeBinary } from "../lib/classes/tools/NativeBinary.js";
import { BinaryManager } from "../lib/classes/tools/BinaryManager.js";
import {
  diffParseBufferNativeParity,
  parseBuffer,
  parseBufferNative,
} from "../lib/domains/atlas/functions/v2/parser/adapter.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Create a placeholder file at the resolved binary path for a tool/os/arch. */
function stageBinary(binRoot, name, osTok, arch, { contents = "", universal = false, executable = false } = {}) {
  const destFile = nativeBinaryPlatform(name, osTok).destinationFile;
  const dir = universal
    ? path.join(binRoot, name, osTok)
    : path.join(binRoot, name, osTok, arch);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, destFile);
  fs.writeFileSync(file, contents);
  if (executable && process.platform !== "win32") fs.chmodSync(file, 0o755);
  return file;
}

// ---------------------------------------------------------------------------
// Platform mapping
// ---------------------------------------------------------------------------

describe("native-platform", () => {
  it("maps process.platform to os tokens", () => {
    assert.equal(osKey("win32"), "windows");
    assert.equal(osKey("darwin"), "macos");
    assert.equal(osKey("linux"), "linux");
    assert.throws(() => osKey("freebsd"), UnsupportedPlatformError);
  });

  it("maps process.arch to arch tokens", () => {
    assert.equal(archKey("x64"), "x64");
    assert.equal(archKey("arm64"), "arm64");
    assert.throws(() => archKey("ia32"), UnsupportedPlatformError);
  });

  it("derives exe suffix and windows flag", () => {
    assert.equal(exeSuffix("win32"), ".exe");
    assert.equal(exeSuffix("linux"), "");
    assert.equal(isWindows("win32"), true);
    assert.equal(isWindows("darwin"), false);
    assert.deepEqual(platformTokens({ platform: "darwin", arch: "arm64" }), { os: "macos", arch: "arm64" });
  });
});

// ---------------------------------------------------------------------------
// Catalog sanity
// ---------------------------------------------------------------------------

describe("binary catalog", () => {
  it("defines atlas, git, and remote with per-os destinationFiles", () => {
    assert.deepEqual([...BINARY_NAMES].sort(), ["atlas", "git", "remote"]);
    for (const name of BINARY_NAMES) {
      for (const osTok of ["windows", "macos", "linux"]) {
        const plat = nativeBinaryPlatform(name, osTok);
        assert.ok(plat, `${name}/${osTok} present`);
        assert.ok(plat.destinationFile, `${name}/${osTok} has destinationFile`);
        if (osTok === "windows") assert.ok(plat.destinationFile.endsWith(".exe"));
      }
      assert.equal(NATIVE_BINARIES[name].platforms.macos.universal, true);
    }
  });
});

// ---------------------------------------------------------------------------
// Path resolution + availability
// ---------------------------------------------------------------------------

describe("NativeBinary path resolution", () => {
  const tmps = [];
  afterEach(() => { while (tmps.length) fs.rmSync(tmps.pop(), { recursive: true, force: true }); });

  it("prefers arch path, then falls back to os-level", () => {
    const binRoot = makeTmp("nb-resolve-"); tmps.push(binRoot);
    const bin = new NativeBinary({ name: "atlas", binRoot, platform: "linux", arch: "x64" });
    assert.equal(bin.isAvailable(), false);
    assert.equal(bin.resolvePath(), null);
    assert.equal(bin.expectedPath(), path.join(binRoot, "atlas", "linux", "x64", "posse-atlas"));

    const osLevel = stageBinary(binRoot, "atlas", "linux", "x64", { universal: true }); // os-level
    assert.equal(bin.resolvePath(), osLevel, "falls back to os-level when no arch build");

    const archFile = stageBinary(binRoot, "atlas", "linux", "x64"); // arch-specific
    assert.equal(bin.resolvePath(), archFile, "prefers arch-specific build");
    assert.equal(bin.isAvailable(), true);
  });

  it("uses .exe destinationFile on windows", () => {
    const binRoot = makeTmp("nb-win-"); tmps.push(binRoot);
    const bin = new NativeBinary({ name: "git", binRoot, platform: "win32", arch: "x64" });
    assert.ok(bin.expectedPath().endsWith(path.join("git", "windows", "x64", "posse-git.exe")));
  });

  it("resolves macOS universal at the os level", () => {
    const binRoot = makeTmp("nb-mac-"); tmps.push(binRoot);
    const bin = new NativeBinary({ name: "atlas", binRoot, platform: "darwin", arch: "arm64" });
    assert.equal(bin.expectedPath(), path.join(binRoot, "atlas", "macos", "posse-atlas"));
    const osLevel = stageBinary(binRoot, "atlas", "macos", "arm64", { universal: true });
    assert.equal(bin.resolvePath(), osLevel);
  });
});

// ---------------------------------------------------------------------------
// Invocation (injected spawn impls)
// ---------------------------------------------------------------------------

describe("NativeBinary invocation", () => {
  const tmps = [];
  afterEach(() => { while (tmps.length) fs.rmSync(tmps.pop(), { recursive: true, force: true }); });

  function availableBinary(spawnSyncImpl, spawnImpl) {
    const binRoot = makeTmp("nb-run-"); tmps.push(binRoot);
    stageBinary(binRoot, "atlas", osKey(), archKey());
    // keyResolver:() => null keeps args deterministic regardless of any
    // POSSE_KEY in the host env / Windows-persisted registry.
    return new NativeBinary({ name: "atlas", binRoot, spawnSyncImpl, spawnImpl, keyResolver: () => null });
  }

  it("runSync forwards subcommand/args/stdin and parses JSON", () => {
    let captured = null;
    const bin = availableBinary((cmd, args, opts) => {
      captured = { cmd, args, opts };
      return { status: 0, stdout: JSON.stringify({ hello: "world" }), stderr: "" };
    });
    const res = bin.runSync("parse", ["--lang", "ts"], { input: Buffer.from("source"), json: true });
    assert.equal(res.ok, true);
    assert.deepEqual(res.json, { hello: "world" });
    assert.equal(captured.cmd, bin.resolvePath());
    assert.deepEqual(captured.args, ["parse", "--lang", "ts"]);
    assert.equal(captured.opts.input.toString(), "source");
    assert.equal(captured.opts.encoding, "utf8");
    assert.equal(captured.opts.windowsHide, true);
  });

  it("runSync reports non-zero exit as not ok", () => {
    const bin = availableBinary(() => ({ status: 2, stdout: "", stderr: "boom" }));
    const res = bin.runSync("parse", []);
    assert.equal(res.ok, false);
    assert.equal(res.code, 2);
    assert.equal(res.stderr, "boom");
  });

  it("runSync surfaces invalid JSON as an error", () => {
    const bin = availableBinary(() => ({ status: 0, stdout: "not json", stderr: "" }));
    const res = bin.runSync("parse", [], { json: true });
    assert.equal(res.ok, false);
    assert.ok(res.error instanceof Error);
  });

  it("runSync short-circuits when the binary is unavailable", () => {
    const binRoot = makeTmp("nb-missing-"); tmps.push(binRoot);
    let called = false;
    const bin = new NativeBinary({ name: "atlas", binRoot, spawnSyncImpl: () => { called = true; return {}; } });
    const res = bin.runSync("parse", []);
    assert.equal(res.ok, false);
    assert.equal(called, false);
    assert.match(res.stderr, /not available/);
  });

  it("injects --posse-key before the command for key-gated binaries", () => {
    const binRoot = makeTmp("nb-key-"); tmps.push(binRoot);
    stageBinary(binRoot, "atlas", osKey(), archKey());
    let captured = null;
    const spawnSyncImpl = (cmd, args) => { captured = args; return { status: 0, stdout: "{}", stderr: "" }; };
    const mk = (keyResolver) => new NativeBinary({ name: "atlas", binRoot, spawnSyncImpl, keyResolver });

    // Explicit per-call key wins.
    mk(() => null).runSync("parse", ["--lang", "ts"], { key: "K123" });
    assert.deepEqual(captured, ["--posse-key", "K123", "parse", "--lang", "ts"]);

    // Resolver-provided key (POSSE_KEY) is injected before the command.
    mk(() => "RKEY").runSync("parse", []);
    assert.deepEqual(captured, ["--posse-key", "RKEY", "parse"]);

    // No key available -> no --posse-key.
    mk(() => null).runSync("parse", []);
    assert.deepEqual(captured, ["parse"]);
  });

  it("injects POSSE_HEARTBEAT_URL for key-gated binaries (overrides honored)", () => {
    let captured = null;
    const bin = availableBinary((cmd, args, opts) => { captured = opts; return { status: 0, stdout: "{}", stderr: "" }; });

    bin.runSync("x", [], { env: {} });
    assert.match(String(captured.env.POSSE_HEARTBEAT_URL || ""), /\/heartbeat$/);

    bin.runSync("x", [], { env: { POSSE_REMOTE_URL: "https://central.test/" } });
    assert.equal(captured.env.POSSE_HEARTBEAT_URL, "https://central.test/heartbeat");

    bin.runSync("x", [], { env: { POSSE_HEARTBEAT_URL: "https://hb.custom" } });
    assert.equal(captured.env.POSSE_HEARTBEAT_URL, "https://hb.custom");
  });

  it("run (async) collects stdout and parses JSON", async () => {
    const bin = availableBinary(undefined, (cmd, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end() {} };
      child.exitCode = null;
      child.killed = false;
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ args })));
        child.emit("close", 0, null);
      });
      return child;
    });
    const res = await bin.run("parse", ["--lang", "go"], { json: true });
    assert.equal(res.ok, true);
    assert.deepEqual(res.json, { args: ["parse", "--lang", "go"] });
  });

  it("run (async) honors abort signals and kills the child", async () => {
    let killed = false;
    const controller = new AbortController();
    const bin = availableBinary(undefined, () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end() {} };
      child.exitCode = null;
      child.killed = false;
      child.kill = () => {
        killed = true;
        child.killed = true;
        setImmediate(() => child.emit("close", null, "SIGTERM"));
      };
      return child;
    });

    const pending = bin.run("parse", [], { signal: controller.signal });
    controller.abort();
    const res = await pending;

    assert.equal(res.ok, false);
    assert.equal(res.error?.name, "AbortError");
    assert.equal(killed, true);
  });
});

// ---------------------------------------------------------------------------
// Manager: flag gating
// ---------------------------------------------------------------------------

describe("BinaryManager gating", () => {
  const tmps = [];
  afterEach(() => { while (tmps.length) fs.rmSync(tmps.pop(), { recursive: true, force: true }); });

  it("git and atlas are hardwired on; env/resolver gate the rest", () => {
    const off = new BinaryManager({ env: {}, enabledResolver: () => false });
    assert.equal(off.enabled("atlas"), true, "atlas is hardwired on");
    assert.equal(off.enabled("git"), true, "git is hardwired on");
    assert.equal(off.enabled("remote"), false);

    const resolverOn = new BinaryManager({ env: {}, enabledResolver: () => true });
    assert.equal(resolverOn.enabled("atlas"), true);
    assert.equal(resolverOn.enabled("remote"), true);

    const master = new BinaryManager({ env: { POSSE_NATIVE_BINARIES: "1" }, enabledResolver: () => false });
    assert.equal(master.enabled("atlas"), true);
    assert.equal(master.enabled("git"), true);
    assert.equal(master.enabled("remote"), true);

    const masterOff = new BinaryManager({ env: { POSSE_NATIVE_BINARIES: "0" }, enabledResolver: () => true });
    assert.equal(masterOff.enabled("atlas"), true, "master env off cannot disable atlas");
    assert.equal(masterOff.enabled("git"), true, "master env off cannot disable git");
    assert.equal(masterOff.enabled("remote"), false);
  });

  it("shouldUse requires enabled AND available", () => {
    const binRoot = makeTmp("bm-"); tmps.push(binRoot);
    const mk = (enabled) => new BinaryManager({ binRoot, enabledResolver: () => enabled });

    assert.equal(mk(true).shouldUse("atlas"), false, "hardwired on but not staged");
    stageBinary(binRoot, "atlas", osKey(), archKey());
    assert.equal(mk(true).shouldUse("atlas"), true, "staged");
    assert.equal(mk(false).shouldUse("atlas"), true, "resolver cannot disable atlas");
    assert.equal(mk(false).shouldUse("remote"), false, "resolver still gates remote");
  });

  it("rejects unknown binaries", () => {
    const mgr = new BinaryManager({ enabledResolver: () => true });
    assert.throws(() => mgr.binary("nope"), RangeError);
    assert.equal(mgr.available("nope"), false);
    assert.equal(mgr.enabled("nope"), false);
  });
});

// ---------------------------------------------------------------------------
// Reference integration: ATLAS parser native migration boundary
// ---------------------------------------------------------------------------

describe("parseBuffer native migration", () => {
  const SRC = "export function greet() { return 'hi'; }\n";
  const REPO_PATH = "src/x.ts";
  const savedEnv = {};
  const ENV_KEYS = ["POSSE_NATIVE_BINARIES", "POSSE_NATIVE_ATLAS", "POSSE_NATIVE_BIN_ROOT"];
  const tmps = [];

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    while (tmps.length) fs.rmSync(tmps.pop(), { recursive: true, force: true });
  });

  function snapshotEnv() { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; }

  function fakeNativeManager(json, capture = {}) {
    return {
      shouldUse(name) {
        capture.shouldUse = name;
        return true;
      },
      binary(name) {
        capture.binary = name;
        return {
          runSync(command, args, opts) {
            capture.command = command;
            capture.args = args;
            capture.input = opts.input;
            return { ok: true, code: 0, stdout: JSON.stringify(json), stderr: "", error: null, json };
          },
        };
      },
    };
  }

  it("keeps parseBuffer as the Node oracle until a function is migrated", () => {
    snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    const r = parseBuffer({ bytes: SRC, repo_rel_path: REPO_PATH, lang: "ts" });
    assert.ok(r.symbols.some((s) => s.name === "greet"), "JS tree-sitter extraction ran");
  });

  it("fails strict native parseBuffer instead of falling back when the binary is unavailable", () => {
    const emptyRoot = makeTmp("pb-empty-");
    tmps.push(emptyRoot);
    const manager = new BinaryManager({ binRoot: emptyRoot, enabledResolver: () => true });
    assert.throws(
      () => parseBufferNative({ bytes: SRC, repo_rel_path: REPO_PATH, lang: "ts" }, { manager }),
      /ATLAS native method unavailable/,
    );
  });

  it("invokes the Rust mirror with a stdin JSON method envelope", () => {
    const nodeResult = parseBuffer({ bytes: SRC, repo_rel_path: REPO_PATH, lang: "ts" });
    const capture = {};
    const manager = fakeNativeManager(nodeResult, capture);
    const r = parseBufferNative({ bytes: SRC, repo_rel_path: REPO_PATH, lang: "ts" }, { manager });
    assert.equal(capture.shouldUse, "atlas");
    assert.equal(capture.binary, "atlas");
    assert.equal(capture.command, "parser.parseBuffer");
    assert.deepEqual(capture.args, []);
    const envelope = JSON.parse(String(capture.input));
    assert.equal(envelope.protocol, "posse.atlas.native.v1");
    assert.equal(envelope.method, "parser.parseBuffer");
    assert.equal(envelope.payload.repo_rel_path, REPO_PATH);
    assert.equal(envelope.payload.lang, "ts");
    assert.equal(Buffer.from(envelope.payload.bytes_base64, "base64").toString("utf8"), SRC);
    assert.deepEqual(r, nodeResult);
  });

  it("reports exact A/B parity when Rust output matches the Node oracle", () => {
    const nodeResult = parseBuffer({ bytes: SRC, repo_rel_path: REPO_PATH, lang: "ts" });
    const manager = fakeNativeManager({ ok: true, data: nodeResult });
    const parity = diffParseBufferNativeParity(
      { bytes: SRC, repo_rel_path: REPO_PATH, lang: "ts" },
      { nodeParseBuffer: parseBuffer, manager },
    );
    assert.equal(parity.ok, true);
  });

  it("reports A/B mismatch instead of hiding drift behind fallback behavior", () => {
    const nodeResult = parseBuffer({ bytes: SRC, repo_rel_path: REPO_PATH, lang: "ts" });
    const drifted = {
      ...nodeResult,
      symbols: [{
        ...nodeResult.symbols[0],
        name: "FROM_RUST_BUT_WRONG",
      }],
    };
    const manager = fakeNativeManager(drifted);
    const parity = diffParseBufferNativeParity(
      { bytes: SRC, repo_rel_path: REPO_PATH, lang: "ts" },
      { nodeParseBuffer: parseBuffer, manager },
    );
    assert.equal(parity.ok, false);
    assert.match(parity.message, /does not match/);
  });
});
