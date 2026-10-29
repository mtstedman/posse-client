import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// A browser bootstrap failure is a missing verification prerequisite, even
// when a repository script launches Playwright through a package manager.
export function missingBrowserTestRuntime(output) {
  return /browserType\.launch: Executable doesn't exist|browserType\.launch:[^\n]*Host system is missing dependencies/u.test(String(output || ""));
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
