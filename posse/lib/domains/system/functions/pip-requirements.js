import fs from "node:fs";
import path from "node:path";
import { localPath } from "./environment-paths.js";

export const PIP_REQUIREMENT_FILES = ["requirements.txt", "requirements-dev.txt", "dev-requirements.txt"];

// pip accepts source directories even with --only-binary=:all:. Only registry
// requirements are admitted without build approval; included files follow the
// same policy and must remain inside this package's reviewed directory.
function assertWheelRequirement(line, dir) {
  if (/\$\{/u.test(line)) throw new Error("Dynamic pip requirements need explicit source-build approval.");
  if (/^--(?:index-url|extra-index-url|find-links|trusted-host)(?:\s+|=)\S+$/u.test(line)
    || /^--(?:no-index|pre|prefer-binary|require-hashes)$/u.test(line)
    || /^--only-binary(?:\s+|=):all:$/u.test(line)) return;
  const withoutHashes = line.replace(/\s+--hash[= ]\S+/gu, "");
  if (/(?:^|\s)--/u.test(withoutHashes)) throw new Error("pip build-control options require explicit source-build approval.");
  const requirement = withoutHashes.split(/\s*;\s*/u, 1)[0].trim();
  // A bare distribution name can also be a local source directory. pip gives
  // an existing installable directory precedence over the registry lookup.
  const localCandidate = requirement.replace(/\s*\[[^\]]*\]$/u, "");
  if (fs.existsSync(path.resolve(dir, localCandidate))) throw new Error("Local pip sources require explicit source-build approval.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._, -]+\])?\s*(?:\(?\s*(?:===?|~=|!=|<=?|>=?)\s*[A-Za-z0-9.*+!_-]+(?:\s*,\s*(?:===?|~=|!=|<=?|>=?)\s*[A-Za-z0-9.*+!_-]+)*\s*\)?)?$/u.test(requirement)) {
    throw new Error("pip source references and build-control options require lifecycle_scripts: true (explicit source-build approval).");
  }
}

export function inspectPipRequirements(dir, { manifest, scripts = true } = {}) {
  const files = new Map();
  const active = new Set();
  let bytes = 0;
  function visit(relative, required = true) {
    const file = localPath(dir, relative);
    if (active.has(relative)) throw new Error(`Cyclic pip requirements include: ${relative}`);
    if (files.has(relative)) return;
    const projected = relative === "requirements.txt" && manifest !== undefined;
    if (!projected && !fs.existsSync(file) && !required) return;
    if (!projected && (!fs.statSync(file).isFile() || fs.statSync(file).size > 32 * 1024)) throw new Error("pip requirements approval is limited to 32 KB.");
    const content = projected ? manifest : fs.readFileSync(file, "utf8");
    bytes += Buffer.byteLength(content);
    if (bytes > 32 * 1024 || files.size >= 32) throw new Error("pip requirements approval is limited to 32 files and 32 KB.");
    files.set(relative, content);
    active.add(relative);
    for (const raw of content.replace(/\\\r?\n/gu, "").split(/\r?\n/u)) {
      const line = raw.replace(/(?:^|\s+)#.*$/u, "").trim();
      if (!line) continue;
      const include = line.match(/^(?:--(?:requirement|constraint)(?:=|\s+)|-[rc]\s*)(.+)$/u);
      if (include) {
        const target = include[1].trim().replace(/^(["'])(.*)\1$/u, "$2");
        if (!target || /["'\u0000-\u001f]|\$\{|^[a-z]+:|^[/\\]/iu.test(target)) throw new Error("pip includes must name local, static requirements files inside the package.");
        const nested = path.relative(dir, path.resolve(path.dirname(file), target)).replaceAll(path.sep, "/");
        visit(nested);
      } else if (!scripts) assertWheelRequirement(line, dir);
    }
    active.delete(relative);
  }
  for (const relative of PIP_REQUIREMENT_FILES) visit(relative, false);
  return files;
}
