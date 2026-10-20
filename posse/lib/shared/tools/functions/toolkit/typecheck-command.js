import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { packageManagerRun } from "./verification-readiness.js";

// Explicit project scripts own custom compilers/configurations. Otherwise use
// only an already installed TypeScript compiler and the package's own config;
// never invoke a build script, download tooling, or emit application artifacts.
export function typecheckCommand(cwd, { packageManager = null, packageManagerReady = null } = {}) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")); } catch { /* config-only projects are supported */ }
  if (typeof manifest?.scripts?.typecheck === "string" && manifest.scripts.typecheck.trim()) {
    if (!packageManager || packageManagerReady === false) {
      return {
        status: "unavailable",
        reason: packageManager ? `${packageManager} executable is not available` : "package manager could not be resolved",
      };
    }
    return { status: "ready", ...packageManagerRun(packageManager, "typecheck") };
  }
  if (!fs.existsSync(path.join(cwd, "tsconfig.json"))) {
    return { status: "not_applicable", reason: manifest ? "no typecheck script or tsconfig.json" : "no package.json or tsconfig.json" };
  }
  try {
    const require = createRequire(path.join(cwd, "package.json"));
    const compiler = require.resolve("typescript/bin/tsc");
    const ts = require("typescript");
    const config = ts.readConfigFile(path.join(cwd, "tsconfig.json"), ts.sys.readFile);
    // `tsc -p` does not check referenced projects. Do not report a solution
    // config's empty file set as a passing build, or invent an emitting -b run.
    if (Array.isArray(config.config?.references) && config.config.references.length > 0) {
      return { status: "unavailable", reason: "TypeScript project references require an explicit typecheck script" };
    }
    const buildInfo = path.join(os.tmpdir(), `posse-typecheck-${randomUUID()}.tsbuildinfo`);
    return {
      status: "ready",
      command: process.execPath,
      args: [compiler, "--project", "tsconfig.json", "--noEmit", "--incremental", "--tsBuildInfoFile", buildInfo, "--pretty", "false"],
      buildInfo,
    };
  } catch {
    return { status: "unavailable", dependency_unavailable: true, reason: "dependency_unavailable: tsconfig.json exists but TypeScript is not installed" };
  }
}

export function cleanTypecheckOutput(invocation) {
  if (invocation.buildInfo) fs.rmSync(invocation.buildInfo, { force: true });
}
