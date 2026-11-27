import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { gitExecAsync } from "../../git/functions/utils.js";
import { gitCommitAllAsync } from "../../git/functions/commit-scope.js";
import { terminateSpawnedProcessTree, trackSpawnedProcess } from "../../../shared/platform/functions/spawned-process.js";
import { filterProcessEnv } from "../../../shared/platform/functions/process-env.js";
import { experimentDigest } from "../functions/snapshots.js";
import { integrationRelativePath } from "../functions/integration-config.js";
import { IntegrationTrunk } from "./IntegrationTrunk.js";

export class IntegrationWorkspace {
  constructor(config, { git = gitExecAsync, commit = gitCommitAllAsync, lock } = {}) { this.config = config; this.git = git; this.commit = commit; this.trunk = new IntegrationTrunk(this, { lock }); }
  async validateBindings(files, signal) {
    const c = this.config;
    for (const item of c.mapping || []) {
      const scope = this.declared(item.target, true);
      const entry = String(await this.git(["ls-tree", c.base_commit, "--", item.target], c.repo_path, { signal })).trim();
      if (scope.mode === "create") { if (entry) throw new Error("Mapped creation already exists at the base commit."); continue; }
      if (!/^100(644|755) blob /.test(entry)) throw new Error("Mapped source must be a regular repository file.");
      const source = String(await this.git(["show", `${c.base_commit}:${item.target}`], c.repo_path, { signal, trim: false }));
      if (source !== files[item.source]) throw new Error(`Starting payload differs from repository source: ${item.target}. Test the shippable source directly or explicitly choose agent adaptation.`);
    }
  }
  async command(args, signal) { return String(await this.git(args, this.config.worktree_path, { signal })).trim(); }
  async safePath(file, { missing = false, directory = false } = {}) {
    if (file !== "." && !integrationRelativePath(file)) throw new Error("Invalid relative path.");
    let current = this.config.worktree_path;
    if (await fs.realpath(current) !== current) throw new Error("Worktree path must not contain symlinks.");
    for (const [index, part] of (file === "." ? [] : file.split("/")).entries()) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch(error => { if (error.code === "ENOENT" && missing) return null; throw error; });
      if (stat && (stat.isSymbolicLink() || (!stat.isDirectory() && index < file.split("/").length - 1))) throw new Error("Symlink or non-directory in declared path.");
      if (stat && !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144)) throw new Error("Declared file must be a bounded regular file without hard links.");
      if (stat && index === file.split("/").length - 1 && (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("Unexpected declared path type.");
    }
    return current;
  }
  async initialize(signal) {
    const c = this.config;
    const root = String(await this.git(["rev-parse", "--show-toplevel"], c.repo_path, { signal })).trim();
    if (await fs.realpath(root) !== await fs.realpath(c.repo_path)) throw new Error("repo_path must name the repository root.");
    if (await fs.lstat(c.worktree_path).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; })) throw new Error("Integration worktree already exists; preserve it and choose a fresh path.");
    const base = String(await this.git(["rev-parse", `${c.base_commit}^{commit}`], c.repo_path, { signal })).trim();
    if (base !== c.base_commit) throw new Error("Base commit must be fully pinned.");
    await this.git(["worktree", "add", "-b", c.branch, c.worktree_path, base], c.repo_path, { signal });
    for (const file of c.files) {
      const exists = !!await this.command(["ls-tree", "HEAD", "--", file.path], signal);
      if (exists === (file.mode === "create")) throw new Error("File mode disagrees with the pinned base tree.");
      await this.safePath(file.path, { missing: file.mode === "create" });
    }
    for (const command of c.prepare) {
      const result = await this.run(command, signal);
      if (!result.ok) throw new Error(`Integration preparation failed: ${result.output}`);
    }
    if ((await this.changes(signal)).length) throw new Error("Preparation changed repository sources.");
  }
  declared(file, write = false) {
    const scope = this.config.files.find(f => f.path === file);
    if (!scope || (write && scope.mode === "read")) throw new Error("File is outside the declared scope.");
    return scope;
  }
  async read(file) {
    this.declared(file);
    return fs.readFile(await this.safePath(file), "utf8");
  }
  async write(file, content) {
    const scope = this.declared(file, true);
    if (Buffer.byteLength(content) > 262144) throw new Error("File exceeds 256 KiB.");
    const target = await this.safePath(file, { missing: scope.mode === "create" });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  async changes(signal) {
    const lists = await Promise.all([
      this.command(["diff", "--name-only", "-z", "HEAD"], signal),
      this.command(["ls-files", "--others", "--exclude-standard", "-z"], signal),
    ]);
    return [...new Set(lists.flatMap(list => list.split("\0").filter(Boolean)))].sort();
  }
  async snapshot(signal) {
    if (await this.command(["rev-parse", "HEAD"], signal) !== this.config.base_commit
      || await this.command(["branch", "--show-current"], signal) !== this.config.branch) throw new Error("Integration branch or base changed.");
    const files = {};
    for (const file of await this.changes(signal)) {
      this.declared(file, true);
      const target = await this.safePath(file);
      files[file] = { content: await fs.readFile(target, "utf8"), executable: !!((await fs.stat(target)).mode & 0o111) };
    }
    if (Buffer.byteLength(JSON.stringify(files)) > 1048576) throw new Error("Integration changes exceed 1 MiB.");
    return { files, digest: experimentDigest(files) };
  }
  async run(command, signal) {
    signal.throwIfAborted();
    const cwd = await this.safePath(command.cwd, { directory: true });
    return new Promise((resolve, reject) => {
      let output = "", bytes = 0, stopped = false;
      const proc = spawn(command.program, command.args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
        env: { ...filterProcessEnv(process.env, { allowedKeys: ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "COMSPEC", "PATHEXT"] }), CI: "1", NO_COLOR: "1" } });
      trackSpawnedProcess(proc, command.program, { creator: "experiment-integration" });
      const stop = () => { stopped = true; terminateSpawnedProcessTree(proc, { force: true, processGroup: true }); };
      const timer = setTimeout(stop, command.timeout_seconds * 1000);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      const capture = chunk => { bytes += chunk.length; output = (output + chunk.toString()).slice(-12000); if (bytes > 1048576) stop(); };
      proc.stdout.on("data", capture); proc.stderr.on("data", capture);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); };
      proc.once("error", error => { cleanup(); reject(error); });
      proc.once("close", code => { cleanup(); resolve({ ok: code === 0 && !stopped, code, stopped, output }); });
    });
  }
  async commitVerified(record, signal) {
    const snapshot = await this.snapshot(signal);
    if (!record.verification?.ok || snapshot.digest !== record.verification.digest || !Object.keys(snapshot.files).length) throw new Error("Run successful checks on the exact nonempty changes before committing.");
    const result = await this.commit(`${this.config.commit_message}\n\nPosse-Experiment: ${record.campaign_id}\nPosse-Integration: ${record.id}\nAccepted-Snapshot: ${record.snapshot_digest}`, this.config.worktree_path, {
      modifyFiles: this.config.files.filter(f => f.mode === "modify" && Object.hasOwn(snapshot.files, f.path)).map(f => f.path),
      createFiles: this.config.files.filter(f => f.mode === "create" && Object.hasOwn(snapshot.files, f.path)).map(f => f.path),
    }, { projectDir: this.config.repo_path, expectedHead: this.config.base_commit });
    if (!result.createdCommit) throw new Error("Integration did not create a commit.");
    return this.confirmCommit(record, signal);
  }
  async confirmCommit(record, signal) {
    const hash = await this.command(["rev-parse", "HEAD"], signal);
    const body = await this.command(["log", "-1", "--format=%B"], signal);
    if (!record.verification?.ok || !body.split("\n").includes(`Posse-Integration: ${record.id}`)
      || await this.command(["rev-parse", "HEAD^"], signal) !== this.config.base_commit
      || await this.command(["branch", "--show-current"], signal) !== this.config.branch
      || (await this.changes(signal)).length) throw new Error("Committed tree could not be reconciled with verification.");
    const files = {};
    const changed = (await this.command(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"], signal)).split("\0").filter(Boolean).sort();
    for (const file of changed) {
      this.declared(file, true);
      await this.safePath(file);
      const entry = await this.command(["ls-tree", hash, "--", file], signal);
      if (!/^100(644|755) blob /.test(entry)) throw new Error("Committed file is not regular source.");
      files[file] = { content: String(await this.git(["show", `${hash}:${file}`], this.config.worktree_path, { signal, trim: false })), executable: entry.startsWith("100755 ") };
    }
    if (experimentDigest(files) !== record.verification.digest) throw new Error("Commit differs from the verified changes.");
    return hash;
  }
}
