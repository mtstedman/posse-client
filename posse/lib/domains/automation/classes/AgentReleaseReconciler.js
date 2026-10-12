import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_RELEASE_LIMITS,
  AGENT_RELEASE_LOCK_FILE,
  AGENT_RELEASE_MANIFEST_FILE,
  AGENT_RELEASE_PATHS,
  AGENT_RELEASE_RESULTS,
  AGENT_RELEASE_ROOT_REFUSAL,
  AGENT_RELEASE_STATE_FILE,
} from "../../../catalog/agent-release.js";
import { SYSTEM_REGISTERED_AGENT } from "../../../catalog/registered-agent.js";
import { archKey } from "../../../shared/platform/functions/native-platform.js";
import { extractNativeArtifactTarball } from "../../../shared/native/functions/artifact-tarball.js";
import { scrubSecretText } from "../../../shared/telemetry/functions/logging/scrub-secret-text.js";
import { resolveNativeBundles } from "../functions/agent-release-bundles.js";
import { loadReleaseConfig } from "../functions/agent-release-config.js";
import { assertOwnerOnlyWritable, formatReleaseLog, runCommand, tryExclusiveLock } from "../functions/agent-release-host.js";
import {
  AGENT_RELEASE_ID_PATTERN,
  crashLoopAction,
  desiredKey,
  emptyReleaseState,
  failureHold,
  fallbackPromotion,
  fallbackRunAction,
  normalizeReleaseState,
  parseReleaseManifest,
  recordFailedInputs,
  recordReconcilerResult,
  recordReconcilerStart,
  recordRunResult,
  releaseIdFor,
  sameInputs,
  selectPrunable,
} from "../functions/agent-release-plan.js";
import { demand } from "../functions/policy.js";
import { verifySystemRelease } from "../functions/system-release-integrity.js";
import { AgentReleaseProbes } from "./AgentReleaseProbes.js";
import { AgentReleaseStager } from "./AgentReleaseStager.js";
import { SystemRegisteredAgentManager } from "./SystemRegisteredAgentManager.js";

const OWN_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const errorText = error => scrubSecretText(String(error?.message || error)).slice(0, 600);
const iso = ms => new Date(ms).toISOString();

function defaultHost() {
  return {
    fs,
    run: runCommand,
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    platform: process.platform,
    getuid: () => process.getuid?.() ?? -1,
    pid: process.pid,
    arch: archKey(),
    trustedUid: 0,
    execPath: process.execPath,
    lock: tryExclusiveLock,
    log: (event, fields) => process.stderr.write(formatReleaseLog(event, fields)),
    verifyRelease: packageRoot => verifySystemRelease(packageRoot, AGENT_RELEASE_PATHS.node),
    installRelease: (packageRoot, options) => new SystemRegisteredAgentManager({ packageRoot }).install(options),
    extractTarball: extractNativeArtifactTarball,
  };
}

const DEFAULT_PATHS = Object.freeze({
  ...AGENT_RELEASE_PATHS,
  ownerEnv: SYSTEM_REGISTERED_AGENT.ownerEnv,
  ownerHome: SYSTEM_REGISTERED_AGENT.dataDir,
  ownerRuntime: SYSTEM_REGISTERED_AGENT.runtimeDir,
  automationDb: SYSTEM_REGISTERED_AGENT.automationDb,
  launcher: SYSTEM_REGISTERED_AGENT.launcher,
  // The release this code runs from: probes ship from here, and it is never pruned.
  selfRoot: OWN_PACKAGE_ROOT,
});

/**
 * Keeps /opt/posse-agent on published posse plus the newest native bundles:
 * resolve the desired state, stage it, gate it on a self-check of its own
 * reconciler and a live smoke, drain in-flight receipts, swap `current`,
 * install, check health, and roll back to the last known-good release on any
 * failure after the swap. Each run also repairs a crash-looping or hung
 * owner. Root only; one run at a time.
 */
export class AgentReleaseReconciler {
  constructor({ host = {}, paths = {}, config = null } = {}) {
    this.host = { ...defaultHost(), ...host };
    this.paths = { ...DEFAULT_PATHS, ...paths };
    this.config = config;
    this.state = emptyReleaseState();
    this.probes = new AgentReleaseProbes({ host: this.host, paths: this.paths });
  }

