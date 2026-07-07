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

export class PhpScipEnvironmentInstaller extends ScipLanguageEnvironmentInstaller {
  get language() {
    return "php";
  }

  get commandSegments() {
    return ["scip", "php", "vendor", "bin"];
  }

  get phpDir() {
    return path.join(this.posseRoot, "scip", "php");
  }

  installPlan() {
    return [
      "check managed Composer package root",
      "check scip-php",
      "resolve Composer",
      "run composer install",
      "validate scip-php",
    ];
  }

  async install() {
    const composerJson = path.join(this.phpDir, "composer.json");
    const manifest = await this.runStep(1, "check managed Composer package root", async () => {
      if (!fs.existsSync(composerJson)) return this.failed(`missing ${composerJson}`);
      return this.ok("ok", "managed Composer package root present");
    });
    if (manifest?.ok === false) return manifest;

    const existing = await this.runStep(2, "check scip-php", async () => {
      const command = this.findCommandPath(this.commandSegments, "scip-php");
      if (this.force || !command) return null;
      return this.ok("ok", "scip-php already installed");
    });
    if (existing?.ok === true || existing?.ok === false) return existing;

    if (this.dryRun) {
      return await this.runStep(4, "run composer install", async () => (
        this.ok("dry-run", `would run composer install in ${this.phpDir}`)
      ));
    }

    const composer = await this.runStep(3, "resolve Composer", async () => {
      const resolved = await this.composerCommand();
      if (!resolved) return this.failed("PHP/Composer not found; install PHP CLI or composer, then retry");
      return resolved;
    });
    if (composer?.ok === false) return composer;

    const install = await this.runStep(4, "run composer install", async () => {
      const run = await runCommand(composer.command, [...composer.args, "install"], {
        cwd: this.phpDir,
        timeoutMs: this.timeoutMs,
      });
      if (!run.ok) return this.failed(`composer install failed: ${run.message}`);
      return this.ok("installed", "installed scip-php");
    });
    if (install?.ok === false) return install;

    return await this.runStep(5, "validate scip-php", async () => {
      if (!this.findCommandPath(this.commandSegments, "scip-php")) {
        return this.failed("composer install completed, but scip-php was not found");
      }
      return this.ok("installed", "installed scip-php");
    });
  }

  status() {
    return this.statusForInstalledCommand(this.commandSegments, "scip-php");
  }

  async composerCommand() {
    if (await commandOnPath("composer")) return { command: composerBin(this.platform), args: [] };
    if (!(await commandOnPath("php"))) return null;
    const phar = path.join(this.posseRoot, "scip", "bin", "composer.phar");
    if (!fileExists(phar)) return null;
    return { command: "php", args: [phar] };
  }
}
