import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// A browser bootstrap failure is a missing verification prerequisite, even
// when a repository script launches Playwright through a package manager.
const BROWSER_LAUNCH_FAILURE = /browserType\.launch: Executable doesn't exist|browserType\.launch:[^\n]*Host system is missing dependencies/u;
export function missingBrowserTestRuntime(output) {
  return BROWSER_LAUNCH_FAILURE.test(String(output || ""));
}

// A run whose only failures are browser launches ran no test; a run that also
// passed tests, or failed more tests than it printed launch failures for, has
// product evidence the missing browser must not hide. Playwright's summary
// prints `N passed (4.2s)` and `N failed`, on separate lines or one line.
export function browserLaunchFailuresExplainTestOutput(output) {
  const text = String(output || "");
  const launchFailures = text.split("\n").filter((line) => BROWSER_LAUNCH_FAILURE.test(line)).length;
  if (launchFailures === 0) return false;
  const counts = (pattern) => [...text.matchAll(pattern)].map((match) => Number(match[1]));
  if (counts(/(?:^|[^\w.])(\d+)\s+passed\b/gmu).some((count) => count > 0)) return false;
  const failed = counts(/(?:^|[^\w.])(\d+)\s+failed\b/gmu);
  return failed.length === 0 || Math.max(...failed) <= launchFailures;
}

// Missing external packages are verification prerequisites; missing relative
// application modules remain product failures.
export function missingNodeTestDependency(output) {
  const match = /(?:Cannot find (?:module|package)|Failed to resolve import) ['"]([^'"]+)['"]/.exec(String(output || ""));
  const name = match?.[1];
  if (!name || /^(?:[./#]|[A-Za-z]:|file:|node:|@\/)/.test(name)) return null;
  return name;
}

// Typecheck can run using an ancestor's tools while a newly declared package
// is still absent. An installed package's bad subpath/types and undeclared
// imports remain product failures; installing dependencies cannot fix them.
export function missingDeclaredNodeDependency(output, projectRoot) {
  if (!projectRoot) return null;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")); }
  catch { return null; }
  const declared = { ...manifest.dependencies, ...manifest.devDependencies,
    ...manifest.optionalDependencies, ...manifest.peerDependencies };
  const require = createRequire(path.resolve(projectRoot, "package.json"));
  for (const line of String(output || "").split("\n")) {
    const specifier = missingNodeTestDependency(line);
    if (!specifier) continue;
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    if (!Object.hasOwn(declared, name)) continue;
    const installed = (require.resolve.paths(name) || [])
      .some((root) => fs.existsSync(path.join(root, name, "package.json")));
    if (!installed) return name;
  }
  return null;
}
