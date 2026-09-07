import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { resolvePathWithin } from "../../../../shared/scope/functions/path.js";
import { realpathExistingPrefix } from "../../../runtime/functions/fs-safety.js";

function comparablePromoteDestination(destination) {
  const resolved = path.normalize(realpathExistingPrefix(destination));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertConcretePromoteDestination(destination, cwd) {
  const destinationAbs = path.resolve(destination);
  if (!resolvePathWithin(cwd, destinationAbs)) {
    const err = new Error(`Promote destination escapes project scope: ${path.relative(cwd, destinationAbs).replace(/\\/g, "/") || destinationAbs}`);
    err.code = "PROMOTE_DESTINATION_OUTSIDE_PROJECT";
    throw err;
  }
  try {
    if (fs.lstatSync(destinationAbs).isSymbolicLink()) {
      const err = new Error(`Promote destination must not be a symbolic link: ${path.relative(cwd, destinationAbs).replace(/\\/g, "/") || destinationAbs}`);
      err.code = "PROMOTE_DESTINATION_SYMLINK";
      throw err;
    }
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  return destinationAbs;
}

export function assertPromoteCopyPlan(copies = [], { cwd = process.cwd() } = {}) {
  const destinations = new Map();
  for (const copy of Array.isArray(copies) ? copies : []) {
    const destination = assertConcretePromoteDestination(copy.destination, cwd);
    const key = comparablePromoteDestination(destination);
    const prior = destinations.get(key);
    if (prior) {
      const destinationRel = copy.destinationRel || path.relative(cwd, destination).replace(/\\/g, "/");
      const err = new Error(`Promote copy plan maps multiple sources to the same destination: ${destinationRel}`);
      err.code = "PROMOTE_DESTINATION_COLLISION";
      throw err;
    }
    destinations.set(key, copy);
  }
}

export function copyPromoteFileSync(copy, { cwd = process.cwd() } = {}) {
  const destination = assertConcretePromoteDestination(copy.destination, cwd);
  const destinationDir = path.dirname(destination);
  fs.mkdirSync(destinationDir, { recursive: true });
  assertConcretePromoteDestination(destination, cwd);
  let destinationMode = null;
  try { destinationMode = fs.lstatSync(destination).mode; } catch { /* new destination */ }

  const temporary = path.join(
    destinationDir,
    `.${path.basename(destination)}.posse-promote-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    // Write a new inode and rename it into place. rename never follows the
    // final destination symlink, so even a link introduced after validation
    // cannot redirect artifact bytes outside the project.
    fs.copyFileSync(copy.source, temporary, fs.constants.COPYFILE_EXCL);
    if (destinationMode != null) fs.chmodSync(temporary, destinationMode & 0o7777);
    assertConcretePromoteDestination(destination, cwd);
    try {
      fs.renameSync(temporary, destination);
    } catch (err) {
      if (process.platform !== "win32" || !["EACCES", "EEXIST", "EPERM"].includes(err?.code)) throw err;
      // Windows does not atomically replace an existing regular file. Remove
      // only the validated directory entry, then install the completed temp.
      assertConcretePromoteDestination(destination, cwd);
      fs.unlinkSync(destination);
      fs.renameSync(temporary, destination);
    }
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* best-effort temp cleanup */ }
  }
}
