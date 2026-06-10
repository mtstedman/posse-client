import {
  assert,
  execFileSync,
  fs,
  it,
  os,
  path,
  __dirname,
  suite,
  withEnv,
} from "../support/core-harness.js";

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

function writeSuccessfulFakeNpm(binDir, capturePath) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "fake-npm.mjs"), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.env, null, 2));`,
    "const pkgPath = path.join(process.cwd(), 'package.json');",
    "let pkg = {};",
    "try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { pkg = {}; }",
    "const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) };",
    "for (const name of Object.keys(deps)) {",
    "  fs.mkdirSync(path.join(process.cwd(), 'node_modules', ...String(name).split('/')), { recursive: true });",
    "}",
    "process.stdout.write('npm fixture installed\\n');",
  ].join("\n"));
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "npm.cmd"), "@echo off\r\nnode \"%~dp0fake-npm.mjs\" %*\r\n");
    return;
  }
  const npm = path.join(binDir, "npm");
  fs.writeFileSync(npm, "#!/usr/bin/env sh\nnode \"$(dirname \"$0\")/fake-npm.mjs\" \"$@\"\n");
  fs.chmodSync(npm, 0o755);
}

function writeFakeComposer(binDir, stderrText) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "fake-composer.mjs"), [
    `process.stderr.write(${JSON.stringify(stderrText)});`,
    "process.exit(2);",
  ].join("\n"));
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "composer.bat"), "@echo off\r\nnode \"%~dp0fake-composer.mjs\" %*\r\n");
    return;
  }
  const composer = path.join(binDir, "composer");
  fs.writeFileSync(composer, "#!/usr/bin/env sh\nnode \"$(dirname \"$0\")/fake-composer.mjs\" \"$@\"\n");
  fs.chmodSync(composer, 0o755);
}

function writeSuccessfulFakeComposer(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "fake-composer.mjs"), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const installed = path.join(process.cwd(), 'vendor', 'composer', 'installed.json');",
    "fs.mkdirSync(path.dirname(installed), { recursive: true });",
    "fs.writeFileSync(installed, '[]\\n');",
    "process.stdout.write('composer fixture installed\\n');",
  ].join("\n"));
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "composer.bat"), "@echo off\r\nnode \"%~dp0fake-composer.mjs\" %*\r\n");
    return;
  }
  const composer = path.join(binDir, "composer");
  fs.writeFileSync(composer, "#!/usr/bin/env sh\nnode \"$(dirname \"$0\")/fake-composer.mjs\" \"$@\"\n");
  fs.chmodSync(composer, 0o755);
}

function writeNoopSuccessfulFakeComposer(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "fake-composer.mjs"), [
    "process.stdout.write('Nothing to install, update or remove\\n');",
  ].join("\n"));
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "composer.bat"), "@echo off\r\nnode \"%~dp0fake-composer.mjs\" %*\r\n");
    return;
  }
  const composer = path.join(binDir, "composer");
  fs.writeFileSync(composer, "#!/usr/bin/env sh\nnode \"$(dirname \"$0\")/fake-composer.mjs\" \"$@\"\n");
  fs.chmodSync(composer, 0o755);
}

suite("system preflight probes", () => {
  it("reports workspace health pressure without exposing a role MCP tool", async () => {
    const { workspaceHealthProbe, formatWorkspaceHealthProbe } = await import("../../../lib/domains/system/functions/preflight-probes.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-workspace-health-"));

    try {
      fs.mkdirSync(path.join(projectDir, ".posse-worktrees", "wi-1"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, ".posse", "recovered-worktrees", "saved-1"), { recursive: true });

      const probe = workspaceHealthProbe(projectDir, { worktreeCap: 1 });
      assert.equal(probe.ok, false);
      assert.equal(probe.checks.worktrees.status, "critical");
      assert.equal(probe.checks.recovered_worktrees.count, 1);
      assert.match(formatWorkspaceHealthProbe(probe), /worktrees critical/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("measures branch drift against the merge target", async () => {
    const { branchStalenessCheck, formatBranchStalenessCheck } = await import("../../../lib/domains/system/functions/preflight-probes.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-branch-staleness-"));
    const git = (...args) => execFileSync("git", args, { cwd: projectDir, encoding: "utf8" });

    try {
      git("init");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test User");
      fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n");
      git("add", ".");
      git("commit", "-m", "base");
      git("branch", "-M", "main");
      git("checkout", "-b", "feature");
      fs.writeFileSync(path.join(projectDir, "feature.txt"), "feature\n");
      git("add", ".");
      git("commit", "-m", "feature");
      git("checkout", "main");
      fs.writeFileSync(path.join(projectDir, "target.txt"), "target\n");
      git("add", ".");
      git("commit", "-m", "target");

      const result = branchStalenessCheck({
        projectDir,
        branchName: "feature",
        targetBranch: "main",
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, "stale");
      assert.equal(result.ahead, 1);
      assert.equal(result.behind, 1);
      assert.match(formatBranchStalenessCheck(result), /behind main/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("summarizes provider liveness without forcing prompt execution", async () => {
    const { providerAuthLivenessProbe, formatProviderAuthLivenessProbe } = await import("../../../lib/domains/system/functions/preflight-probes.js");
    const probe = providerAuthLivenessProbe({ projectDir: __dirname, primeAuth: false });

    assert.equal(typeof probe.ok, "boolean");
    assert.ok(Array.isArray(probe.providers));
    assert.equal(probe.prime.skipped, "disabled");
    assert.match(formatProviderAuthLivenessProbe(probe), /provider auth liveness|:/);
  });

  it("plans manifest-backed dependency repair without installing during dry runs", async () => {
    const { ensureBootDependencies, formatBootDependencySync } = await import("../../../lib/domains/system/functions/dependency-sync.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-dependency-sync-"));

    try {
      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
        name: "dependency-sync-fixture",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
      }, null, 2));

      const result = await ensureBootDependencies({
        projectDir,
        posseRoot: projectDir,
        dryRun: true,
        includePython: false,
        includeComposer: false,
        includeGo: false,
        includeCargo: false,
        includeScip: false,
        includeTestTools: false,
      });

      assert.equal(result.ok, true);
      assert.equal(result.node.length, 1);
      assert.equal(result.node[0].status, "dry-run");
      assert.match(result.node[0].message, /would run npm install/);
      assert.match(formatBootDependencySync(result), /would install/);
      assert.equal(fs.existsSync(path.join(projectDir, "node_modules")), false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("scrubs provider and Posse secrets from dependency install subprocesses", async () => {
    const { ensureBootDependencies } = await import("../../../lib/domains/system/functions/dependency-sync.js");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-dependency-env-scrub-"));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "posse-fake-npm-env-"));
    const capturePath = path.join(projectDir, "captured-env.json");

    try {
      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
        name: "dependency-env-scrub-fixture",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
      }, null, 2));
      writeSuccessfulFakeNpm(fakeBin, capturePath);

      const result = await withEnv({
        OPENAI_API_KEY: "openai-secret",
        XAI_API_KEY: "xai-secret",
        ANTHROPIC_API_KEY: "anthropic-secret",
        CODEX_API_KEY: "codex-secret",
        POSSE_KEY: "remote-secret",
        POSSE_SYNTHETIC_SECRET: "posse-secret",
        POSSE_REMOTE_API_KEY: "remote-secret",
        PIP_INDEX_URL: "https://token@example.invalid/simple",
        COMPOSER_AUTH: "{\"github-oauth\":{\"github.com\":\"secret\"}}",
        NPM_TOKEN: "npm-secret",
        NODE_EXTRA_CA_CERTS: path.join(projectDir, "node-extra-ca.pem"),
        HTTPS_PROXY: "http://proxy-user:proxy-pass@proxy.example.test:8080",
        HTTP_PROXY: "http://proxy.example.test:8081",
        NO_PROXY: "localhost,127.0.0.1",
        NPM_CONFIG_REGISTRY: "https://registry-user:registry-pass@registry.example.test/npm/",
        NPM_CONFIG_CAFILE: path.join(projectDir, "npm-ca.pem"),
        NPM_CONFIG_STRICT_SSL: "false",
      }, () => withPrependedPath(fakeBin, () => ensureBootDependencies({
        projectDir,
        posseRoot: projectDir,
        includePython: false,
        includeComposer: false,
        includeGo: false,
        includeCargo: false,
        includeScip: false,
        includeTestTools: false,
      })));

      const captured = JSON.parse(fs.readFileSync(capturePath, "utf8"));
      const pathKey = Object.keys(captured).find((key) => key.toLowerCase() === "path");

      assert.equal(result.ok, true);
      assert.equal(result.node[0].status, "installed");
      assert.ok(pathKey, "install subprocess should retain PATH");
      assert.match(captured[pathKey], new RegExp(fakeBin.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
      assert.equal(captured.OPENAI_API_KEY, undefined);
      assert.equal(captured.XAI_API_KEY, undefined);
      assert.equal(captured.ANTHROPIC_API_KEY, undefined);
      assert.equal(captured.CODEX_API_KEY, undefined);
      assert.equal(captured.POSSE_KEY, undefined);
      assert.equal(captured.POSSE_SYNTHETIC_SECRET, undefined);
      assert.equal(captured.POSSE_REMOTE_API_KEY, undefined);
      assert.equal(captured.PIP_INDEX_URL, undefined);
      assert.equal(captured.COMPOSER_AUTH, undefined);
      assert.equal(captured.NPM_TOKEN, undefined);
      assert.equal(captured.NODE_EXTRA_CA_CERTS, path.join(projectDir, "node-extra-ca.pem"));
      assert.equal(captured.HTTPS_PROXY, "http://proxy.example.test:8080/");
      assert.equal(captured.HTTP_PROXY, "http://proxy.example.test:8081");
      assert.equal(captured.NO_PROXY, "localhost,127.0.0.1");
      assert.equal(captured.NPM_CONFIG_REGISTRY, "https://registry.example.test/npm/");
      assert.equal(captured.NPM_CONFIG_CAFILE, path.join(projectDir, "npm-ca.pem"));
      assert.equal(captured.NPM_CONFIG_STRICT_SSL, "false");
      assert.equal(Object.keys(captured).some((key) => key.startsWith("POSSE_")), false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("preserves scoped npm registry paths for dependency install subprocesses", async () => {
    const { ensureBootDependencies } = await import("../../../lib/domains/system/functions/dependency-sync.js");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-dependency-registry-scope-"));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "posse-fake-npm-registry-"));
    const capturePath = path.join(projectDir, "captured-env.json");

    try {
      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
        name: "dependency-registry-scope-fixture",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
      }, null, 2));
      writeSuccessfulFakeNpm(fakeBin, capturePath);

      const result = await withEnv({
        NPM_CONFIG_REGISTRY: "https://registry.example.test/@scope/",
      }, () => withPrependedPath(fakeBin, () => ensureBootDependencies({
        projectDir,
        posseRoot: projectDir,
        includePython: false,
        includeComposer: false,
        includeGo: false,
        includeCargo: false,
        includeScip: false,
        includeTestTools: false,
      })));

      const captured = JSON.parse(fs.readFileSync(capturePath, "utf8"));
      assert.equal(result.ok, true);
      assert.equal(result.node[0].status, "installed");
      assert.equal(captured.NPM_CONFIG_REGISTRY, "https://registry.example.test/@scope/");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("plans Python requirements in a Posse-managed runtime instead of repo .venv", async () => {
    const { ensureBootDependencies } = await import("../../../lib/domains/system/functions/dependency-sync.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-python-dependency-sync-"));
    const posseRoot = fs.mkdtempSync(path.join(__dirname, "tmp-python-runtime-root-"));

    try {
      fs.writeFileSync(path.join(projectDir, "requirements.txt"), "requests==2.34.2\n");

      const result = await ensureBootDependencies({
        projectDir,
        posseRoot,
        dryRun: true,
        includeNode: false,
        includeComposer: false,
        includeGo: false,
        includeCargo: false,
        includeScip: false,
        includeTestTools: false,
      });

      assert.equal(result.ok, true);
      assert.equal(result.python.length, 1);
      assert.equal(result.python[0].status, "dry-run");
      assert.match(result.python[0].message, /Posse-managed Python runtime/);
      assert.ok(result.python[0].runtime_dir.startsWith(path.join(posseRoot, ".posse", "runtime", "python")));
      assert.equal(result.python[0].python.includes(path.join(projectDir, ".venv")), false);
      assert.equal(fs.existsSync(path.join(projectDir, ".venv")), false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(posseRoot, { recursive: true, force: true });
    }
  });

  it("doctors missing Python requirements into a Posse-managed runtime plan", async () => {
    const { doctorRepoDependencies, formatBootDependencySync } = await import("../../../lib/domains/system/functions/dependency-sync.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-python-dependency-doctor-"));
    const posseRoot = fs.mkdtempSync(path.join(__dirname, "tmp-python-doctor-root-"));

    try {
      fs.writeFileSync(path.join(projectDir, "requirements.txt"), "requests==2.34.2\n");

      const result = await doctorRepoDependencies({
        projectDir,
        posseRoot,
        dryRun: true,
        includeNode: false,
        includeComposer: false,
        includeGo: false,
        includeCargo: false,
        includeScip: false,
        includeTestTools: false,
      });

      assert.equal(result.ok, true);
      assert.equal(result.doctor.mode, "plan");
      assert.equal(result.doctor.pending.length, 1);
      assert.equal(result.doctor.pending[0].label, "repo python");
      assert.equal(result.doctor.failed.length, 0);
      assert.equal(result.doctor.summary, formatBootDependencySync(result));
      assert.ok(result.doctor.pending[0].runtime_dir.startsWith(path.join(posseRoot, ".posse", "runtime", "python")));
      assert.equal(fs.existsSync(path.join(projectDir, ".venv")), false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(posseRoot, { recursive: true, force: true });
    }
  });

  it("runs dependency doctor planning in a worker thread", async () => {
    const { doctorRepoDependenciesInWorker } = await import("../../../lib/domains/system/functions/dependency-sync.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-python-dependency-doctor-worker-"));
    const posseRoot = fs.mkdtempSync(path.join(__dirname, "tmp-python-doctor-worker-root-"));

    try {
      fs.writeFileSync(path.join(projectDir, "requirements.txt"), "requests==2.34.2\n");

      const result = await doctorRepoDependenciesInWorker({
        projectDir,
        posseRoot,
        dryRun: true,
        includeNode: false,
        includeComposer: false,
        includeGo: false,
        includeCargo: false,
        includeScip: false,
        includeTestTools: false,
      });

      assert.equal(result.ok, true);
      assert.equal(result.doctor.mode, "plan");
      assert.equal(result.python[0].status, "dry-run");
      assert.ok(result.python[0].runtime_dir.startsWith(path.join(posseRoot, ".posse", "runtime", "python")));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(posseRoot, { recursive: true, force: true });
    }
  });

  it("adds a ready managed Python runtime to child process PATH", async () => {
    const { buildRuntimeEnv } = await import("../../../lib/domains/runtime/functions/paths.js");
    const { resolveManagedPythonRuntimeForProject } = await import("../../../lib/domains/runtime/functions/python-runtime.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-python-runtime-env-"));
    let runtimeDir = "";

    try {
      fs.writeFileSync(path.join(projectDir, "requirements.txt"), "requests==2.34.2\n");
      const runtime = resolveManagedPythonRuntimeForProject({ projectDir });
      runtimeDir = runtime.runtimeDir;
      fs.mkdirSync(runtime.binDir, { recursive: true });
      fs.writeFileSync(runtime.python, "", "utf8");
      fs.writeFileSync(runtime.stampPath, `${runtime.requirementsHash}\n`, "utf8");

      const env = buildRuntimeEnv(projectDir, projectDir, { PATH: "base-path" });

      assert.equal(env.POSSE_PROJECT_PYTHON, runtime.python);
      assert.equal(env.POSSE_PYTHON_RUNTIME, runtime.runtimeDir);
      assert.equal(env.VIRTUAL_ENV, runtime.runtimeDir);
      assert.ok(env.PATH.startsWith(`${runtime.binDir}${path.delimiter}`));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      if (runtimeDir) fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("summarizes Composer platform requirement failures in dependency doctor output", async () => {
    const { ensureBootDependencies, formatBootDependencySync } = await import("../../../lib/domains/system/functions/dependency-sync.js");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-composer-doctor-"));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "posse-fake-composer-"));

    try {
      fs.writeFileSync(path.join(projectDir, "composer.json"), JSON.stringify({
        require: { "fixture/package": "*" },
      }, null, 2));
      writeFakeComposer(fakeBin, [
        "Composer is operating significantly slower than normal because you do not have the PHP curl extension enabled.\n",
        "Loading composer repositories with package information\n",
        "Your requirements could not be resolved to an installable set of packages.\n",
        "  - fixture/package requires ext-mbstring * -> it is missing from your system. Install or enable PHP's mbstring extension.\n",
        "Alternatively, you can run Composer with `--ignore-platform-req=ext-mbstring` to temporarily ignore these required extensions.\n",
      ].join(""));

      const result = await withPrependedPath(fakeBin, () => ensureBootDependencies({
        projectDir,
        posseRoot: projectDir,
        includeNode: false,
        includePython: false,
        includeGo: false,
        includeCargo: false,
        includeScip: false,
        includeTestTools: false,
      }));

      assert.equal(result.ok, false);
      assert.equal(result.composer[0].status, "failed");
      assert.match(result.composer[0].message, /missing PHP extension\(s\): ext-mbstring/);
      assert.match(result.composer[0].message, /PHP curl extension is disabled/);
      assert.match(formatBootDependencySync(result), /ext-mbstring/);
      assert.doesNotMatch(formatBootDependencySync(result), /Loading composer repositories/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("summarizes Composer archive extraction and child process timeout failures", async () => {
    const { ensureBootDependencies, formatBootDependencySync } = await import("../../../lib/domains/system/functions/dependency-sync.js");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-composer-zip-doctor-"));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "posse-fake-composer-zip-"));

    try {
      fs.writeFileSync(path.join(projectDir, "composer.json"), JSON.stringify({
        require: { "fixture/package": "*" },
      }, null, 2));
      writeFakeComposer(fakeBin, [
        "Installing dependencies from lock file (including require-dev)\n",
        "Failed to download sebastian/version from dist: The zip extension and unzip/7z commands are both missing, skipping.\n",
        "Now trying to download from source\n",
        "The process exceeded the timeout of 300 seconds.\n",
        "Check https://getcomposer.org/doc/06-config.md#process-timeout for details\n",
      ].join(""));

      const result = await withPrependedPath(fakeBin, () => ensureBootDependencies({
        projectDir,
        posseRoot: projectDir,
        includeNode: false,
        includePython: false,
        includeGo: false,
        includeCargo: false,
        includeScip: false,
        includeTestTools: false,
      }));

      const summary = formatBootDependencySync(result);
      assert.equal(result.ok, false);
      assert.match(result.composer[0].message, /missing PHP extension ext-zip or an unzip\/7z command/);
      assert.match(result.composer[0].message, /process-timeout/);
      assert.match(summary, /ext-zip/);
      assert.doesNotMatch(summary, /sebastian\/version from dist/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("auto-ignores generated Composer vendor directories without hiding lockfiles", async () => {
    const { ensureBootDependencies } = await import("../../../lib/domains/system/functions/dependency-sync.js");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-composer-auto-ignore-"));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "posse-fake-composer-success-"));
    const git = (...args) => execFileSync("git", args, { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    try {
      git("init");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test User");
      fs.writeFileSync(path.join(projectDir, "composer.json"), JSON.stringify({
        require: { "fixture/package": "*" },
      }, null, 2));
      git("add", "composer.json");
      git("commit", "-m", "base");
      writeSuccessfulFakeComposer(fakeBin);

      const result = await withPrependedPath(fakeBin, () => ensureBootDependencies({
        projectDir,
        posseRoot: projectDir,
        includeNode: false,
        includePython: false,
        includeGo: false,
        includeCargo: false,
        includeScip: false,
        includeTestTools: false,
      }));

      const ignoreText = fs.readFileSync(path.join(projectDir, ".gitignore"), "utf8");
      assert.equal(result.ok, true);
      assert.equal(result.composer[0].status, "installed");
      assert.deepEqual(result.composer[0].generated_ignore?.pattern, "vendor/");
      assert.match(ignoreText, /^vendor\/$/m);
      assert.equal(git("check-ignore", "vendor").trim(), "vendor");
      assert.doesNotMatch(ignoreText, /composer\.lock/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("stamps successful Composer no-op installs when vendor metadata remains older than the lockfile", async () => {
    const { ensureBootDependencies } = await import("../../../lib/domains/system/functions/dependency-sync.js");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-composer-stamp-noop-"));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "posse-fake-composer-noop-"));

    try {
      fs.writeFileSync(path.join(projectDir, "composer.json"), JSON.stringify({
        require: { "fixture/package": "*" },
      }, null, 2));
      const installedJson = path.join(projectDir, "vendor", "composer", "installed.json");
      fs.mkdirSync(path.dirname(installedJson), { recursive: true });
      fs.writeFileSync(installedJson, "[]\n");
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(path.join(projectDir, "vendor"), old, old);
      fs.utimesSync(path.join(projectDir, "vendor", "composer"), old, old);
      fs.utimesSync(installedJson, old, old);
      fs.writeFileSync(path.join(projectDir, "composer.lock"), JSON.stringify({
        packages: [{ name: "fixture/package", version: "1.0.0" }],
      }, null, 2));
      writeNoopSuccessfulFakeComposer(fakeBin);

      const first = await withPrependedPath(fakeBin, () => ensureBootDependencies({
        projectDir,
        posseRoot: projectDir,
        includeNode: false,
        includePython: false,
        includeGo: false,
        includeCargo: false,
        includeScip: false,
        includeTestTools: false,
      }));

      assert.equal(first.ok, true);
      assert.equal(first.composer[0].status, "installed");
      assert.equal(first.composer[0].message, "composer install completed");
      assert.equal(fs.existsSync(path.join(projectDir, "vendor", "composer", ".posse-manifest.sha256")), true);

      const second = await withPrependedPath(fakeBin, () => ensureBootDependencies({
        projectDir,
        posseRoot: projectDir,
        includeNode: false,
        includePython: false,
        includeGo: false,
        includeCargo: false,
        includeScip: false,
        includeTestTools: false,
      }));

      assert.equal(second.ok, true);
      assert.equal(second.composer[0].status, "ok");
      assert.equal(second.composer[0].action, "none");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("trusts present node packages on first boot and stamps dependency manifests", async () => {
    const { ensureBootDependencies, formatBootDependencySync } = await import("../../../lib/domains/system/functions/dependency-sync.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-dependency-sync-stamp-"));

    try {
      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
        name: "dependency-sync-stamp-fixture",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
      }, null, 2));
      fs.mkdirSync(path.join(projectDir, "node_modules", "left-pad"), { recursive: true });
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(path.join(projectDir, "node_modules"), old, old);

      const result = await ensureBootDependencies({
        projectDir,
        posseRoot: projectDir,
        dryRun: false,
        includePython: false,
        includeComposer: false,
        includeGo: false,
        includeCargo: false,
        includeScip: false,
        includeTestTools: false,
      });

      assert.equal(result.ok, true);
      assert.equal(result.node[0].status, "ok");
      assert.equal(result.node[0].action, "stamp");
      assert.equal(fs.existsSync(path.join(projectDir, "node_modules", ".posse-manifest.sha256")), true);
      assert.equal(formatBootDependencySync(result), "ready");

      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
        name: "dependency-sync-stamp-fixture",
        version: "1.0.0",
        dependencies: { "left-pad": "1.1.3" },
      }, null, 2));
      const stale = await ensureBootDependencies({
        projectDir,
        posseRoot: projectDir,
        dryRun: true,
        includePython: false,
        includeComposer: false,
        includeGo: false,
        includeCargo: false,
        includeScip: false,
        includeTestTools: false,
      });

      assert.equal(stale.ok, true);
      assert.equal(stale.node[0].status, "dry-run");
      assert.equal(stale.node[0].stale, true);
      assert.match(stale.node[0].message, /manifest newer than install/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("includes the failed dependency label and message in boot summaries", async () => {
    const { formatBootDependencySync } = await import("../../../lib/domains/system/functions/dependency-sync.js");
    const summary = formatBootDependencySync({
      counts: { checked: 1, failed: 1, installed: 0, dry_run: 0, ready: 0 },
      node: [{
        present: true,
        label: "posse npm",
        ok: false,
        status: "failed",
        message: "npm install failed: spawn EINVAL",
      }],
    });

    assert.match(summary, /1 failed: posse npm: npm install failed: spawn EINVAL/);
  });

  it("runs dependency repair planning in a worker thread", async () => {
    const { ensureBootDependenciesInWorker } = await import("../../../lib/domains/system/functions/dependency-sync.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-dependency-sync-worker-"));
    const progress = [];

    try {
      fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
        name: "dependency-sync-worker-fixture",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
      }, null, 2));

      const result = await ensureBootDependenciesInWorker({
        projectDir,
        posseRoot: projectDir,
        dryRun: true,
        includePython: false,
        includeComposer: false,
        includeGo: false,
        includeCargo: false,
        includeScip: false,
        includeTestTools: false,
      }, {
        timeoutMs: 30_000,
        onProgress: (event) => progress.push(event.message),
      });

      assert.equal(result.ok, true);
      assert.equal(result.node[0].status, "dry-run");
      assert.equal(fs.existsSync(path.join(projectDir, "node_modules")), false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
