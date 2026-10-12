import crypto from "node:crypto";
import path from "node:path";

import {
  AGENT_RELEASE_COMMANDS,
  AGENT_RELEASE_LIMITS,
  AGENT_RELEASE_MANIFEST_FILE,
} from "../../../catalog/agent-release.js";
import { extractVerifiedBundleBinary } from "../functions/agent-release-bundles.js";
import { assertOwnerOnlyWritable, childEnv, commandFailure, lookupAccount } from "../functions/agent-release-host.js";
import {
  AGENT_RELEASE_SHA_PATTERN,
  parseReleaseManifest,
  releaseIdCandidates,
  releaseManifest,
  sameInputs,
} from "../functions/agent-release-plan.js";
import { demand } from "../functions/policy.js";
import { assertContainedTree } from "../functions/system-release-integrity.js";

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * Builds one immutable release directory, <releasesRoot>/<id>, for a desired
 * state. Everything that reads the source repository (git, npm) runs as the
 * repository's owner, never root: a root git over a user-writable repository
 * would run repo-configured programs such as core.fsmonitor as root. That
 * owner is trusted with root (its published ref picks code root will run),
 * so nobody else may be able to write the repository's refs or objects. The
 * finished tree is root-owned, not group/other-writable, and verified before
 * it is renamed into place.
 */
export class AgentReleaseStager {
  /**
   * @param {{ host: any, paths: { releasesRoot: string, node: string }, config: { sourceRepo: string, npmCli: string } }} options
   */
  constructor({ host, paths, config }) {
    this.host = host;
    this.paths = paths;
    this.config = config;
    this.account = null;
  }

  /**
   * The source repository's owner. Refuses a root-owned repository, and one
   * whose refs or objects someone besides its owner can write.
   */
  sourceAccount() {
    if (this.account) return this.account;
    const repo = this.config.sourceRepo;
    demand(repo, "release.env names no source repository (POSSE_RELEASE_SOURCE_REPO)", "invalid_request");
    const info = this.host.fs.lstatSync(repo, { throwIfNoEntry: false });
    demand(info?.isDirectory() && !info.isSymbolicLink(), `Source repository is not a directory: ${repo}`, "invalid_request");
    demand(info.uid !== 0, "Source repository is root-owned; git would have to run as root", "forbidden");
    const git = path.join(repo, ".git");
    const remote = this.config.ref.split("/")[0];
    for (const filename of [repo, git, path.join(git, "objects"), path.join(git, "refs"), path.join(git, "refs", "remotes"),
      path.join(git, "refs", "remotes", remote), path.join(git, "refs", "remotes", ...this.config.ref.split("/")),
      path.join(git, "packed-refs")]) {
      assertOwnerOnlyWritable({ run: this.host.run, io: this.host.fs, filename });
    }
    this.account = lookupAccount(this.host.run, info.uid);
    demand(this.account.uid === info.uid && this.account.uid !== 0, "Source repository owner lookup disagrees", "forbidden");
    return this.account;
  }

  git(args, options = {}) {
    const account = this.sourceAccount();
    const result = this.host.run(AGENT_RELEASE_COMMANDS.git, ["-C", this.config.sourceRepo, ...args], {
      uid: account.uid, gid: account.gid, env: childEnv(account, { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }),
      cwd: this.config.sourceRepo, timeoutMs: AGENT_RELEASE_LIMITS.gitTimeoutMs, ...options,
    });
    demand(result.status === 0, commandFailure(`git ${args[0]}`, result), "release_source_failed");
    return result.stdout;
  }

