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
    return path.join(this.installRoot, "scip", "bin");
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
      // Older wrappers delegated through PATH. That made a successfully
      // installed indexer fail later in scrubbed workers whose PATH differed
      // from the install session. Refresh it with the validated absolute
      // analyzer path whenever dependency setup runs.
      await this.writeRustWrapper(validation.path);
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

    let analyzerPath = null;
    const analyzer = await this.runStep(3, "validate rust-analyzer", async () => {
      const validation = await this.validateRustAnalyzer();
      if (!validation.ok) return this.failed(validation.message);
      analyzerPath = validation.path;
      return this.ok("ok", "rust-analyzer available");
    });
    if (analyzer?.ok === false) return analyzer;

    const prepared = await this.runStep(4, "prepare Posse scip/bin", async () => {
      await fs.promises.mkdir(this.binDir, { recursive: true });
      return this.ok("ok", `prepared ${this.binDir}`);
    });
    if (prepared?.ok === false) return prepared;

    return await this.runStep(5, "write scip-rust wrapper", async () => {
      await this.writeRustWrapper(analyzerPath);
      return this.ok("installed", "installed scip-rust wrapper");
    });
  }

  status() {
    return this.statusForInstalledCommand(this.commandSegments, "scip-rust");
  }

  async validateRustAnalyzer() {
    let analyzerPath = await this.resolveRustAnalyzerPath();
    let probe = analyzerPath
      ? await runCommand(analyzerPath, ["--version"], { timeoutMs: 30_000 })
      : { ok: false, message: "rust-analyzer is not on PATH" };
    if (!probe.ok && await commandOnPath("rustup")) {
      const install = await runCommand("rustup", ["component", "add", "rust-analyzer"], { timeoutMs: this.timeoutMs });
      clearCommandOnPathCache("rust-analyzer");
      if (!install.ok) {
        return { ok: false, message: `rustup component add rust-analyzer failed: ${install.message}` };
      }
      analyzerPath = await this.resolveRustAnalyzerPath();
      probe = analyzerPath
        ? await runCommand(analyzerPath, ["--version"], { timeoutMs: 30_000 })
        : { ok: false, message: "rust-analyzer is not on PATH after rustup install" };
    }
    if (!probe.ok) return { ok: false, message: `rust-analyzer not runnable: ${probe.message}` };
    return { ok: true, message: "", path: analyzerPath };
  }

  async resolveRustAnalyzerPath() {
    const locator = this.platform === "win32" ? "where" : "which";
    const located = await runCommand(locator, ["rust-analyzer"], { timeoutMs: 30_000 });
    if (!located.ok) return null;
    const first = String(located.message || "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
    return first ? path.resolve(first) : null;
  }

  async writeRustWrapper(analyzerPath) {
    if (!analyzerPath || !path.isAbsolute(analyzerPath)) {
      throw new Error("cannot write scip-rust wrapper without an absolute rust-analyzer path");
    }
    if (this.platform === "win32") {
      await fs.promises.writeFile(
        path.join(this.binDir, "scip-rust.cmd"),
        [
          "@echo off",
          `"${String(analyzerPath).replaceAll('"', '""')}" scip %*`,
        ].join("\r\n"),
        "utf8",
      );
      return;
    }
    const file = path.join(this.binDir, "scip-rust");
    const quoted = `'${String(analyzerPath).replaceAll("'", `'"'"'`)}'`;
    await fs.promises.writeFile(file, `#!/usr/bin/env sh\nexec ${quoted} scip "$@"\n`, "utf8");
    await fs.promises.chmod(file, 0o755);
  }
}
