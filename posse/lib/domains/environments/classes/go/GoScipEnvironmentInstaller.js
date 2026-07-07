// @ts-check

import fs from "fs";
import path from "path";
import { ScipLanguageEnvironmentInstaller } from "../ScipLanguageEnvironmentInstaller.js";
import {
  commandOnPath,
  runCommand,
  scipDependencyInstallEnv,
} from "../../functions/scip-install-runtime.js";

export class GoScipEnvironmentInstaller extends ScipLanguageEnvironmentInstaller {
  get language() {
    return "go";
  }

  get commandSegments() {
    return ["scip", "bin"];
  }

  get binDir() {
    return path.join(this.posseRoot, "scip", "bin");
  }

  installPlan() {
    return [
      "check scip-go",
      "check Go toolchain",
      "prepare Posse scip/bin",
      "run go install",
      "validate scip-go",
    ];
  }

  async install() {
    const existing = await this.runStep(1, "check scip-go", async () => {
      const command = this.findCommandPath(this.commandSegments, "scip-go");
      if (this.force || !command) return null;
      return this.ok("ok", "scip-go already installed");
    });
    if (existing?.ok === true || existing?.ok === false) return existing;

    if (this.dryRun) {
      return await this.runStep(4, "run go install", async () => (
        this.ok("dry-run", `would run go install github.com/scip-code/scip-go/cmd/scip-go@latest with GOBIN=${this.binDir}`)
      ));
    }

    const toolchain = await this.runStep(2, "check Go toolchain", async () => {
      if (!(await commandOnPath("go"))) {
        return this.failed("Go toolchain not found on PATH; install Go or deselect Go in atlas_scip_languages");
      }
      return this.ok("ok", "Go toolchain present");
    });
    if (toolchain?.ok === false) return toolchain;

    const prepared = await this.runStep(3, "prepare Posse scip/bin", async () => {
      await fs.promises.mkdir(this.binDir, { recursive: true });
      return this.ok("ok", `prepared ${this.binDir}`);
    });
    if (prepared?.ok === false) return prepared;

    const install = await this.runStep(4, "run go install", async () => {
      const run = await runCommand("go", ["install", "github.com/scip-code/scip-go/cmd/scip-go@latest"], {
        env: { ...scipDependencyInstallEnv(), GOBIN: this.binDir },
        timeoutMs: this.timeoutMs,
      });
      if (!run.ok) return this.failed(`go install failed: ${run.message}`);
      return this.ok("installed", "installed scip-go");
    });
    if (install?.ok === false) return install;

    return await this.runStep(5, "validate scip-go", async () => {
      if (!this.findCommandPath(this.commandSegments, "scip-go")) {
        return this.failed("go install completed, but scip-go was not found in Posse scip/bin");
      }
      return this.ok("installed", "installed scip-go");
    });
  }

  status() {
    return this.statusForInstalledCommand(this.commandSegments, "scip-go");
  }
}
