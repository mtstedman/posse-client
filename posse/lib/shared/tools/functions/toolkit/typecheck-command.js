import fs from "node:fs";
import path from "node:path";
import { resolveVerificationTypeScript } from "../../../../domains/environments/functions/node-verification-runtime.js";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { packageManagerRun } from "./verification-readiness.js";

// Explicit project scripts own custom compilers/configurations. Otherwise use
// an installed project or compatible managed compiler and the package's config;
// never invoke a build script, download tooling, or emit application artifacts.
export function typecheckCommand(cwd, { packageManager = null, packageManagerReady = null, posseRoot = undefined } = {}) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")); } catch { /* config-only projects are supported */ }
  const script = manifest?.scripts?.typecheck?.trim();
  const plainTsc = /^(?:tsc|tsc --noEmit)(?: --pretty false)?$/u.test(script || "");
  const resolved = resolveVerificationTypeScript(cwd, { posseRoot });
  if (script && !(plainTsc && resolved?.source === "managed" && fs.existsSync(path.join(cwd, "tsconfig.json")))) {
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
    if (!resolved) throw new Error("no compatible compiler");
    const { compiler, ts } = resolved;
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
      tool_source: resolved.source,
    };
  } catch {
    return { status: "unavailable", dependency_unavailable: true, reason: "dependency_unavailable: no compatible project or managed TypeScript compiler; run posse doctor" };
  }
}

export function cleanTypecheckOutput(invocation) {
  if (invocation.buildInfo) fs.rmSync(invocation.buildInfo, { force: true });
}