  log(event, fields = {}) { this.host.log(event, fields); }

  run(command, args, options) { return this.host.run(command, args, options); }

  loadConfig() {
    return this.config || loadReleaseConfig({ io: this.host.fs, filename: this.paths.releaseEnv, trustedUid: this.host.trustedUid });
  }

  stager(config) {
    return new AgentReleaseStager({ host: this.host, paths: this.paths, config });
  }

  /** install() pins the owner to the Node that runs it, so that must be the release Node. */
  runsReleaseNode() {
    const io = this.host.fs;
    try { return io.realpathSync(this.host.execPath) === io.realpathSync(this.paths.node); } catch { return false; }
  }

  // State: one root-only JSON file; the run lock lives in /run.

  get stateFile() { return path.join(this.paths.stateDir, AGENT_RELEASE_STATE_FILE); }

  ensurePrivateDir(dir) {
    const io = this.host.fs;
    io.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = io.lstatSync(dir);
    demand(info.isDirectory() && !info.isSymbolicLink() && info.uid === this.host.trustedUid,
      `Release state directory is untrusted: ${dir}`, "forbidden");
    io.chmodSync(dir, 0o700);
  }

  readState() {
    const io = this.host.fs;
    const info = io.lstatSync(this.stateFile, { throwIfNoEntry: false });
    if (!info) return emptyReleaseState();
    demand(info.isFile() && !info.isSymbolicLink() && info.uid === this.host.trustedUid && !(info.mode & 0o077),
      `Release state file is untrusted: ${this.stateFile}`, "forbidden");
    try { return normalizeReleaseState(JSON.parse(io.readFileSync(this.stateFile, "utf8"))); }
    catch { return emptyReleaseState(); }
  }

  writeState() {
    const io = this.host.fs;
    const temporary = `${this.stateFile}.${this.host.pid}.new`;
    io.rmSync(temporary, { force: true });
    io.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    io.renameSync(temporary, this.stateFile);
  }

  /**
   * One run at a time. The lock belongs to this process and the kernel drops
   * it when the process exits however it exits, so a crash, a
   * TimeoutStartSec kill or a reboot never leaves a lock behind.
   *
   * @returns {(() => void) | null} a release function, or null while another run holds the lock
   */
  acquireLock() {
    this.ensurePrivateDir(this.paths.runDir);
    return this.host.lock(path.join(this.paths.runDir, AGENT_RELEASE_LOCK_FILE));
  }

  // Releases on disk.

  /** The release a link under the install root points at, or null when there is no link. */
  readReleaseLink(link) {
    const io = this.host.fs;
    const info = io.lstatSync(link, { throwIfNoEntry: false });
    if (!info) return null;
    demand(info.isSymbolicLink(), `${link} is not a symlink`, "forbidden");
    const target = path.resolve(path.dirname(link), io.readlinkSync(link));
    const id = path.basename(target);
    demand(path.dirname(target) === this.paths.releasesRoot && AGENT_RELEASE_ID_PATTERN.test(id),
      `${link} points outside ${this.paths.releasesRoot}`, "forbidden");
    return { id, dir: target };
  }

  /** The release `current` points at, with its manifest when it has one. */
  readCurrent() {
    const link = this.readReleaseLink(this.paths.current);
    if (!link) return null;
    const io = this.host.fs;
    const manifestFile = path.join(link.dir, AGENT_RELEASE_MANIFEST_FILE);
    const manifest = io.existsSync(manifestFile) ? parseReleaseManifest(io.readFileSync(manifestFile, "utf8")) : null;
    return { ...link, packageRoot: path.join(link.dir, "posse"), manifest };
  }

  releaseExists(id) {
    return Boolean(id) && AGENT_RELEASE_ID_PATTERN.test(id) && this.host.fs.existsSync(path.join(this.paths.releasesRoot, id, "posse"));
  }

