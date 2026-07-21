// @ts-check

import fs from "fs";
import path from "path";
import { ScipLanguageEnvironmentInstaller } from "../ScipLanguageEnvironmentInstaller.js";
import {
  commandOnPath,
  commandOnPathSync,
  runCommand,
} from "../../functions/scip-install-runtime.js";

const SCIP_CLANG_VERSION = "v0.4.0";

export class ClangScipEnvironmentInstaller extends ScipLanguageEnvironmentInstaller {
  get language() {
    return "clang";
  }

  get commandSegments() {
    return ["scip", "bin"];
  }

  get binDir() {
    return path.join(this.posseRoot, "scip", "bin");
  }

  installPlan() {
    return this.platform === "win32"
      ? ["check scip-clang", "skip unsupported Windows build"]
      : ["check scip-clang", "check curl", "prepare Posse scip/bin", "download scip-clang", "validate scip-clang"];
  }

  async install() {
    const found = await this.resolveInstalledCommand();
    const existing = await this.runStep(1, "check scip-clang", async () => {
      if (this.force || !found) return null;
      return this.ok("ok", "scip-clang already installed");
    });
    if (existing?.ok === true || existing?.ok === false) return existing;

    if (this.platform === "win32") {
      return await this.runStep(2, "skip unsupported Windows build", async () => ({
        language: "clang",
        ok: true,
        status: "skipped",
        message: "scip-clang has no Windows build; C/C++ SCIP stays off (use WSL or atlas_scip_index_command)",
      }));
    }

    if (this.dryRun) {
      return await this.runStep(4, "download scip-clang", async () => (
        this.ok("dry-run", `would download scip-clang ${SCIP_CLANG_VERSION} into ${this.binDir}`)
      ));
    }

    const curl = await this.runStep(2, "check curl", async () => {
      if (!(await commandOnPath("curl"))) {
        return this.failed("curl not found; install curl or place scip-clang on PATH / in Posse scip/bin");
      }
      return this.ok("ok", "curl present");
    });
    if (curl?.ok === false) return curl;

    const prepared = await this.runStep(3, "prepare Posse scip/bin", async () => {
      await fs.promises.mkdir(this.binDir, { recursive: true });
      return this.ok("ok", `prepared ${this.binDir}`);
    });
    if (prepared?.ok === false) return prepared;

    const downloaded = await this.runStep(4, "download scip-clang", async () => {
      return await this.downloadClang();
    });
    if (downloaded?.ok === false) return downloaded;

    return await this.runStep(5, "validate scip-clang", async () => {
      const dest = path.join(this.binDir, "scip-clang");
      const probe = await runCommand(dest, ["--version"], { timeoutMs: 30_000 });
      if (!probe.ok) {
        await unlinkIfExists(dest);
        return this.failed(`downloaded scip-clang failed its --version probe: ${probe.message}`);
      }
      return this.ok("installed", `installed scip-clang ${SCIP_CLANG_VERSION}`);
    });
  }

  status() {
    return this.statusSync();
  }

  statusSync() {
    const found = this.findCommandPath(this.commandSegments, "scip-clang")
      || (commandOnPathSync("scip-clang") ? "scip-clang" : null);
    if (found) return this.ok("ok", "installed");
    if (this.platform === "win32") {
      return {
        language: "clang",
        ok: true,
        status: "skipped",
        message: "scip-clang has no Windows build (WSL or atlas_scip_index_command)",
      };
    }
    return this.failed(`missing scip-clang (PATH or ${this.expectedCommandPath(this.commandSegments, "scip-clang")}); posse doctor installs it`);
  }

  async resolveInstalledCommand() {
    return this.findCommandPath(this.commandSegments, "scip-clang")
      || (await commandOnPath("scip-clang") ? "scip-clang" : null);
  }

  releaseAssetCandidates() {
    const arch = this.arch === "arm64" ? "arm64" : "x86_64";
    const os = this.platform === "darwin" ? "darwin" : "linux";
    return [`scip-clang-${arch}-${os}`, `scip-clang-${os}-${arch}`];
  }

  async downloadClang() {
    const dest = path.join(this.binDir, "scip-clang");
    const tmpDest = `${dest}.download`;
    const errors = [];
    for (const asset of this.releaseAssetCandidates()) {
      const url = `https://github.com/sourcegraph/scip-clang/releases/download/${SCIP_CLANG_VERSION}/${asset}`;
      const run = await runCommand("curl", ["-fsSL", "--retry", "2", "-o", tmpDest, url], { timeoutMs: this.timeoutMs });
      if (!run.ok) {
        errors.push(`${asset}: ${run.message || "download failed"}`);
        await unlinkIfExists(tmpDest);
        continue;
      }
      await fs.promises.rename(tmpDest, dest);
      await fs.promises.chmod(dest, 0o755);
      return this.ok("installed", `downloaded scip-clang ${SCIP_CLANG_VERSION}`);
    }
    return this.failed(
      `scip-clang ${SCIP_CLANG_VERSION} download failed (${errors.join("; ")}); download manually from https://github.com/sourcegraph/scip-clang/releases into ${this.binDir}`,
    );
  }
}

async function unlinkIfExists(file) {
  try { await fs.promises.unlink(file); } catch { /* best effort */ }
}
