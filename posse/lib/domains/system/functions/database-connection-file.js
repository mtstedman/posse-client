import fs from "node:fs";
import path from "node:path";
import { localPath } from "./environment-paths.js";
import { listIgnoredRepoPaths } from "../../git/functions/ignored-paths.js";

// Connection source comes from the planner/developer in the application's
// language. Setup never reads credentials into it or executes it. Approval
// includes the complete file, just like the other proposed setup writes.
export async function prepareDatabaseConnectionFile(connection, cwd, capture, { reservedPaths = [], assertWritable } = {}) {
  if (!connection || typeof connection !== "object" || Array.isArray(connection)) {
    throw new Error("Database setup requires an application connector: provide path and content for a new module, or path alone to reuse an existing module.");
  }
  const file = localPath(cwd, connection.path);
  const relative = path.relative(cwd, file).replaceAll(path.sep, "/");
  if (reservedPaths.includes(relative)) throw new Error("The connection module must be separate from other setup files.");
  if ((await listIgnoredRepoPaths(cwd, [relative])).length) throw new Error("The connection source must be committable, not an ignored configuration or runtime file.");
  if (connection.content === undefined) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !fs.statSync(file).size) {
      throw new Error("The existing application connector must be a nonempty source file. Supply content to create a new module.");
    }
    capture(relative);
    return { path: relative, existing: true };
  }
  if (typeof connection.content !== "string" || !connection.content.trim()
    || Buffer.byteLength(connection.content) > 16 * 1024 || connection.content.includes("\0")) {
    throw new Error("Provide a new connection source file with nonempty text no larger than 16 KB.");
  }
  if (fs.existsSync(file)) throw new Error("Connection file already exists. Reuse the application's existing connector with path alone; setup never replaces it.");
  assertWritable?.(file);
  capture(relative, { writable: true });
  return { path: relative, content: connection.content };
}