  /** The release this code runs from, when it runs from one. */
  selfRelease() {
    const dir = path.dirname(this.paths.selfRoot);
    const id = path.basename(dir);
    return path.dirname(dir) === this.paths.releasesRoot && AGENT_RELEASE_ID_PATTERN.test(id) ? id : "";
  }

  /** Point a link at a release in one rename. */
  pointLink(link, id) {
    const io = this.host.fs;
    demand(this.releaseExists(id), `Release ${id} is missing`, "release_stage_failed");
    const temporary = path.join(path.dirname(link), `.${path.basename(link)}-${this.host.pid}`);
    io.rmSync(temporary, { force: true });
    io.symlinkSync(path.join(this.paths.releasesRoot, id), temporary);
    io.renameSync(temporary, link);
  }

  /** Point `current` at a release and record it at once. */
  swap(id) {
    this.pointLink(this.paths.current, id);
    this.state.current = id;
    this.state.swapped_at = new Date(this.host.now()).toISOString();
    // Recorded now, so a run interrupted before install finishes is found next time.
    this.writeState();
    this.log("swapped", { release: id });
  }

  // Desired state.

  async resolveDesired(config, sha = "") {
    const stager = this.stager(config);
    const commit = stager.resolveCommit(sha || `refs/remotes/${config.ref}`);
    // Whoever can write the bundles picks the bytes the owner runs.
    for (const filename of [config.artifactRoot, ...config.products.map(product => path.join(config.artifactRoot, product))]) {
      assertOwnerOnlyWritable({ run: this.host.run, io: this.host.fs, filename });
    }
    const products = await resolveNativeBundles({ io: this.host.fs, artifactRoot: config.artifactRoot, products: config.products,
      arch: this.host.arch, scratchDir: this.paths.stateDir, maxBytes: AGENT_RELEASE_LIMITS.nativeBinaryMaxBytes,
      extract: this.host.extractTarball });
    return { sha: commit, products };
  }

  // Install, roll back, repair.

  /** @param {string} id @param {{ restart?: boolean }} [options] */
  async installAndCheck(id, { restart = false } = {}) {
    let status;
    try { status = this.host.installRelease(path.join(this.paths.releasesRoot, id, "posse"), { restart }); }
    catch (error) { return { ok: false, stage: "install", detail: errorText(error) }; }
    if (status?.release_triggers?.ok === false) this.log("triggers_failed", { release: id, detail: status.release_triggers.detail });
    const health = await this.probes.health();
    if (!health.healthy) return { ok: false, stage: "health", detail: "owner is not healthy after install", health };
    return { ok: true, restarts: health.restarts };
  }

  /** Remember failed inputs, and whose reconciler found them failing (`by`). */
  markFailed(key, failure) {
    this.state = recordFailedInputs(this.state, key, { at: new Date(this.host.now()).toISOString(), by: this.selfRelease(), ...failure });
  }

  /** Swap back to `id` and install it. The pending target is recorded with the swap. */
  async rollbackTo(id, reason) {
    this.log("rollback", { release: id, reason });
    this.state.rolling_back_to = id;
    try { this.swap(id); }
    catch (error) {
      this.state.rolling_back_to = "";
      this.state.known_good = "";
      this.state.previous_known_good = "";
      return { ok: false, stage: "install", detail: errorText(error) };
    }
    return this.settleRollback(id);
  }

  /** Install the rollback target `current` already points at. */
  async settleRollback(id) {
    const installed = await this.installAndCheck(id);
    this.state.rolling_back_to = "";
    if (installed.ok) {
      this.state.known_good = id;
      this.state.restart_baseline = installed.restarts;
    } else {
      // Nothing is proven good now: later runs reinstall, then adopt whatever is healthy.
      this.state.known_good = "";
    }
    // Never cascade further back on a later loop: reinstall instead.
    this.state.previous_known_good = "";
    return installed;
  }

