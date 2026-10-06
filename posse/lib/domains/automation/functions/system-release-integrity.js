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
