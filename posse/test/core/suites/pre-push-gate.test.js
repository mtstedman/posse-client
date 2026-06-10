import {
  it,
  assert,
  fs,
  os,
  path,
  execFileSync,
  suite,
  runtimeModules,
} from "../support/core-harness.js";

let db;

function refspecCanPublishSnapshotRefs(refspec) {
  const source = String(refspec || "").trim().replace(/^\+/, "").split(":")[0].replace(/\/+$/, "");
  if (!source || source === "HEAD") return false;
  for (const protectedRef of ["refs/notes/posse-snapshots", "refs/posse"]) {
    if (source === protectedRef || source.startsWith(`${protectedRef}/`)) return true;
    const prefix = source.replace(/(?:\/\*\*|\/\*|\*)+$/g, "").replace(/\/+$/, "");
    if (!prefix) return source === "*" || source === "**";
    if (protectedRef === prefix || protectedRef.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function gitLines(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function snapshotPublishingPushConfigs(cwd) {
  const findings = [];
  for (const remote of gitLines(cwd, ["remote"])) {
    const mirrorKey = `remote.${remote}.mirror`;
    if (gitLines(cwd, ["config", "--bool", "--get", mirrorKey])[0] === "true") {
      findings.push({ remote, key: mirrorKey, value: "true", reason: "mirror" });
    }
    const pushKey = `remote.${remote}.push`;
    for (const value of gitLines(cwd, ["config", "--get-all", pushKey])) {
      if (refspecCanPublishSnapshotRefs(value)) {
        findings.push({ remote, key: pushKey, value, reason: "snapshot_refspec" });
      }
    }
  }
  return findings;
}

function fakePushGuardManager({ failure = null } = {}) {
  return {
    shouldUse(name) {
      assert.equal(name, "git");
      return true;
    },
    binary(name) {
      assert.equal(name, "git");
      return {
        runSync(command, args, opts) {
          assert.deepEqual(args, []);
          const envelope = JSON.parse(String(opts.input));
          if (command === "git.push.refspecCanPublishSnapshotRefs") {
            const json = { ok: true, data: refspecCanPublishSnapshotRefs(envelope.payload.refspec) };
            return { ok: true, code: 0, stdout: JSON.stringify(json), stderr: "", error: null, json };
          }
          if (command === "git.snapshotPublishingPushConfigs") {
            const json = { ok: true, data: snapshotPublishingPushConfigs(envelope.payload.cwd) };
            return { ok: true, code: 0, stdout: JSON.stringify(json), stderr: "", error: null, json };
          }
          assert.equal(command, "git.ensureRestrictivePushRefspecs");
          if (failure) {
            return { ok: false, code: 1, stdout: "", stderr: failure, error: null, json: null };
          }
          const cwd = envelope.payload.cwd;
          execFileSync("git", ["config", "remote.origin.mirror", "false"], { cwd, stdio: "ignore" });
          execFileSync("git", ["config", "--unset-all", "remote.origin.push"], { cwd, stdio: "ignore" });
          execFileSync("git", ["config", "--add", "remote.origin.push", "HEAD"], { cwd, stdio: "ignore" });
          const changed = [
            { remote: "origin", key: "remote.origin.mirror", value: "false", replaced: false },
            { remote: "origin", key: "remote.origin.push", value: "HEAD", replaced: true },
          ];
          const json = { ok: true, data: { changed, failures: [] } };
          return { ok: true, code: 0, stdout: JSON.stringify(json), stderr: "", error: null, json };
        },
      };
    },
  };
}

function prePushGateContext(repoDir) {
  return { cwd: repoDir, nativeParity: { manager: fakePushGuardManager() } };
}

suite("Pre-push gate", () => {
  it("reports timed-out verify commands through the hook command helper", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-hook-timeout-"));
    try {
      const scriptPath = path.join(tmpDir, "sleep.js");
      fs.writeFileSync(scriptPath, "setInterval(() => {}, 1000);\n", "utf8");
      const command = `"${process.execPath}" "${scriptPath}"`;
      assert.throws(
        () => runtimeModules.hooksMod.__testRunHookShellCommand(command, {
          cwd: tmpDir,
          timeoutMs: 50,
        }),
        (err) => {
          assert.equal(err.timedOut, true);
          assert.equal(err.status, 124);
          assert.match(err.message, /timed out/);
          return true;
        },
      );
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("preserves helper JSON when verify commands fill both stdout and stderr", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-hook-dual-stream-"));
    try {
      const scriptPath = path.join(tmpDir, "dual-stream.js");
      fs.writeFileSync(scriptPath, [
        "const chunk = 'x'.repeat(1024 * 1024);",
        "for (let i = 0; i < 5; i++) process.stdout.write(chunk);",
        "for (let i = 0; i < 5; i++) process.stderr.write(chunk);",
      ].join("\n"), "utf8");
      const command = `"${process.execPath}" "${scriptPath}"`;

      const result = runtimeModules.hooksMod.__testRunHookShellCommand(command, {
        cwd: tmpDir,
        timeoutMs: 5000,
      });

      assert.equal(result.status, 0);
      assert.equal(result.stdout.length, 1024 * 1024 * 4);
      assert.equal(result.stderr.length, 1024 * 1024 * 4);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("blocks pushes from a dirty tree", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-pre-push-"));
    try {
      execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoDir, stdio: "ignore" });
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n", "utf-8");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
      fs.writeFileSync(path.join(repoDir, "README.md"), "dirty\n", "utf-8");

      const result = runtimeModules.hooksMod.runHook("pre_push_gate", prePushGateContext(repoDir));
      assert.equal(result.ok, false);
      assert.match(result.output, /Working tree is not clean/);
    } finally {
      try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("ignores runtime-only .posse dirt in the pre-push gate", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-pre-push-runtime-"));
    try {
      execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoDir, stdio: "ignore" });
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n", "utf-8");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

      fs.mkdirSync(path.join(repoDir, ".posse", "resources", "artifacts"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, ".posse", "resources", "artifacts", "design-metadata.txt"), "<<<<<<< ours\n", "utf-8");

      const result = runtimeModules.hooksMod.runHook("pre_push_gate", prePushGateContext(repoDir));
      assert.equal(result.ok, true);
    } finally {
      try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("blocks unquoted env-style secrets in unpushed non-env diffs", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-pre-push-secret-"));
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-pre-push-remote-"));
    try {
      execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["init", "--bare"], { cwd: remoteDir, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir, stdio: "ignore" });
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n", "utf-8");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["push", "-u", "origin", "HEAD"], { cwd: repoDir, stdio: "ignore" });

      fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, "src", "config.js"), "OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz123456\n", "utf-8");
      execFileSync("git", ["add", "src/config.js"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "add config"], { cwd: repoDir, stdio: "ignore" });

      const result = runtimeModules.hooksMod.runHook("pre_push_gate", prePushGateContext(repoDir));
      assert.equal(result.ok, false);
      assert.match(result.output, /Possible secrets detected/);
      assert.match(result.output, /OPENAI_API_KEY/);
    } finally {
      try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(remoteDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("blocks broad remote push refspecs that would publish snapshot refs", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-pre-push-refspec-"));
    try {
      execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoDir, stdio: "ignore" });
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n", "utf-8");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "origin", "https://example.invalid/repo.git"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "--add", "remote.origin.push", "refs/*:refs/*"], { cwd: repoDir, stdio: "ignore" });

      const result = runtimeModules.hooksMod.runHook("pre_push_gate", prePushGateContext(repoDir));
      assert.equal(result.ok, false);
      assert.match(result.output, /snapshot refs/);
    } finally {
      try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("rewrites risky remote push refspecs to a restrictive HEAD refspec", async () => {
    const { ensureRestrictivePushRefspecs } = await import("../../../lib/domains/git/functions/push-guard.js");
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-pre-push-rewrite-"));
    try {
      execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "origin", "https://example.invalid/repo.git"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "--add", "remote.origin.push", "refs/*:refs/*"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "remote.origin.mirror", "true"], { cwd: repoDir, stdio: "ignore" });

      const changed = ensureRestrictivePushRefspecs(repoDir, {
        manager: fakePushGuardManager(),
      });
      const push = execFileSync("git", ["config", "--get-all", "remote.origin.push"], { cwd: repoDir, encoding: "utf-8" }).trim();
      const mirror = execFileSync("git", ["config", "--bool", "--get", "remote.origin.mirror"], { cwd: repoDir, encoding: "utf-8" }).trim();

      assert.ok(changed.length >= 2);
      assert.equal(push, "HEAD");
      assert.equal(mirror, "false");
    } finally {
      try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("detects glob push refspecs that can publish snapshot refs", async () => {
    const { pushRefspecCanPublishSnapshotRefs } = await import("../../../lib/domains/git/functions/push-guard.js");
    const manager = fakePushGuardManager();
    assert.equal(pushRefspecCanPublishSnapshotRefs("refs/notes/**:refs/notes/**", { manager }), true);
    assert.equal(pushRefspecCanPublishSnapshotRefs("refs/notes/*:refs/notes/*", { manager }), true);
    assert.equal(pushRefspecCanPublishSnapshotRefs("refs/posse/**:refs/posse/**", { manager }), true);
    assert.equal(pushRefspecCanPublishSnapshotRefs("refs/heads/**:refs/heads/**", { manager }), false);
  });

  it("surfaces native push refspec rewrite failures", async () => {
    const { ensureRestrictivePushRefspecs } = await import("../../../lib/domains/git/functions/push-guard.js");
    const stderr = "Failed to restrict git push refspecs: origin.push add HEAD: cannot lock config";

    assert.throws(
      () => ensureRestrictivePushRefspecs("C:\\repo", {
        manager: fakePushGuardManager({ failure: stderr }),
      }),
      (err) => {
        assert.match(err.message, /cannot lock config/);
        assert.equal(Object.hasOwn(err, "applied"), false);
        assert.equal(Object.hasOwn(err, "failures"), false);
        return true;
      }
    );
  });
});