  /**
   * Install the release `current` now points at; promote it, or roll back.
   * @param {Record<string, unknown>} [carried] fields every failure of these inputs keeps
   */
  async completeSwap(id, key, rollbackTarget, carried = {}) {
    const installed = await this.installAndCheck(id);
    if (installed.ok) {
      if (this.state.known_good && this.state.known_good !== id) this.state.previous_known_good = this.state.known_good;
      this.state.known_good = id;
      this.state.restart_baseline = installed.restarts;
      return { result: "installed", release: id };
    }
    if (key) this.markFailed(key, { stage: installed.stage, release: id, reason: installed.detail, ...carried });
    if (!rollbackTarget) return { result: "failed", release: id, stage: installed.stage, detail: `${installed.detail}; no release to roll back to` };
    const rolled = await this.rollbackTo(rollbackTarget, installed.stage);
    return { result: rolled.ok ? "rolled_back" : "failed", release: id, rolled_back_to: rollbackTarget, stage: installed.stage,
      detail: rolled.ok ? installed.detail : `${installed.detail}; rollback failed: ${rolled.detail}` };
  }

  /** A swap whose install never finished: `current` is ours but not yet known-good. */
  interruptedSwap(current) {
    return Boolean(current && this.state.current === current.id && this.state.known_good && this.state.known_good !== current.id);
  }

  /** A healthy release installed outside this reconciler (by hand, or before it existed) becomes the rollback target. */
  adopt(current, health) {
    if (!current || !health?.healthy || (this.state.known_good && this.state.current === current.id)) return;
    if (this.state.known_good && this.state.known_good !== current.id) this.state.previous_known_good = this.state.known_good;
    this.state.known_good = current.id;
    this.state.current = current.id;
  }

  /**
   * What an unhealthy or restart-looping owner needs: a release that never
   * proved itself rolls back to the known-good one; a known-good release that
   * starts looping soon after its swap rolls back to the one before it;
   * otherwise the current release is reinstalled.
   *
   * @returns {{ action: "ok" | "rollback" | "reinstall", target: string }}
   */
  repairPlan(current, health) {
    if (!current || !health) return { action: "ok", target: "" };
    const ours = this.state.current === current.id;
    const target = current.id !== this.state.known_good ? this.state.known_good : this.state.previous_known_good;
    const action = crashLoopAction({ healthy: health.healthy, restarts: health.restarts,
      baseline: ours ? this.state.restart_baseline : {}, swappedAtMs: ours ? Date.parse(this.state.swapped_at) : Number.NaN,
      nowMs: this.host.now(), currentId: current.id, rollbackId: this.releaseExists(target) ? target : "" });
    return { action, target };
  }

  /** Repair an unhealthy or restart-looping owner; null when nothing is wrong. */
  async remediate(current, initialHealth) {
    let health = initialHealth;
    let plan = this.repairPlan(current, health);
    if (plan.action === "ok") return null;
    if (!health.healthy) {
      // One short unhealthy reading can be an ordinary restart in progress:
      // probe for the whole health window before rolling back or restarting.
      health = await this.probes.health();
      plan = this.repairPlan(current, health);
      if (plan.action === "ok") return null;
    }
    this.log("unhealthy", { release: current.id, action: plan.action, ready: health.ready, restarts: health.restarts });
    if (plan.action === "rollback") {
      if (current.manifest) this.markFailed(desiredKey(current.manifest), { stage: "crash_loop", release: current.id,
        reason: "owner restart loop or unhealthy soon after install" });
      const rolled = await this.rollbackTo(plan.target, "crash_loop");
      return { result: rolled.ok ? "rolled_back" : "failed", release: plan.target, from: current.id, stage: "crash_loop",
        detail: rolled.ok ? "" : rolled.detail };
    }
    // A hung owner keeps its unit text and its process, so install() would
    // otherwise leave it running untouched.
    const installed = await this.installAndCheck(current.id, { restart: !health.healthy });
    if (installed.ok) {
      this.state.restart_baseline = installed.restarts;
      if (!this.state.known_good) this.state.known_good = current.id;
    }
    return { result: installed.ok ? "reinstalled" : "failed", release: current.id, stage: "crash_loop",
      detail: installed.ok ? "" : installed.detail };
  }