  /** The full commit sha of `rev` (a hex id or refs/remotes/<remote>/<branch>). */
  resolveCommit(rev) {
    const sha = String(this.git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]) || "").trim();
    demand(AGENT_RELEASE_SHA_PATTERN.test(sha), `Source revision did not resolve to a commit: ${rev}`, "release_source_failed");
    return sha;
  }

  root(command, args, options = {}) {
    const result = this.host.run(command, args, options);
    demand(result.status === 0, commandFailure(path.basename(command), result), "release_stage_failed");
    return result;
  }

  readManifest(dir) {
    const file = path.join(dir, AGENT_RELEASE_MANIFEST_FILE);
    return this.host.fs.existsSync(file) ? parseReleaseManifest(this.host.fs.readFileSync(file, "utf8")) : null;
  }

  /**
   * Where `desired` goes: a release directory that already holds exactly
   * these inputs, else the first free name of releaseIdCandidates(). An
   * existing release directory is never replaced or deleted here: it may be
   * `current`, known-good, the previous known-good, a pending rollback
   * target, the fallback reconciler or the release this run executes from.
   *
   * @param {{ sha: string, products: any[] }} desired
   * @returns {{ id: string, dir: string, reuse: boolean }}
   */
  placement(desired) {
    const io = this.host.fs;
    const candidates = releaseIdCandidates(desired);
    let free = null;
    for (const id of candidates) {
      const dir = path.join(this.paths.releasesRoot, id);
      if (!io.lstatSync(dir, { throwIfNoEntry: false })) {
        free ??= { id, dir };
        continue;
      }
      if (sameInputs(this.readManifest(dir), desired)) return { id, dir, reuse: true };
    }
    demand(free, `Release directories ${candidates.join(", ")} already hold other inputs`, "release_stage_failed");
    return { ...free, reuse: false };
  }

  /**
   * Stage (or reuse an identical, verified) release for `desired`.
   *
   * @param {{ sha: string, products: any[] }} desired
   * @param {{ currentDir?: string }} [options]
   */
  async stage(desired, { currentDir = "" } = {}) {
    const io = this.host.fs;
    const { id, dir, reuse } = this.placement(desired);
    const packageRoot = path.join(dir, "posse");
    if (reuse) {
      const manifest = this.readManifest(dir);
      this.host.verifyRelease(packageRoot);
      return { id, dir, packageRoot, manifest, reused: true, nodeModules: manifest.node_modules };
    }
    const work = path.join(this.paths.releasesRoot, `.stage-${id}-${this.host.pid}`);
    io.rmSync(work, { recursive: true, force: true });
    io.mkdirSync(work, { mode: 0o755 });
    let manifest;
    try {
      const archive = this.git(["archive", "--format=tar", desired.sha],
        { encoding: "buffer", maxBuffer: AGENT_RELEASE_LIMITS.archiveMaxBytes });
      this.root(AGENT_RELEASE_COMMANDS.tar, ["-x", "--no-same-owner", "--no-same-permissions", "-C", work], { input: archive });
      // Root writes into this tree next (node_modules, native bins): no
      // committed symlink may point those writes anywhere else.
      assertContainedTree(work, { io });
      const workRoot = path.join(work, "posse");
      const lockFile = path.join(workRoot, "package-lock.json");
      demand(io.existsSync(path.join(workRoot, "package.json")) && io.existsSync(lockFile),
        "Archived source has no posse/package.json and package-lock.json", "release_stage_failed");
      demand(!io.lstatSync(path.join(workRoot, "node_modules"), { throwIfNoEntry: false }),
        "Archived source carries posse/node_modules", "release_stage_failed");
      const lock = io.readFileSync(lockFile);
      const nodeModules = this.stageNodeModules({ id, workRoot, lock, currentDir });
      for (const product of desired.products) await this.stageBinary(workRoot, product);
      manifest = releaseManifest(desired, { lockSha256: sha256(lock), stagedAt: new Date(this.host.now()).toISOString(), nodeModules });
      io.writeFileSync(path.join(work, AGENT_RELEASE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
      this.root(AGENT_RELEASE_COMMANDS.chown, ["-R", "-h", "root:root", work]);
      this.root(AGENT_RELEASE_COMMANDS.chmod, ["-R", "go-w,a-s", work]);
      io.renameSync(work, dir);
    } catch (error) {
      io.rmSync(work, { recursive: true, force: true });
      throw error;
    }
    try { this.host.verifyRelease(packageRoot); }
    catch (error) { io.rmSync(dir, { recursive: true, force: true }); throw error; }
    return { id, dir, packageRoot, manifest, reused: false, nodeModules: manifest.node_modules };
  }

  /**
   * Reuse the current release's node_modules when package-lock.json is byte
   * identical; otherwise `npm ci --omit=dev --ignore-scripts` as the source
   * owner in a private directory, then hand the tree to root.
   *
   * @returns {"reused" | "installed"}
   */
  stageNodeModules({ id, workRoot, lock, currentDir }) {
    const io = this.host.fs;
    const currentLock = currentDir ? path.join(currentDir, "posse", "package-lock.json") : "";
    const currentModules = currentDir ? path.join(currentDir, "posse", "node_modules") : "";
    if (currentDir && io.existsSync(currentLock) && io.existsSync(currentModules) && lock.equals(io.readFileSync(currentLock))) {
      io.cpSync(currentModules, path.join(workRoot, "node_modules"), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      return "reused";
    }
    demand(this.config.npmCli, "package-lock.json changed and release.env names no npm CLI (POSSE_RELEASE_NPM_CLI)", "release_stage_failed");
    const account = this.sourceAccount();
    const npmDir = path.join(this.paths.releasesRoot, `.npm-${id}-${this.host.pid}`);
    demand(this.removeWorkTree(npmDir), `Could not clear ${npmDir}`, "release_stage_failed");
    io.mkdirSync(npmDir, { mode: 0o700 });
    try {
      for (const name of ["package.json", "package-lock.json"]) io.copyFileSync(path.join(workRoot, name), path.join(npmDir, name));
      this.root(AGENT_RELEASE_COMMANDS.chown, ["-R", "-h", `${account.uid}:${account.gid}`, npmDir]);
      const result = this.host.run(this.paths.node, [this.config.npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
        uid: account.uid, gid: account.gid, cwd: npmDir, timeoutMs: AGENT_RELEASE_LIMITS.npmTimeoutMs,
        // The cache (and npm's logs) stay in the work directory: the source owner's home may be read-only here.
        env: childEnv(account, { npm_config_update_notifier: "false", npm_config_cache: path.join(npmDir, ".npm-cache") }),
      });
      demand(result.status === 0, commandFailure("npm ci", result), "release_stage_failed");
      this.root(AGENT_RELEASE_COMMANDS.chown, ["-R", "-h", "root:root", npmDir]);
      this.root(AGENT_RELEASE_COMMANDS.chmod, ["-R", "go-w,a-s", npmDir]);
      demand(io.existsSync(path.join(npmDir, "node_modules")), "npm ci produced no node_modules", "release_stage_failed");
      // Copied, not renamed: fresh inodes, so a descriptor the source owner
      // opened during npm ci cannot reach the release afterwards.
      io.cpSync(path.join(npmDir, "node_modules"), path.join(workRoot, "node_modules"),
        { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    } finally { this.removeWorkTree(npmDir); }
    return "installed";
  }

  /**
   * Delete a work directory, first taking it back to root: a root `rm -r`
   * over a tree its former owner can still write could be redirected.
   *
   * @returns {boolean} false when it could not be taken back (it is left for the next prune)
   */
  removeWorkTree(dir) {
    const io = this.host.fs;
    if (!io.lstatSync(dir, { throwIfNoEntry: false })) return true;
    for (const [command, args] of [[AGENT_RELEASE_COMMANDS.chown, ["-R", "-h", "root:root", dir]],
      [AGENT_RELEASE_COMMANDS.chmod, ["-R", "go-w", dir]]]) {
      if (this.host.run(command, args).status !== 0) return false;
    }
    io.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /**
   * Place one native binary at lib/bin/<product>/<version>/linux/<arch>/ with
   * a hex .sha256 sidecar. The version directory is created first, so the
   * binary always lands inside it.
   */
  async stageBinary(workRoot, product) {
    const io = this.host.fs;
    const dir = path.join(workRoot, "lib", "bin", product.product, product.version, "linux", product.arch);
    io.mkdirSync(dir, { recursive: true, mode: 0o755 });
    const target = path.join(dir, product.filename);
    const sha = await extractVerifiedBundleBinary({ io, candidate: product, outPath: target,
      maxBytes: AGENT_RELEASE_LIMITS.nativeBinaryMaxBytes, extract: this.host.extractTarball });
    demand(sha === product.sha256, `Native bundle changed after it was resolved: ${product.product} ${product.version}`, "artifact_checksum_mismatch");
    io.chmodSync(target, 0o755);
    io.writeFileSync(`${target}.sha256`, `${sha}\n`, { flag: "wx", mode: 0o644 });
  }
}
