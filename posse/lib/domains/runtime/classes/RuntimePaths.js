// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Lightweight path owner shared by bootstrap logging and the normal runtime.
// Runtime paths intentionally do not read environment overrides.
export class RuntimePaths {
  constructor() {
    this.runtimePathOverrides = {};
    this.testRuntimeRoot = null;
  }

  isUnderTest() {
    return Boolean(process.env.NODE_TEST_CONTEXT || process.env.POSSE_TEST_RUN);
  }

  getTestRuntimeLogDir() {
    if (!this.testRuntimeRoot) {
      this.testRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-test-runtime-"));
    }
    return path.join(this.testRuntimeRoot, "logs");
  }

  overridePath(key) {
    const value = this.runtimePathOverrides?.[key];
    return value ? path.resolve(value) : null;
  }

  normalizeCwd(cwd = null) {
    return path.resolve(cwd || this.safeProcessCwd());
  }

  normalizeProjectDir(projectDir = null, cwd = null) {
    return path.resolve(this.overridePath("projectDir")
      || projectDir
      || cwd
      || this.safeProcessCwd());
  }

  safeProcessCwd() {
    try {
      return process.cwd();
    } catch {
      return os.tmpdir();
    }
  }

  getRuntimeRoot(projectDir = null, cwd = null) {
    const override = this.overridePath("runtimeRoot");
    if (override) return override;
    const projectRoot = this.normalizeProjectDir(projectDir, cwd);
    return path.join(projectRoot, ".posse");
  }

  getRuntimeDbPath(projectDir = null, cwd = null) {
    const override = this.overridePath("dbPath");
    if (override) return override;
    const projectRoot = this.normalizeProjectDir(projectDir, cwd);
    return path.join(this.getRuntimeRoot(projectRoot, cwd), "db", "orchestrator.db");
  }

  getRuntimeResourcesDir(projectDir = null, cwd = null) {
    const override = this.overridePath("resourcesDir");
    if (override) return override;
    const projectRoot = this.normalizeProjectDir(projectDir, cwd);
    return path.join(this.getRuntimeRoot(projectRoot, cwd), "resources");
  }

  getRuntimeLogDir(projectDir = null, cwd = null) {
    const override = this.overridePath("logDir");
    if (override) return override;
    const runtimeRootOverride = this.overridePath("runtimeRoot");
    if (runtimeRootOverride) return path.join(runtimeRootOverride, "logs");
    // Direct unit tests often exercise an in-memory database without installing
    // runtime-path overrides. Keep their logger side effects out of the source
    // checkout while preserving explicit fixture/project destinations.
    if (this.isUnderTest() && !this.overridePath("projectDir") && projectDir == null && cwd == null) {
      return this.getTestRuntimeLogDir();
    }
    const projectRoot = this.normalizeProjectDir(projectDir, cwd);
    return path.join(this.getRuntimeRoot(projectRoot, cwd), "logs");
  }

  getRuntimeReportsDir(projectDir = null, cwd = null) {
    return path.join(path.dirname(this.getRuntimeDbPath(projectDir, cwd)), "reports");
  }

  setRuntimePathOverrides(overrides = null) {
    this.runtimePathOverrides = {};
    if (!overrides || typeof overrides !== "object") return;
    for (const [key, value] of Object.entries(overrides)) {
      if (value == null || String(value).trim() === "") continue;
      this.runtimePathOverrides[key] = path.resolve(String(value));
    }
  }

  getRuntimePathOverridesForTests() {
    return { ...this.runtimePathOverrides };
  }
}

export const runtimePaths = new RuntimePaths();