  /**
   * @param {{ smokeAttempts?: number }} [options] smokeAttempts: earlier
   *   smokes of these inputs that failed transiently
   */
  async upgrade(config, desired, current, { smokeAttempts = 0 } = {}) {
    const key = desiredKey(desired);
    // The transient smoke count stays with any later failure of these inputs,
    // so its bound holds when a fallback run and the run in `current` take turns.
    const carried = smokeAttempts ? { attempts: smokeAttempts } : {};
    let staged;
    try {
      staged = await this.stager(config).stage(desired, { currentDir: current?.dir || "" });
    } catch (error) {
      this.markFailed(key, { stage: "stage", release: releaseIdFor(desired), reason: errorText(error), ...carried });
      return { result: "stage_failed", release: releaseIdFor(desired), detail: errorText(error) };
    }
    // Not always releaseIdFor(desired): an existing directory of that name may hold other inputs.
    const id = staged.id;
    this.log("staged", { release: id, reused: staged.reused, node_modules: staged.nodeModules });
    const check = this.probes.selfCheck(staged);
    this.log("self_check", { release: id, ok: check.ok });
    if (!check.ok) {
      this.markFailed(key, { stage: "self_check", release: id, reason: check.detail, ...carried });
      return { result: "smoke_failed", stage: "self_check", release: id, detail: check.detail };
    }
    const smoke = this.probes.smoke(staged);
    this.log("smoke", { release: id, ok: smoke.ok, output: smoke.output, failure_class: smoke.failureClass });
    if (!smoke.ok) {
      const reason = smoke.detail || smoke.output;
      if (!smoke.transient) {
        this.markFailed(key, { stage: "smoke", release: id, reason, ...carried });
        return { result: "smoke_failed", stage: "smoke", release: id, detail: reason };
      }
      // The provider or the network failed, not the release: a later run tries again, a few times.
      const attempts = smokeAttempts + 1;
      this.markFailed(key, { stage: "smoke", release: id, reason, transient: true, failure_class: smoke.failureClass, attempts });
      const { retryAtMs } = failureHold(this.state.failed[key], this.host.now());
      return { result: "smoke_failed", stage: "smoke", release: id, detail: reason, transient: true,
        failure_class: smoke.failureClass, attempt: attempts, retry_at: retryAtMs === null ? "" : iso(retryAtMs) };
    }
    // With no current release there is no owner to drain.
    const drained = current ? await this.probes.drain(config) : { drained: true, unfinished: 0 };
    if (!drained.drained) return { result: "drain_timeout", release: id, unfinished: drained.unfinished };
    const rollbackTarget = [this.state.known_good, current?.id].find(candidate => candidate && candidate !== id && this.releaseExists(candidate)) || "";
    this.swap(id);
    const outcome = await this.completeSwap(id, key, rollbackTarget, carried);
    return { ...outcome, previous: current?.id || "", node_modules: staged.nodeModules };
  }

