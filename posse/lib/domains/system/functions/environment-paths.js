import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { safePath } from "../../../shared/tools/functions/toolkit/path-policy.js";
import { protectedMutablePathReason, isSensitiveEnvRepoPath } from "../../runtime/functions/protected-paths.js";

export function localPath(cwd, value, { dependencyDirectory = false, environmentFile = false } = {}) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || /^[A-Za-z]:|[\\\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Use a repository-relative path with forward slashes.");
  }
  if (value.split("/").includes("..")) throw new Error("Parent paths are not allowed.");
  const full = safePath(cwd, value);
  const relative = path.relative(cwd, full).replaceAll(path.sep, "/");
  const reason = protectedMutablePathReason(relative, { allowRuntimeResources: false });
  const approvedEnv = environmentFile && path.basename(relative) === ".env" && !isSensitiveEnvRepoPath(path.dirname(relative));
  if ((!dependencyDirectory && reason) || (isSensitiveEnvRepoPath(relative) && !approvedEnv)) throw new Error(`Protected setup path: ${value}`);
  // A package manager traverses paths itself; do not allow a symlink to redirect
  // even an apparently local package, lockfile, database, or node_modules root.
  let cursor = full;
  while (cursor !== path.resolve(cwd)) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Symlink setup path: ${value}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    cursor = path.dirname(cursor);
  }
  return full;
}

export function fingerprint(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error(`Setup input must be a file smaller than 5 MB: ${path.basename(file)}`);
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function readManifest(file) {
  fingerprint(file);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`${path.basename(file)} must contain an object.`);
  return manifest;
}
