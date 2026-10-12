import fs from "node:fs";
import path from "node:path";
import { demand } from "./policy.js";

function trusted(filename, kind = "file") {
  const info = fs.lstatSync(filename);
  demand(info.uid === 0 && (info.isSymbolicLink() || !(info.mode & 0o022)), `Untrusted ${kind}: ${filename}`, "forbidden");
  return info;
}

export function verifyTrustedExecutable(filename) {
  const target = fs.realpathSync(filename);
  for (const initial of [filename, target]) {
    let cursor = path.resolve(initial);
    while (cursor !== path.dirname(cursor)) { trusted(cursor, "executable path component"); cursor = path.dirname(cursor); }
  }
  demand(trusted(target, "runtime executable").isFile(), "Runtime executable is not a file", "forbidden");
  return target;
}

export function verifySystemRelease(packageRoot, nodePath) {
  demand(process.platform === "linux" && process.getuid() === 0, "System release verification requires Linux root", "forbidden");
  const root = fs.realpathSync(packageRoot);
  demand(path.isAbsolute(packageRoot) && !root.startsWith("/home/") && !root.startsWith("/tmp/"),
    "System package must be in a protected path", "forbidden");
  for (const initial of [packageRoot, root]) {
    let cursor = path.resolve(initial);
    while (cursor !== path.dirname(cursor)) { trusted(cursor, "path component"); cursor = path.dirname(cursor); }
  }
  const node = verifyTrustedExecutable(nodePath);
  const seen = new Set();
  function visit(filename) {
    const info = trusted(filename, "release entry");
    if (info.isSymbolicLink()) {
      const target = fs.realpathSync(filename);
      demand(target.startsWith(root + path.sep), "Release symlink escapes package root", "forbidden");
      if (!seen.has(target)) { seen.add(target); visit(target); }
      return;
    }
    if (info.isDirectory()) for (const child of fs.readdirSync(filename)) visit(path.join(filename, child));
    else demand(info.isFile(), "Unexpected release entry", "forbidden");
  }
  visit(root);
  const entry = path.join(root, "lib/domains/automation/functions/automation-owner-entry.js");
  demand(fs.statSync(entry).isFile(), "System owner entry is missing", "invalid_request");
  const gateway = path.join(root, "lib/domains/automation/functions/registered-agent-gateway.py");
  demand(fs.statSync(gateway).isFile(), "Gateway entry is missing", "invalid_request");
  return { root, node, entry, gateway };
}

/**
 * Read a root-owned configuration file such as owner.env or release.env. A
 * missing file reads as null. It must be a regular file owned by root that
 * neither group nor others can write, and it may not set a reserved key.
 *
 * @param {string} filename
 * @param {{ io?: typeof fs, label?: string, reservedKeys?: readonly string[], trustedUid?: number }} [options]
 * @returns {string | null}
 */
export function readTrustedConfigFile(filename, { io = fs, label = "Configuration", reservedKeys = [], trustedUid = 0 } = {}) {
  if (!io.existsSync(filename)) return null;
  const info = io.lstatSync(filename);
  demand(info.isFile() && !info.isSymbolicLink() && info.uid === trustedUid && !(info.mode & 0o022),
    `${label} file is untrusted`, "forbidden");
  const text = io.readFileSync(filename, "utf8");
  const reserved = new Set(reservedKeys);
  for (const line of text.split("\n")) {
    const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    demand(!key || !reserved.has(key), `${label} cannot override ${key}`, "forbidden");
  }
  return text;
}

/**
 * Refuse a freshly extracted tree that could steer a later root write or read
 * outside itself. Every symlink must be relative with no `..` segment, which
 * keeps each resolution below the link's own directory (and so inside the
 * tree); anything other than a directory, file or such a link is refused.
 *
 * @param {string} root
 * @param {{ io?: typeof fs }} [options]
 */
export function assertContainedTree(root, { io = fs } = {}) {
  const visit = dir => {
    for (const entry of io.readdirSync(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = io.readlinkSync(filename);
        demand(!path.isAbsolute(target) && !target.split(/[\\/]+/).includes(".."),
          `Release source symlink leaves its directory: ${path.relative(root, filename)} -> ${target}`, "forbidden");
      } else if (entry.isDirectory()) visit(filename);
      else demand(entry.isFile(), `Unexpected release source entry: ${path.relative(root, filename)}`, "forbidden");
    }
  };
  visit(root);
}