  /**
   * Delete old releases, keeping current, known-good, the previous
   * known-good, the fallback reconciler, this run's own and `keep` more.
   */
  prune(config) {
    const io = this.host.fs;
    const stager = this.stager(config);
    const protect = new Set([this.state.current, this.state.known_good, this.state.previous_known_good, this.state.rolling_back_to,
      this.state.fallback, this.selfRelease(), this.readCurrent()?.id, this.readReleaseLink(this.paths.fallback)?.id].filter(Boolean));
    const entries = io.readdirSync(this.paths.releasesRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
    // Work directories of an interrupted run; the run lock is held.
    const work = entry => /^\.(?:stage|npm)-/.test(entry.name);
    for (const entry of entries.filter(work)) {
      if (!stager.removeWorkTree(path.join(this.paths.releasesRoot, entry.name))) this.log("prune_skipped", { dir: entry.name });
    }
    const removed = selectPrunable(entries.filter(entry => !work(entry)).map(entry => ({ name: entry.name,
      mtimeMs: io.statSync(path.join(this.paths.releasesRoot, entry.name)).mtimeMs })), protect, config.keep);
    for (const name of removed) {
      io.rmSync(path.join(this.paths.releasesRoot, name), { recursive: true, force: true });
      // A later release staged under the same name has not run its reconciler yet.
      delete this.state.reconciler_runs[name];
    }
    if (removed.length) this.log("pruned", { releases: removed.join(",") });
  }

  /** The release `current` points at, or "" when there is none or the link is unusable. */
  currentId() {
    try { return this.readCurrent()?.id || ""; } catch { return ""; }
  }

  /**
   * Record that this release's reconciler started a run, before it changes
   * anything, so a run that dies part way (killed, or its last write failed)
   * reads as not ok to the fallback unit.
   */
  recordRunStart(self) {
    if (!self || !this.releaseExists(self)) return;
    this.state = recordReconcilerStart(this.state, self, iso(this.host.now()));
    this.writeState();
  }

  /**
   * After a run: remember how this release's reconciler ended it, and move
   * the fallback link to this release only as fallbackPromotion() allows (the
   * run completed a real upgrade). A reconciler that has not proven its
   * upgrade path never displaces one that has, so the fallback unit can still
   * update and repair past it.
   *
   * @param {{ self: string, outcome: { result: string, resumed?: boolean }, at: string }} run
   */
  recordReconcilerRun({ self, outcome, at }) {
    if (!self || !this.releaseExists(self)) return;
    this.state = recordReconcilerResult(this.state, self, { at, result: outcome.result, ok: AGENT_RELEASE_RESULTS[outcome.result]?.ok === true });
    const linked = this.readReleaseLink(this.paths.fallback)?.id || "";
    const target = fallbackPromotion({ self, linked, result: outcome.result, resumed: outcome.resumed === true });
    if (target) {
      this.pointLink(this.paths.fallback, target);
      this.log("fallback", { release: target });
    }
    this.state.fallback = this.readReleaseLink(this.paths.fallback)?.id || "";
  }

  /**
   * A fallback run whose decision is "replace": the reconciler shipped in
   * `current` has not run since its swap (it crashes on import), so it can
   * neither update nor repair. Finish an interrupted swap or rollback first,
   * as any run does. Otherwise drain like an upgrade swap, remember the
   * inputs of the release state names as swapped in (fallbackRunAction()
   * checked that is `current`) as failed so they are not installed again
   * until they change, and roll back to the release this proven reconciler
   * ships in, a known-good owner.
   */
  async replaceReconciler(config, current) {
    const resumed = await this.resumePending(current);
    if (resumed) return resumed;
    const self = this.selfRelease();
    const failedRelease = this.state.current;
    const drained = await this.probes.drain(config);
    if (!drained.drained) return { result: "drain_timeout", release: self, from: failedRelease, unfinished: drained.unfinished };
    this.log("reconciler_failed", { release: failedRelease, fallback: self });
    if (current.manifest) {
      this.markFailed(desiredKey(current.manifest), { stage: "reconciler", release: failedRelease,
        reason: "its reconciler never ran after its swap; the fallback reconciler rolled it back" });
    }
    const rolled = await this.rollbackTo(self, "reconciler");
    return { result: rolled.ok ? "rolled_back" : "failed", release: self, from: failedRelease, stage: "reconciler",
      detail: rolled.ok ? "" : rolled.detail };
  }

  /** Report a drain that keeps timing out as a failure, so the unit shows it. */
  escalateDrain(outcome) {
    if (outcome.result !== "drain_timeout") {
      this.state.drain_timeouts = 0;
      return outcome;
    }
    this.state.drain_timeouts += 1;
    if (this.state.drain_timeouts < AGENT_RELEASE_LIMITS.drainStuckRuns) return outcome;
    this.log("drain_stuck", { runs: this.state.drain_timeouts, unfinished: outcome.unfinished ?? "unknown" });
    return { ...outcome, result: "drain_stuck", consecutive: this.state.drain_timeouts };
  }

  /**
   * Finish what an earlier run left half done: a rollback swapped back but
   * never installed, or an upgrade swapped but never installed. Null when
   * nothing is pending. `resumed` marks the outcome: finishing another run's
   * swap proves nothing about this reconciler's upgrade path.
   */
  async resumePending(current) {
    const pending = this.state.rolling_back_to;
    if (pending && current?.id === pending) {
      this.log("resume_rollback", { release: pending });
      const rolled = await this.settleRollback(pending);
      return { result: rolled.ok ? "rolled_back" : "failed", release: pending, stage: "resume_rollback", resumed: true,
        detail: rolled.ok ? "" : rolled.detail };
    }
    this.state.rolling_back_to = "";
    if (!this.interruptedSwap(current)) return null;
    this.log("resume", { release: current.id });
    const outcome = await this.completeSwap(current.id, current.manifest ? desiredKey(current.manifest) : "",
      this.releaseExists(this.state.known_good) ? this.state.known_good : "");
    return { ...outcome, resumed: true };
  }

  /**
   * One reconcile pass.
   * @param {{ retry?: boolean, fallback?: string }} [options] fallback: the
   *   fallback release, when the fallback unit runs this pass on `current`'s behalf
   */
  async reconcile(config, sha, { retry = false, fallback = "" } = {}) {
    const current = this.readCurrent();
    const resumed = await this.resumePending(current);
    if (resumed) return resumed;
    const health = current ? await this.probes.health(3) : null;
    this.adopt(current, health);
    if (!config.sourceRepo) {
      demand(!sha, "release.env names no source repository (POSSE_RELEASE_SOURCE_REPO)", "invalid_request");
      return (await this.remediate(current, health)) || { result: "unconfigured", release: current?.id || "" };
    }
    let desired;
    try { desired = await this.resolveDesired(config, sha); }
    catch (error) {
      return (await this.remediate(current, health)) || { result: "failed", stage: "resolve", detail: errorText(error) };
    }
    const key = desiredKey(desired);
    if (current && sameInputs(current.manifest, desired)) {
      return (await this.remediate(current, health)) || { result: "noop", release: current.id };
    }
    const failure = this.state.failed[key];
    let smokeAttempts = 0;
    if (failure && retry) {
      this.log("retry", { release: releaseIdFor(desired), stage: failure.stage });
      delete this.state.failed[key];
    } else if (failure) {
      const hold = failureHold(failure, this.host.now(), { fallback });
      if (hold.blocks) {
        return (await this.remediate(current, health)) || { result: "skipped_failed", release: releaseIdFor(desired),
          detail: failure.reason, ...(hold.retryAtMs === null ? {} : { retry_at: iso(hold.retryAtMs) }) };
      }
      smokeAttempts = Number(failure.attempts) || 0;
      // A fallback run tries inputs another reconciler failed, once; or a
      // transient smoke failure's wait is over.
      if (hold.fallbackRetry) this.log("fallback_retry", { release: releaseIdFor(desired), stage: failure.stage, by: failure.by || "" });
      else this.log("retry_transient", { release: releaseIdFor(desired), attempt: smokeAttempts + 1, failure_class: failure.failure_class });
      delete this.state.failed[key];
    }
    const outcome = await this.upgrade(config, desired, current, { smokeAttempts });
    if (["stage_failed", "smoke_failed", "drain_timeout"].includes(outcome.result) && health && !health.healthy) {
      const repaired = await this.remediate(current, health);
      if (repaired) outcome.remediation = repaired.result;
    }
    return outcome;
  }

  /** What a run would do, without staging, swapping or recording anything. */
  async plan(config, sha, { retry = false } = {}) {
    // In memory only: a dry run never writes state.
    this.state = this.readState();
    const current = this.readCurrent();
    const health = current ? await this.probes.health(1) : null;
    const base = { ok: true, result: "dry_run", current: current?.id || "", healthy: health?.healthy ?? false };
    if (current && this.state.rolling_back_to === current.id) return { ...base, plan: "finish_rollback", release: current.id };
    if (this.interruptedSwap(current)) return { ...base, plan: "finish_install", release: current.id };
    this.adopt(current, health);
    const repair = this.repairPlan(current, health).action;
    const unlessRepair = plan => (repair === "ok" ? plan : repair);
    if (!config.sourceRepo) return { ...base, plan: unlessRepair("unconfigured") };
    const desired = await this.resolveDesired(config, sha);
    const key = desiredKey(desired);
    const plan = current && sameInputs(current.manifest, desired) ? unlessRepair("noop")
      : failureHold(this.state.failed[key], this.host.now()).blocks && !retry ? unlessRepair("skip_failed") : "install";
    let release = releaseIdFor(desired);
    // Both names already hold other inputs: the real run fails staging.
    try { release = this.stager(config).placement(desired).id; } catch { /* report the plain id */ }
    return { ...base, plan, ...(repair === "ok" ? {} : { repair }), release, desired: { sha: desired.sha,
      products: desired.products.map(({ product, version, arch, sha256 }) => ({ product, version, arch, sha256 })) } };
  }

  /**
   * `posse agent service update --system [--sha REV] [--retry] [--dry-run] [--fallback]`.
   *
   * @param {{ sha?: string, dryRun?: boolean, retry?: boolean, fallback?: boolean }} [options]
   *   retry: forget a recorded failure of the resolved inputs and try them
   *   again; fallback: the run comes from the fallback unit
   */
  async update({ sha = "", dryRun = false, retry = false, fallback = false } = {}) {
    // First, always: the pre-swap self-check of every newer release relies on this refusal.
    demand(this.host.platform === "linux" && this.host.getuid() === 0, AGENT_RELEASE_ROOT_REFUSAL, "forbidden");
    demand(!sha || /^[0-9a-fA-F]{7,40}$/.test(sha), "--sha must be a hexadecimal commit id", "invalid_request");
    demand(this.runsReleaseNode(), `Run the reconciler with ${this.paths.node}; install() pins the owner to the running Node`, "forbidden");
    const config = this.loadConfig();
    this.ensurePrivateDir(this.paths.stateDir);
    if (dryRun) return this.plan(config, sha.toLowerCase(), { retry });
    const unlock = this.acquireLock();
    if (!unlock) {
      this.log("result", { result: "busy" });
      return { ok: true, result: "busy" };
    }
    try {
      this.state = this.readState();
      const self = this.selfRelease();
      const startedOn = this.currentId();
      // The fallback unit runs only after the reconcile service failed.
      const action = fallback ? fallbackRunAction({ self, current: startedOn, state: this.state }) : "reconcile";
      if (action === "idle") {
        // Recording nothing keeps the failure that started this run as the last result.
        this.log("result", { result: "fallback_idle", release: self, current: startedOn });
        return { ok: true, result: "fallback_idle", release: self, current: startedOn };
      }
      this.recordRunStart(self);
      let outcome;
      try {
        outcome = action === "replace" ? await this.replaceReconciler(config, this.readCurrent())
          : await this.reconcile(config, sha.toLowerCase(), { retry, fallback: fallback ? self : "" });
      } catch (error) { outcome = { result: "failed", detail: errorText(error) }; }
      outcome = this.escalateDrain(outcome);
      if (fallback) outcome = { ...outcome, fallback: true };
      const at = iso(this.host.now());
      try { this.recordReconcilerRun({ self, outcome, at }); }
      catch (error) { this.log("fallback_failed", { detail: errorText(error) }); }
      try { this.prune(config); } catch (error) { this.log("prune_failed", { detail: errorText(error) }); }
      const recorded = { ...outcome, at };
      this.state = recordRunResult(this.state, recorded);
      this.writeState();
      this.log("result", recorded);
      return { ok: AGENT_RELEASE_RESULTS[recorded.result]?.ok === true, ...recorded };
    } finally { unlock(); }
  }

  /** Release state for `service status --system`. */
  status() {
    if (this.host.platform !== "linux" || this.host.getuid() !== 0) return { readable: false, reason: "release state is root only" };
    try {
      const state = this.readState();
      const current = this.readCurrent();
      return { readable: true, current: current?.id || "", current_sha: current?.manifest?.sha || "",
        current_products: current?.manifest?.products || [], known_good: state.known_good,
        previous_known_good: state.previous_known_good, fallback: this.readReleaseLink(this.paths.fallback)?.id || "",
        rolling_back_to: state.rolling_back_to, swapped_at: state.swapped_at, drain_timeouts: state.drain_timeouts,
        reconciler_runs: state.reconciler_runs,
        last_result: state.last_result, last_failure: state.last_failure,
        failed_inputs: Object.entries(state.failed).map(([key, failure]) => ({ key, ...failure })) };
    } catch (error) { return { readable: false, reason: errorText(error) }; }
  }
}
