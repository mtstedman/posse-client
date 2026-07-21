// @ts-check

import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { KeyedAsyncGate } from "../../../shared/concurrency/classes/AsyncGate.js";
import { withDependencyInstallLock } from "../../../shared/concurrency/functions/dependency-install-lock.js";
import { normalizeScipLanguages } from "../../atlas/functions/v2/scip/languages.js";
import { EnvironmentInstallHarness } from "./EnvironmentInstallHarness.js";
import { TypeScriptScipEnvironmentInstaller } from "./typescript/TypeScriptScipEnvironmentInstaller.js";
import { PythonScipEnvironmentInstaller } from "./python/PythonScipEnvironmentInstaller.js";
import { PhpScipEnvironmentInstaller } from "./php/PhpScipEnvironmentInstaller.js";
import { GoScipEnvironmentInstaller } from "./go/GoScipEnvironmentInstaller.js";
import { RustScipEnvironmentInstaller } from "./rust/RustScipEnvironmentInstaller.js";
import { ClangScipEnvironmentInstaller } from "./clang/ClangScipEnvironmentInstaller.js";
import {
  DEFAULT_POSSE_ROOT,
  DEFAULT_SCIP_COMMAND_TIMEOUT_MS,
  commandOnPathSync,
  normalizeCommandTimeoutMs,
} from "../functions/scip-install-runtime.js";

const INSTALL_GATE = new KeyedAsyncGate({ name: "scip-language-installs", maxConcurrency: 1 });
const THIS_FILE = fileURLToPath(import.meta.url);

export class ScipLanguageInstallManager {
  /**
   * @param {{
   *   languages?: string[] | string | null,
   *   posseRoot?: string | null,
   *   force?: boolean,
   *   dryRun?: boolean,
   *   timeoutMs?: number | string | boolean | null,
   *   onProgress?: ((message: string) => void) | null,
   *   onEvent?: ((event: Record<string, any>) => void) | null,
   *   platform?: NodeJS.Platform,
   *   arch?: string,
   * }} [input]
   */
  constructor(input = {}) {
    this.posseRoot = path.resolve(String(input.posseRoot || DEFAULT_POSSE_ROOT));
    this.languages = normalizeScipLanguages(input.languages);
    this.force = input.force === true;
    this.dryRun = input.dryRun === true;
    this.timeoutMs = normalizeCommandTimeoutMs(input.timeoutMs, DEFAULT_SCIP_COMMAND_TIMEOUT_MS);
    this.platform = input.platform || process.platform;
    this.arch = input.arch || process.arch;
    this.harness = new EnvironmentInstallHarness({
      onProgress: input.onProgress,
      onEvent: input.onEvent,
    });
  }

  installPlan() {
    return this.languages.map((language) => {
      const installer = this.createInstaller(language);
      return {
        language,
        platform: this.platform,
        installKey: installer.installKey,
        steps: installer.installPlan(),
      };
    });
  }

  async install() {
    return await withDependencyInstallLock(this.posseRoot, () => this.installUnlocked(), {
      dryRun: this.dryRun,
      waitMs: this.timeoutMs,
      onProgress: (message) => this.harness.emit({
        kind: "environment.install.waiting",
        language: "scip",
        step: "wait for dependency install lock",
        message: `SCIP deps: ${message}`,
      }),
    });
  }

  async installUnlocked() {
    this.harness.emit({
      kind: "environment.install.started",
      language: "scip",
      step: "start SCIP language dependency install",
      totalLanguages: this.languages.length,
      message: `SCIP deps: installing ${this.languages.join(", ") || "no languages"}`,
    });
    const results = await Promise.all(this.languages.map(async (language) => {
      const installer = this.createInstaller(language);
      try {
        return await INSTALL_GATE.run(installer.installKey, () => installer.install(), {
          label: `SCIP ${language} install`,
          waitMs: this.timeoutMs,
        });
      } catch (err) {
        const message = err?.message || String(err);
        this.harness.emit({
          kind: "environment.install.language.failed",
          language,
          step: "run language installer",
          message: `${language} installer failed: ${message}`,
        });
        return { language, ok: false, status: "failed", message };
      }
    }));
    const out = {
      ok: results.every((result) => result?.ok),
      languages: this.languages,
      results,
    };
    this.harness.emit({
      kind: out.ok ? "environment.install.completed" : "environment.install.failed",
      language: "scip",
      step: "finish SCIP language dependency install",
      totalLanguages: this.languages.length,
      message: `SCIP deps: ${out.ok ? "completed" : "failed"} ${this.languages.join(", ")}`,
    });
    return out;
  }

