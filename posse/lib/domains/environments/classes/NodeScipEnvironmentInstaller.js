// @ts-check

import fs from "fs";
import path from "path";
import { ScipLanguageEnvironmentInstaller } from "./ScipLanguageEnvironmentInstaller.js";
import {
  npmCommand,
  runCommand,
} from "../functions/scip-install-runtime.js";

export class NodeScipEnvironmentInstaller extends ScipLanguageEnvironmentInstaller {
  get installKey() {
    return "scip:node";
  }

  get nodeDir() {
    return path.join(this.posseRoot, "scip", "node");
  }

  get commandSegments() {
    return ["scip", "node", "node_modules", ".bin"];
  }

  get commandName() {
    return "scip-node";
  }

  installPlan() {
    return [
      "check managed Node package root",
      `check ${this.commandName}`,
      "run npm install",
      `validate ${this.commandName}`,
    ];
  }

  async install() {
    const packageJson = path.join(this.nodeDir, "package.json");
    const manifest = await this.runStep(1, "check managed Node package root", async () => {
      if (!fs.existsSync(packageJson)) return this.failed(`missing ${packageJson}`);
      return this.ok("ok", "managed Node package root present");
    });
    if (manifest?.ok === false) return manifest;

    const existing = await this.runStep(2, `check ${this.commandName}`, async () => {
      const command = this.findCommandPath(this.commandSegments, this.commandName);
      if (this.force || !command) return null;
      const validation = await this.validateCommand();
      if (!validation.ok) return this.failed(validation.message);
      return this.ok("ok", `${this.commandName} already installed`);
    });
    if (existing?.ok === false) return existing;
    if (existing?.ok === true) return existing;

    const install = await this.runStep(3, "run npm install", async () => {
      const args = ["install", "--include=optional", "--no-save"];
      if (this.dryRun) return this.ok("dry-run", `would run ${["npm", ...args].join(" ")} in ${this.nodeDir}`);
      const run = await runCommand(npmCommand(this.platform), args, {
        cwd: this.nodeDir,
        timeoutMs: this.timeoutMs,
      });
      if (!run.ok) return this.failed(`npm install failed: ${run.message}`);
      return this.ok("installed", "installed SCIP Node indexers");
    });
    if (install?.ok === false || install?.status === "dry-run") return install;

    const validation = await this.runStep(4, `validate ${this.commandName}`, async () => {
      const result = await this.validateCommand();
      if (!result.ok) return this.failed(result.message);
      return this.ok("installed", `installed ${this.commandName}`);
    });
    return validation;
  }

  status() {
    return this.statusForInstalledCommand(this.commandSegments, this.commandName);
  }

  async validateCommand() {
    const command = this.findCommandPath(this.commandSegments, this.commandName);
    if (!command) {
      return {
        ok: false,
        message: `SCIP Node indexer validation failed: ${this.language}: missing ${this.expectedCommandPath(this.commandSegments, this.commandName)}`,
      };
    }
    const probe = await runCommand(command, ["--version"], { timeoutMs: 30_000 });
    if (!probe.ok) {
      return {
        ok: false,
        message: `SCIP Node indexer validation failed: ${this.language}: ${this.commandName} validation failed: ${probe.message}`,
      };
    }
    return { ok: true, message: "" };
  }
}
