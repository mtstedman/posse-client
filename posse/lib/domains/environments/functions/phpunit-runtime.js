import fs from "node:fs";
import path from "node:path";
import { PHPUNIT_RELEASES } from "../../../catalog/phpunit.js";
import { comparePhpVersions } from "./php-scip-tracks.js";
import { managedToolRoot } from "../../../shared/platform/functions/managed-install-state.js";

export function selectPhpUnitRelease(phpVersion) {
  return phpVersion ? PHPUNIT_RELEASES.find((release) => comparePhpVersions(phpVersion, release.minPhp) >= 0) || null : null;
}

export function managedPhpUnitPath(installRoot) {
  return path.join(installRoot, "scip", "bin", "phpunit.phar");
}

// Discovery is read-only. Only doctor/setup downloads tools; a test run never
// mutates Composer manifests, installs packages, or selects an ambient PHPUnit.
export function resolveManagedPhpUnit(posseRoot) {
  const installRoot = managedToolRoot(posseRoot);
  const file = managedPhpUnitPath(installRoot);
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

// Shared by file-based tests and declared suite commands. Preserve all caller
// selections/configuration; only the executable location may fall back.
export function resolvePhpUnitInvocation({ cwd, script = "vendor/bin/phpunit", args = [], posseRoot } = {}) {
  let runner = null;
  const candidates = script === "phpunit" ? ["vendor/bin/phpunit", script] : [script];
  for (const candidate of candidates) {
    try { if (fs.statSync(path.resolve(cwd, candidate)).isFile()) { runner = candidate; break; } } catch { /* managed fallback below */ }
  }
  runner ||= resolveManagedPhpUnit(posseRoot);
  return runner ? { runner: "phpunit", executable: "php", args: [runner, ...args] } : null;
}
