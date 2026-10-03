// @ts-check

import fs from "fs";
import path from "path";
import { ScipLanguageEnvironmentInstaller } from "../ScipLanguageEnvironmentInstaller.js";
import {
  commandOnPath,
  composerBin,
  fileExists,
  runCommand,
} from "../../functions/scip-install-runtime.js";
import {
  PHP_SCIP_ENV_INPUTS,
  PHP_SCIP_TRACKS,
  PHP_SCIP_TRACK_ORDER,
  describePhpScipSelection,
  parsePhpCliVersion,
  phpScipEnvInputHash,
  phpScipUpstreamCommand,
  readPhpScipEnvStamp,
  removePhpScipEnvStamp,
  resolvePhpScipRuntime,
  selectPhpScipTrack,
  writePhpScipEnvStamp,
} from "../../functions/php-scip-tracks.js";

/** @typedef {import("../../functions/php-scip-tracks.js").PhpScipTrackId} PhpScipTrackId */

export class PhpScipEnvironmentInstaller extends ScipLanguageEnvironmentInstaller {
  get language() {
    return "php";
  }

  /** @param {PhpScipTrackId} [track] */
  commandSegmentsFor(track = "modern") {
    return ["scip", PHP_SCIP_TRACKS[track].dir, "vendor", "bin"];
  }

  get commandSegments() {
    return this.commandSegmentsFor("modern");
  }

  /** @param {PhpScipTrackId} [track] */
  trackDir(track = "modern") {
    return path.join(this.installRoot, "scip", PHP_SCIP_TRACKS[track].dir);
  }

  /** @param {PhpScipTrackId} [track] */
  sourceTrackDir(track = "modern") {
    return path.join(this.posseRoot, "scip", PHP_SCIP_TRACKS[track].dir);
  }

  get phpDir() {
    return this.trackDir("modern");
  }

  get sourcePhpDir() {
    return this.sourceTrackDir("modern");
  }

  /** @param {PhpScipTrackId} [track] */
  async preparePackageRoot(track = "modern") {
    const target = this.trackDir(track);
    const source = this.sourceTrackDir(track);
    if (target === source || this.dryRun) return;
    await fs.promises.mkdir(target, { recursive: true });
    for (const name of PHP_SCIP_ENV_INPUTS) {
      await fs.promises.copyFile(path.join(source, name), path.join(target, name));
    }
  }

  installPlan() {
    return [
      "select scip-php track and check its Composer package root",
      "check scip-php",
      "resolve Composer",
      "run composer install",
      "validate scip-php",
    ];
  }

  /**
   * @returns {Promise<string | null>}
   */
  async detectPhpVersion() {
    if (!(await commandOnPath("php"))) return null;
    // `php -v` needs no quoting through Windows .cmd/.bat shims.
    const probe = await runCommand("php", ["-v"], { timeoutMs: 30_000 });
    return probe.ok ? parsePhpCliVersion(probe.message) : null;
  }