  getStatus() {
    return this.languages.map((language) => {
      const installer = this.createInstaller(language);
      if ("statusSync" in installer && typeof installer.statusSync === "function") return installer.statusSync();
      return installer.status();
    });
  }

  createInstaller(language) {
    const options = {
      posseRoot: this.posseRoot,
      force: this.force,
      dryRun: this.dryRun,
      timeoutMs: this.timeoutMs,
      harness: this.harness,
      platform: this.platform,
      arch: this.arch,
    };
    if (language === "typescript") return new TypeScriptScipEnvironmentInstaller(options);
    if (language === "python") return new PythonScipEnvironmentInstaller(options);
    if (language === "php") return new PhpScipEnvironmentInstaller(options);
    if (language === "go") return new GoScipEnvironmentInstaller(options);
    if (language === "rust") return new RustScipEnvironmentInstaller(options);
    if (language === "clang") return new ClangScipEnvironmentInstaller(options);
    throw new Error(`unknown SCIP language: ${language}`);
  }

  /**
   * Compatibility bridge for older synchronous callers. Internal code should
   * use install() so installers remain async and progress can stream live.
   *
   * @param {ConstructorParameters<typeof ScipLanguageInstallManager>[0]} [input]
   */
  static installSync(input = {}) {
    const serializable = { ...(input || {}) };
    delete serializable.onProgress;
    delete serializable.onEvent;
    const payload = Buffer.from(JSON.stringify(serializable), "utf8").toString("base64");
    const script = [
      `import { ScipLanguageInstallManager } from ${JSON.stringify(pathToFileUrl(THIS_FILE))};`,
      "const input = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));",
      "const progress = [];",
      "const result = await new ScipLanguageInstallManager({ ...input, onProgress: (message) => progress.push(message) }).install();",
      "process.stdout.write(JSON.stringify({ result, progress }));",
    ].join("\n");
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script, payload], {
      encoding: "utf8",
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (run.error) {
      return { ok: false, languages: normalizeScipLanguages(input.languages), results: [{ language: "scip", ok: false, status: "failed", message: run.error.message }] };
    }
    if (run.status !== 0) {
      return {
        ok: false,
        languages: normalizeScipLanguages(input.languages),
        results: [{
          language: "scip",
          ok: false,
          status: "failed",
          message: String(run.stderr || run.stdout || `installer subprocess exited ${run.status}`).trim(),
        }],
      };
    }
    try {
      const parsed = JSON.parse(String(run.stdout || "{}"));
      if (typeof input.onProgress === "function") {
        for (const message of parsed.progress || []) {
          try { input.onProgress(String(message)); } catch { /* observational */ }
        }
      }
      return parsed.result;
    } catch (err) {
      return {
        ok: false,
        languages: normalizeScipLanguages(input.languages),
        results: [{
          language: "scip",
          ok: false,
          status: "failed",
          message: `installer subprocess returned invalid JSON: ${err?.message || err}`,
        }],
      };
    }
  }
}

function pathToFileUrl(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, "/");
  return `file://${resolved.startsWith("/") ? "" : "/"}${resolved}`;
}

export function getScipLanguageDependencyStatus(input = {}) {
  return new ScipLanguageInstallManager(input).getStatus();
}

export async function installScipLanguageDependencies(input = {}) {
  return await new ScipLanguageInstallManager(input).install();
}

export function installScipLanguageDependenciesSync(input = {}) {
  return ScipLanguageInstallManager.installSync(input);
}

export function getScipLanguageInstallPlan(input = {}) {
  return new ScipLanguageInstallManager(input).installPlan();
}

export function clangScipStatusSync(input = {}) {
  const manager = new ScipLanguageInstallManager({ ...input, languages: "clang" });
  const installer = manager.createInstaller("clang");
  const found = installer.findCommandPath(installer.commandSegments, "scip-clang")
    || (commandOnPathSync("scip-clang") ? "scip-clang" : null);
  if (found) return installer.ok("ok", "installed");
  if (installer.platform === "win32") {
    return {
      language: "clang",
      ok: true,
      status: "skipped",
      message: "scip-clang has no Windows build (WSL or atlas_scip_index_command)",
    };
  }
  return installer.failed(`missing scip-clang (PATH or ${installer.expectedCommandPath(installer.commandSegments, "scip-clang")}); posse doctor installs it`);
}
