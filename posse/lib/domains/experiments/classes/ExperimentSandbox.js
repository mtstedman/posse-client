import { EXPERIMENT_CORPUS_EVALUATION_SCHEMA } from '../../../catalog/experiment-corpus.js';
import { stageCorpusInputs } from '../functions/corpus-inputs.js';
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { experimentDigest } from "../functions/snapshots.js";
import { scorePrediction } from "../functions/evaluation.js";
import { EXPERIMENT_SANDBOX_LIMITS as L } from "../../../catalog/experiments.js";

const exec = promisify(execFile);
const docker = "/usr/bin/docker";
const environment = () => ({ PATH: "/usr/bin:/bin", HOME: os.homedir(), XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`, DOCKER_HOST: "unix:///var/run/docker.sock" });

// Operator-provisioned Linux backend. The guest receives payload + case inputs;
// the scoring code, labels, receipts, Docker socket and owner state stay outside.
// A transient systemd service owns the deadline even if the Node owner dies.
export class ExperimentSandbox {
  constructor({ images = {} } = {}) { this.images = structuredClone(images); }
  fingerprint(plan, evaluation) { return experimentDigest({ profile: plan.runtime.profile, image: this.images[plan.runtime.profile], evaluation: plan.evaluation.digest, protocol: evaluation?.schema === EXPERIMENT_CORPUS_EVALUATION_SCHEMA ? "jsonl.corpus.v1" : "jsonl.numeric.v1" }); }
  async command(file, args, { timeout = 15000 } = {}) { return (await exec(file, args, { env: environment(), timeout, maxBuffer: 1048576 })).stdout.trim(); }
  identity(runId) {
    if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Invalid sandbox identity.");
    return `posse-experiment-${runId}`;
  }
  async preflight(plan) {
    const image = this.images[plan.runtime.profile];
    if (process.platform !== "linux" || !/^sha256:[a-f0-9]{64}$/.test(image || "") || plan.runtime.dependencies.length
      || plan.resources.cpu_count > L.cpus || plan.resources.memory_mb > L.memoryMB || plan.resources.wall_seconds > L.wallSeconds) throw new Error("Runtime profile is not provisioned within owner limits.");
    const info = JSON.parse(await this.command(docker, ["info", "--format", "{{json .}}"]));
    if (info.OSType !== "linux" || info.CgroupVersion !== "2" || !info.MemoryLimit || !info.SwapLimit || !info.PidsLimit || !info.CpuCfsQuota
      || !info.SecurityOptions.some(option => option.startsWith("name=seccomp"))) throw new Error("Required sandbox isolation is unavailable.");
    const details = JSON.parse(await this.command(docker, ["image", "inspect", image]))[0];
    if (details.Id !== image || Object.keys(details.Config.Volumes || {}).length) throw new Error("Runtime image is not a supported immutable image.");
    await this.command("/usr/bin/systemctl", ["--user", "show-environment"]);
  }
  async cleanup(runId) {
    const name = this.identity(runId);
    // Stop the independent supervisor before removing its container. Missing
    // resources are fine, but a daemon/query failure cannot prove cleanup.
    await this.command("/usr/bin/systemctl", ["--user", "stop", `${name}.service`]).catch(() => {});
    await this.command(docker, ["rm", "--force", name]).catch(() => {});
    const remaining = await this.command(docker, ["ps", "--all", "--quiet", "--filter", `name=^/${name}$`]);
    if (remaining) throw Object.assign(new Error("Sandbox cleanup is unconfirmed."), { cleanupUnconfirmed: true });
    for (const entry of await fs.readdir(os.tmpdir())) {
      if (entry.startsWith(`${name}-`)) await fs.rm(path.join(os.tmpdir(), entry), { recursive: true, force: true });
    }
  }
  async run({ runId, plan, files, evaluation, signal, onObservation }) {
    const name = this.identity(runId);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
    let failure = null; let result;
    try {
      await fs.chmod(directory, 0o755);
      for (const [filename, content] of Object.entries(files)) {
        const destination = path.join(directory, filename);
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
        await fs.writeFile(destination, content, { flag: "wx", mode: 0o444 });
      }
      const corpus = evaluation.schema === EXPERIMENT_CORPUS_EVALUATION_SCHEMA ? await stageCorpusInputs(evaluation, directory) : null;
      if (signal.aborted) throw new Error("Cancelled.");
      const executable = plan.runtime.profile === "node" ? "/usr/local/bin/node" : "/usr/local/bin/python3";
      await this.command(docker, ["create", "--name", name, "--pull=never", "--network=none", "--read-only", "--user=65534:65534",
        "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", `--memory=${plan.resources.memory_mb}m`,
        `--memory-swap=${plan.resources.memory_mb}m`, `--cpus=${plan.resources.cpu_count}`, "--ipc=private", "--cgroupns=private",
        "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m", "--shm-size=8m", "--ulimit=nofile=256:256", "--ulimit=core=0:0",
        "--log-driver=none", "--no-healthcheck", "--init", "--interactive", "--workdir=/payload", "--env=HOME=/tmp", "--env=PYTHONDONTWRITEBYTECODE=1",
        "--mount", `type=bind,src=${directory},dst=/payload,readonly,bind-propagation=rprivate`,
        ...(corpus ? ["--mount", `type=bind,src=${corpus.directory},dst=/input-files,readonly,bind-propagation=rprivate`] : []),
        "--entrypoint", executable, this.images[plan.runtime.profile], ...(plan.runtime.profile === "python" ? ["-I", "-u"] : []), `/payload/${plan.entrypoint}`]);
      if (signal.aborted) throw new Error("Cancelled.");
      const messages = [];
      await new Promise((resolve, reject) => {
        const child = spawn("/usr/bin/systemd-run", ["--user", "--quiet", "--pipe", "--wait", "--collect", `--unit=${name}`,
          `--property=RuntimeMaxSec=${plan.resources.wall_seconds}`, "--property=TimeoutStopSec=5",
          `--property=ExecStopPost=/bin/sh -c '${docker} rm -f ${name} >/dev/null 2>&1'`, "--", docker, "start", "--attach", "--interactive", name],
        { env: environment(), stdio: ["pipe", "pipe", "pipe"] });
        let bytes = 0; let buffer = ""; let error = null;
        const stop = reason => { error ||= reason; child.kill("SIGTERM"); void this.cleanup(runId).catch(() => {}); };
        const abort = () => stop(new Error("Cancelled."));
        signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => stop(new Error("Sandbox deadline exceeded.")), (plan.resources.wall_seconds + 10) * 1000);
        const consume = line => {
          if (!line.trim()) return;
          const message = JSON.parse(line); const observation = scorePrediction(evaluation, message);
          if (messages.some(item => item.case_id === message.case_id)) throw new Error("Duplicate prediction.");
          messages.push(message); onObservation(observation);
        };
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", chunk => {
          if (error) return;
          bytes += Buffer.byteLength(chunk); buffer += chunk;
          if (bytes > plan.resources.max_output_bytes || buffer.length > 65536) { stop(new Error("Output limit exceeded.")); return; }
          try {
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
          } catch { stop(new Error("Invalid sandbox output.")); }
        });
        child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > plan.resources.max_output_bytes) stop(new Error("Output limit exceeded.")); });
        child.stdin.on("error", err => stop(err));
        child.on("error", err => { error ||= err; });
        child.on("close", code => {
          clearTimeout(timer); signal.removeEventListener("abort", abort);
          try { if (!error && buffer) consume(buffer); } catch { error = new Error("Invalid sandbox output."); }
          if (error || code !== 0 || messages.length !== evaluation.cases.length) reject(error || new Error("Incomplete or failed test execution.")); else resolve();
        });
        child.stdin.end(evaluation.cases.map(item => JSON.stringify({ case_id: item.id, input: item.input, ...(corpus ? { files: corpus.cases.get(item.id) } : {}) })).join("\n") + "\n");
        if (signal.aborted) abort();
      });
      result = { evidence_digest: experimentDigest({ evaluation: plan.evaluation.digest, image: this.images[plan.runtime.profile], files, messages }) };
    } catch (error) { failure = error; }
    try { await this.cleanup(runId); } catch { throw Object.assign(new Error("Sandbox cleanup is unconfirmed."), { cleanupUnconfirmed: true }); }
    await fs.rm(directory, { recursive: true, force: true });
    if (failure) throw failure;
    return result;
  }
}
