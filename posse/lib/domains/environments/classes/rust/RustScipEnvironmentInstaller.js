// @ts-check

import fs from "fs";
import path from "path";
import { ScipLanguageEnvironmentInstaller } from "../ScipLanguageEnvironmentInstaller.js";
import {
  clearCommandOnPathCache,
  commandOnPath,
  fileExists,
  runCommand,
} from "../../functions/scip-install-runtime.js";

export class RustScipEnvironmentInstaller extends ScipLanguageEnvironmentInstaller {
  get language() {
    return "rust";
  }

  get commandSegments() {
    return ["scip", "bin"];
  }

  get binDir() {
    return path.join(this.posseRoot, "scip", "bin");
  }

  installPlan() {
    return [
      "check scip-rust wrapper",
      "check Rust toolchain",
      "validate rust-analyzer",
      "prepare Posse scip/bin",
      "write scip-rust wrapper",
    ];
  }

  async install() {
    const existing = await this.runStep(1, "check scip-rust wrapper", async () => {
      const wrapper = this.commandPath(this.commandSegments, "scip-rust");
      if (this.force || !fileExists(wrapper)) return null;
      if (this.dryRun) return this.ok("ok", "scip-rust wrapper present");
      const validation = await this.validateRustAnalyzer();
      if (!validation.ok) return this.failed(`scip-rust wrapper exists, but ${validation.message}`);
      return this.ok("ok", "scip-rust wrapper already installed");
    });
    if (existing?.ok === true || existing?.ok === false) return existing;

    if (this.dryRun) {
      return await this.runStep(5, "write scip-rust wrapper", async () => (
        this.ok("dry-run", `would install rust-analyzer if needed and write scip-rust wrapper in ${this.binDir}`)
      ));
    }

    const toolchain = await this.runStep(2, "check Rust toolchain", async () => {
      if (!(await commandOnPath("cargo")) || !(await commandOnPath("rustc"))) {
        return this.failed("Rust toolchain not found on PATH; install Rust or deselect Rust in atlas_scip_languages");
      }
      return this.ok("ok", "Rust toolchain present");
    });
    if (toolchain?.ok === false) return toolchain;

    const analyzer = await this.runStep(3, "validate rust-analyzer", async () => {
      const validation = await this.validateRustAnalyzer();
      if (!validation.ok) return this.failed(validation.message);
      return this.ok("ok", "rust-analyzer available");
    });
    if (analyzer?.ok === false) return analyzer;

    const prepared = await this.runStep(4, "prepare Posse scip/bin", async () => {
      await fs.promises.mkdir(this.binDir, { recursive: true });
      return this.ok("ok", `prepared ${this.binDir}`);
    });
    if (prepared?.ok === false) return prepared;

    return await this.runStep(5, "write scip-rust wrapper", async () => {
      await this.writeRustWrapper();
      return this.ok("installed", "installed scip-rust wrapper");
    });
  }

  status() {
    return this.statusForInstalledCommand(this.commandSegments, "scip-rust");
  }

  async validateRustAnalyzer() {
    let probe = await runCommand("rust-analyzer", ["--version"], { timeoutMs: 30_000 });
    if (!probe.ok && await commandOnPath("rustup")) {
      const install = await runCommand("rustup", ["component", "add", "rust-analyzer"], { timeoutMs: this.timeoutMs });
      clearCommandOnPathCache("rust-analyzer");
      if (!install.ok) {
        return { ok: false, message: `rustup component add rust-analyzer failed: ${install.message}` };
      }
      probe = await runCommand("rust-analyzer", ["--version"], { timeoutMs: 30_000 });
    }
    if (!probe.ok) return { ok: false, message: `rust-analyzer not runnable: ${probe.message}` };
    return { ok: true, message: "" };
  }

  async writeRustWrapper() {
    if (this.platform === "win32") {
      await fs.promises.writeFile(
        path.join(this.binDir, "scip-rust.cmd"),
        [
          "@echo off",
          "rust-analyzer scip %*",
        ].join("\r\n"),
        "utf8",
      );
      return;
    }
    const file = path.join(this.binDir, "scip-rust");
    await fs.promises.writeFile(file, "#!/usr/bin/env sh\nexec rust-analyzer scip \"$@\"\n", "utf8");
    await fs.promises.chmod(file, 0o755);
  }
}