  async install() {
    const selection = selectPhpScipTrack(await this.detectPhpVersion());
    const track = selection.track;
    const reuse = track ? this.reuseDecision(track) : null;
    const totalSteps = !reuse ? 1 : reuse.reuse ? 2 : (this.dryRun ? 3 : this.installPlan().length);

    const manifest = await this.runStep(1, `select ${describePhpScipSelection(selection)}`, async () => {
      if (!track) {
        const message = `${selection.reason}; SCIP PHP indexing needs PHP 8.1+ (8.3+ runs the current scip-php)`;
        return this.dryRun ? this.ok("dry-run", `would install scip-php once PHP is available: ${message}`) : this.failed(message);
      }
      const sourceComposerJson = path.join(this.sourceTrackDir(track), "composer.json");
      if (!fs.existsSync(sourceComposerJson)) return this.failed(`missing ${sourceComposerJson}`);
      if (!reuse?.inputHash) {
        return this.failed(`missing Composer inputs in ${this.sourceTrackDir(track)} (${PHP_SCIP_ENV_INPUTS.join(", ")})`);
      }
      await this.preparePackageRoot(track);
      const composerJson = path.join(this.trackDir(track), "composer.json");
      if (!this.dryRun && !fs.existsSync(composerJson)) return this.failed(`missing ${composerJson}`);
      return this.ok("ok", "managed Composer package root present");
    }, { totalSteps });
    if (manifest?.ok === false || !track || !reuse) return manifest;

    const existing = await this.runStep(2, `check scip-php ${track} track (${reuse.reason})`, async () => {
      if (!reuse.reuse) return null;
      if (!this.dryRun) this.unstampOtherTracks(track);
      return this.ok("ok", `scip-php ${track} track already installed (${selection.reason})`);
    }, { totalSteps });
    if (existing?.ok === true || existing?.ok === false) return existing;

    const envDir = this.trackDir(track);
    if (this.dryRun) {
      return await this.runStep(3, "run composer install", async () => (
        this.ok("dry-run", `would run composer install in ${envDir} (scip-php ${track} track: ${reuse.reason})`)
      ), { totalSteps });
    }

    const composer = await this.runStep(3, "resolve Composer", async () => {
      const resolved = await this.composerCommand();
      if (!resolved) return this.failed("PHP/Composer not found; install PHP CLI or composer, then retry");
      return resolved;
    }, { totalSteps });
    if (!composer || !("command" in composer)) {
      if (composer && "language" in composer) return composer;
      return this.failed("Composer resolution returned an invalid command");
    }

    const install = await this.runStep(4, "run composer install", async () => {
      // A half-finished reinstall must not keep claiming the old identity.
      removePhpScipEnvStamp(envDir);
      const run = await runCommand(composer.command, [
        ...composer.args,
        "install",
        "--no-interaction",
        "--no-progress",
        "--no-ansi",
      ], {
        cwd: envDir,
        timeoutMs: this.timeoutMs,
      });
      if (!run.ok) {
        // 7-Zip refuses the symlinks in scip-php's archive; Composer only
        // falls back to PHP's ZipArchive when the zip extension is loaded.
        const hint = /Dangerous link path/iu.test(run.message)
          ? " (7-Zip cannot unpack scip-php's archive: enable PHP's zip extension, extension=zip in php.ini, so Composer can use ZipArchive)"
          : "";
        return this.failed(`composer install failed: ${run.message}${hint}`);
      }
      return this.ok("installed", `installed scip-php ${track} track`);
    }, { totalSteps });
    if (install?.ok === false) return install;

    return await this.runStep(5, "validate scip-php", async () => {
      if (!fileExists(phpScipUpstreamCommand(envDir))) {
        return this.failed(`composer install completed, but ${phpScipUpstreamCommand(envDir)} was not found`);
      }
      writePhpScipEnvStamp(envDir, {
        track,
        inputHash: /** @type {string} */ (reuse.inputHash),
        phpVersion: selection.phpVersion,
      });
      this.unstampOtherTracks(track);
      return this.ok("installed", `installed scip-php ${track} track (${selection.reason})`);
    }, { totalSteps });
  }

  /**
   * Reinstall unless the environment carries a stamp for this track whose
   * input hash matches the shipped composer.json/composer.lock/patch script.
   *
   * @param {PhpScipTrackId} track
   * @returns {{ reuse: boolean, reason: string, inputHash: string | null }}
   */
  reuseDecision(track) {
    const inputHash = phpScipEnvInputHash(this.sourceTrackDir(track));
    const envDir = this.trackDir(track);
    if (this.force) return { reuse: false, reason: "forced reinstall", inputHash };
    if (!fileExists(phpScipUpstreamCommand(envDir))) return { reuse: false, reason: "not installed", inputHash };
    const stamp = readPhpScipEnvStamp(envDir);
    if (!stamp) return { reuse: false, reason: "no install stamp; reinstalling", inputHash };
    if (stamp.track !== track) return { reuse: false, reason: `stamped for the ${stamp.track} track; reinstalling`, inputHash };
    if (!inputHash || stamp.input_hash !== inputHash) {
      return { reuse: false, reason: "Composer inputs changed; reinstalling", inputHash };
    }
    return { reuse: true, reason: "install stamp current", inputHash };
  }

  /** @param {PhpScipTrackId} track */
  unstampOtherTracks(track) {
    for (const other of PHP_SCIP_TRACK_ORDER) {
      if (other !== track) removePhpScipEnvStamp(this.trackDir(other));
    }
  }

  status() {
    const runtime = resolvePhpScipRuntime({ scipRoots: [path.join(this.installRoot, "scip")] });
    if (!runtime) return this.failed(`missing ${this.expectedCommandPath(this.commandSegments, "scip-php")}`);
    const current = phpScipEnvInputHash(this.sourceTrackDir(runtime.track));
    if (!runtime.stamp || runtime.stamp.input_hash !== current) {
      return {
        language: this.language,
        ok: false,
        status: "needs-install",
        message: `scip-php ${runtime.track} track is out of date; posse doctor reinstalls it`,
      };
    }
    const php = runtime.stamp.php_version ? ` for PHP ${runtime.stamp.php_version}` : "";
    return this.ok("ok", `scip-php ${runtime.track} track installed${php}`);
  }

  async composerCommand() {
    if (await commandOnPath("composer")) return { command: composerBin(this.platform), args: [] };
    if (!(await commandOnPath("php"))) return null;
    const phar = path.join(this.installRoot, "scip", "bin", "composer.phar");
    if (!fileExists(phar)) return null;
    return { command: "php", args: [phar] };
  }
}
