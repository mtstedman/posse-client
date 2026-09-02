// @ts-check

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { pipeline } from "stream/promises";
import { ScipLanguageEnvironmentInstaller } from "../ScipLanguageEnvironmentInstaller.js";
import {
  commandOnPath,
  commandOnPathSync,
  runCommand,
} from "../../functions/scip-install-runtime.js";

const SCIP_CLANG_VERSION = "v0.4.0";
const SCIP_CLANG_MAX_BYTES = 200 * 1024 * 1024;
export const SCIP_CLANG_SHA256 = Object.freeze({
  "scip-clang-arm64-darwin": "ff042fbc8a029f09f4b69fc7692e290e21c52923593207ee52d4e7439473ec64",
  "scip-clang-x86_64-linux": "06fd18c576f979a726c651594644ec4a35db4f471f2160b3f72eb89fa6001784",
});

export class ClangScipEnvironmentInstaller extends ScipLanguageEnvironmentInstaller {
  get language() {
    return "clang";
  }

  get commandSegments() {
    return ["scip", "bin"];
  }

  get binDir() {
    return path.join(this.installRoot, "scip", "bin");
  }

  installPlan() {
    return this.platform === "win32"
      ? ["check scip-clang", "skip unsupported Windows build"]
      : ["check scip-clang", "check curl", "prepare Posse scip/bin", "download scip-clang", "validate scip-clang"];
  }

  async install() {
    const found = await this.resolveInstalledCommand();
    const reuseExisting = !this.force && Boolean(found);
    const totalSteps = reuseExisting
      ? 1
      : (this.platform === "win32" || this.dryRun ? 2 : this.installPlan().length);
    const existing = await this.runStep(1, "check scip-clang", async () => {
      if (!reuseExisting) return null;
      return this.ok("ok", "scip-clang already installed");
    }, { totalSteps });
    if (existing?.ok === true || existing?.ok === false) return existing;

    if (this.platform === "win32") {
      return await this.runStep(2, "skip unsupported Windows build", async () => ({
        language: "clang",
        ok: true,
        status: "skipped",
        message: "scip-clang has no Windows build; C/C++ SCIP stays off (use WSL or atlas_scip_index_command)",
      }), { totalSteps });
    }

    if (this.dryRun) {
      return await this.runStep(2, "download scip-clang", async () => (
        this.ok("dry-run", `would download scip-clang ${SCIP_CLANG_VERSION} into ${this.binDir}`)
      ), { totalSteps });
    }

    const curl = await this.runStep(2, "check curl", async () => {
      if (!(await commandOnPath("curl"))) {
        return this.failed("curl not found; install curl or place scip-clang on PATH / in Posse scip/bin");
      }
      return this.ok("ok", "curl present");
    }, { totalSteps });
    if (curl?.ok === false) return curl;

    const prepared = await this.runStep(3, "prepare Posse scip/bin", async () => {
      await fs.promises.mkdir(this.binDir, { recursive: true });
      return this.ok("ok", `prepared ${this.binDir}`);
    }, { totalSteps });
    if (prepared?.ok === false) return prepared;

    const downloaded = await this.runStep(4, "download scip-clang", async () => {
      return await this.downloadClang();
    }, { totalSteps });
    if (downloaded?.ok === false) return downloaded;

    return await this.runStep(5, "validate scip-clang", async () => {
      const dest = path.join(this.binDir, "scip-clang");
      const probe = await runCommand(dest, ["--version"], { timeoutMs: 30_000 });
      if (!probe.ok) {
        await unlinkIfExists(dest);
        return this.failed(`downloaded scip-clang failed its --version probe: ${probe.message}`);
      }
      return this.ok("installed", `installed scip-clang ${SCIP_CLANG_VERSION}`);
    }, { totalSteps });
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
      const expectedSha256 = SCIP_CLANG_SHA256[asset];
      if (!expectedSha256) {
        errors.push(`${asset}: no pinned checksum is available`);
        continue;
      }
      const url = `https://github.com/sourcegraph/scip-clang/releases/download/${SCIP_CLANG_VERSION}/${asset}`;
      const run = await runCommand("curl", [
        "-fsSL", "--retry", "2", "--max-filesize", String(SCIP_CLANG_MAX_BYTES),
        "-o", tmpDest, url,
      ], { timeoutMs: this.timeoutMs });
      if (!run.ok) {
        errors.push(`${asset}: ${run.message || "download failed"}`);
        await unlinkIfExists(tmpDest);
        continue;
      }
      const stat = await fs.promises.stat(tmpDest).catch(() => null);
      if (!stat || stat.size <= 0 || stat.size > SCIP_CLANG_MAX_BYTES) {
        errors.push(`${asset}: downloaded binary size is outside the allowed range`);
        await unlinkIfExists(tmpDest);
        continue;
      }
      let actualSha256;
      try {
        actualSha256 = await sha256File(tmpDest);
      } catch (err) {
        errors.push(`${asset}: checksum failed: ${err?.message || err}`);
        await unlinkIfExists(tmpDest);
        continue;
      }
      if (actualSha256 !== expectedSha256) {
        errors.push(`${asset}: SHA-256 checksum mismatch`);
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

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

async function unlinkIfExists(file) {
  try { await fs.promises.unlink(file); } catch { /* best effort */ }
}
